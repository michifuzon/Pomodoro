// UI + Socket layer — imports the 3D engine from game.js
import * as THREE from 'three';
import { startGame, addOtherPlayer, removeOtherPlayer, moveOtherPlayer, buildBoxChar } from './game.js';

// ==================== STATE ====================
const S = {
  socket: null,
  roomId: null,
  mode: null,
  user: {
    name: '',
    character: { skin: '#FDBCB4', hairColor: '#1C0A00', hairStyle: 'short', outfit: '#5C6BC0', accessory: 'none' },
    status: 'idle'
  },
  timerCfg: { study: 25, break: 5 },
  timer: { running: false, isStudy: true, left: 25 * 60, interval: null, sessions: 0 },
  chatOpen: false,
  musicOpen: false,
  currentTrack: 0,
  knownUsers: new Map()
};

const TRACKS = [
  { name: '☕ Lofi Chill', id: 'jfKfPfyJRdk' },
  { name: '🎷 Jazz Café', id: 'Dx5qFachd3A' },
  { name: '🌧️ Rain', id: 'KKZr7tfZoSs' },
  { name: '🎹 Piano Study', id: 'n61ULEU7CO0' }
];

// ==================== INIT ====================
function init() {
  const params = new URLSearchParams(location.search);
  const code = params.get('room');
  if (code) document.getElementById('code-input').value = code.toUpperCase();

  try {
    const saved = JSON.parse(localStorage.getItem('cozy-user') || '{}');
    if (saved.name) S.user.name = saved.name;
    if (saved.character) S.user.character = { ...S.user.character, ...saved.character };
    if (saved.timerCfg) S.timerCfg = saved.timerCfg;
  } catch (_) {}

  _buildCharUI();
  _spawnLandingFX();
  updateTimerDisplay();

  S.socket = io();
  _bindSocket();

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ==================== SOCKET ====================
function _bindSocket() {
  const sock = S.socket;

  sock.on('room-created', ({ roomId }) => {
    S.roomId = roomId;
    _enterScene(roomId);
  });

  sock.on('room-joined', ({ roomId, messages }) => {
    S.roomId = roomId;
    _enterScene(roomId);
    if (messages) messages.forEach(addMsg);
  });

  sock.on('room-error', ({ message }) => toast(message, true));

  sock.on('users-updated', (users) => {
    const newIds = new Set(users.map(u => u.id));

    // Spawn new players
    users.forEach(u => {
      if (u.id !== sock.id && !S.knownUsers.has(u.id)) {
        addOtherPlayer(u);
        S.knownUsers.set(u.id, u);
      }
    });

    // Remove disconnected players
    for (const [id] of S.knownUsers) {
      if (!newIds.has(id)) {
        removeOtherPlayer(id);
        S.knownUsers.delete(id);
      }
    }

    const count = users.length;
    document.getElementById('online-count').textContent = `👥 ${count} en sala`;
  });

  sock.on('player-moved', ({ userId, x, z, ry }) => {
    moveOtherPlayer(userId, x, z, ry);
  });

  sock.on('new-message', (msg) => {
    addMsg(msg);
    if (!S.chatOpen) {
      document.getElementById('notif-dot').classList.remove('hidden');
    }
  });

  sock.on('user-joined', ({ name }) => {
    addSystemMsg(`🚪 ${name} entró a la sala`);
    toast(`${name} se unió`);
  });

  sock.on('user-left', ({ name }) => {
    addSystemMsg(`👋 ${name} salió de la sala`);
  });
}

// ==================== FLOW ====================
function showSetup(mode) {
  if (mode === 'join') {
    const code = document.getElementById('code-input').value.trim();
    if (!code) { toast('Ingresá un código de sala', true); return; }
  }
  S.mode = mode;
  document.getElementById('setup-modal').classList.remove('hidden');
  if (S.user.name) {
    document.getElementById('char-name').value = S.user.name;
    document.getElementById('preview-name').textContent = S.user.name;
  }
  document.getElementById('study-min').value = S.timerCfg.study;
  document.getElementById('break-min').value = S.timerCfg.break;
  _syncSwatches();
  updatePreview();
}
window.showSetup = showSetup;

function closeSetup() {
  _stopPvAnim();
  document.getElementById('setup-modal').classList.add('hidden');
}
window.closeSetup = closeSetup;

async function enterRoom() {
  const name = document.getElementById('char-name').value.trim();
  if (!name) { toast('Ingresá tu nombre', true); return; }

  S.user.name = name;
  S.timerCfg.study = parseInt(document.getElementById('study-min').value) || 25;
  S.timerCfg.break = parseInt(document.getElementById('break-min').value) || 5;
  S.timer.left = S.timerCfg.study * 60;

  localStorage.setItem('cozy-user', JSON.stringify({
    name: S.user.name,
    character: S.user.character,
    timerCfg: S.timerCfg
  }));

  const userData = { name: S.user.name, character: S.user.character, status: 'idle' };

  if (S.mode === 'create') {
    S.socket.emit('create-room', { user: userData });
  } else {
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    S.socket.emit('join-room', { roomId: code, user: userData });
  }
  closeSetup();
}
window.enterRoom = enterRoom;

async function _enterScene(roomId) {
  // Hide landing
  document.getElementById('landing').classList.remove('active');
  document.getElementById('landing').classList.add('hidden');
  // Show game HUD
  document.getElementById('game-hud').classList.remove('hidden');
  document.getElementById('game-hud').classList.add('active');
  // Show canvas
  document.getElementById('game-canvas').style.display = 'block';

  document.getElementById('room-code-show').textContent = roomId;
  history.replaceState({}, '', `?room=${roomId}`);
  updateTimerDisplay();

  // Start Three.js game
  await startGame(S.socket, roomId, S.user);
}

// ==================== CHARACTER BUILDER ====================
function _buildCharUI() {
  document.querySelectorAll('.sw').forEach(el => {
    el.addEventListener('click', () => {
      const { t: type, v: val } = el.dataset;
      document.querySelectorAll(`.sw[data-t="${type}"]`).forEach(s => s.classList.remove('selected'));
      el.classList.add('selected');
      if (type === 'skin') S.user.character.skin = val;
      else if (type === 'hairColor') S.user.character.hairColor = val;
      else if (type === 'outfit') S.user.character.outfit = val;
      updatePreview();
    });
  });

  document.querySelectorAll('.chip').forEach(el => {
    el.addEventListener('click', () => {
      const { t: type, v: val } = el.dataset;
      document.querySelectorAll(`.chip[data-t="${type}"]`).forEach(c => c.classList.remove('selected'));
      el.classList.add('selected');
      if (type === 'hairStyle') S.user.character.hairStyle = val;
      else if (type === 'accessory') S.user.character.accessory = val;
      updatePreview();
    });
  });

  document.getElementById('char-name').addEventListener('input', e => {
    document.getElementById('preview-name').textContent = e.target.value.trim() || 'Tu personaje';
  });

  updatePreview();
}

function _syncSwatches() {
  const c = S.user.character;
  const map = { skin: c.skin, hairColor: c.hairColor, outfit: c.outfit, hairStyle: c.hairStyle, accessory: c.accessory };
  for (const [t, v] of Object.entries(map)) {
    document.querySelectorAll(`[data-t="${t}"]`).forEach(el => el.classList.toggle('selected', el.dataset.v === v));
  }
}

// ==================== 3D CHARACTER PREVIEW ====================
let _pvRenderer = null, _pvScene = null, _pvCamera = null;
let _pvChar = null, _pvAnimId = null;

function _initPvRenderer(canvas) {
  _pvRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  _pvRenderer.setSize(120, 150);
  _pvRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  _pvRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  _pvRenderer.toneMappingExposure = 1.0;

  _pvScene = new THREE.Scene();
  _pvScene.background = new THREE.Color(0x1c1508);

  _pvCamera = new THREE.PerspectiveCamera(40, 120 / 150, 0.1, 20);
  _pvCamera.position.set(0, 1.5, 3.2);
  _pvCamera.lookAt(0, 1.0, 0);

  _pvScene.add(new THREE.AmbientLight(0xfff4e8, 2.5));
  const key = new THREE.DirectionalLight(0xffe8cc, 2.2);
  key.position.set(2, 4, 3); _pvScene.add(key);
  const fill = new THREE.DirectionalLight(0xaaccff, 0.8);
  fill.position.set(-2, 1, -1); _pvScene.add(fill);
}

function _startPvAnim() {
  if (_pvAnimId) return;
  let angle = 0;
  function loop() {
    _pvAnimId = requestAnimationFrame(loop);
    angle += 0.012;
    if (_pvChar) _pvChar.rotation.y = angle;
    _pvRenderer.render(_pvScene, _pvCamera);
  }
  loop();
}

function _stopPvAnim() {
  if (_pvAnimId) { cancelAnimationFrame(_pvAnimId); _pvAnimId = null; }
}

// 2D CSS sprite — used only in chat messages
function buildCharSprite(char) {
  const { skin, hairColor, hairStyle, outfit, accessory } = char;
  const accMap = {
    glasses: '<div class="acc-glasses"></div>',
    hat: `<div class="acc-hat" style="background:${hairColor}"></div>`,
    headphones: '<div class="acc-hp"></div>',
    none: ''
  };
  // Slightly darker skin tone for nose/ear shading
  const shadeSkin = `color-mix(in srgb, ${skin} 78%, #3a1a1a)`;
  return `
    <div class="char-sprite">
      <div class="char-hair hair-${hairStyle}" style="background:${hairColor}"></div>
      <div class="char-head" style="background:${skin}">
        <div class="char-face">
          <div class="char-eyes">
            <div class="char-eye"></div>
            <div class="char-eye"></div>
          </div>
          <div class="char-nose"></div>
          <div class="char-mouth"></div>
        </div>
        ${accMap[accessory] || ''}
      </div>
      <div class="char-neck" style="background:${skin}"></div>
      <div class="char-torso-wrap">
        <div class="char-arm char-arm-l" style="background:${skin}"></div>
        <div class="char-body" style="background:${outfit}">
          <div class="char-collar"></div>
        </div>
        <div class="char-arm char-arm-r" style="background:${skin}"></div>
      </div>
      <div class="char-legs">
        <div class="char-leg"></div>
        <div class="char-leg"></div>
      </div>
      <div class="char-feet">
        <div class="char-foot"></div>
        <div class="char-foot"></div>
      </div>
    </div>`;
}

function updatePreview() {
  const canvas = document.getElementById('char-canvas');
  if (!canvas) return;
  if (!_pvRenderer) _initPvRenderer(canvas);
  if (_pvChar) { _pvScene.remove(_pvChar); _pvChar = null; }
  _pvChar = buildBoxChar(S.user.character);
  _pvScene.add(_pvChar);
  _startPvAnim();
}
window.updatePreview = updatePreview;

// ==================== POMODORO TIMER ====================
function updateTimerDisplay() {
  const m = Math.floor(S.timer.left / 60);
  const s = S.timer.left % 60;
  document.getElementById('pom-time').textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function startTimer() {
  if (S.timer.running) return;
  S.timer.running = true;
  S.user.status = S.timer.isStudy ? 'studying' : 'break';
  if (S.socket && S.roomId) S.socket.emit('update-status', { status: S.user.status });

  S.timer.interval = setInterval(() => {
    S.timer.left--;
    updateTimerDisplay();
    if (S.timer.left <= 0) { clearInterval(S.timer.interval); S.timer.running = false; _onTimerEnd(); }
  }, 1000);
}
window.startTimer = startTimer;

function pauseTimer() {
  clearInterval(S.timer.interval);
  S.timer.running = false;
  S.user.status = 'idle';
  if (S.socket && S.roomId) S.socket.emit('update-status', { status: 'idle' });
}
window.pauseTimer = pauseTimer;

function resetTimer() {
  clearInterval(S.timer.interval);
  S.timer.running = false;
  S.timer.isStudy = true;
  S.timer.left = S.timerCfg.study * 60;
  document.getElementById('pom-phase').textContent = '📚 Estudiando';
  updateTimerDisplay();
  if (S.socket && S.roomId) S.socket.emit('update-status', { status: 'idle' });
}
window.resetTimer = resetTimer;

function _onTimerEnd() {
  if (S.timer.isStudy) {
    S.timer.sessions++;
    S.timer.isStudy = false;
    S.timer.left = S.timerCfg.break * 60;
    document.getElementById('pom-phase').textContent = '☕ Descanso';
    toast('🎉 Sesión completada! Hora del descanso');
    _updateDots();
  } else {
    S.timer.isStudy = true;
    S.timer.left = S.timerCfg.study * 60;
    document.getElementById('pom-phase').textContent = '📚 Estudiando';
    toast('⏰ Listo! De vuelta al estudio');
  }
  updateTimerDisplay();
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('CozyStudy ☕', { body: S.timer.isStudy ? '¡Hora de estudiar!' : '¡Tomá un descanso!' });
  }
}

function _updateDots() {
  const dots = document.querySelectorAll('.pom-dot');
  const sess = S.timer.sessions;
  dots.forEach((d, i) => d.classList.toggle('done', i < sess % 4));
  document.getElementById('pom-label').textContent =
    `Ciclo ${Math.floor(sess / 4) + 1} · Sesión ${(sess % 4) || 4}/4`;
}

// ==================== CHAT ====================
function openChat() {
  S.chatOpen = true;
  document.getElementById('chat-side').classList.remove('hidden');
  document.getElementById('chat-fab').style.display = 'none';
  document.getElementById('notif-dot').classList.add('hidden');
  setTimeout(() => document.getElementById('msg-input').focus(), 100);
}
window.openChat = openChat;

function closeChat() {
  S.chatOpen = false;
  document.getElementById('chat-side').classList.add('hidden');
  document.getElementById('chat-fab').style.display = '';
}
window.closeChat = closeChat;

function sendMsg() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !S.socket) return;
  S.socket.emit('send-message', { text });
  input.value = '';
}
window.sendMsg = sendMsg;

