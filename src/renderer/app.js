const $ = (selector) => document.querySelector(selector);
const screens = { home: $('#screen-home'), list: $('#screen-list'), player: $('#screen-player') };
const audio = $('#audio');
const listEl = $('#track-list');
const bgCover = $('#bg-cover');

const state = {
  source: null,
  local: { dir: '', gen: 0, tracks: [] },
  sessions: [],
  current: null,
  sys: { position: 0, duration: 0, status: 'Stopped', at: 0 },
  screen: 'home',
};

let actx = null;
let localAnalyser = null;
let sysAnalyser = null;
let systemStream = null;
let systemSource = null;
let systemGain = null;
let captureStartPromise = null;
let runtimePlatform = '';
let androidCaptureActive = false;
let latestCaptureStats = null;
let captureSilence = false;
let diagnosticsRefreshTimer = null;
let diagnosticsCopyTimer = null;
let androidFrequency = new Uint8Array(1024);
const androidAnalyser = {
  frequencyBinCount: 1024,
  getByteFrequencyData(target) {
    target.set(androidFrequency.subarray(0, target.length));
  },
};
let systemListSignature = '';
let currentCover = null;
let failedCover = null;
let failedMiniCover = null;

const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const platformText = (android, desktop) => runtimePlatform === 'android' ? android : desktop;

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Доброй ночи';
  if (h < 12) return 'Доброе утро';
  if (h < 18) return 'Добрый день';
  return 'Добрый вечер';
}

function appName(id = '') {
  if (/^app#/.test(id)) return 'Приложение';
  const rules = [
    [/spotify/i, 'Spotify'], [/chrome/i, 'Google Chrome'], [/msedge|edge/i, 'Microsoft Edge'],
    [/firefox|308046B0AF4A39CB/i, 'Firefox'], [/zunemusic/i, 'Groove Music'], [/yandex/i, 'Яндекс Музыка'],
    [/vlc/i, 'VLC'], [/telegram/i, 'Telegram'], [/opera/i, 'Opera'], [/brave/i, 'Brave'], [/vk/i, 'VK Музыка'],
    [/itunes|music/i, 'Music'], [/foobar/i, 'foobar2000'], [/aimp/i, 'AIMP'], [/discord/i, 'Discord'],
  ];
  for (const [re, name] of rules) if (re.test(id)) return name;
  return id.replace(/\.exe$/i, '').split('!')[0].split('_')[0] || 'Приложение';
}

function sessionAppName(item, id = item?.id) {
  return item?.app || appName(id);
}

const plural = (n, one, few, many) => {
  const m = n % 10, h = n % 100;
  return m === 1 && h !== 11 ? one : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? few : many;
};

function showScreen(name) {
  state.screen = name;
  if (name === 'list' && state.source === 'system') renderList();
  for (const key in screens) screens[key].classList.toggle('active', key === name);
  updateMini();
}

/* ---------- Audio graph ---------- */
function ensureCtx() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    localAnalyser = actx.createAnalyser();
    localAnalyser.fftSize = 512;
    localAnalyser.smoothingTimeConstant = 0.82;
    const source = actx.createMediaElementSource(audio);
    source.connect(localAnalyser);
    localAnalyser.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
}

function captureActive() {
  if (runtimePlatform === 'android') return androidCaptureActive;
  return !!systemStream && systemStream.getAudioTracks().some((track) => track.readyState === 'live');
}

function updateCaptureSilenceState() {
  if (runtimePlatform !== 'android') return;
  const silent = androidCaptureActive && Number(latestCaptureStats?.silentMs) > 3000;
  if (silent === captureSilence) return;
  captureSilence = silent;
  systemListSignature = '';
  if (state.source === 'system' && state.screen === 'list') renderList();
}

