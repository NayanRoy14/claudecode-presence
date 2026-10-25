#!/usr/bin/env node
// Claude Code hook: records what the session is doing and makes sure the
// presence daemon is running. Must stay fast and never fail the hook.
const path = require('path');
const { readSession, writeSession, removeSession, ensureDaemon } = require('./session');

const TOOL_NAMES = {
  Edit: 'Editing', MultiEdit: 'Editing', Write: 'Writing', NotebookEdit: 'Editing', Read: 'Reading',
  Bash: 'Running a command', PowerShell: 'Running a command', Grep: 'Searching', Glob: 'Searching',
  WebFetch: 'Browsing the web', WebSearch: 'Searching the web', Task: 'Running a subagent',
  Agent: 'Running a subagent', TodoWrite: 'Planning', Skill: 'Using a skill',
};

function main(raw) {
  let ev = {};
  try { ev = JSON.parse(raw.replace(/^﻿/, '') || '{}'); } catch {}
  if (!ev.session_id) return;
  const id = ev.session_id;

  if (ev.hook_event_name === 'SessionEnd') {
    removeSession(id);
    return;
  }

  const s = readSession(id) || {};
  const now = Date.now();
  s.startedAt = s.startedAt || now;
  s.updatedAt = now;
  s.cwd = ev.cwd || s.cwd;
  s.transcript = ev.transcript_path || s.transcript;
  if (ev.model) s.model = typeof ev.model === 'string' ? ev.model : ev.model.id || ev.model.display_name;

  const tool = ev.tool_name || '';
  const input = ev.tool_input || {};
  switch (ev.hook_event_name) {
    case 'SessionStart':
    case 'Stop':
      s.status = 'idle';
      break;
    case 'UserPromptSubmit':
    case 'PostToolUse':
      s.status = 'thinking';
      if (/\bgit\s+commit\b/.test(input.command || '')) s.shippedAt = now;
      break;
    case 'PreCompact':
      s.status = 'compacting';
      break;
    case 'Notification':
      // "waiting for your input" fires a minute after Stop; only permission prompts need the user.
      if (ev.notification_type === 'permission_prompt' || /permission/i.test(ev.message || '')) s.status = 'notification';
      break;
    case 'PreToolUse':
      s.status = 'working';
      s.tool = tool.startsWith('mcp__') ? `Using ${tool.split('__')[1]}` : TOOL_NAMES[tool] || `Using ${tool}`;
      s.file = path.basename(String(input.file_path || input.notebook_path || ''));
      s.toolAt = now;
      break;
  }
  writeSession(id, s);
  ensureDaemon();
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try { main(raw); } catch {}
  process.exit(0);
});
