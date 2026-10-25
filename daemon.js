#!/usr/bin/env node
// Background process: talks to the local Discord client over IPC and mirrors
// the most recently active Claude Code session as Rich Presence.
// Started by hook.js; exits on its own once no sessions are left.
const fs = require('fs');
const net = require('net');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const stats = require('./stats');
const { ROOT, stateDir } = require('./session');

const STATE = stateDir();
const SESSIONS = path.join(STATE, 'sessions');
const PID_FILE = path.join(STATE, 'daemon.pid');
const PAUSE_FILE = path.join(STATE, 'pause.json');
const AGG_FILE = path.join(STATE, 'aggregate.json');
const LOG_FILE = path.join(STATE, 'daemon.log');

const config = {
  appName: 'Claude Code',
  images: {},
  frames: {},
  projects: {},
  githubButton: true,
  rotateSeconds: 12,
  hideAfterIdleMinutes: 0,
  staleMinutes: 30,
  exitAfterIdleSeconds: 60,
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')),
};

function log(...args) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 256 * 1024) fs.rmSync(LOG_FILE);
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.join(' ')}\n`);
  } catch {}
}

// --- single instance --------------------------------------------------------
function otherDaemon() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    if (pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Discord IPC ------------------------------------------------------------
const OP_HANDSHAKE = 0, OP_FRAME = 1, OP_CLOSE = 2, OP_PING = 3, OP_PONG = 4;
let sock = null;
let ready = false;

function pipePath(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return path.join(dir, `discord-ipc-${i}`);
}

function send(op, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  sock.write(Buffer.concat([head, body]));
}

function connect(i = 0) {
  if (i > 9) return setTimeout(connect, 15000);
  const s = net.connect(pipePath(i));
  s.once('error', () => connect(i + 1));
  s.once('connect', () => {
    s.removeAllListeners('error');
    sock = s;
    let buf = Buffer.alloc(0);
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        const msg = JSON.parse(buf.subarray(8, 8 + len).toString());
        buf = buf.subarray(8 + len);
        if (op === OP_PING) send(OP_PONG, msg);
        else if (op === OP_CLOSE) log('discord closed:', JSON.stringify(msg));
        else if (msg.evt === 'READY') {
          ready = true;
          lastSent = null;
          log('connected to discord as', msg.data?.user?.username);
          update();
        } else if (msg.evt === 'ERROR') log('discord error:', JSON.stringify(msg.data));
        else if (msg.cmd === 'SET_ACTIVITY') log('presence:', msg.data ? `${msg.data.details} | ${msg.data.state}` : 'cleared');
      }
    });
    const reset = () => {
      if (sock !== s) return;
      sock = null;
      ready = false;
      setTimeout(connect, 15000);
    };
    s.on('error', reset);
    s.on('close', reset);
    send(OP_HANDSHAKE, { v: 1, client_id: config.clientId });
  });
}

// --- formatting -------------------------------------------------------------
function fmtNum(n) {
  if (!n) return '';
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function fmtHours(ms) {
  const m = Math.round(ms / 60000);
  if (!m) return '';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// claude-opus-5-5 -> Opus 5.5, claude-sonnet-4-5-20250929 -> Sonnet 4.5
function prettyModel(id) {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(String(id || ''));
  if (!m) return '';
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

// Fill "{a} · {b}" templates; segments with an empty variable are dropped.
function fill(template, vars) {
  return template
    .split(' · ')
    .map((seg) => {
      let empty = false;
      const out = seg.replace(/\{(\w+)\}/g, (_, k) => {
        const v = vars[k];
        if (v === undefined || v === null || v === '' || v === 0) empty = true;
        return v ?? '';
      });
      return empty ? '' : out;
    })
    .filter(Boolean)
    .join(' · ');
}

// --- project info: privacy aliases, GitHub button, last commit ----------------
function projectName(cwd) {
  // A drive root like "d:\" has no basename; show it as "D:".
  const name = cwd ? path.basename(cwd) || cwd.replace(/[\\/]+$/, '').toUpperCase() : '';
  const rule = config.projects[name];
  if (rule === 'hidden') return { name: 'a private project', hidden: true };
  return { name: rule || name, hidden: false };
}

const repoCache = new Map(); // cwd -> github url | null | 'pending'
function githubUrl(cwd) {
  if (!config.githubButton || !cwd) return null;
  if (repoCache.has(cwd)) {
    const v = repoCache.get(cwd);
    return v === 'pending' ? null : v;
  }
  repoCache.set(cwd, null);
  let dir = cwd, gitConfig = null;
  for (let i = 0; i < 20 && !gitConfig; i++) {
    const p = path.join(dir, '.git', 'config');
    if (fs.existsSync(p)) gitConfig = fs.readFileSync(p, 'utf8');
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const origin = gitConfig && /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(gitConfig);
  const m = origin && /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(origin[1]);
  if (!m) return null;
  // Only link public repos: the unauthenticated API returns 404 for private ones.
  repoCache.set(cwd, 'pending');
  https
    .get(`https://api.github.com/repos/${m[1]}/${m[2]}`, { headers: { 'User-Agent': 'claudecode-presence' } }, (res) => {
      res.resume();
      repoCache.set(cwd, res.statusCode === 200 ? `https://github.com/${m[1]}/${m[2]}` : null);
    })
    .on('error', () => repoCache.set(cwd, null));
  return null;
}