function updateVisualizerSource() {
  const localPlaying = state.current?.kind === 'local' && !audio.paused;
  const hasSystemSession = state.sessions.some((item) => item.status === 'Playing');
  if (localPlaying) {
    Viz.setAnalyser(localAnalyser);
    Viz.setSynth(false);
  } else if (captureActive()) {
    Viz.setAnalyser(sysAnalyser);
    Viz.setSynth(false);
  } else if (hasSystemSession) {
    Viz.setAnalyser(null);
    Viz.setSynth(true);
  } else {
    Viz.setAnalyser(null);
    Viz.setSynth(false);
  }
  Viz.setActive(localPlaying || captureActive() || hasSystemSession);
}

function refreshSystemSummary() {
  const count = state.sessions.length;
  const listening = captureActive();
  $('#sys-sub').textContent = `${count} ${plural(count, 'трек', 'трека', 'треков')} · ${platformText('звук телефона', 'звук ПК')}: ${listening ? 'слушаю' : 'недоступен'}`;
  $('.live-dot').classList.toggle('off', !listening);
}

function onSystemAudioEnded(stream) {
  if (systemStream !== stream) return;
  systemStream = null;
  systemSource?.disconnect();
  systemGain?.disconnect();
  systemSource = null;
  systemGain = null;
  if (state.current?.kind === 'capture') setPlayingUI(false);
  refreshSystemSummary();
  updateVisualizerSource();
  if (state.source === 'system' && state.screen === 'list') renderList();
}

function attachSystemAudio(stream) {
  ensureCtx();
  const source = actx.createMediaStreamSource(stream);
  const analyser = actx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.82;
  const gain = actx.createGain();
  gain.gain.value = 0;
  source.connect(analyser);
  analyser.connect(gain);
  gain.connect(actx.destination);
  systemStream = stream;
  systemSource = source;
  sysAnalyser = analyser;
  systemGain = gain;
  stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => onSystemAudioEnded(stream), { once: true }));
  refreshSystemSummary();
  updateVisualizerSource();
  if (state.source === 'system' && state.screen === 'list') renderList();
}

async function audioInputDevices() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (!devices.some((device) => device.kind === 'audioinput' && device.label)) {
    const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permissionStream.getTracks().forEach((track) => track.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  return devices.filter((device) => device.kind === 'audioinput');
}

async function openInputDevice(device) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: device.deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
}

async function openDisplayAudio() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((track) => track.stop());
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((track) => track.stop());
    return null;
  }
  return stream;
}

async function acquireSystemAudio() {
  if (!navigator.mediaDevices) return null;
  if (runtimePlatform === 'linux' || runtimePlatform === 'darwin') {
    try {
      const inputs = await audioInputDevices();
      const pattern = runtimePlatform === 'linux'
        ? /monitor/i
        : /blackhole|soundflower|loopback|vb-?cable/i;
      const device = inputs.find((item) => pattern.test(item.label));
      if (device) {
        try { return await openInputDevice(device); } catch {}
      }
    } catch {}
  }
  try { return await openDisplayAudio(); } catch { return null; }
}

async function startSystemAudio() {
  if (captureActive()) return runtimePlatform === 'android' ? { android: true } : systemStream;
  if (captureStartPromise) return captureStartPromise;
  captureStartPromise = (async () => {
    if (runtimePlatform === 'android') {
      const active = await window.api.startCapture();
      androidCaptureActive = !!active;
      sysAnalyser = androidAnalyser;
      refreshSystemSummary();
      if (state.source === 'system' && state.screen === 'list') renderList();
      return active ? { android: true } : null;
    }
    const stream = await acquireSystemAudio();
    if (!stream) return null;
    try {
      attachSystemAudio(stream);
      return stream;
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }
  })();
  try {
    return await captureStartPromise;
  } catch {
    return null;
  } finally {
    captureStartPromise = null;
    refreshSystemSummary();
    updateVisualizerSource();
  }
}

