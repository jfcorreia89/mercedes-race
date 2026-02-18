'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const CAR_LABELS = {
  'a-class': 'A-Class',
  'cla':     'CLA',
  'amg-gt':  'AMG GT',
  '300sl':   '300 SL',
  'amg-gtr': 'AMG GT R',
  'c-class': 'C-Class',
};

const VALID_MODELS = Object.keys(CAR_LABELS);
const CLICKS_TO_FINISH = 100;
const CLICK_THROTTLE_MS = 50;

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  socket:        null,
  mySocketId:    null,
  myName:        '',
  myCarModel:    null,
  roomCode:      null,
  isHost:        false,
  players:       {},       // socketId → player object
  phase:         'idle',   // idle | lobby | countdown | racing | finished
  raceStartTime: null,
  clickCount:    0,        // optimistic local count
  lastClickSent: 0,
  nextKey:       'a',      // 'a' | 'b' — which key is expected next
  myFinished:    false,    // true once my car crosses the finish line
  countdownTimer: null,
  raceTimer:     null,     // interval handle for the live race timer
  lastChanceTimer: null,   // interval for the post-winner countdown banner
};

// ─── Screen switching ─────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─── Car SVG helper ───────────────────────────────────────────────────────────
function carSVG(model, color) {
  return `<svg viewBox="0 0 120 50" style="color:${color}; width:100%; height:100%"><use href="#car-${model}"/></svg>`;
}