const commitCache = new Map(); // cwd -> { at, subject }
function lastCommit(cwd, shippedAt) {
  const c = commitCache.get(cwd);
  if (c && c.at === shippedAt) return c.subject;
  commitCache.set(cwd, { at: shippedAt, subject: '' });
  execFile('git', ['log', '-1', '--format=%s'], { cwd, windowsHide: true }, (err, out) => {
    if (!err) commitCache.set(cwd, { at: shippedAt, subject: out.trim().slice(0, 100) });
  });
  return '';
}

// --- aggregate stats --------------------------------------------------------
let summary = { todayMs: 0, todayPrompts: 0, week: {}, topLang: '' };
function rescan() {
  try {
    summary = stats.summarize(stats.scan(AGG_FILE));
  } catch (e) {
    log('scan failed:', e.message);
  }
}

// --- presence ---------------------------------------------------------------
const lastGood = new Map(); // file -> last session parsed, used if a read races a write
function readSessions() {
  const out = [];
  const cutoff = Date.now() - config.staleMinutes * 60000;
  for (const f of fs.readdirSync(SESSIONS)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(SESSIONS, f);
    let s;
    try {
      s = JSON.parse(fs.readFileSync(p, 'utf8'));
      lastGood.set(f, s);
    } catch {
      s = lastGood.get(f);
    }
    if (!s) continue;
    if (s.updatedAt < cutoff) {
      fs.rmSync(p, { force: true });
      lastGood.delete(f);
    } else out.push(s);
  }
  return out;
}

// A session that's actively doing something beats an idle one, then the most recent wins.
const ACTIVE = new Set(['working', 'thinking', 'notification', 'compacting', 'shipped']);
function rank(s) {
  return (ACTIVE.has(s.status) ? 1e15 : 0) + (s.updatedAt || 0);
}

function paused() {
  try {
    return JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8')).until > Date.now();
  } catch {
    return false;
  }
}