function stopSystemAudio() {
  if (runtimePlatform === 'android') {
    androidCaptureActive = false;
    void window.api.stopCapture();
    if (state.current?.kind === 'capture') setPlayingUI(false);
    refreshSystemSummary();
    updateVisualizerSource();
    if (state.source === 'system' && state.screen === 'list') renderList();
    return;
  }
  const stream = systemStream;
  if (!stream) return;
  systemStream = null;
  systemSource?.disconnect();
  systemGain?.disconnect();
  systemSource = null;
  systemGain = null;
  stream.getTracks().forEach((track) => track.stop());
  if (state.current?.kind === 'capture') setPlayingUI(false);
  refreshSystemSummary();
  updateVisualizerSource();
  if (state.source === 'system' && state.screen === 'list') renderList();
}

/* ---------- List rendering ---------- */
function renderList() {
  const isLocal = state.source === 'local';
  $('#change-folder').style.display = isLocal ? '' : 'none';
  if (isLocal) {
    systemListSignature = '';
    $('#list-title').textContent = 'Локальная папка';
    $('#list-sub').textContent = state.local.dir ? `${state.local.tracks.length} треков · ${state.local.dir}` : '';
    const fragment = document.createDocumentFragment();
    if (!state.local.tracks.length) {
      fragment.appendChild(emptyMessage('Пусто', 'В этой папке не нашлось аудиофайлов'));
    } else {
      state.local.tracks.forEach((track, index) => fragment.appendChild(trackRow({
        cover: track.hasCover ? window.api.toCoverUrl(track.path) : null,
        title: track.title,
        sub: [track.artist, track.album].filter(Boolean).join(' — '),
        right: track.duration ? fmtTime(track.duration) : '',
        current: state.current?.kind === 'local' && state.current.index === index,
        onClick: () => playLocal(index, true),
        delay: index,
        index,
      })));
    }
    listEl.replaceChildren(fragment);
    return;
  }

  $('#list-title').textContent = 'Другие приложения';
  $('#list-sub').textContent = 'Поиск идёт постоянно — список обновляется сам';
  const signature = JSON.stringify({
    capture: captureActive(),
    captureSilence,
    sessionAccess: !!window.api.needsSessionAccess?.(),
    sessions: state.sessions.map((item) => [item.id, item.title, item.artist, item.status, item.thumb?.length || 0]),
  });
  if (signature === systemListSignature) {
    listEl.querySelectorAll('.track').forEach((row) => {
      const current = row.classList.contains('capture-row')
        ? state.current?.kind === 'capture'
        : state.current?.kind === 'system' && state.current.id === row.dataset.sessionId;
      row.classList.toggle('current', current);
    });
    return;
  }
  systemListSignature = signature;
  const fragment = document.createDocumentFragment();
  const captureSilent = runtimePlatform === 'android' && captureActive() && captureSilence;
  fragment.appendChild(trackRow({
    title: platformText('Весь звук телефона', 'Весь звук компьютера'),
    sub: captureSilent
      ? 'Звук не поступает: ничего не играет или приложение запрещает захват'
      : platformText('Любой звук, который играет на телефоне', 'Любой звук, который играет на ПК'),
    badge: !captureActive() ? 'Недоступно' : captureSilent ? 'Тишина' : 'Слушаю',
    playing: captureActive(),
    current: state.current?.kind === 'capture',
    capture: true,
    onClick: selectCapture,
    delay: 0,
  }));
  if (runtimePlatform === 'android') {
    fragment.appendChild(trackRow({
      title: 'Диагностика захвата',
      sub: 'Журнал для отправки разработчику',
      onClick: openCaptureDiagnostics,
      delay: 1,
    }));
  }
  if (window.api.needsSessionAccess?.()) {
    fragment.appendChild(trackRow({
      title: 'Доступ к плеерам',
      sub: 'Нажмите, чтобы разрешить',
      onClick: () => window.api.requestSessionAccess(),
      delay: runtimePlatform === 'android' ? 2 : 1,
    }));
  }
  if (!state.sessions.length) {
    fragment.appendChild(emptyMessage('Пока ничего не играет', 'Включите музыку в любом приложении — Spotify, браузере, Яндекс Музыке… Трек появится здесь автоматически.'));
  } else {
    state.sessions.forEach((item, index) => fragment.appendChild(trackRow({
      cover: item.thumb,
      title: item.title || 'Без названия',
      sub: [item.artist, sessionAppName(item)].filter(Boolean).join(' · '),
      badge: item.status === 'Playing' ? 'Играет' : item.status === 'Paused' ? 'Пауза' : 'Стоп',
      playing: item.status === 'Playing',
      current: state.current?.kind === 'system' && state.current.id === item.id,
      onClick: () => selectSystem(item.id),
      delay: index + (runtimePlatform === 'android' ? 2 : 1),
      sessionId: item.id,
    })));
  }
  listEl.replaceChildren(fragment);
}

