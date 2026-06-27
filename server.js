const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*' }
});

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Socket.IO logic
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('joinSwapRoom', (swapId) => {
    socket.join(`swap:${swapId}`);
    io.to(`swap:${swapId}`).emit('message', { system: 'User joined the swap room' });
  });

  socket.on('chatMessage', ({ swapId, message, user }) => {
    io.to(`swap:${swapId}`).emit('message', { user, message, time: new Date() });
  });

  socket.on('disconnect', () => console.log('User disconnected'));
});

module.exports = { app, server, io };
