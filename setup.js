#!/usr/bin/env node
// Installs (or removes) the Claude Code hooks that point at this folder.
// Usage: node setup.js [--uninstall]
// Other settings and hooks are kept; a .bak copy is written before any change.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname.replace(/\\/g, '/');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const CMD = `node "${ROOT}/hook.js"`;
const uninstall = process.argv.includes('--uninstall');

const EVENTS = {
  SessionStart: {}, UserPromptSubmit: {}, PreToolUse: { matcher: '*', async: true }, PostToolUse: { matcher: '*', async: true },
  PreCompact: {}, Notification: {}, Stop: {}, SessionEnd: {},
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`${file} is not valid JSON (${e.message}); fix it first`);
  }
}

const ours = (group) => (group.hooks || []).some((h) => (h.command || '').replace(/\\/g, '/').includes(`${ROOT}/hook.js`));

try {
  const settings = readJson(SETTINGS);
  settings.hooks = settings.hooks || {};
  for (const [event, opt] of Object.entries(EVENTS)) {
    const groups = (settings.hooks[event] || []).filter((g) => !ours(g));
    if (!uninstall) {
      const hook = { type: 'command', command: CMD, timeout: 5, ...(opt.async ? { async: true } : {}) };
      groups.push({ ...(opt.matcher ? { matcher: opt.matcher } : {}), hooks: [hook] });
    }
    if (groups.length) settings.hooks[event] = groups;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.bak`);
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(`${uninstall ? 'Removed' : 'Installed'} Claude Code hooks in ${SETTINGS}`);
  if (!uninstall) console.log('\nDone. Restart Claude Code so the hooks load.');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