function emptyMessage(title, text) {
  const message = document.createElement('div');
  message.className = 'empty';
  const heading = document.createElement('b');
  heading.textContent = title;
  message.append(heading, document.createTextNode(text));
  return message;
}

function trackRow({ cover, title, sub, right, badge, playing, current, onClick, delay, index, capture, sessionId }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `track${current ? ' current' : ''}${capture ? ' capture-row' : ''}`;
  if (index !== undefined) button.dataset.index = String(index);
  if (sessionId !== undefined) button.dataset.sessionId = sessionId;
  if (delay < 15) button.style.animationDelay = `${delay * 40}ms`;
  else button.style.animation = 'none';

  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  if (cover) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = cover;
    thumb.appendChild(image);
  } else {
    thumb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 18V6l12-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  }

  const text = document.createElement('span');
  text.className = 't-text';
  const heading = document.createElement('span');
  heading.className = 't-title';
  heading.textContent = title || '';
  const detail = document.createElement('span');
  detail.className = 't-sub';
  detail.textContent = sub || '';
  text.append(heading, detail);

  const rightSide = document.createElement('span');
  rightSide.className = 't-right';
  if (badge) {
    const label = document.createElement('span');
    label.className = `badge${playing ? ' playing' : ''}`;
    label.textContent = badge;
    rightSide.appendChild(label);
  }
  if (right) {
    const duration = document.createElement('span');
    duration.className = 'duration';
    duration.textContent = right;
    rightSide.appendChild(duration);
  }
  button.append(thumb, text, rightSide);
  button.addEventListener('click', onClick);
  return button;
}

/* ---------- Now playing ---------- */
function setMiniCover(src) {
  const image = $('#mini-cover');
  const fallback = $('#mini-cover-fallback');
  if (!src || src === failedMiniCover) {
    image.removeAttribute('src');
    image.classList.add('hidden');
    fallback.classList.remove('hidden');
    return;
  }
  if (image.getAttribute('src') !== src) {
    image.src = src;
    failedMiniCover = null;
  }
  image.classList.remove('hidden');
  fallback.classList.add('hidden');
}

function setCover(src) {
  const image = $('#cover');
  const fallback = $('#cover-fallback');
  currentCover = src && src !== failedCover ? src : null;
  if (currentCover) {
    image.src = currentCover;
    image.classList.remove('hidden');
    fallback.classList.add('hidden');
    bgCover.style.backgroundImage = `url("${currentCover.replace(/["\\\n\r]/g, '\\$&')}")`;
    bgCover.classList.add('on');
    Viz.paletteFromImage(currentCover).then((colors) => (colors ? Viz.setPalette(colors) : Viz.resetPalette()));
  } else {
    image.removeAttribute('src');
    image.classList.add('hidden');
    fallback.classList.remove('hidden');
    bgCover.style.backgroundImage = '';
    bgCover.classList.remove('on');
    Viz.resetPalette();
  }
}

