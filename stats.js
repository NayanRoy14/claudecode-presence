// Transcript parsing shared by the daemon: per-session tail + all-time aggregate.
// Claude Code writes one JSON object per line to ~/.claude/projects/<proj>/<session>.jsonl.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const ACTIVE_GAP = 5 * 60000; // gaps longer than this don't count as active time
const CHUNK = 4 * 1024 * 1024;

const LANGS = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C',
  cpp: 'C++', cc: 'C++', hpp: 'C++', cs: 'C#', rb: 'Ruby', php: 'PHP', lua: 'Lua', dart: 'Dart',
  html: 'HTML', css: 'CSS', scss: 'SCSS', vue: 'Vue', svelte: 'Svelte', astro: 'Astro', sql: 'SQL',
  sh: 'Shell', ps1: 'PowerShell', md: 'Markdown', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML',
};

function lineCount(s) {
  return s ? String(s).split('\n').length : 0;
}

// Pull the bits we care about out of one transcript entry. `last` carries the
// previous assistant message ({ id, tokens }) between calls for de-duplication.
function parseEntry(e, last) {
  const out = { ts: Date.parse(e.timestamp) || 0, prompt: false, tokens: 0, model: null, edits: [] };
  const m = e.message;
  if (!m) return out;
  if (e.type === 'user' && !e.isMeta && !e.isSidechain) {
    const c = m.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) && !c.some((b) => b.type === 'tool_result') ? c.map((b) => b.text || '').join('') : '';
    out.prompt = !!text && !text.trimStart().startsWith('<');
  }
  if (e.type === 'assistant') {
    if (m.model && !m.model.startsWith('<')) out.model = m.model;
    // One API message is split across several lines that repeat its usage,
    // and later lines can carry a higher output count: count only the growth.
    if (m.usage) {
      const u = m.usage;
      const total = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const prev = m.id && m.id === last.id ? last.tokens : 0;
      out.tokens = Math.max(0, total - prev);
      last.id = m.id;
      last.tokens = Math.max(total, prev);
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type !== 'tool_use' || !b.input) continue;
      const i = b.input;
      if (b.name === 'Edit') out.edits.push({ file: i.file_path, added: lineCount(i.new_string), removed: lineCount(i.old_string) });
      else if (b.name === 'MultiEdit') for (const ed of i.edits || []) out.edits.push({ file: i.file_path, added: lineCount(ed.new_string), removed: lineCount(ed.old_string) });
      else if (b.name === 'Write') out.edits.push({ file: i.file_path, added: lineCount(i.content), removed: 0 });
    }
  }
  return out;
}

// Read complete lines appended since `offset`. Returns the new offset.
function readNew(file, offset, onLine) {
  let size;
  try { size = fs.statSync(file).size; } catch { return offset; }
  if (size < offset) offset = 0; // file was rewritten
  if (size === offset) return offset;
  const fd = fs.openSync(file, 'r');
  try {
    // Split on newline bytes so a multi-byte char cut by a chunk edge stays intact.
    let rest = Buffer.alloc(0);
    let pos = offset;
    while (pos < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK, size - pos));
      fs.readSync(fd, chunk, 0, chunk.length, pos);
      pos += chunk.length;
      let buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let nl;
      while ((nl = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, nl).toString('utf8').trim();
        buf = buf.subarray(nl + 1);
        if (!line) continue;
        try { onLine(JSON.parse(line)); } catch {}
      }
      rest = Buffer.from(buf);
    }
    return size - rest.length;
  } finally {
    fs.closeSync(fd);
  }
}

function langOf(file) {
  const ext = path.extname(String(file || '')).slice(1).toLowerCase();
  return LANGS[ext] || null;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- per-session live tail --------------------------------------------------
const tails = new Map();
function sessionStats(transcript) {
  if (!transcript) return null;
  let t = tails.get(transcript);
  if (!t) tails.set(transcript, (t = { offset: 0, prompts: 0, tokens: 0, model: null, last: {}, added: 0, removed: 0 }));
  t.offset = readNew(transcript, t.offset, (e) => {
    const p = parseEntry(e, t.last);
    if (p.prompt) t.prompts++;
    if (p.model) t.model = p.model;
    t.tokens += p.tokens;
    for (const ed of p.edits) { t.added += ed.added; t.removed += ed.removed; }
  });
  return t;
}

// --- aggregate over all transcripts ------------------------------------------
function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
  for (const d of ents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (d.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function scan(aggFile) {
  let agg = { v: 2, files: {}, days: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(aggFile, 'utf8'));
    if (saved.v === agg.v) agg = saved; // older format: rebuild from scratch
  } catch {}
  for (const file of walk(PROJECTS)) {
    const f = (agg.files[file] = agg.files[file] || { offset: 0, lastTs: 0, last: {} });
    // Subagent transcripts overlap their parent session's time; count their tokens only.
    const isSubagent = file.split(path.sep).includes('subagents');
    f.offset = readNew(file, f.offset, (e) => {
      const p = parseEntry(e, f.last);
      if (!p.ts) return;
      const day = (agg.days[dayKey(p.ts)] = agg.days[dayKey(p.ts)] || { ms: 0, prompts: 0, tokens: 0, added: 0, removed: 0, langs: {} });
      const gap = p.ts - f.lastTs;
      if (!isSubagent && f.lastTs && gap > 0 && gap <= ACTIVE_GAP) day.ms += gap;
      if (p.ts > f.lastTs) f.lastTs = p.ts;
      if (p.prompt) day.prompts++;
      day.tokens += p.tokens;
      for (const ed of p.edits) {
        day.added += ed.added;
        day.removed += ed.removed;
        const lang = langOf(ed.file);
        if (lang) day.langs[lang] = (day.langs[lang] || 0) + ed.added;
      }
    });
  }
  fs.writeFileSync(aggFile, JSON.stringify(agg));
  return agg;
}

function summarize(agg) {
  const now = Date.now();
  const today = agg.days[dayKey(now)] || {};
  const week = { ms: 0, prompts: 0, tokens: 0, added: 0, removed: 0, langs: {} };
  for (let i = 0; i < 7; i++) {
    const d = agg.days[dayKey(now - i * 86400000)];
    if (!d) continue;
    for (const k of ['ms', 'prompts', 'tokens', 'added', 'removed']) week[k] += d[k];
    for (const [l, n] of Object.entries(d.langs)) week.langs[l] = (week.langs[l] || 0) + n;
  }
  const topLang = Object.entries(week.langs).sort((a, b) => b[1] - a[1])[0];
  return { todayMs: today.ms || 0, todayPrompts: today.prompts || 0, week, topLang: topLang ? topLang[0] : '' };
}

module.exports = { sessionStats, scan, summarize };
