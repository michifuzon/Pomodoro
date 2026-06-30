const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
// Serve Three.js from local node_modules (no CDN dependency)
app.use('/three', express.static(path.join(__dirname, 'node_modules/three')));

const rooms = {};

function genRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
  let roomId = null;
  let user = null;

  socket.on('create-room', ({ user: u }) => {
    roomId = genRoomId();
    user = u;
    rooms[roomId] = { id: roomId, users: {}, messages: [] };
    rooms[roomId].users[socket.id] = { ...user, id: socket.id, pos: { x: 0, z: 2, ry: 0 } };
    socket.join(roomId);
    socket.emit('room-created', { roomId });
    io.to(roomId).emit('users-updated', Object.values(rooms[roomId].users));
  });

  socket.on('join-room', ({ roomId: rid, user: u }) => {
    const target = rid.toUpperCase();
    if (!rooms[target]) {
      socket.emit('room-error', { message: 'Sala no encontrada. Verificá el código.' });
      return;
    }
    roomId = target;
    user = u;
    rooms[roomId].users[socket.id] = { ...user, id: socket.id, pos: { x: 1, z: 2, ry: 0 } };
    socket.join(roomId);
    socket.emit('room-joined', { roomId, messages: rooms[roomId].messages });
    io.to(roomId).emit('users-updated', Object.values(rooms[roomId].users));
    socket.to(roomId).emit('user-joined', { name: user.name });
  });

  socket.on('send-message', ({ text }) => {
    if (!roomId || !rooms[roomId] || !user) return;
    const msg = {
      id: Date.now(),
      userId: socket.id,
      userName: user.name,
      character: user.character,
      text,
      timestamp: new Date().toISOString()
    };
    rooms[roomId].messages.push(msg);
    if (rooms[roomId].messages.length > 100) rooms[roomId].messages.shift();
    io.to(roomId).emit('new-message', msg);
  });

  socket.on('update-status', ({ status }) => {
    if (!roomId || !rooms[roomId] || !rooms[roomId].users[socket.id]) return;
    rooms[roomId].users[socket.id].status = status;
    io.to(roomId).emit('users-updated', Object.values(rooms[roomId].users));
  });

  socket.on('player-move', ({ x, z, ry }) => {
    if (!roomId || !rooms[roomId] || !rooms[roomId].users[socket.id]) return;
    rooms[roomId].users[socket.id].pos = { x, z, ry };
    socket.to(roomId).emit('player-moved', { userId: socket.id, x, z, ry });
  });

  socket.on('disconnect', () => {
    if (!roomId || !rooms[roomId]) return;
    const leaving = rooms[roomId].users[socket.id];
    delete rooms[roomId].users[socket.id];
    if (Object.keys(rooms[roomId].users).length === 0) {
      setTimeout(() => {
        if (rooms[roomId] && Object.keys(rooms[roomId].users).length === 0) {
          delete rooms[roomId];
        }
      }, 300000);
    } else {
      io.to(roomId).emit('users-updated', Object.values(rooms[roomId].users));
      if (leaving) io.to(roomId).emit('user-left', { name: leaving.name });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n☕  CozyStudy corriendo en http://localhost:${PORT}\n`);
});