$('#cover').addEventListener('error', () => {
  const image = $('#cover');
  const src = image.getAttribute('src');
  if (!src || src !== currentCover) return;
  failedCover = src;
  currentCover = null;
  image.classList.add('hidden');
  $('#cover-fallback').classList.remove('hidden');
  bgCover.style.backgroundImage = '';
  bgCover.classList.remove('on');
  Viz.resetPalette();
  setMiniCover(null);
});

$('#mini-cover').addEventListener('error', () => {
  const image = $('#mini-cover');
  const src = image.getAttribute('src');
  if (!src || src !== currentCover) return;
  failedMiniCover = src;
  image.classList.add('hidden');
  $('#mini-cover-fallback').classList.remove('hidden');
});

function setMeta({ title, artist, source }) {
  $('#np-title').textContent = title || 'Без названия';
  $('#np-artist').textContent = artist || '';
  $('#np-source').textContent = source || '';
  $('#mini-title').textContent = title || 'Без названия';
  $('#mini-artist').textContent = artist || '';
  setMiniCover(currentCover);
}

function configurePlayerControls() {
  const capture = state.current?.kind === 'capture';
  $('.seek').hidden = capture;
  $('#seek').disabled = state.current?.kind !== 'local';
  $('#btn-prev').disabled = capture;
  $('#btn-next').disabled = capture;
}

function openPlayer(track, withTransition) {
  const parts = [$('.cover-wrap'), $('.np-meta'), $('.controls-card')];
  parts.forEach((part) => part.classList.remove('in'));
  setCover(track.cover);
  setMeta(track);
  configurePlayerControls();
  const reveal = () => { void parts[0].offsetWidth; parts.forEach((part) => part.classList.add('in')); };
  if (withTransition) {
    listEl.classList.add('dissolve');
    Viz.burst();
    setTimeout(() => { showScreen('player'); listEl.classList.remove('dissolve'); }, 520);
    setTimeout(reveal, 700);
  } else {
    showScreen('player');
    requestAnimationFrame(reveal);
  }
}

function setPlayingUI(playing) {
  $('#btn-play').classList.toggle('playing', playing);
  $('#mini-play').classList.toggle('playing', playing);
}

function setSeek(position, duration) {
  const range = $('#seek');
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  if (!range.matches(':active')) range.value = Math.round(progress * 1000);
  range.style.backgroundSize = `${progress * 100}% 100%`;
  $('#t-cur').textContent = fmtTime(position);
  $('#t-dur').textContent = fmtTime(duration);
}

function updateMini() {
  const visible = !!state.current && state.screen !== 'player';
  $('#mini').classList.toggle('on', visible);
  document.body.classList.toggle('has-mini', visible);
}

/* ---------- Local source ---------- */
function localFolderName() {
  return state.local.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
}

function updateLocalSummary() {
  const count = state.local.tracks.length;
  $('#local-sub').textContent = state.local.dir
    ? `${localFolderName()} · ${count} ${plural(count, 'трек', 'трека', 'треков')}`
    : platformText('Выбрать папку с музыкой на телефоне', 'Выбрать папку с музыкой на компьютере');
  if (state.source === 'local') $('#list-sub').textContent = `${count} треков · ${state.local.dir}`;
}

async function chooseFolder() {
  const result = await window.api.pickFolder();
  if (!result) return;
  state.local = result;
  state.source = 'local';
  updateLocalSummary();
  renderList();
  showScreen('list');
}

function localCover(track) {
  return track.hasCover ? window.api.toCoverUrl(track.path) : null;
}

