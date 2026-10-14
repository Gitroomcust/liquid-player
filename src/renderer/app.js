const $ = (s) => document.querySelector(s);
const screens = { home: $('#screen-home'), list: $('#screen-list'), player: $('#screen-player') };
const audio = $('#audio');
const listEl = $('#track-list');
const bgCover = $('#bg-cover');

const state = {
  platform: '',
  source: null,                 // 'local' | 'system'
  local: { dir: '', tracks: [] },
  sessions: [],
  current: null,                // { kind: 'local', index } | { kind: 'system', id }
  sys: { position: 0, duration: 0, status: 'Stopped', at: 0 },
  screen: 'home',
};

let actx = null, localAnalyser = null, sysAnalyser = null, loopback = null;

const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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

function showScreen(name) {
  state.screen = name;
  for (const k in screens) screens[k].classList.toggle('active', k === name);
  updateMini();
}

/* ---------- Audio graph ---------- */
function ensureCtx() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    localAnalyser = actx.createAnalyser();
    localAnalyser.fftSize = 512; localAnalyser.smoothingTimeConstant = 0.82;
    const src = actx.createMediaElementSource(audio);
    src.connect(localAnalyser); localAnalyser.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
}

async function startLoopback() {
  if (sysAnalyser) return true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!stream.getAudioTracks().length) throw new Error('no audio');
    ensureCtx();
    const src = actx.createMediaStreamSource(stream);
    sysAnalyser = actx.createAnalyser();
    sysAnalyser.fftSize = 512; sysAnalyser.smoothingTimeConstant = 0.82;
    src.connect(sysAnalyser);
    loopback = stream;
    return true;
  } catch { return false; }
}

/* ---------- List rendering ---------- */
function renderList() {
  listEl.innerHTML = '';
  const isLocal = state.source === 'local';
  $('#change-folder').style.display = isLocal ? '' : 'none';
  if (isLocal) {
    $('#list-title').textContent = 'Локальная папка';
    $('#list-sub').textContent = state.local.dir ? `${state.local.tracks.length} треков · ${state.local.dir}` : '';
    if (!state.local.tracks.length) { listEl.innerHTML = `<div class="empty"><b>Пусто</b>В этой папке не нашлось аудиофайлов</div>`; return; }
    state.local.tracks.forEach((t, i) => listEl.appendChild(trackRow({
      cover: t.cover, title: t.title, sub: [t.artist, t.album].filter(Boolean).join(' — '), right: t.duration ? fmtTime(t.duration) : '',
      current: state.current?.kind === 'local' && state.current.index === i, onClick: () => playLocal(i, true), delay: i,
    })));
  } else {
    $('#list-title').textContent = 'Другие приложения';
    $('#list-sub').textContent = 'Поиск идёт постоянно — список обновляется сам';
    if (!state.sessions.length) {
      listEl.innerHTML = `<div class="empty"><b>Пока ничего не играет</b>Включите музыку в любом приложении — Spotify, браузере, Яндекс Музыке… Трек появится здесь автоматически.</div>`;
      return;
    }
    state.sessions.forEach((s, i) => listEl.appendChild(trackRow({
      cover: s.thumb, title: s.title || 'Без названия', sub: [s.artist, appName(s.id)].filter(Boolean).join(' · '),
      badge: s.status === 'Playing' ? 'Играет' : s.status === 'Paused' ? 'Пауза' : 'Стоп', playing: s.status === 'Playing',
      current: state.current?.kind === 'system' && state.current.id === s.id, onClick: () => selectSystem(s.id), delay: i,
    })));
  }
}