function buildActivity(s, count) {
  const now = Date.now();
  let status = s.status || 'idle';
  if (status === 'idle' && config.hideAfterIdleMinutes && now - s.updatedAt > config.hideAfterIdleMinutes * 60000) return null;
  if (s.shippedAt && now - s.shippedAt < 60000 && status !== 'notification') status = 'shipped';

  const project = projectName(s.cwd);
  const sess = stats.sessionStats(s.transcript) || {};
  const w = summary.week;
  const vars = {
    project: project.name,
    model: prettyModel(sess.model || s.model) || s.model,
    tool: s.tool,
    file: project.hidden ? '' : s.file,
    sessionPrompts: sess.prompts,
    sessionTokens: fmtNum(sess.tokens),
    sessionAdded: fmtNum(sess.added),
    todayHours: fmtHours(summary.todayMs),
    todayPrompts: summary.todayPrompts,
    weekHours: fmtHours(w.ms),
    weekPrompts: fmtNum(w.prompts),
    weekTokens: fmtNum(w.tokens),
    weekAdded: fmtNum(w.added),
    weekRemoved: fmtNum(w.removed) || '0',
    topLang: summary.topLang,
    lastCommit: status === 'shipped' && !project.hidden ? lastCommit(s.cwd, s.shippedAt) : '',
  };

  // Rotate through the frames whose lines don't come out empty.
  const render = (list = []) => list.map(([d, st]) => [fill(d, vars), fill(st, vars)]).filter(([d, st]) => d && st);
  let frames = render(config.frames[status]);
  if (!frames.length && status === 'shipped') {
    status = 'thinking'; // shipped before the commit subject has loaded
    frames = render(config.frames.thinking);
  }
  if (!frames.length) {
    // Nothing fully filled in: use the first details line that is, under the app name.
    const details = (config.frames[status] || []).map(([d]) => fill(d, vars)).find(Boolean) || '';
    frames = [[details || (project.name ? `${config.appName} · ${project.name}` : config.appName), details ? config.appName : status[0].toUpperCase() + status.slice(1)]];
  }
  const [details, state] = frames[Math.floor(now / (config.rotateSeconds * 1000)) % frames.length];

  const activity = {
    details: (count > 1 ? `${details} (+${count - 1})` : details).slice(0, 128),
    state: state.slice(0, 128),
    timestamps: { start: s.startedAt },
    assets: {
      large_image: config.images[status] || config.images.idle,
      large_text: vars.model ? `${config.appName} · ${vars.model}` : config.appName,
    },
    instance: false,
  };
  const gh = project.hidden ? null : githubUrl(s.cwd);
  if (gh) activity.buttons = [{ label: 'View on GitHub', url: gh }];
  return activity;
}

// Discord allows ~5 activity updates per 20s; keep a gap and coalesce.
const MIN_GAP = 4000;
let lastSent = null, lastAt = 0, pending = null, emptySince = null;

function update() {
  const sessions = readSessions();
  if (!sessions.length) {
    emptySince = emptySince || Date.now();
    if (Date.now() - emptySince > config.exitAfterIdleSeconds * 1000) shutdown();
  } else emptySince = null;

  if (!ready) return;
  sessions.sort((a, b) => rank(b) - rank(a));
  const show = sessions.length && !paused();
  const activity = show ? buildActivity(sessions[0], sessions.length) : null;
  const key = JSON.stringify(activity);
  if (key === lastSent) return;

  const wait = lastAt + MIN_GAP - Date.now();
  if (wait > 0) {
    if (!pending) pending = setTimeout(() => { pending = null; update(); }, wait);
    return;
  }
  lastSent = key;
  lastAt = Date.now();
  send(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: String(lastAt) });
}

function shutdown() {
  try { if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.rmSync(PID_FILE); } catch {}
  log('no sessions left, exiting');
  process.exit(0);
}

function main() {
  fs.mkdirSync(SESSIONS, { recursive: true });
  if (otherDaemon()) process.exit(0);
  fs.writeFileSync(PID_FILE, String(process.pid));
  setTimeout(() => otherDaemon() && process.exit(0), 300);

  if (!/^\d+$/.test(config.clientId)) {
    log('config.json is missing clientId');
    shutdown();
  }

  let debounce = null;
  fs.watch(SESSIONS, () => {
    clearTimeout(debounce);
    debounce = setTimeout(update, 250);
  });
  setInterval(update, 4000); // frame rotation, stale cleanup, idle exit
  setInterval(rescan, 5 * 60000);
  setTimeout(rescan, 1000);
  connect();
  log('daemon started, pid', process.pid);
}

if (require.main === module) main();
else module.exports = { buildActivity, prettyModel, fill, fmtNum, fmtHours, rescan, config };