function playLocal(index, withTransition) {
  const track = state.local.tracks[index];
  if (!track) return;
  ensureCtx();
  state.current = { kind: 'local', index };
  audio.src = window.api.toMediaUrl(track.path);
  audio.play().catch(() => {});
  openPlayer({
    cover: localCover(track),
    title: track.title,
    artist: [track.artist, track.album].filter(Boolean).join(' — '),
    source: 'Локальная папка',
  }, withTransition);
  updateVisualizerSource();
  listEl.querySelectorAll('.track[data-index]').forEach((element) => {
    element.classList.toggle('current', Number(element.dataset.index) === index);
  });
}

function applyTrackMetadata({ gen, updates }) {
  if (gen !== state.local.gen) return;
  for (const update of updates) {
    const track = state.local.tracks[update.index];
    if (!track) continue;
    Object.assign(track, update);
    const row = listEl.querySelector(`.track[data-index="${update.index}"]`);
    if (row) {
      row.querySelector('.t-title').textContent = track.title;
      row.querySelector('.t-sub').textContent = [track.artist, track.album].filter(Boolean).join(' — ');
      const duration = row.querySelector('.duration');
      if (duration) duration.textContent = track.duration ? fmtTime(track.duration) : '';
      else if (track.duration) {
        const label = document.createElement('span');
        label.className = 'duration';
        label.textContent = fmtTime(track.duration);
        row.querySelector('.t-right').appendChild(label);
      }
      if (track.hasCover && !row.querySelector('.thumb img')) {
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.src = localCover(track);
        row.querySelector('.thumb').replaceChildren(image);
      }
    }
    if (state.current?.kind === 'local' && state.current.index === update.index) {
      const cover = localCover(track);
      if (cover && cover !== currentCover) setCover(cover);
      setMeta({
        title: track.title,
        artist: [track.artist, track.album].filter(Boolean).join(' — '),
        source: 'Локальная папка',
      });
    }
  }
  updateLocalSummary();
}

const localDuration = () => (
  Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : (state.local.tracks[state.current?.index]?.duration || 0)
);
audio.addEventListener('timeupdate', () => {
  if (state.current?.kind === 'local') setSeek(audio.currentTime, localDuration());
});
audio.addEventListener('play', () => {
  if (state.current?.kind === 'local') setPlayingUI(true);
  updateVisualizerSource();
});
audio.addEventListener('pause', () => {
  if (state.current?.kind === 'local') setPlayingUI(false);
  updateVisualizerSource();
});
audio.addEventListener('ended', () => step(1));

/* ---------- System source ---------- */
function sessionById(id) { return state.sessions.find((item) => item.id === id); }

async function selectCapture() {
  audio.pause();
  state.current = { kind: 'capture' };
  openPlayer({ cover: null, title: platformText('Весь звук телефона', 'Весь звук компьютера'), artist: '', source: 'Системный звук' }, true);
  const stream = await startSystemAudio();
  setPlayingUI(!!stream);
  updateVisualizerSource();
}

async function selectSystem(id) {
  const item = sessionById(id);
  if (!item) return;
  audio.pause();
  state.current = { kind: 'system', id };
  state.sys = { position: item.position, duration: item.duration, status: item.status, at: performance.now() };
  openPlayer({ cover: item.thumb, title: item.title, artist: item.artist, source: sessionAppName(item) }, true);
  setPlayingUI(item.status === 'Playing');
  setSeek(item.position, item.duration);
  updateVisualizerSource();
}

function applySessions(sessions) {
  state.sessions = sessions;
  refreshSystemSummary();
  if (state.source === 'system' && state.screen === 'list') renderList();
  if (state.current?.kind === 'system') {
    const item = sessionById(state.current.id);
    if (!item) {
      setMeta({ title: 'Воспроизведение завершено', artist: '', source: sessionAppName(null, state.current.id) });
      setPlayingUI(false);
      updateVisualizerSource();
      return;
    }
    const previousTitle = $('#np-title').textContent;
    if (item.title !== previousTitle || (item.thumb && item.thumb !== currentCover)) setCover(item.thumb);
    setMeta({ title: item.title, artist: item.artist, source: sessionAppName(item) });
    const estimate = state.sys.status === 'Playing'
      ? state.sys.position + (performance.now() - state.sys.at) / 1000
      : state.sys.position;
    const reanchor = item.status !== state.sys.status
      || item.title !== previousTitle
      || Math.abs(item.position - estimate) > 2
      || item.duration !== state.sys.duration;
    if (reanchor) state.sys = { position: item.position, duration: item.duration, status: item.status, at: performance.now() };
    setPlayingUI(item.status === 'Playing');
  }
  updateVisualizerSource();
}