function trackRow({ cover, title, sub, right, badge, playing, current, onClick, delay }) {
  const b = document.createElement('button');
  b.className = 'track' + (current ? ' current' : '');
  b.style.animationDelay = `${Math.min(delay, 12) * 40}ms`;
  b.innerHTML = `
    <span class="thumb">${cover ? `<img src="${cover}" alt="">` : `<svg viewBox="0 0 24 24"><path d="M9 18V6l12-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`}</span>
    <span class="t-text"><span class="t-title">${esc(title)}</span><span class="t-sub">${esc(sub)}</span></span>
    <span class="t-right">${badge ? `<span class="badge${playing ? ' playing' : ''}">${badge}</span>` : ''}${right ? `<span>${right}</span>` : ''}</span>`;
  b.addEventListener('click', onClick);
  return b;
}

/* ---------- Now playing ---------- */
function setCover(src) {
  const img = $('#cover'), fb = $('#cover-fallback');
  if (src) {
    img.src = src; img.classList.remove('hidden'); fb.classList.add('hidden');
    bgCover.style.backgroundImage = `url("${src}")`; bgCover.classList.add('on');
    Viz.paletteFromImage(src).then((p) => (p ? Viz.setPalette(p) : Viz.resetPalette()));
  } else {
    img.removeAttribute('src'); img.classList.add('hidden'); fb.classList.remove('hidden');
    bgCover.classList.remove('on');
    Viz.resetPalette();
  }
}

function setMeta({ title, artist, source }) {
  $('#np-title').textContent = title || 'Без названия';
  $('#np-artist').textContent = artist || '';
  $('#np-source').textContent = source || '';
  $('#mini-title').textContent = title || 'Без названия';
  $('#mini-artist').textContent = artist || '';
  const mc = $('#mini-cover'), c = $('#cover');
  if (c.getAttribute('src')) mc.src = c.src; else mc.removeAttribute('src');
}

function openPlayer(track, withTransition) {
  const parts = [$('.cover-wrap'), $('.np-meta'), $('.controls-card')];
  parts.forEach((p) => p.classList.remove('in'));
  setCover(track.cover);
  setMeta(track);
  Viz.setActive(true);
  const reveal = () => { void parts[0].offsetWidth; parts.forEach((p) => p.classList.add('in')); };
  if (withTransition) {
    listEl.classList.add('dissolve');
    Viz.burst();
    setTimeout(() => { showScreen('player'); listEl.classList.remove('dissolve'); }, 520);
    setTimeout(reveal, 700);
  } else { showScreen('player'); requestAnimationFrame(reveal); }
}

function setPlayingUI(playing) {
  $('#btn-play').classList.toggle('playing', playing);
  $('#mini-play').classList.toggle('playing', playing);
}

function setSeek(pos, dur) {
  const r = $('#seek');
  const p = dur > 0 ? Math.min(1, pos / dur) : 0;
  if (!r.matches(':active')) r.value = Math.round(p * 1000);
  r.style.backgroundSize = `${p * 100}% 100%`;
  $('#t-cur').textContent = fmtTime(pos); $('#t-dur').textContent = fmtTime(dur);
}

function updateMini() {
  const on = !!state.current && state.screen !== 'player';
  $('#mini').classList.toggle('on', on);
  document.body.classList.toggle('has-mini', on);
}

/* ---------- Local source ---------- */
async function chooseFolder() {
  const res = await window.api.pickFolder();
  if (!res) return;
  state.local = res; state.source = 'local';
  renderList(); showScreen('list');
}

function playLocal(i, withTransition) {
  const t = state.local.tracks[i];
  if (!t) return;
  ensureCtx();
  state.current = { kind: 'local', index: i };
  audio.src = window.api.toMediaUrl(t.path);
  audio.play().catch(() => {});
  Viz.setAnalyser(localAnalyser); Viz.setSynth(false);
  $('#seek').disabled = false;
  openPlayer({ cover: t.cover, title: t.title, artist: [t.artist, t.album].filter(Boolean).join(' — '), source: 'Локальная папка' }, withTransition);
  listEl.querySelectorAll('.track').forEach((el, k) => el.classList.toggle('current', k === i));
}

const localDuration = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (state.local.tracks[state.current?.index]?.duration || 0));
audio.addEventListener('timeupdate', () => { if (state.current?.kind === 'local') setSeek(audio.currentTime, localDuration()); });
audio.addEventListener('play', () => { if (state.current?.kind === 'local') setPlayingUI(true); });
audio.addEventListener('pause', () => { if (state.current?.kind === 'local') setPlayingUI(false); });
audio.addEventListener('ended', () => step(1));

/* ---------- System source ---------- */
function sessionById(id) { return state.sessions.find((s) => s.id === id); }

async function selectSystem(id) {
  const s = sessionById(id);
  if (!s) return;
  audio.pause();
  state.current = { kind: 'system', id };
  state.sys = { position: s.position, duration: s.duration, status: s.status, at: performance.now() };
  $('#seek').disabled = true;
  openPlayer({ cover: s.thumb, title: s.title, artist: s.artist, source: appName(s.id) }, true);
  setPlayingUI(s.status === 'Playing');
  setSeek(s.position, s.duration);
  const ok = await startLoopback();
  if (state.current?.kind !== 'system') return;
  if (ok) { Viz.setAnalyser(sysAnalyser); Viz.setSynth(false); }
  else { Viz.setAnalyser(null); Viz.setSynth(s.status === 'Playing'); }
}

function applySessions(sessions) {
  state.sessions = sessions;
  const playing = sessions.filter((s) => s.status === 'Playing').length;
  $('#sys-sub').textContent = sessions.length
    ? `${sessions.length} ${plural(sessions.length, 'трек', 'трека', 'треков')}, играет: ${playing}`
    : 'Ищем активные треки…';
  if (state.source === 'system' && state.screen === 'list') renderList();
  if (state.current?.kind === 'system') {
    const s = sessionById(state.current.id);
    if (!s) { setMeta({ title: 'Воспроизведение завершено', artist: '', source: appName(state.current.id) }); setPlayingUI(false); Viz.setSynth(false); return; }
    const prevTitle = $('#np-title').textContent;
    if (s.title !== prevTitle) { setCover(s.thumb); }
    else if (s.thumb && $('#cover').src !== s.thumb) setCover(s.thumb);
    setMeta({ title: s.title, artist: s.artist, source: appName(s.id) });
    const est = state.sys.status === 'Playing' ? state.sys.position + (performance.now() - state.sys.at) / 1000 : state.sys.position;
    const reanchor = s.status !== state.sys.status || s.title !== prevTitle || Math.abs(s.position - est) > 2.5 || s.duration !== state.sys.duration;
    if (reanchor) state.sys = { position: s.position, duration: s.duration, status: s.status, at: performance.now() };
    setPlayingUI(s.status === 'Playing');
    if (!sysAnalyser) Viz.setSynth(s.status === 'Playing');
  }
}
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };

setInterval(() => {
  if (state.current?.kind !== 'system') return;
  const { position, duration, status, at } = state.sys;
  const pos = status === 'Playing' ? position + (performance.now() - at) / 1000 : position;
  setSeek(Math.min(pos, duration || pos), duration);
}, 250);

/* ---------- Controls ---------- */
function togglePlay() {
  if (!state.current) return;
  if (state.current.kind === 'local') { ensureCtx(); audio.paused ? audio.play() : audio.pause(); }
  else window.api.systemControl(state.current.id, 'toggle');
}
function step(dir) {
  if (!state.current) return;
  if (state.current.kind === 'local') {
    const n = state.local.tracks.length;
    if (n) playLocal((state.current.index + dir + n) % n, false);
  } else window.api.systemControl(state.current.id, dir > 0 ? 'next' : 'prev');
}
$('#btn-play').addEventListener('click', togglePlay);
$('#mini-play').addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
$('#btn-prev').addEventListener('click', () => step(-1));
$('#btn-next').addEventListener('click', () => step(1));
$('#seek').addEventListener('input', (e) => { if (state.current?.kind === 'local' && localDuration()) audio.currentTime = (e.target.value / 1000) * localDuration(); });
$('#mini').addEventListener('click', () => openPlayer(currentTrackInfo(), false));
$('#change-folder').addEventListener('click', chooseFolder);
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.go)));
document.querySelectorAll('.source').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.source === 'local') { if (state.local.tracks.length) { state.source = 'local'; renderList(); showScreen('list'); } else chooseFolder(); }
  else { state.source = 'system'; renderList(); showScreen('list'); }
}));

function currentTrackInfo() {
  if (state.current?.kind === 'local') { const t = state.local.tracks[state.current.index]; return { cover: t.cover, title: t.title, artist: [t.artist, t.album].filter(Boolean).join(' — '), source: 'Локальная папка' }; }
  const s = sessionById(state.current.id) || {};
  return { cover: s.thumb, title: s.title || $('#np-title').textContent, artist: s.artist || '', source: appName(state.current.id) };
}

/* ---------- Init ---------- */
(async () => {
  const { name, platform } = await window.api.getUser();
  state.platform = platform;
  $('#greet').textContent = `${greeting()}, ${cap(name) || 'друг'}`;
  $('#greet-date').textContent = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  window.api.onSystemSessions(applySessions);
})();