// ─── Time formatter ───────────────────────────────────────────────────────────
function formatTime(ms) {
  const totalS = ms / 1000;
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

// ─── Medal helper ─────────────────────────────────────────────────────────────
function medalText(rank) {
  if (rank === 1) return '1st';
  if (rank === 2) return '2nd';
  if (rank === 3) return '3rd';
  return rank + 'th';
}

// ─── Sanitize (light client-side guard) ───────────────────────────────────────
function sanitize(str) {
  return String(str || '').trim().slice(0, 20).replace(/[<>&"']/g, '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// LANDING SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function bindLanding() {
  const nameInput  = document.getElementById('input-name');
  const carGrid    = document.getElementById('car-grid');
  const btnCreate  = document.getElementById('btn-create');
  const btnShowJoin = document.getElementById('btn-show-join');
  const joinPanel  = document.getElementById('join-panel');
  const codeInput  = document.getElementById('input-room-code');
  const btnJoin    = document.getElementById('btn-confirm-join');
  const errMsg     = document.getElementById('landing-error');

  function validate() {
    const ok = nameInput.value.trim().length > 0 && state.myCarModel != null;
    btnCreate.disabled   = !ok;
    btnShowJoin.disabled = !ok;
  }

  nameInput.addEventListener('input', () => { state.myName = sanitize(nameInput.value); validate(); });

  carGrid.addEventListener('click', e => {
    const opt = e.target.closest('.car-option');
    if (!opt) return;
    carGrid.querySelectorAll('.car-option').forEach(c => c.classList.remove('selected'));
    opt.classList.add('selected');
    state.myCarModel = opt.dataset.model;
    validate();
  });

  btnCreate.addEventListener('click', () => {
    errMsg.classList.add('hidden');
    state.socket.emit('create-room', { name: state.myName, carModel: state.myCarModel });
  });

  btnShowJoin.addEventListener('click', () => {
    joinPanel.classList.toggle('hidden');
    if (!joinPanel.classList.contains('hidden')) codeInput.focus();
  });

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  btnJoin.addEventListener('click', () => {
    const code = codeInput.value.trim();
    if (code.length !== 6) { showLandingError('Enter the 6-character room code.'); return; }
    errMsg.classList.add('hidden');
    state.socket.emit('join-room', { code, name: state.myName, carModel: state.myCarModel });
  });

  // Auto-fill code from URL (?room=XXXX)
  const urlCode = new URLSearchParams(window.location.search).get('room');
  if (urlCode) {
    codeInput.value = urlCode.toUpperCase();
    joinPanel.classList.remove('hidden');
  }
}

function showLandingError(msg) {
  const el = document.getElementById('landing-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOBBY SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function enterLobby(code, players, hostId) {
  state.roomCode = code;
  state.phase = 'lobby';
  state.players = {};
  players.forEach(p => { state.players[p.socketId] = p; });

  // Set URL so sharing works
  const url = new URL(window.location.href);
  url.searchParams.set('room', code);
  history.replaceState({}, '', url.toString());

  // Room code display
  document.getElementById('lobby-room-code').textContent = code;
  document.getElementById('lobby-share-link').value = window.location.origin + '?room=' + code;

  // Players list
  renderAllLobbyPlayers(players, hostId);

  // Host controls
  const btnStart = document.getElementById('btn-start-race');
  const waiting  = document.getElementById('lobby-waiting');
  if (state.isHost) {
    btnStart.classList.remove('hidden');
    waiting.classList.add('hidden');
    updateStartButton();
  } else {
    btnStart.classList.add('hidden');
    waiting.classList.remove('hidden');
  }

  showScreen('screen-lobby');
}

function renderAllLobbyPlayers(players, hostId) {
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';
  players.forEach(p => list.appendChild(buildPlayerCard(p, hostId)));
  updatePlayerCount();
}

function buildPlayerCard(player, hostId) {
  const isMe = player.socketId === state.mySocketId;
  const isHost = player.socketId === hostId;

  const div = document.createElement('div');
  div.className = 'player-card' + (isMe ? ' is-me' : '');
  div.id = 'lobby-player-' + player.socketId;

  div.innerHTML = `
    <div class="player-car-preview" style="color:${player.carColor}">
      ${carSVG(player.carModel, player.carColor)}
    </div>
    <div class="player-info">
      <div class="player-name">${player.name}${isMe ? ' <span style="color:var(--silver-400);font-weight:400;font-size:11px">(you)</span>' : ''}</div>
      <div class="player-car-label">${CAR_LABELS[player.carModel] || player.carModel}</div>
    </div>
    ${isHost ? '<span class="host-badge">HOST</span>' : ''}
  `;
  return div;
}

function updatePlayerCount() {
  const count = Object.keys(state.players).length;
  document.getElementById('lobby-player-count').textContent = count + ' / 16';
}

function updateStartButton() {
  const btn = document.getElementById('btn-start-race');
  const count = Object.keys(state.players).length;
  btn.disabled = count < 1; // Allow 1 player for testing
}

function bindLobby() {
  document.getElementById('btn-copy-link').addEventListener('click', () => {
    const link = document.getElementById('lobby-share-link').value;
    navigator.clipboard.writeText(link).then(() => {
      const btn = document.getElementById('btn-copy-link');
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy Link'; btn.classList.remove('copied'); }, 2000);
    });
  });

  document.getElementById('btn-start-race').addEventListener('click', () => {
    state.socket.emit('start-race', { roomCode: state.roomCode });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// RACE SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function buildRaceScreen() {
  hideLastChanceBanner();
  const container = document.getElementById('track-container');
  container.innerHTML = '';

  const playerCount = Object.keys(state.players).length;

  // Sort: me first, then others alphabetically
  const sorted = Object.values(state.players).sort((a, b) => {
    if (a.socketId === state.mySocketId) return -1;
    if (b.socketId === state.mySocketId) return 1;
    return a.name.localeCompare(b.name);
  });

  sorted.forEach(player => {
    container.appendChild(buildLane(player, playerCount));
  });

  // Update header
  document.getElementById('race-driver-name').textContent = state.myName.toUpperCase();
  document.getElementById('race-click-count').textContent = '0';
}

function buildLane(player, totalPlayers) {
  const isMe = player.socketId === state.mySocketId;

  const lane = document.createElement('div');
  lane.className = 'lane' + (isMe ? ' is-me' : '');
  lane.id = 'lane-' + player.socketId;

  // Shrink lanes if many players
  if (totalPlayers > 10) {
    lane.style.minHeight = '36px';
  }

  lane.innerHTML = `
    <div class="lane-label">
      <span class="lane-color-dot" style="background:${player.carColor}"></span>
      <span class="lane-label-name" title="${player.name}">${player.name}</span>
    </div>
    <div class="track" id="track-${player.socketId}">
      <div class="track-surface"></div>
      <div class="finish-line"></div>
      <div class="car-wrapper" id="car-${player.socketId}" style="left:0%">
        ${carSVG(player.carModel, player.carColor)}
      </div>
    </div>
    <div class="lane-progress" id="progress-${player.socketId}">0%</div>
  `;
  return lane;
}

function hideLastChanceBanner() {
  clearInterval(state.lastChanceTimer);
  state.lastChanceTimer = null;
  const banner = document.getElementById('last-chance-banner');
  if (banner) banner.classList.add('hidden');
}

function updateCarPosition(socketId, progress) {
  const car = document.getElementById('car-' + socketId);
  if (!car) return;
  // Map 0–100 progress to 0–88% left offset (car reaches finish line at 100)
  const leftPct = (progress / 100) * 88;
  car.style.left = leftPct + '%';

  const pEl = document.getElementById('progress-' + socketId);
  if (pEl) pEl.textContent = Math.round(progress) + '%';
}

function startCountdown(startTime) {
  state.phase = 'countdown';
  state.raceStartTime = startTime;
  buildRaceScreen();
  showScreen('screen-race');

  const overlay = document.getElementById('countdown-overlay');
  const numEl   = document.getElementById('countdown-number');
  overlay.classList.remove('hidden');

  const hintEl = document.getElementById('countdown-hint');

  state.countdownTimer = setInterval(() => {
    const remaining = Math.ceil((startTime - Date.now()) / 1000);
    if (remaining > 0) {
      numEl.textContent = remaining;
      if (hintEl) hintEl.classList.remove('hidden');
      // Re-trigger animation
      numEl.style.animation = 'none';
      void numEl.offsetWidth; // reflow
      numEl.style.animation = '';
    } else {
      clearInterval(state.countdownTimer);
      numEl.textContent = 'GO!';
      if (hintEl) hintEl.classList.add('hidden');
      numEl.style.animation = 'none';
      void numEl.offsetWidth;
      numEl.style.animation = '';
      // Only enable input AFTER the overlay is hidden — prevents pressing during GO!
      setTimeout(() => {
        overlay.classList.add('hidden');
        state.phase = 'racing';
        setActiveKey('a');
        // Start live race timer
        const timerEl = document.getElementById('race-timer');
        if (timerEl) timerEl.textContent = '0:00.0';
        state.raceTimer = setInterval(() => {
          if (timerEl) timerEl.textContent = formatTime(Date.now() - state.raceStartTime);
        }, 100);
      }, 700);
    }
  }, 100);
}

// ─── A/B mechanic helpers ─────────────────────────────────────────────────────
function setActiveKey(key) {
  state.nextKey = key;
  const btnA = document.getElementById('btn-a');
  const btnB = document.getElementById('btn-b');
  if (!btnA || !btnB) return;
  if (key === 'a') {
    btnA.classList.add('btn-ab--active');
    btnB.classList.remove('btn-ab--active');
  } else {
    btnB.classList.add('btn-ab--active');
    btnA.classList.remove('btn-ab--active');
  }
}

function flashPressed(key) {
  const btn = document.getElementById('btn-' + key);
  if (!btn) return;
  btn.classList.add('btn-ab--pressed');
  setTimeout(() => btn.classList.remove('btn-ab--pressed'), 90);
}

function flashWrong(key) {
  const btn = document.getElementById('btn-' + key);
  if (!btn) return;
  btn.classList.add('btn-ab--wrong');
  setTimeout(() => btn.classList.remove('btn-ab--wrong'), 320);
}

function handleKeyPress(key) {
  if (state.phase !== 'racing' || state.myFinished) return;

  const now = Date.now();
  if (now - state.lastClickSent < CLICK_THROTTLE_MS) return;

  if (key !== state.nextKey) {
    flashWrong(key);
    return;
  }

  state.lastClickSent = now;

  // Optimistic update
  state.clickCount++;
  const myProgress = Math.min(CLICKS_TO_FINISH, state.clickCount);
  updateCarPosition(state.mySocketId, myProgress);
  document.getElementById('race-click-count').textContent = Math.min(CLICKS_TO_FINISH, state.clickCount);

  // Optimistically stop input once we hit 100 — don't wait for server round-trip
  if (state.clickCount >= CLICKS_TO_FINISH) {
    state.myFinished = true;
  }

  // Visual feedback
  flashPressed(key);

  // Switch to the other key
  setActiveKey(key === 'a' ? 'b' : 'a');

  // Send to server
  state.socket.emit('click', { roomCode: state.roomCode });
}

function bindRace() {
  // Touch/click on A/B buttons (mobile + mouse)
  ['a', 'b'].forEach(k => {
    const btn = document.getElementById('btn-' + k);
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      handleKeyPress(k);
    });
  });

  // Keyboard support — ignore when user is typing in an input
  document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (k === 'a' || k === 'b') {
      e.preventDefault();
      handleKeyPress(k);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULTS SCREEN
// ═══════════════════════════════════════════════════════════════════════════════
function buildResults(results) {
  buildPodium(results);
  buildResultsList(results);

  const btnPlayAgain = document.getElementById('btn-play-again');
  const waiting = document.getElementById('results-waiting');
  if (state.isHost) {
    btnPlayAgain.classList.remove('hidden');
    if (waiting) waiting.classList.add('hidden');
  } else {
    btnPlayAgain.classList.add('hidden');
    if (waiting) waiting.classList.remove('hidden');
  }
}

function buildPodium(results) {
  const podium = document.getElementById('podium-row');
  podium.innerHTML = '';

  const top3 = results.slice(0, 3);
  // Order: 2nd, 1st, 3rd
  const displayOrder = [top3[1], top3[0], top3[2]].filter(Boolean);

  displayOrder.forEach((player) => {
    const pos = player.rank;
    const cls = pos === 1 ? '--1st' : pos === 2 ? '--2nd' : '--3rd';

    const item = document.createElement('div');
    item.className = `podium-item podium-item-${cls}`;
    item.innerHTML = `
      <div class="podium-car-preview">
        ${carSVG(player.carModel, player.carColor)}
      </div>
      <div class="podium-player-name">${player.name}</div>
      <div class="podium-block">${medalText(pos)}</div>
    `;
    podium.appendChild(item);
  });
}

function buildResultsList(results) {
  const list = document.getElementById('results-list');
  list.innerHTML = '';

  results.forEach(player => {
    const isMe = player.socketId === state.mySocketId;
    const row = document.createElement('div');
    row.className = 'result-row' + (isMe ? ' is-me' : '');
    row.innerHTML = `
      <span class="result-rank">${player.rank}</span>
      <span class="result-color-dot" style="background:${player.carColor}"></span>
      <div class="result-player-info">
        <span class="result-name">${player.name}${isMe ? ' ★' : ''}</span>
        <span class="result-car">${CAR_LABELS[player.carModel] || player.carModel}</span>
      </div>
      <span class="result-time">${player.finishTime != null ? formatTime(player.finishTime) : ''}</span>
      ${player.dnf ? '<span class="dnf-badge">DNF</span>' : ''}
    `;
    list.appendChild(row);
  });
}

function bindResults() {
  document.getElementById('btn-play-again').addEventListener('click', () => {
    state.socket.emit('reset-room', { roomCode: state.roomCode });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOCKET EVENTS
// ═══════════════════════════════════════════════════════════════════════════════
function bindSocket() {
  const socket = state.socket;

  // Connection status
  socket.on('connect', () => {
    state.mySocketId = socket.id;
    document.getElementById('loading-note').textContent = 'Connected';
    setTimeout(() => document.getElementById('loading-note').classList.add('hidden'), 1500);

    // Rejoin attempt if we have a saved room
    const saved = sessionStorage.getItem('mercedesRaceRoom');
    if (saved && state.phase !== 'idle') {
      try {
        const { code, name, carModel } = JSON.parse(saved);
        socket.emit('rejoin-room', { code, name, carModel });
      } catch (_) {}
    }
  });

  socket.on('disconnect', () => {
    document.getElementById('loading-note').textContent = 'Reconnecting...';
    document.getElementById('loading-note').classList.remove('hidden');
  });

  // ── Landing events ─────────────────────────────────────────────────────────
  socket.on('room-created', ({ code, player }) => {
    state.isHost = true;
    state.myName = player.name;
    state.players[player.socketId] = player;
    sessionStorage.setItem('mercedesRaceRoom', JSON.stringify({
      code, name: player.name, carModel: player.carModel
    }));
    enterLobby(code, [player], socket.id);
  });

  socket.on('room-joined', ({ code, players, hostId }) => {
    state.isHost = socket.id === hostId;
    const me = players.find(p => p.socketId === socket.id);
    if (me) state.myName = me.name;
    sessionStorage.setItem('mercedesRaceRoom', JSON.stringify({
      code, name: state.myName, carModel: state.myCarModel
    }));
    enterLobby(code, players, hostId);
  });

  socket.on('join-error', ({ reason }) => {
    showLandingError(reason);
  });

  socket.on('rejoin-failed', () => {
    sessionStorage.removeItem('mercedesRaceRoom');
  });

  // ── Lobby events ───────────────────────────────────────────────────────────
  socket.on('player-joined', ({ player }) => {
    state.players[player.socketId] = player;

    const list = document.getElementById('lobby-player-list');
    if (list) list.appendChild(buildPlayerCard(player, state.roomHostId || ''));
    updatePlayerCount();
    if (state.isHost) updateStartButton();
  });

  socket.on('player-left', ({ socketId, newHostId }) => {
    delete state.players[socketId];
    const card = document.getElementById('lobby-player-' + socketId);
    if (card) card.remove();
    updatePlayerCount();

    if (newHostId) {
      state.roomHostId = newHostId;
      if (newHostId === socket.id) {
        state.isHost = true;
        document.getElementById('btn-start-race').classList.remove('hidden');
        document.getElementById('lobby-waiting').classList.add('hidden');
        updateStartButton();
      }
      // Update host badge
      document.querySelectorAll('.host-badge').forEach(b => b.remove());
      const newHostCard = document.getElementById('lobby-player-' + newHostId);
      if (newHostCard) {
        const badge = document.createElement('span');
        badge.className = 'host-badge';
        badge.textContent = 'HOST';
        newHostCard.appendChild(badge);
      }
    }

    if (state.isHost) updateStartButton();

    // If racing and player left, mark their lane as disconnected
    if (state.phase === 'racing') {
      const lane = document.getElementById('lane-' + socketId);
      if (lane) lane.classList.add('disconnected');
    }
  });

  socket.on('host-changed', ({ newHostId }) => {
    state.roomHostId = newHostId;
    if (newHostId === socket.id) {
      state.isHost = true;
      const btn = document.getElementById('btn-start-race');
      if (btn) { btn.classList.remove('hidden'); updateStartButton(); }
      const w = document.getElementById('lobby-waiting');
      if (w) w.classList.add('hidden');
    }
  });

  socket.on('start-error', ({ reason }) => {
    alert(reason);
  });

  // ── Race events ────────────────────────────────────────────────────────────
  socket.on('race-started', ({ startTime }) => {
    state.clickCount = 0;
    state.lastClickSent = 0;
    state.nextKey = 'a';
    state.myFinished = false;
    Object.values(state.players).forEach(p => { p.progress = 0; });
    startCountdown(startTime);
  });

  socket.on('progress-update', ({ updates }) => {
    if (state.phase !== 'racing' && state.phase !== 'countdown') return;
    updates.forEach(({ socketId, progress }) => {
      if (socketId === state.mySocketId) {
        // Reconcile: never go backward
        const display = Math.max(progress, state.clickCount);
        updateCarPosition(socketId, Math.min(100, display));
      } else {
        updateCarPosition(socketId, progress);
        if (state.players[socketId]) state.players[socketId].progress = progress;
      }
    });
  });

  socket.on('player-finished', ({ socketId, rank, time }) => {
    if (state.players[socketId]) state.players[socketId].rank = rank;

    const track = document.getElementById('track-' + socketId);
    if (track) {
      const badge = document.createElement('div');
      badge.className = 'finish-badge rank-' + rank;
      badge.textContent = medalText(rank);
      track.appendChild(badge);
    }

    const lane = document.getElementById('lane-' + socketId);
    if (lane) lane.classList.add('finished');

    // Disable A/B buttons when I finish, but keep watching others race
    if (socketId === state.mySocketId) {
      state.myFinished = true;
      // Freeze timer at server-confirmed finish time
      clearInterval(state.raceTimer);
      const timerEl = document.getElementById('race-timer');
      if (timerEl) timerEl.textContent = formatTime(time);
      document.getElementById('btn-a').disabled = true;
      document.getElementById('btn-b').disabled = true;
      // Remove active glow — race is over for me
      document.getElementById('btn-a').classList.remove('btn-ab--active');
      document.getElementById('btn-b').classList.remove('btn-ab--active');
    }
  });

  socket.on('first-finisher-countdown', ({ endsAt }) => {
    const banner = document.getElementById('last-chance-banner');
    const secEl  = document.getElementById('last-chance-seconds');
    if (!banner || !secEl) return;

    banner.classList.remove('hidden');
    banner.classList.add('urgent');

    clearInterval(state.lastChanceTimer);
    state.lastChanceTimer = setInterval(() => {
      const remaining = Math.ceil((endsAt - Date.now()) / 1000);
      if (remaining <= 0) {
        secEl.textContent = '0';
        clearInterval(state.lastChanceTimer);
        return;
      }
      secEl.textContent = remaining;
      if (remaining <= 5) {
        banner.classList.add('urgent');
      }
    }, 250);
  });

  socket.on('race-finished', ({ results }) => {
    state.phase = 'finished';
    clearInterval(state.countdownTimer);
    clearInterval(state.raceTimer);
    hideLastChanceBanner();

    setTimeout(() => {
      buildResults(results);
      showScreen('screen-results');
    }, 2200);
  });

  // ── Reset (play again) ─────────────────────────────────────────────────────
  socket.on('room-reset', ({ players, hostId }) => {
    state.phase = 'lobby';
    state.clickCount = 0;
    clearInterval(state.raceTimer);
    state.raceTimer = null;
    hideLastChanceBanner();
    state.players = {};
    players.forEach(p => { state.players[p.socketId] = p; });
    state.isHost = socket.id === hostId;
    state.roomHostId = hostId;

    const btnA = document.getElementById('btn-a');
    const btnB = document.getElementById('btn-b');
    if (btnA) { btnA.disabled = false; btnA.classList.remove('btn-ab--active', 'btn-ab--pressed', 'btn-ab--wrong'); }
    if (btnB) { btnB.disabled = false; btnB.classList.remove('btn-ab--active', 'btn-ab--pressed', 'btn-ab--wrong'); }
    state.nextKey = 'a';
    state.myFinished = false;

    enterLobby(state.roomCode, players, hostId);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════
function init() {
  // Show "first load may be slow" note
  const note = document.getElementById('loading-note');
  note.textContent = 'Connecting... (first load may take ~30s on free tier)';

  // Connect to socket
  state.socket = io({ reconnection: true, reconnectionDelay: 1000 });
  state.roomHostId = null;

  bindLanding();
  bindLobby();
  bindRace();
  bindResults();
  bindSocket();
}

document.addEventListener('DOMContentLoaded', init);