function addMsg(msg) {
  const container = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const time = new Date(msg.timestamp).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const char = msg.character || S.user.character;
  div.innerHTML = `
    <div class="msg-avatar">${buildCharSprite(char).replace('class="char-sprite"','class="char-sprite chat-char"')}</div>
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-name">${esc(msg.userName)}</span><span class="msg-time">${time}</span></div>
      <div class="msg-text">${esc(msg.text)}</div>
    </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function addSystemMsg(text) {
  const container = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = 'chat-system';
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ==================== MUSIC ====================
function toggleMusic() {
  S.musicOpen = !S.musicOpen;
  document.getElementById('music-panel').classList.toggle('hidden', !S.musicOpen);
  document.getElementById('music-btn').classList.toggle('active', S.musicOpen);
  if (S.musicOpen && !document.getElementById('yt-frame').src) {
    selectTrack(0, document.querySelector('.track-btn'));
  }
}
window.toggleMusic = toggleMusic;

function selectTrack(i, btn) {
  S.currentTrack = i;
  document.getElementById('yt-frame').src =
    `https://www.youtube.com/embed/${TRACKS[i].id}?autoplay=1&rel=0`;
  document.querySelectorAll('.track-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}
window.selectTrack = selectTrack;

// ==================== ROOM LINK ====================
function copyLink() {
  const url = `${location.origin}?room=${S.roomId}`;
  navigator.clipboard.writeText(url)
    .then(() => toast('🔗 Enlace copiado! Mandáselo a tu amig@'))
    .catch(() => prompt('Copiá este enlace:', url));
}
window.copyLink = copyLink;

// ==================== LANDING FX ====================
function _spawnLandingFX() {
  _makeStars('ls-sky');
  _makeRain('ls-rain');
  _makeParticles('ls-particles');
}

function _makeStars(id) {
  const el = document.getElementById(id);
  if (!el) return;
  for (let i = 0; i < 35; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    s.style.cssText = `left:${Math.random()*100}%;top:${Math.random()*80}%;animation-duration:${1.5+Math.random()*2.5}s;animation-delay:${Math.random()*3}s`;
    el.appendChild(s);
  }
}

function _makeRain(id) {
  const el = document.getElementById(id);
  if (!el) return;
  for (let i = 0; i < 25; i++) {
    const d = document.createElement('div');
    d.className = 'raindrop';
    d.style.cssText = `left:${Math.random()*100}%;top:${Math.random()*100}%;animation-duration:${0.4+Math.random()*0.4}s;animation-delay:${Math.random()*2}s`;
    el.appendChild(d);
  }
}

function _makeParticles(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const emojis = ['✨','📖','⭐','💫','🌟','☕','📝','🎵'];
  for (let i = 0; i < 8; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.textContent = emojis[i % emojis.length];
    p.style.cssText = `left:${5+Math.random()*90}%;bottom:${Math.random()*30}%;animation-duration:${8+Math.random()*12}s;animation-delay:${Math.random()*6}s`;
    el.appendChild(p);
  }
}

// ==================== UTILS ====================
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' toast-err' : ''}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.addEventListener('DOMContentLoaded', init);
