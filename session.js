// Used by hook.js and daemon.js: session files live in .state/sessions.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
function stateDir() {
  return path.join(ROOT, '.state');
}

function sessionFile(id) {
  return path.join(stateDir(), 'sessions', `${String(id).replace(/[^\w-]/g, '')}.json`);
}

function readSession(id) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
  } catch {
    return null;
  }
}

// Write then rename so the daemon never reads a half-written file.
function writeSession(id, s) {
  const file = sessionFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true }); // Windows: target briefly locked by a reader
    fs.writeFileSync(file, JSON.stringify(s));
  }
}

function removeSession(id) {
  fs.rmSync(sessionFile(id), { force: true });
}

function daemonAlive() {
  try {
    process.kill(Number(fs.readFileSync(path.join(stateDir(), 'daemon.pid'), 'utf8')), 0);
    return true;
  } catch {
    return false;
  }
}

function ensureDaemon() {
  if (daemonAlive()) return;
  spawn(process.execPath, [path.join(ROOT, 'daemon.js')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

module.exports = { ROOT, stateDir, readSession, writeSession, removeSession, daemonAlive, ensureDaemon };
