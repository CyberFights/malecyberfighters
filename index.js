require('dotenv').config();
const FormData = require('form-data');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_KEY = process.env.ADMIN_KEY;

const DISCORD_WEBHOOK_URL = process.env.Discord_webhook || null;
const DISCORD_SUPPORT_URL = process.env.Discord_Support || null;

app.use(express.static(path.join(__dirname, 'public')));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

// ---------- MIDDLEWARE ----------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://i.ibb.co", "https://ibb.co"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'", "data:"],
        frameAncestors: ["'self'"],
        frameSrc: ["'self'"],
        mediaSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
      }
    }
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// ---------- DB ----------
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// ---------- SCHEMAS ----------
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true, index: true },
  email:    { type: String, unique: true, required: true, index: true },
  passwordHash: { type: String, required: true },
  display:  { type: String },
  age:      { type: Number },
  stats:    { type: Object, default: {} },
  info:     { type: String },
  color:    { type: String },
  language: { type: String },
  imageUrl: { type: String },
  online:   { type: Boolean, default: false },
  socketId: { type: String, default: null },
  role:     { type: String, default: 'user' },
  banned:   { type: Boolean, default: false }
}, { timestamps: true });

const publicMessageSchema = new mongoose.Schema({
  from: String,
  display: String,
  text: String,
  time: { type: Date, default: Date.now }
});

const roomMessageSchema = new mongoose.Schema({
  room: { type: String, required: true },
  from: String,
  display: String,
  text: String,
  imageUrl: String,
  time: { type: Date, default: Date.now }
});

const RoomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  private: { type: Boolean, default: false },
  owner: { type: String, required: true },
  invitedUsers: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
});

const ipLogSchema = new mongoose.Schema({
  ip: String,
  username: String,
  action: String,
  userAgent: String,
  createdAt: { type: Date, default: Date.now }
});

const dmSchema = new mongoose.Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },

  // text message (translated)
  text: { type: String },

  // original text (sender’s language)
  originalText: { type: String, required: false },

  // image message
  imageUrl: { type: String },

  time: { type: Date, default: Date.now }
});

const DM = mongoose.model("DM", dmSchema);
const User = mongoose.model('User', userSchema);
const PublicMessage = mongoose.model("PublicMessage", publicMessageSchema);
const RoomMessage = mongoose.model("RoomMessage", roomMessageSchema);
const IpLog = mongoose.model('IpLog', ipLogSchema);
const Room = mongoose.model('Room', RoomSchema);

// ---------- HELPERS ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
}

async function logIp(req, { action, username }) {
  try {
    await IpLog.create({
      ip: getIp(req),
      username: username || null,
      action,
      userAgent: req.headers['user-agent'] || ''
    });
  } catch (e) {
    console.error('IP log error', e);
  }
}

async function translateText(text, targetLang) {
  try {
    const resp = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`
    );

    const data = await resp.json();
    return data[0][0][0]; // translated text
  } catch (err) {
    console.error("Translation error:", err);
    return text; // fallback
  }
}

async function sendDiscordWebhookMessage(username, message, avatarUrl) {
  if (!DISCORD_WEBHOOK_URL) return;

  const payload = {
    username: username || "Chat Message",
    content: message,
    avatar_url: avatarUrl || ""
  };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error("Failed to send webhook:", response.statusText);
    }
  } catch (err) {
    console.error("Error sending webhook:", err);
  }
}

async function updateRoomMembers(roomId) {
  const sockets = await io.in(roomId).fetchSockets();

  const members = await Promise.all(
    sockets.map(async s => {
      const user = await User.findOne({ username: s.username }).lean();
      return {
        username: user.username,
        display: user.display,
        imageUrl: user.imageUrl,
        online: user.online
      };
    })
  );

  io.to(roomId).emit("roomMembers", members);
}

app.get("/api/admin/users", async (req, res) => {
  try {
    const users = await User.find()
      .select("username display email imageUrl info wins losses color language age role banned createdAt")
      .lean();

    res.json({ ok: true, users });
  } catch (err) {
    console.error("Admin user fetch error:", err);
    res.status(500).json({ success: false });
  }
});

app.post("/api/check-availability", async (req, res) => {
  try {
    const { username, email } = req.body;

    const conflict = {
      username: false,
      email: false
    };

    const user = await User.findOne({
      $or: [
        { username: username?.toLowerCase() },
        { email: email?.toLowerCase() }
      ]
    });

    if (user) {
      if (user.username === username.toLowerCase()) conflict.username = true;
      if (user.email === email.toLowerCase()) conflict.email = true;
    }

    res.json({
      ok: !conflict.username && !conflict.email,
      conflict
    });

  } catch (err) {
    console.error("check-availability error:", err);
    res.json({
      ok: false,
      conflict: { username: false, email: false }
    });
  }
});

// ---------- API: PUBLIC CHAT HISTORY ----------
app.get("/api/public-messages", async (req, res) => {
  try {
    const messages = await PublicMessage
      .find({})
      .sort({ time: 1 })
      .limit(200)
      .lean();

    res.json({ ok: true, messages });
  } catch (err) {
    console.error("load public messages error:", err);
    res.status(500).json({ ok: false });
  }
});

// ---------- API: IMAGE UPLOAD ----------
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  const IMGBB_KEY = process.env.IMGBB_API_KEY;
  if (!IMGBB_KEY) return res.status(500).json({ ok: false, error: 'no_imgbb_key' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });

  try {
    const base64 = req.file.buffer.toString('base64');

    const form = new FormData();
    form.append("image", base64);

    const resp = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_KEY}`, {
      method: "POST",
      body: form,
      headers: form.getHeaders()
    });

    const data = await resp.json();

    if (!data.success) {
      return res.status(500).json({ ok: false, error: 'upload_failed', details: data });
    }

    return res.json({
      ok: true,
      imageUrl: data.data.url,
      viewer: data.data.url_viewer
    });

  } catch (e) {
    console.error("upload error", e);
    return res.status(500).json({ ok: false, error: 'upload_error' });
  }
});

