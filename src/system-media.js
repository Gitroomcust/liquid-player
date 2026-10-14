const { execFile, spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const POLL_MS = 2000;
const DELIMITER = '\u0001';
const RESTART_DELAYS = [2000, 5000, 10000, 20000, 30000];
const PS_SCRIPT = path.join(__dirname, '..', 'scripts', 'media-sessions.ps1').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
let timer = null;
let restartTimer = null;
let windowsWorker = null;
let restartAttempt = 0;
let busy = false;
let pendingTick = false;
let stopped = true;
let lastSnapshot = '';
let positionAnchors = new Map();
let onUpdate = () => {};

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

function normalizeStatus(status) {
  if (/playing/i.test(status || '')) return 'Playing';
  if (/paused/i.test(status || '')) return 'Paused';
  return 'Stopped';
}

function publishSnapshot(sessions) {
  const now = Date.now();
  const normalized = Array.isArray(sessions) ? sessions : [];
  const snapshot = JSON.stringify(normalized.map(({ position, ...session }) => session));
  let positionJumped = false;
  for (const session of normalized) {
    const previous = positionAnchors.get(session.id);
    if (!previous) continue;
    const expected = previous.position + (previous.status === 'Playing' ? (now - previous.at) / 1000 : 0);
    if (Math.abs((Number(session.position) || 0) - expected) > 2) {
      positionJumped = true;
      break;
    }
  }
  if (snapshot === lastSnapshot && !positionJumped) return;
  lastSnapshot = snapshot;
  positionAnchors = new Map(normalized.map((session) => [
    session.id,
    { position: Number(session.position) || 0, status: session.status, at: now },
  ]));
  onUpdate(normalized);
}

async function queryLinux() {
  const format = `{{playerName}}${DELIMITER}{{title}}${DELIMITER}{{artist}}${DELIMITER}{{album}}${DELIMITER}{{status}}${DELIMITER}{{position}}${DELIMITER}{{mpris:length}}${DELIMITER}{{mpris:artUrl}}`;
  const output = await run('playerctl', ['-a', 'metadata', '--format', format]);
  if (!output) return [];
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, title, artist, album, status, position, duration, thumb] = line.split(DELIMITER);
    return {
      id, title, artist, album,
      status: normalizeStatus(status),
      position: (Number(position) || 0) / 1e6,
      duration: (Number(duration) || 0) / 1e6,
      thumb: thumb || null,
    };
  }).filter((session) => session.id);
}

function macQueryScript() {
  const sep = 'character id 1';
  const result = [];
  for (const app of ['Spotify', 'Music']) {
    result.push(`if application "${app}" is running then`);
    result.push('  try');
    result.push(`    tell application "${app}"`);
    result.push('      set trackInfo to current track');
    result.push('      set rowText to ' + `"${app}" & ${sep} & (name of trackInfo as string) & ${sep} & (artist of trackInfo as string) & ${sep} & (album of trackInfo as string) & ${sep} & (player state as string) & ${sep} & (player position as string) & ${sep} & (duration of trackInfo as string)`);
    result.push('    end tell');
    result.push('    if outputText is "" then');
    result.push('      set outputText to rowText');
    result.push('    else');
    result.push('      set outputText to outputText & linefeed & rowText');
    result.push('    end if');
    result.push('  end try');
    result.push('end if');
  }
  return `set outputText to ""\n${result.join('\n')}\nreturn outputText`;
}

async function queryMac() {
  const output = await run('osascript', ['-e', macQueryScript()]);
  if (!output) return [];
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, title, artist, album, status, position, duration] = line.split(DELIMITER);
    return {
      id, title, artist, album,
      status: normalizeStatus(status),
      position: Number(position) || 0,
      duration: (Number(duration) || 0) / 1000,
      thumb: null,
    };
  }).filter((session) => session.id);
}

async function query() {
  return process.platform === 'darwin' ? queryMac() : queryLinux();
}

async function tick() {
  if (stopped) return;
  if (busy) {
    pendingTick = true;
    return;
  }
  busy = true;
  try {
    publishSnapshot(await query());
  } finally {
    busy = false;
    if (pendingTick && !stopped) {
      pendingTick = false;
      void tick();
    }
  }
}

function scheduleWorkerRestart() {
  if (stopped || restartTimer) return;
  const delay = RESTART_DELAYS[Math.min(restartAttempt, RESTART_DELAYS.length - 1)];
  restartAttempt += 1;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startWindowsWorker();
  }, delay);
}

function startWindowsWorker() {
  if (stopped || windowsWorker) return;
  let worker;
  try {
    worker = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    scheduleWorkerRestart();
    return;
  }
  windowsWorker = worker;
  worker.stdout.setEncoding('utf8');
  const lines = readline.createInterface({ input: worker.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    try {
      const sessions = JSON.parse(line);
      restartAttempt = 0;
      publishSnapshot(sessions);
    } catch {}
  });
  const onExit = () => {
    if (windowsWorker !== worker) return;
    windowsWorker = null;
    lines.close();
    scheduleWorkerRestart();
  };
  worker.once('error', onExit);
  worker.once('close', onExit);
}

async function control(id, action) {
  if (!['play', 'pause', 'toggle', 'next', 'prev'].includes(action)) return false;
  if (process.platform === 'win32') {
    if (!windowsWorker || !windowsWorker.stdin.writable) return false;
    windowsWorker.stdin.write(`${action}\t${id || ''}\n`);
    return true;
  }
  if (process.platform === 'darwin') {
    const commands = { play: 'play', pause: 'pause', toggle: 'playpause', next: 'next track', prev: 'previous track' };
    if (['Spotify', 'Music'].includes(id)) await run('osascript', ['-e', `tell application "${id}" to ${commands[action]}`]);
  } else {
    const commands = { play: 'play', pause: 'pause', toggle: 'play-pause', next: 'next', prev: 'previous' };
    await run('playerctl', ['-p', id, commands[action]]);
  }
  await tick();
  return true;
}

function start(callback) {
  stop();
  stopped = false;
  onUpdate = callback;
  lastSnapshot = '';
  positionAnchors = new Map();
  restartAttempt = 0;
  if (process.platform === 'win32') {
    startWindowsWorker();
  } else {
    void tick();
    timer = setInterval(tick, POLL_MS);
  }
}

function stop() {
  stopped = true;
  clearInterval(timer);
  clearTimeout(restartTimer);
  timer = null;
  restartTimer = null;
  pendingTick = false;
  if (windowsWorker) {
    const worker = windowsWorker;
    windowsWorker = null;
    worker.stdin.end();
    worker.kill();
  }
}

module.exports = { start, stop, control };
