const { app, BrowserWindow, ipcMain, dialog, protocol, session, desktopCapturer } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { createReadStream } = require('fs');
const { Readable } = require('stream');
const mm = require('music-metadata');
const systemMedia = require('./system-media');

const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
};
const AUDIO_EXT = new Set(Object.keys(MIME));
const MAX_FILES = 5000;
const MAX_SCAN_DEPTH = 6;
const COVER_CACHE_LIMIT = 60;
const allowedRoots = new Set();
const coverCache = new Map();

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } },
]);

if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'PulseaudioLoopbackForScreenShare');

const hasLock = app.requestSingleInstanceLock();
let win;
let scanGeneration = 0;
let pendingFocus = false;

if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) {
      pendingFocus = true;
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  function startSystemMedia() {
    systemMedia.start((sessions) => {
      if (win && !win.isDestroyed()) win.webContents.send('system-sessions', sessions);
    });
  }

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
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    win.on('closed', () => {
      win = null;
      systemMedia.stop();
    });
    win.webContents.once('did-finish-load', startSystemMedia);
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    if (pendingFocus) {
      pendingFocus = false;
      win.focus();
    }
  }

  async function scanDir(dir, depth, out) {
    if (depth > MAX_SCAN_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await scanDir(full, depth + 1, out);
      else if (entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  }

  function sendTrackUpdates(gen, updates) {
    if (updates.length && gen === scanGeneration && win && !win.isDestroyed()) {
      win.webContents.send('tracks-meta', { gen, updates });
    }
  }

  async function parseTrackMetadata(file, index, gen, updates, queueFlush) {
    const fallback = path.basename(file, path.extname(file));
    const update = { index, title: fallback, artist: '', album: '', duration: 0, hasCover: false };
    try {
      const metadata = await mm.parseFile(file, { duration: false, skipPostHeaders: true });
      const common = metadata.common;
      update.title = common.title || fallback;
      update.artist = common.artist || (common.artists || []).join(', ') || '';
      update.album = common.album || '';
      update.duration = metadata.format.duration || 0;
      update.hasCover = !!(common.picture && common.picture.length);
    } catch {}
    if (gen === scanGeneration) {
      updates.push(update);
      queueFlush();
    }
  }

  async function scanMetadata(files, gen) {
    const pending = [];
    let timer = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      sendTrackUpdates(gen, pending.splice(0));
    };
    const queueFlush = () => {
      if (!timer) timer = setTimeout(flush, 200);
    };

    for (let i = 0; i < files.length && gen === scanGeneration; i += 8) {
      await Promise.all(files.slice(i, i + 8).map((file, offset) => parseTrackMetadata(file, i + offset, gen, pending, queueFlush)));
    }
    flush();
  }

  function isWithinRoot(candidate) {
    for (const root of allowedRoots) {
      const relative = path.relative(root, candidate);
      if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return true;
    }
    return false;
  }

  async function authorizedFile(filePath) {
    const absolute = path.resolve(filePath || '');
    if (!isWithinRoot(absolute)) return null;
    try {
      const actual = await fs.realpath(absolute);
      return isWithinRoot(actual) ? actual : null;
    } catch { return null; }
  }

  function corsHeaders(headers = {}) {
    return { ...headers, 'Access-Control-Allow-Origin': '*' };
  }

  function rememberCover(filePath, cover) {
    coverCache.delete(filePath);
    coverCache.set(filePath, cover);
    while (coverCache.size > COVER_CACHE_LIMIT) coverCache.delete(coverCache.keys().next().value);
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
    const gen = ++scanGeneration;
    const root = path.resolve(dir);
    allowedRoots.add(root);
    try { allowedRoots.add(await fs.realpath(root)); } catch {}
    const files = [];
    await scanDir(root, 0, files);
    files.sort((a, b) => a.localeCompare(b));
    const tracks = files.map((file) => ({
      path: file, title: path.basename(file, path.extname(file)), artist: '', album: '', duration: 0, hasCover: false,
    }));
    void scanMetadata(files, gen);
    return { dir, gen, tracks };
  });

  ipcMain.handle('system-control', (_event, id, action) => systemMedia.control(id, action));

  app.whenReady().then(() => {
    protocol.handle('media', async (request) => {
      const url = new URL(request.url);
      const filePath = await authorizedFile(url.searchParams.get('p'));
      if (!filePath) return new Response('Not found', { status: 404, headers: corsHeaders() });

      if (url.hostname === 'cover') {
        let cover = coverCache.get(filePath);
        if (cover) {
          coverCache.delete(filePath);
          coverCache.set(filePath, cover);
        } else {
          try {
            const metadata = await mm.parseFile(filePath, { duration: false, skipPostHeaders: true });
            const picture = metadata.common.picture && metadata.common.picture[0];
            if (!picture) return new Response('Not found', { status: 404, headers: corsHeaders() });
            cover = { data: Buffer.from(picture.data), type: picture.format || 'image/jpeg' };
            rememberCover(filePath, cover);
          } catch {
            return new Response('Not found', { status: 404, headers: corsHeaders() });
          }
        }
        return new Response(cover.data, {
          status: 200,
          headers: corsHeaders({ 'Content-Type': cover.type, 'Content-Length': String(cover.data.length), 'Cache-Control': 'private, max-age=3600' }),
        });
      }

      if (url.hostname !== 'local') return new Response('Not found', { status: 404, headers: corsHeaders() });
      let stat;
      try { stat = await fs.stat(filePath); } catch { return new Response('Not found', { status: 404, headers: corsHeaders() }); }
      if (!stat.isFile()) return new Response('Not found', { status: 404, headers: corsHeaders() });

      const size = stat.size;
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      const range = request.headers.get('range');
      let start = 0;
      let end = size - 1;
      let status = 200;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2]) || size === 0) {
          return new Response(null, { status: 416, headers: corsHeaders({ 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }) });
        }
        if (!match[1]) {
          const suffix = Number(match[2]);
          if (!suffix) return new Response(null, { status: 416, headers: corsHeaders({ 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }) });
          start = Math.max(0, size - suffix);
        } else {
          start = Number(match[1]);
          if (match[2]) end = Number(match[2]);
        }
        end = Math.min(end, size - 1);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
          return new Response(null, { status: 416, headers: corsHeaders({ 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }) });
        }
        status = 206;
      }

      const headers = corsHeaders({
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
      });
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      if (size === 0) return new Response(null, { status, headers });
      const stream = Readable.toWeb(createReadStream(filePath, { start, end }));
      return new Response(stream, { status, headers });
    });

    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
        if (!sources.length) return callback(null);
        callback({ video: sources[0], audio: 'loopback' });
      }).catch(() => callback(null));
    });

    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