// ---------- API: UPDATE PROFILE ----------
app.post('/api/update-profile', async (req, res) => {
  const { username, updates } = req.body;

  if (!username) {
    return res.status(400).json({ ok: false, error: 'missing_username' });
  }

  try {
    const user = await User.findOneAndUpdate(
      { username },
      updates,
      { new: true }
    ).select('-passwordHash');

    if (!user) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    return res.json({ ok: true, user });

  } catch (e) {
    console.error('update-profile error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: REGISTER ----------
app.post('/api/register', async (req, res) => {
  const { username, email, password, display, age, stats, info, color, language, imageUrl } = req.body;
  if (!username || !email || !password) {
    await logIp(req, { action: 'register_fail', username });
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  try {
    const existing = await User.findOne({ $or: [{ username }, { email }] }).lean();
    if (existing) {
      const conflict = {};
      if (existing.username === username) conflict.username = true;
      if (existing.email === email) conflict.email = true;
      await logIp(req, { action: 'register_conflict', username });
      return res.status(409).json({ ok: false, conflict });
    }

    const hash = await bcrypt.hash(password, 10);

    const user = new User({
      username,
      email,
      passwordHash: hash,
      display: display || username,
      age: age ? Number(age) : undefined,
      stats: stats || {},
      info: info || '',
      color: color || '',
      language: language || 'en',
      imageUrl: imageUrl || ''
    });

    await user.save();
    await logIp(req, { action: 'register', username });

    return res.json({
      ok: true,
      user: {
        username: user.username,
        display: user.display,
        imageUrl: user.imageUrl
      }
    });
  } catch (e) {
    console.error('register error', e);
    await logIp(req, { action: 'register_error', username });
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: LOGIN ----------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    await logIp(req, { action: 'login_fail', username });
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  try {
    const user = await User.findOne({ username }).lean();
    if (!user) {
      await logIp(req, { action: 'login_fail', username });
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    if (user.banned) {
      await logIp(req, { action: 'login_banned', username });
      return res.status(403).json({ ok: false, error: 'banned' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      await logIp(req, { action: 'login_fail', username });
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    await logIp(req, { action: 'login_success', username });

    return res.json({
      ok: true,
      user: {
        username: user.username,
        display: user.display,
        imageUrl: user.imageUrl,
        color: user.color,
        language: user.language,
        role: user.role,
        stats: user.stats,
        info: user.info,
        age: user.age
      }
    });
  } catch (e) {
    console.error(e);
    await logIp(req, { action: 'login_error', username });
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: EXTERNAL PUBLIC CHAT MESSAGE ----------
app.post("/api/chatMessage", async (req, res) => {
  try {
    const { username, message, timestamp, avatar } = req.body;

    if (!username || !message) {
      return res.status(400).json({ error: "Username and message are required" });
    }

    const msgTimestamp = timestamp ? new Date(timestamp) : new Date();

    const enriched = {
      from: username,
      display: username,
      text: message,
      time: msgTimestamp
    };

    await PublicMessage.create(enriched);

    io.emit("externalPublicMessage", {
      from: username,
      display: username,
      text: message,
      avatar: avatar || null,
      time: msgTimestamp.toISOString()
    });

    return res.json({ success: true, message: "Message saved and broadcasted" });

  } catch (err) {
    console.error("Error saving chat message:", err);
    return res.status(500).json({ error: "Failed to save message" });
  }
});

app.post("/api/dm/history", async (req, res) => {
  const { a, b } = req.body;

  const messages = await DM.find({
    $or: [
      { from: a, to: b },
      { from: b, to: a }
    ]
  })
  .sort({ time: 1 })
  .lean();

  res.json({ ok: true, messages });
});

app.post("/api/dm/partners", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.json({ ok: false, partners: [] });
  }

  const messages = await DM.find({
    $or: [
      { from: username },
      { to: username }
    ]
  }).lean();

  const partners = new Set();

  messages.forEach(m => {
    if (m.from !== username) partners.add(m.from);
    if (m.to !== username) partners.add(m.to);
  });

  res.json({ ok: true, partners: [...partners] });
});

app.post("/api/dm/clear", async (req, res) => {
  const { a, b } = req.body;

  if (!a || !b) {
    return res.json({ ok: false, error: "missing_users" });
  }

  await DM.deleteMany({
    $or: [
      { from: a, to: b },
      { from: b, to: a }
    ]
  });

  res.json({ ok: true });
});

app.get("/api/allUsers", async (req, res) => {
  try {
    const users = await User.find()
      .select("username display imageUrl info wins losses color language age createdAt")
      .lean();

    res.json({ success: true, users });
  } catch (err) {
    console.error("Error fetching all users:", err);
    res.status(500).json({ success: false });
  }
});


// ---------- SOCKET.IO ----------
const onlineByUsername = new Map();

io.on("connection", async (socket) => {
  console.log("socket connected", socket.id);

  const rooms = await Room.find().lean();
  socket.emit("roomsList", rooms);

  socket.on('login', async (user) => {
    socket.username = user.username;
    const u = await User.findOneAndUpdate(
      { username: user.username },
      { online: true, socketId: socket.id },
      { new: true }
    );
    if (!u) return;

    const onlineUsers = await User.find({ online: true })
      .select('username display imageUrl info wins losses color language age createdAt -_id')
      .lean();

    io.emit('presence', onlineUsers);
  });

  socket.on("chatClosed", async ({ username }) => {
    if (!username) return;

    await User.findOneAndUpdate(
      { username },
      { online: false }
    );

    const onlineUsers = await User.find({ online: true })
      .select("username display imageUrl info wins losses color language age createdAt -_id")
      .lean();

    io.emit("presence", onlineUsers);
  });

  socket.on("forceLogout", async ({ username }) => {
    if (!username) return;

    await User.findOneAndUpdate(
      { username },
      { online: false, socketId: null }
    );

    const onlineUsers = await User.find({ online: true })
      .select("username display imageUrl info wins losses color language age createdAt -_id")
      .lean();

    io.emit("presence", onlineUsers);
  });

  socket.on('publicMessage', async (msg) => {
    try {
      const enriched = {
        from: msg.from,
        display: msg.display,
        text: msg.text,
        time: new Date()
      };

      await PublicMessage.create(enriched);

      const onlineUsers = await User.find({ online: true }).lean();

      onlineUsers.forEach(async u => {
        const translated = await translateText(enriched.text, u.language || "en");

        io.to(u.socketId).emit("publicMessage", {
          ...enriched,
          text: translated
        });
      });

      const user = await User.findOne({ username: msg.from }).lean();
      const avatarUrl = user?.imageUrl || null;

      await sendDiscordWebhookMessage(
        msg.display || msg.from,
        msg.text,
        avatarUrl
      );

    } catch (err) {
      console.error("Error in publicMessage:", err);
    }
  });

  socket.on("privateMessage", async pm => {
    const sender = await User.findOne({ username: pm.from }).lean();
    const receiver = await User.findOne({ username: pm.to }).lean();

    if (!receiver) {
      socket.emit("pmError", { reason: "User not found" });
      return;
    }

    // IMAGE MESSAGE
    if (pm.imageUrl) {
      const saved = await DM.create({
        from: pm.from,
        to: pm.to,
        imageUrl: pm.imageUrl,
        text: null,
        originalText: null
      });

      if (receiver.socketId) {
        io.to(receiver.socketId).emit("privateMessage", {
          from: pm.from,
          to: pm.to,
          imageUrl: pm.imageUrl,
          time: saved.time
        });
      }

      if (sender.socketId) {
        io.to(sender.socketId).emit("privateMessage", {
          from: pm.from,
          to: pm.to,
          imageUrl: pm.imageUrl,
          time: saved.time
        });
      }

      return;
    }

    // TEXT MESSAGE
    const translated = await translateText(pm.text, receiver.language || "en");

    const saved = await DM.create({
      from: pm.from,
      to: pm.to,
      originalText: pm.text,
      text: translated
    });

    if (receiver.socketId) {
      io.to(receiver.socketId).emit("privateMessage", {
        from: pm.from,
        to: pm.to,
        text: translated,
        time: saved.time
      });
    }

    if (sender.socketId) {
      io.to(sender.socketId).emit("privateMessage", {
        from: pm.from,
        to: pm.to,
        text: pm.text,
        time: saved.time
      });
    }
  });

  socket.on("joinRoom", async ({ room }) => {
    socket.join(room);
    socket.currentRoom = room;

    const history = await RoomMessage.find({ room }).sort({ time: 1 }).limit(200).lean();
    io.to(socket.id).emit("roomHistory", { room, history });

    updateRoomMembers(room);
  });

  socket.on("roomMessage", async (msg) => {
    const enriched = {
      room: msg.room,
      from: msg.from,
      display: msg.display,
      text: msg.text || null,
      imageUrl: msg.imageUrl || null,
      time: new Date()
    };

    try {
      await RoomMessage.create(enriched);
    } catch (err) {
      console.error("Failed to save room message:", err);
    }

    const members = await User.find({ socketId: { $ne: null } }).lean();

    if (msg.imageUrl) {
      members.forEach(u => {
        io.to(u.socketId).emit("roomMessage", enriched);
      });
      return;
    }

    members.forEach(async u => {
      const translated = await translateText(enriched.text, u.language || "en");

      io.to(u.socketId).emit("roomMessage", {
        ...enriched,
        text: translated
      });
    });
  });

  socket.on("typingDM", ({ from, to }) => {
    const target = [...io.sockets.sockets.values()].find(s => s.username === to);
    if (target) {
      io.to(target.id).emit("typingDM", { from });
    }
  });

  socket.on("stopTypingDM", ({ from, to }) => {
    const target = [...io.sockets.sockets.values()].find(s => s.username === to);
    if (target) {
      io.to(target.id).emit("stopTypingDM", { from });
    }
  });

  socket.on("typingRoom", ({ room, from }) => {
    socket.to(room).emit("typingRoom", { from, room });
  });

  socket.on("stopTypingRoom", ({ room, from }) => {
    socket.to(room).emit("stopTypingRoom", { from, room });
  });

  socket.on("createRoom", async ({ name, private }) => {
    if (!name) return;

    const room = await Room.create({
      name,
      private: !!private,
      owner: socket.username,
      invitedUsers: [],
      createdAt: new Date()
    });

    socket.join(room._id.toString());

    const rooms = await Room.find().lean();
    io.emit("roomsList", rooms);
  });

  socket.on("inviteToRoom", async ({ roomId, username }) => {
    const room = await Room.findById(roomId);
    if (!room) return;

    if (room.owner !== socket.username) return;

    if (!room.invitedUsers.includes(username)) {
      room.invitedUsers.push(username);
      await room.save();
    }

    const targetSocket = [...io.sockets.sockets.values()]
      .find(s => s.username === username);

    if (targetSocket) {
      targetSocket.emit("roomInvited", {
        roomId,
        roomName: room.name
      });
    }

    const rooms = await Room.find().lean();
    io.emit("roomsList", rooms);
  });

  socket.on('disconnect', async () => {
    const u = await User.findOneAndUpdate(
      { socketId: socket.id },
      { online: false, socketId: null }
    );

    if (u) {
      const onlineUsers = await User.find({ online: true })
        .select('username display imageUrl info wins losses color language age createdAt -_id')
        .lean();

      io.emit('presence', onlineUsers);
    }

    if (socket.currentRoom) {
      updateRoomMembers(socket.currentRoom);
    }

    console.log('socket disconnected', socket.id);
  });
});

// ---------- START ----------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
