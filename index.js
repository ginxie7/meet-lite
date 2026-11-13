
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// SERVER STATUS
app.get('/', (_req, res) => {
  res.json({
    app: 'Meet Lite signaling server',
    status: 'ok',
    message: 'Server is running'
  });
});

// HEALTH CHECK
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'healthy',
    app: 'Meet Lite signaling server'
  });
});

const server = http.createServer(app);

// SOCKET.IO CONFIGURATION
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['polling', 'websocket'],
  allowEIO3: true
});

// ROOM STORAGE
// roomId -> Map(socketId, { name })
const rooms = new Map();

// GENERATE UNIQUE MEETING CODE
function generateRoomCode() {
  let code;

  do {
    code = crypto
      .randomBytes(4)
      .toString('hex')
      .substring(0, 6)
      .toUpperCase();
  } while (rooms.has(code));

  return code;
}

// DISPLAY NAME
function getDisplayName(name) {
  return String(name || 'Guest')
    .trim()
    .slice(0, 28) || 'Guest';
}

// SEND ACKNOWLEDGEMENT SAFELY
function respond(callback, result) {
  if (typeof callback === 'function') {
    callback(result);
  }
}

// CREATE ROOM
async function createRoom(socket, data, callback) {
  try {
    console.log('CREATE ROOM REQUEST:', data);

    if (socket.data.roomId) {
      return respond(callback, {
        ok: false,
        error: 'You are already in a meeting.'
      });
    }

    const roomId = generateRoomCode();
    const name = getDisplayName(data?.name);

    const room = new Map();

    room.set(socket.id, {
      name
    });

    rooms.set(roomId, room);

    await socket.join(roomId);

    socket.data.roomId = roomId;
    socket.data.name = name;

    socket.emit('room-users', []);

    console.log('ROOM CREATED:', roomId);
    console.log('CREATOR:', name);

    respond(callback, {
      ok: true,
      roomId
    });

  } catch (error) {
    console.error('CREATE ROOM ERROR:', error);

    respond(callback, {
      ok: false,
      error: 'Server error while creating the meeting.'
    });
  }
}

// JOIN EXISTING ROOM
async function joinRoom(socket, data, callback) {
  try {
    console.log('JOIN ROOM REQUEST:', data);

    if (socket.data.roomId) {
      return respond(callback, {
        ok: false,
        error: 'You are already in a meeting.'
      });
    }

    const roomId = String(data?.roomId || '')
      .trim()
      .toUpperCase();

    if (!roomId) {
      return respond(callback, {
        ok: false,
        error: 'Please enter a meeting code.'
      });
    }

    const room = rooms.get(roomId);

    if (!room || room.size === 0) {
      return respond(callback, {
        ok: false,
        error: 'Meeting not found. Please check the meeting code.'
      });
    }

    const name = getDisplayName(data?.name);

    const existingUsers = [...room.entries()].map(
      ([id, user]) => ({
        id,
        name: user.name
      })
    );

    await socket.join(roomId);

    socket.data.roomId = roomId;
    socket.data.name = name;

    room.set(socket.id, {
      name
    });

    socket.emit('room-users', existingUsers);

    socket.to(roomId).emit('user-joined', {
      id: socket.id,
      name
    });

    console.log('USER JOINED:', name);
    console.log('MEETING CODE:', roomId);
    console.log('PARTICIPANTS:', room.size);

    respond(callback, {
      ok: true,
      roomId
    });

  } catch (error) {
    console.error('JOIN ROOM ERROR:', error);

    respond(callback, {
      ok: false,
      error: 'Server error while joining the meeting.'
    });
  }
}

// REMOVE USER FROM ROOM
function leaveRoom(socket) {
  const roomId = socket.data.roomId;

  if (!roomId) return;

  const room = rooms.get(roomId);

  socket.to(roomId).emit('user-left', {
    id: socket.id
  });

  socket.leave(roomId);

  if (room) {
    room.delete(socket.id);

    if (room.size === 0) {
      rooms.delete(roomId);

      console.log('ROOM DELETED:', roomId);
    } else {
      console.log(
        'PARTICIPANTS REMAINING:',
        room.size
      );
    }
  }

  console.log(
    `${socket.data.name || 'Guest'} left room ${roomId}`
  );

  delete socket.data.roomId;
  delete socket.data.name;
}

// SOCKET CONNECTION
io.on('connection', socket => {
  console.log('--------------------------------');
  console.log('CLIENT CONNECTED:', socket.id);
  console.log('TRANSPORT:', socket.conn.transport.name);

  // DEBUG: LOG EVERY EVENT RECEIVED
  socket.onAny(event => {
    console.log('EVENT RECEIVED:', event);
  });

  // CREATE MEETING
  socket.on('create-room', (data, callback) => {
    createRoom(socket, data || {}, callback);
  });

  // JOIN MEETING
  socket.on('join-room', (data, callback) => {
    joinRoom(socket, data || {}, callback);
  });

  // WEBRTC SIGNALING
  const signalingEvents = [
    'offer',
    'answer',
    'ice-candidate'
  ];

  for (const event of signalingEvents) {
    socket.on(event, payload => {
      try {
        if (!payload || !payload.to) return;

        const roomId = socket.data.roomId;

        if (!roomId) return;

        const room = rooms.get(roomId);

        if (!room || !room.has(socket.id)) return;

        if (!room.has(payload.to)) return;

        io.to(payload.to).emit(event, {
          ...payload,
          from: socket.id
        });

      } catch (error) {
        console.error(
          'SIGNALING ERROR:',
          event,
          error
        );
      }
    });
  }

  // LEAVE MEETING
  socket.on('leave-room', () => {
    leaveRoom(socket);
  });

  // DISCONNECT
  socket.on('disconnect', reason => {
    console.log('CLIENT DISCONNECTED:', socket.id);
    console.log('REASON:', reason);

    leaveRoom(socket);
  });

  socket.on('error', error => {
    console.error('SOCKET ERROR:', error);
  });
});

// SERVER ERRORS
server.on('error', error => {
  console.error('HTTP SERVER ERROR:', error);
});

// START SERVER
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('================================');
  console.log('MEET LITE SERVER STARTED');
  console.log(`PORT: ${PORT}`);
  console.log('HOST: 0.0.0.0');
  console.log('================================');
});