setInterval(() => {
  if (state.screen !== 'player' && !$('#mini').classList.contains('on')) return;
  if (state.current?.kind === 'local') {
    setSeek(audio.currentTime, localDuration());
    return;
  }
  if (state.current?.kind !== 'system') return;
  const { position, duration, status, at } = state.sys;
  const estimate = status === 'Playing' ? position + (performance.now() - at) / 1000 : position;
  setSeek(Math.min(estimate, duration || estimate), duration);
}, 250);

/* ---------- Controls ---------- */
function togglePlay() {
  if (!state.current) return;
  if (state.current.kind === 'local') {
    ensureCtx();
    audio.paused ? audio.play() : audio.pause();
  } else if (state.current.kind === 'capture') {
    if (captureActive()) stopSystemAudio();
    else {
      startSystemAudio().then((stream) => {
        setPlayingUI(!!stream);
        updateVisualizerSource();
      });
    }
  } else {
    window.api.systemControl(state.current.id, 'toggle');
  }
}

function step(direction) {
  if (!state.current || state.current.kind === 'capture') return;
  if (state.current.kind === 'local') {
    const count = state.local.tracks.length;
    if (count) playLocal((state.current.index + direction + count) % count, false);
  } else {
    window.api.systemControl(state.current.id, direction > 0 ? 'next' : 'prev');
  }
}

$('#btn-play').addEventListener('click', togglePlay);
$('#mini-play').addEventListener('click', (event) => { event.stopPropagation(); togglePlay(); });
$('#btn-prev').addEventListener('click', () => step(-1));
$('#btn-next').addEventListener('click', () => step(1));
$('#seek').addEventListener('input', (event) => {
  if (state.current?.kind === 'local' && localDuration()) audio.currentTime = (event.target.value / 1000) * localDuration();
});
$('#mini').addEventListener('click', () => openPlayer(currentTrackInfo(), false));
$('#change-folder').addEventListener('click', chooseFolder);
document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => showScreen(button.dataset.go)));
document.querySelectorAll('.source').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.source === 'local') {
    if (state.local.tracks.length) {
      state.source = 'local';
      renderList();
      showScreen('list');
    } else chooseFolder();
  } else {
    state.source = 'system';
    systemListSignature = '';
    renderList();
    showScreen('list');
    if (runtimePlatform === 'darwin') void startSystemAudio();
  }
}));

function currentTrackInfo() {
  if (state.current?.kind === 'capture') {
    return { cover: null, title: platformText('Весь звук телефона', 'Весь звук компьютера'), artist: '', source: 'Системный звук' };
  }
  if (state.current?.kind === 'local') {
    const track = state.local.tracks[state.current.index];
    return {
      cover: localCover(track),
      title: track.title,
      artist: [track.artist, track.album].filter(Boolean).join(' — '),
      source: 'Локальная папка',
    };
  }
  const item = sessionById(state.current.id) || {};
  return { cover: item.thumb, title: item.title || $('#np-title').textContent, artist: item.artist || '', source: sessionAppName(item, state.current.id) };
}

async function refreshCaptureDiagnostics() {
  const overlay = $('#capture-diagnostics');
  if (runtimePlatform !== 'android' || overlay.hidden) return;
  const lines = await window.api.getDiagnostics?.() || [];
  if (overlay.hidden) return;
  const log = $('#capture-diagnostics-log');
  log.textContent = Array.isArray(lines) ? lines.join('\n') : '';
  log.scrollTop = log.scrollHeight;
}

