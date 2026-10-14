// Continuously polls media sessions of other applications.
// Windows: GlobalSystemMediaTransportControlsSessionManager via PowerShell.
// Linux: MPRIS via playerctl. macOS: Spotify / Music via AppleScript.
const { execFile } = require('child_process');
const path = require('path');

const POLL_MS = 1500;
let timer = null;
let busy = false;
let lastJson = '';
let onUpdate = () => {};

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

const PS_SCRIPT = path.join(__dirname, '..', 'scripts', 'media-sessions.ps1');

async function queryWindows(action, target) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT];
  if (action) args.push('-Action', action, '-Target', target || '');
  const out = await run('powershell.exe', args);
  if (!out) return [];
  try { return JSON.parse(out.trim() || '[]'); } catch { return []; }
}

async function queryLinux(action, target) {
  if (action) {
    const map = { play: 'play', pause: 'pause', toggle: 'play-pause', next: 'next', prev: 'previous' };
    await run('playerctl', ['-p', target, map[action]]);
  }
  const list = await run('playerctl', ['-l']);
  if (!list) return [];
  const players = list.trim().split('\n').filter(Boolean);
  const sessions = [];
  for (const p of players) {
    const fmt = '{{title}}\u0001{{artist}}\u0001{{album}}\u0001{{status}}\u0001{{position}}\u0001{{mpris:length}}\u0001{{mpris:artUrl}}';
    const out = await run('playerctl', ['-p', p, 'metadata', '--format', fmt]);
    if (!out) continue;
    const [title, artist, album, status, pos, len, art] = out.trim().split('\u0001');
    sessions.push({
      id: p, title, artist, album,
      status: status === 'Playing' ? 'Playing' : status === 'Paused' ? 'Paused' : 'Stopped',
      position: (Number(pos) || 0) / 1e6, duration: (Number(len) || 0) / 1e6,
      thumb: art || null,
    });
  }
  return sessions;
}

async function queryMac(action, target) {
  const apps = ['Spotify', 'Music'];
  const cmds = { play: 'play', pause: 'pause', toggle: 'playpause', next: 'next track', prev: 'previous track' };
  if (action && apps.includes(target)) await run('osascript', ['-e', `tell application "${target}" to ${cmds[action]}`]);
  const sessions = [];
  for (const a of apps) {
    const running = await run('osascript', ['-e', `application "${a}" is running`]);
    if (!running || running.trim() !== 'true') continue;
    const script = `tell application "${a}"
      set t to current track
      set st to player state as string
      return (name of t) & "\u0001" & (artist of t) & "\u0001" & (album of t) & "\u0001" & st & "\u0001" & (player position as string) & "\u0001" & ((duration of t) as string)
    end tell`;
    const out = await run('osascript', ['-e', script]);
    if (!out) continue;
    const [title, artist, album, st, pos, dur] = out.trim().split('\u0001');
    sessions.push({
      id: a, title, artist, album,
      status: st === 'playing' ? 'Playing' : st === 'paused' ? 'Paused' : 'Stopped',
      position: Number(pos) || 0,
      duration: a === 'Spotify' ? (Number(dur) || 0) / 1000 : Number(dur) || 0,
      thumb: null,
    });
  }
  return sessions;
}

function query(action, target) {
  if (process.platform === 'win32') return queryWindows(action, target);
  if (process.platform === 'darwin') return queryMac(action, target);
  return queryLinux(action, target);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const sessions = await query();
    const json = JSON.stringify(sessions);
    if (json !== lastJson) { lastJson = json; onUpdate(sessions); }
  } finally { busy = false; }
}

function start(cb) {
  onUpdate = cb;
  tick();
  timer = setInterval(tick, POLL_MS);
}

function stop() { clearInterval(timer); timer = null; }

async function control(id, action) {
  const sessions = await query(action, id);
  lastJson = JSON.stringify(sessions);
  onUpdate(sessions);
  return sessions;
}

module.exports = { start, stop, control };
