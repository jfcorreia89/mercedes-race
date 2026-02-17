'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { customAlphabet } = require('nanoid');

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 10000,
  pingInterval: 5000,
});

// ─── In-memory room store ────────────────────────────────────────────────────

const rooms = new Map();

const COLOR_PALETTE = [
  '#C0C0C0', '#CC0000', '#1E3A8A', '#B8860B', '#F5F5F5',
  '#4A4A4A', '#006B4F', '#FF6B35', '#7B2D8B', '#00A8CC',
  '#8B4513', '#FF1493', '#888888', '#FFD700', '#00CED1', '#DC143C',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateRoomCode() {
  let code;
  do {
    code = nanoid();
  } while (rooms.has(code));
  return code;
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, 20).replace(/[<>&"']/g, '');
}

function getNextColor(room) {
  const usedColors = new Set([...room.players.values()].map(p => p.carColor));
  return COLOR_PALETTE.find(c => !usedColors.has(c)) || COLOR_PALETTE[room.players.size % COLOR_PALETTE.length];
}

function serializePlayer(p) {
  return {
    socketId: p.socketId,
    name: p.name,
    carModel: p.carModel,
    carColor: p.carColor,
    progress: p.progress,
    rank: p.rank,
    dnf: p.dnf || false,
    disconnected: p.disconnected || false,
  };
}

function findRoomBySocket(socketId) {
  for (const [, room] of rooms) {
    if (room.players.has(socketId)) return room;
  }
  return null;
}

function buildResultsArray(room) {
  const players = [...room.players.values()];
  const finished = players.filter(p => p.finishedAt).sort((a, b) => a.rank - b.rank);
  const unfinished = players.filter(p => !p.finishedAt).sort((a, b) => b.progress - a.progress);
  let rank = finished.length;
  unfinished.forEach(p => { p.rank = ++rank; p.dnf = true; });
  return [...finished, ...unfinished].map(serializePlayer);
}

function checkAllFinished(room, roomCode) {
  const activePlayers = [...room.players.values()].filter(p => !p.disconnected);
  const allDone = activePlayers.every(p => p.finishedAt);
  if (allDone) endRace(room, roomCode);
}

function endRace(room, roomCode) {
  if (room.phase === 'finished') return;
  room.phase = 'finished';
  clearInterval(room.broadcastInterval);
  clearTimeout(room.raceTimeout);
  const results = buildResultsArray(room);
  io.to(roomCode).emit('race-finished', { results });
}

function handleDisconnect(socket) {
  const room = findRoomBySocket(socket.id);
  if (!room) return;

  const roomCode = room.code;
  const player = room.players.get(socket.id);
  if (!player) return;

  if (room.phase === 'lobby') {
    room.players.delete(socket.id);
    let newHostId = null;
    if (room.hostSocketId === socket.id && room.players.size > 0) {
      newHostId = room.players.keys().next().value;
      room.hostSocketId = newHostId;
    }
    if (room.players.size === 0) {
      rooms.delete(roomCode);
      return;
    }
    io.to(roomCode).emit('player-left', { socketId: socket.id, newHostId });
  } else if (room.phase === 'racing') {
    player.disconnected = true;
    let newHostId = null;
    if (room.hostSocketId === socket.id && room.players.size > 0) {
      const next = [...room.players.keys()].find(id => !room.players.get(id).disconnected);
      if (next) { room.hostSocketId = next; newHostId = next; }
    }
    io.to(roomCode).emit('player-left', { socketId: socket.id, newHostId });
    checkAllFinished(room, roomCode);
  } else {
    room.players.delete(socket.id);
    if (room.players.size === 0) rooms.delete(roomCode);
  }
}

// ─── Socket.io ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // ── Create room ─────────────────────────────────────────────────────────────
  socket.on('create-room', ({ name, carModel }) => {
    const safeName = sanitize(name);
    const safeModel = ['a-class', 'cla', 'amg-gt', '300sl', 'amg-gtr', 'c-class'].includes(carModel) ? carModel : 'a-class';

    const code = generateRoomCode();
    const player = {
      socketId: socket.id,
      name: safeName || 'Driver',
      carModel: safeModel,
      carColor: COLOR_PALETTE[0],
      progress: 0,
      clickCount: 0,
      lastClickTime: 0,
      finishedAt: null,
      rank: null,
      dnf: false,
      disconnected: false,
    };

    const room = {
      code,
      hostSocketId: socket.id,
      phase: 'lobby',
      players: new Map([[socket.id, player]]),
      createdAt: Date.now(),
      raceStartedAt: null,
      finishedCount: 0,
      broadcastInterval: null,
      raceTimeout: null,
    };

    rooms.set(code, room);
    socket.join(code);
    socket.emit('room-created', { code, player: serializePlayer(player) });
  });

  // ── Join room ────────────────────────────────────────────────────────────────
  socket.on('join-room', ({ code, name, carModel }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return socket.emit('join-error', { reason: 'Room not found. Check the code and try again.' });
    if (room.phase !== 'lobby') return socket.emit('join-error', { reason: 'This race has already started. Wait for the next round.' });
    if (room.players.size >= 16) return socket.emit('join-error', { reason: 'Room is full (max 16 players).' });

    const safeName = sanitize(name);
    const safeModel = ['a-class', 'cla', 'amg-gt', '300sl', 'amg-gtr', 'c-class'].includes(carModel) ? carModel : 'a-class';

    const player = {
      socketId: socket.id,
      name: safeName || 'Driver',
      carModel: safeModel,
      carColor: getNextColor(room),
      progress: 0,
      clickCount: 0,
      lastClickTime: 0,
      finishedAt: null,
      rank: null,
      dnf: false,
      disconnected: false,
    };

    room.players.set(socket.id, player);
    socket.join(code.toUpperCase());

    socket.emit('room-joined', {
      code: room.code,
      hostId: room.hostSocketId,
      players: [...room.players.values()].map(serializePlayer),
    });

    socket.to(room.code).emit('player-joined', { player: serializePlayer(player) });
  });

  // ── Rejoin room (reconnect) ──────────────────────────────────────────────────
  socket.on('rejoin-room', ({ code, name, carModel }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return socket.emit('rejoin-failed', { reason: 'Room no longer exists.' });

    const safeName = sanitize(name);
    const safeModel = ['a-class', 'cla', 'amg-gt', '300sl', 'amg-gtr', 'c-class'].includes(carModel) ? carModel : 'a-class';

    const player = {
      socketId: socket.id,
      name: safeName || 'Driver',
      carModel: safeModel,
      carColor: getNextColor(room),
      progress: 0,
      clickCount: 0,
      lastClickTime: 0,
      finishedAt: null,
      rank: null,
      dnf: false,
      disconnected: false,
    };

    room.players.set(socket.id, player);
    socket.join(room.code);

    socket.emit('room-joined', {
      code: room.code,
      hostId: room.hostSocketId,
      players: [...room.players.values()].map(serializePlayer),
      phase: room.phase,
    });

    socket.to(room.code).emit('player-joined', { player: serializePlayer(player) });
  });

  // ── Start race ───────────────────────────────────────────────────────────────
  socket.on('start-race', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;
    if (room.phase !== 'lobby') return;
    if (room.players.size < 1) {
      return socket.emit('start-error', { reason: 'Need at least 1 player to start the race.' });
    }

    room.phase = 'racing';
    room.raceStartedAt = Date.now();
    room.finishedCount = 0;

    const startTime = Date.now() + 3500;
    io.to(roomCode).emit('race-started', { startTime });

    // Progress broadcast loop at 20Hz
    room.broadcastInterval = setInterval(() => {
      if (room.phase !== 'racing') { clearInterval(room.broadcastInterval); return; }
      const updates = [...room.players.values()].map(p => ({ socketId: p.socketId, progress: p.progress }));
      io.to(roomCode).emit('progress-update', { updates });
    }, 50);

    // 5 minute race timeout
    room.raceTimeout = setTimeout(() => {
      if (room.phase !== 'racing') return;
      endRace(room, roomCode);
    }, 5 * 60 * 1000);
  });

  // ── Click ────────────────────────────────────────────────────────────────────
  socket.on('click', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== 'racing') return;

    const player = room.players.get(socket.id);
    if (!player || player.finishedAt || player.disconnected) return;

    const now = Date.now();
    if (now - player.lastClickTime < 50) return; // server-side throttle: max 20 CPS

    player.lastClickTime = now;
    player.clickCount = Math.min(100, player.clickCount + 1);
    player.progress = player.clickCount;

    if (player.clickCount >= 100 && !player.finishedAt) {
      player.finishedAt = now;
      player.rank = ++room.finishedCount;
      io.to(roomCode).emit('player-finished', {
        socketId: socket.id,
        rank: player.rank,
        time: now - room.raceStartedAt,
      });
      checkAllFinished(room, roomCode);
    }
  });

  // ── Reset room (play again) ──────────────────────────────────────────────────
  socket.on('reset-room', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;

    clearInterval(room.broadcastInterval);
    clearTimeout(room.raceTimeout);
    room.phase = 'lobby';
    room.raceStartedAt = null;
    room.finishedCount = 0;

    for (const player of room.players.values()) {
      player.progress = 0;
      player.clickCount = 0;
      player.lastClickTime = 0;
      player.finishedAt = null;
      player.rank = null;
      player.dnf = false;
      player.disconnected = false;
    }

    io.to(roomCode).emit('room-reset', {
      players: [...room.players.values()].map(serializePlayer),
      hostId: room.hostSocketId,
    });
  });

  // ── Leave room ───────────────────────────────────────────────────────────────
  socket.on('leave-room', () => {
    handleDisconnect(socket);
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

// ─── Static serving ───────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: Math.round(process.uptime()) });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Room TTL cleanup (every 5 min, delete rooms older than 2h) ───────────────

setInterval(() => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (Date.now() - room.createdAt > TWO_HOURS) {
      clearInterval(room.broadcastInterval);
      clearTimeout(room.raceTimeout);
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mercedes Race server running on http://localhost:${PORT}`);
});