function openCaptureDiagnostics() {
  if (runtimePlatform !== 'android') return;
  const overlay = $('#capture-diagnostics');
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  void refreshCaptureDiagnostics();
  if (diagnosticsRefreshTimer === null) {
    diagnosticsRefreshTimer = setInterval(() => { void refreshCaptureDiagnostics(); }, 1000);
  }
}

function closeCaptureDiagnostics() {
  if (runtimePlatform !== 'android') return;
  const overlay = $('#capture-diagnostics');
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  if (diagnosticsRefreshTimer !== null) {
    clearInterval(diagnosticsRefreshTimer);
    diagnosticsRefreshTimer = null;
  }
  if (diagnosticsCopyTimer !== null) {
    clearTimeout(diagnosticsCopyTimer);
    diagnosticsCopyTimer = null;
  }
  $('#capture-diagnostics-copy-status').textContent = '';
}

function showDiagnosticsCopied() {
  const status = $('#capture-diagnostics-copy-status');
  status.textContent = 'Скопировано';
  if (diagnosticsCopyTimer !== null) clearTimeout(diagnosticsCopyTimer);
  diagnosticsCopyTimer = setTimeout(() => {
    status.textContent = '';
    diagnosticsCopyTimer = null;
  }, 1500);
}

async function copyCaptureDiagnostics() {
  const text = $('#capture-diagnostics-log').textContent;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
  } catch {
    let copied = false;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    try {
      textarea.select();
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    } finally {
      textarea.remove();
    }
    if (!copied) return;
  }
  showDiagnosticsCopied();
}

/* ---------- Init ---------- */
window.api.onSystemSessions(applySessions);
window.api.onTracksMeta(applyTrackMetadata);
window.api.onCaptureFrame?.(({ frequency }) => {
  if (!frequency) return;
  const decoded = atob(frequency);
  const length = Math.min(decoded.length, androidFrequency.length);
  for (let i = 0; i < length; i++) androidFrequency[i] = decoded.charCodeAt(i);
  androidFrequency.fill(0, length);
});
window.api.onCaptureState?.(({ active }) => {
  androidCaptureActive = !!active;
  updateCaptureSilenceState();
  if (!active && state.current?.kind === 'capture') setPlayingUI(false);
  refreshSystemSummary();
  updateVisualizerSource();
  if (state.source === 'system' && state.screen === 'list') renderList();
});
window.api.onCaptureStats?.((stats) => {
  if (runtimePlatform !== 'android') return;
  latestCaptureStats = stats || null;
  updateCaptureSilenceState();
});
window.api.onSessionAccess?.(() => {
  if (state.source === 'system' && state.screen === 'list') {
    systemListSignature = '';
    renderList();
  }
});
window.api.onBackButton?.(() => {
  if (runtimePlatform === 'android' && !$('#capture-diagnostics').hidden) {
    closeCaptureDiagnostics();
    return;
  }
  if (state.screen === 'player') showScreen('list');
  else if (state.screen === 'list') showScreen('home');
  else void window.api.minimizeApp?.();
});
$('#capture-diagnostics-close').addEventListener('click', closeCaptureDiagnostics);
$('#capture-diagnostics-copy').addEventListener('click', () => { void copyCaptureDiagnostics(); });

(async () => {
  const { name, platform } = await window.api.getUser();
  runtimePlatform = platform;
  $('#local-sub').textContent = platformText('Выбрать папку с музыкой на телефоне', 'Выбрать папку с музыкой на компьютере');
  $('#greet').textContent = `${greeting()}, ${cap(name) || 'друг'}`;
  $('#greet-date').textContent = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  refreshSystemSummary();
  if (platform === 'win32' || platform === 'linux') void startSystemAudio();
})();
