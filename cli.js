#!/usr/bin/env node
// node cli.js pause [30m|2h]  |  resume  |  status
const fs = require('fs');
const path = require('path');
const { stateDir } = require('./session');

const DIR = stateDir();
const PAUSE_FILE = path.join(DIR, 'pause.json');
const [cmd, arg] = process.argv.slice(2);

function parseDuration(s = '1h') {
  const m = /^(\d+)\s*([mh]?)$/.exec(s);
  if (!m) throw new Error(`bad duration: ${s} (use e.g. 30m or 2h)`);
  return Number(m[1]) * (m[2] === 'h' ? 3600000 : 60000);
}

function status() {
  let pause = null;
  try { pause = JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8')).until; } catch {}
  console.log(`paused: ${pause && pause > Date.now() ? `until ${new Date(pause).toLocaleTimeString()}` : 'no'}`);
  let pid = null;
  try { pid = Number(fs.readFileSync(path.join(DIR, 'daemon.pid'), 'utf8')); process.kill(pid, 0); } catch { pid = null; }
  console.log(`daemon: ${pid ? `running (pid ${pid})` : 'not running'}`);
  let sessions = [];
  try {
    sessions = fs.readdirSync(path.join(DIR, 'sessions')).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, 'sessions', f), 'utf8')));
  } catch {}
  for (const s of sessions) console.log(`  session: ${path.basename(s.cwd || '?')} - ${s.status || 'idle'}${s.tool && s.status === 'working' ? ` (${s.tool})` : ''}`);
  try {
    const lines = fs.readFileSync(path.join(DIR, 'daemon.log'), 'utf8').trim().split('\n');
    console.log(`  last log: ${lines[lines.length - 1]}`);
  } catch {}
}

fs.mkdirSync(DIR, { recursive: true });
switch (cmd) {
  case 'pause': {
    const until = Date.now() + parseDuration(arg);
    fs.writeFileSync(PAUSE_FILE, JSON.stringify({ until }));
    console.log(`Discord presence hidden until ${new Date(until).toLocaleTimeString()}`);
    break;
  }
  case 'resume':
    fs.rmSync(PAUSE_FILE, { force: true });
    console.log('Discord presence resumed');
    break;
  case 'status':
    status();
    break;
  default:
    console.log('usage: node cli.js pause [30m|2h] | resume | status');
}
