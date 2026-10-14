const { app, BrowserWindow, ipcMain, dialog, protocol, net, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { createReadStream } = require('fs');
const { Readable } = require('stream');
const mm = require('music-metadata');
const systemMedia = require('./system-media');

const MIME = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg', '.webm': 'audio/webm', '.wma': 'audio/x-ms-wma' };
const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.webm', '.wma']);

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#0a0b14',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

async function scanDir(dir, depth, out) {
  if (depth > 4 || out.length > 2000) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await scanDir(full, depth + 1, out);
    else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

async function readTrack(file) {
  const base = { path: file, title: path.basename(file, path.extname(file)), artist: '', album: '', duration: 0, cover: null };
  try {
    const meta = await mm.parseFile(file, { duration: false, skipPostHeaders: true });
    const c = meta.common;
    base.title = c.title || base.title;
    base.artist = c.artist || (c.artists || []).join(', ') || '';
    base.album = c.album || '';
    base.duration = meta.format.duration || 0;
    const pic = c.picture && c.picture[0];
    if (pic) base.cover = `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}`;
  } catch { /* keep filename fallback */ }
  return base;
}

ipcMain.handle('get-user', () => {
  let name = '';
  try { name = os.userInfo().username; } catch { name = process.env.USERNAME || process.env.USER || ''; }
  return { name, platform: process.platform };
});

ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Выберите папку с музыкой' });
  if (res.canceled || !res.filePaths.length) return null;
  const dir = res.filePaths[0];
  const files = [];
  await scanDir(dir, 0, files);
  files.sort((a, b) => a.localeCompare(b));
  const tracks = [];
  for (let i = 0; i < files.length; i += 8) {
    tracks.push(...await Promise.all(files.slice(i, i + 8).map(readTrack)));
  }
  return { dir, tracks };
});

ipcMain.handle('system-control', (_e, id, action) => systemMedia.control(id, action));

app.whenReady().then(() => {
  protocol.handle('media', async (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const abs = process.platform === 'win32' ? filePath.replace(/^([a-zA-Z])\//, '$1:/') : '/' + filePath;
    let stat;
    try { stat = await fs.stat(abs); } catch { return new Response('Not found', { status: 404 }); }
    const size = stat.size;
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const range = request.headers.get('range');
    let start = 0, end = size - 1, status = 200;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1]) start = parseInt(m[1], 10);
        if (m[2]) end = parseInt(m[2], 10);
        if (!m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
        end = Math.min(end, size - 1);
        status = 206;
      }
    }
    const stream = Readable.toWeb(createReadStream(abs, { start, end }));
    const headers = {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    return new Response(stream, { status, headers });
  });

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const { desktopCapturer } = require('electron');
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  });

  createWindow();

  systemMedia.start((sessions) => {
    if (win && !win.isDestroyed()) win.webContents.send('system-sessions', sessions);
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  systemMedia.stop();
  if (process.platform !== 'darwin') app.quit();
});
