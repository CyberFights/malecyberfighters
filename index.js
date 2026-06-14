require('dotenv').config();

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
const server = http.createServer(app);
const io = new Server(server);

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_KEY = process.env.ADMIN_KEY;

// ---------- MIDDLEWARE ----------
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
  role:     { type: String, default: 'user' }, // "user" | "admin"
  banned:   { type: Boolean, default: false }
}, { timestamps: true });

const ipLogSchema = new mongoose.Schema({
  ip: String,
  username: String,
  action: String,
  userAgent: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const IpLog = mongoose.model('IpLog', ipLogSchema);

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

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  next();
}

// ---------- API: AVAILABILITY ----------
app.get('/api/check-availability', async (req, res) => {
  const { username, email } = req.query;
  try {
    const queries = [];
    if (username) queries.push({ username });
    if (email) queries.push({ email });
    if (!queries.length) return res.json({ ok: true });

    const existing = await User.findOne({ $or: queries }).select('username email -_id').lean();
    if (!existing) return res.json({ ok: true });

    const conflict = {};
    if (username && existing.username === username) conflict.username = true;
    if (email && existing.email === email) conflict.email = true;
    return res.json({ ok: false, conflict });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: IMAGE UPLOAD (IMGBB) ----------
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
      body: form
    });

    const data = await resp.json();

    if (!data || !data.success) {
      return res.status(500).json({ ok: false, error: 'upload_failed', details: data });
    }

    return res.json({
      ok: true,
      url: data.data.url,          // direct image URL
      viewer: data.data.url_viewer // optional
    });

  } catch (e) {
    console.error("upload error", e);
    return res.status(500).json({ ok: false, error: 'upload_error' });
  }
});

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

// ---------- ADMIN API ----------
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await User.find().select('-passwordHash').lean();
  res.json({ ok: true, users });
});

app.post('/api/admin/update-user', requireAdmin, async (req, res) => {
  const { username, updates } = req.body;
  const user = await User.findOneAndUpdate({ username }, updates, { new: true }).select('-passwordHash');
  res.json({ ok: true, user });
});

app.post('/api/admin/ban', requireAdmin, async (req, res) => {
  const { username, banned } = req.body;
  const user = await User.findOneAndUpdate({ username }, { banned }, { new: true }).select('-passwordHash');
  res.json({ ok: true, user });
});

app.post('/api/admin/reset-password', requireAdmin, async (req, res) => {
  const { username, newPassword } = req.body;
  const hash = await bcrypt.hash(newPassword, 10);
  await User.findOneAndUpdate({ username }, { passwordHash: hash });
  res.json({ ok: true });
});

app.post('/api/admin/delete-user', requireAdmin, async (req, res) => {
  const { username } = req.body;
  await User.deleteOne({ username });
  res.json({ ok: true });
});

// ---------- ADMIN ANALYTICS ----------
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const [totalUsers, onlineUsers, bannedUsers, totalLogs] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ online: true }),
    User.countDocuments({ banned: true }),
    IpLog.countDocuments({})
  ]);

  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [logins24h, fails24h, regs24h] = await Promise.all([
    IpLog.countDocuments({ action: 'login_success', createdAt: { $gte: last24h } }),
    IpLog.countDocuments({ action: 'login_fail', createdAt: { $gte: last24h } }),
    IpLog.countDocuments({ action: 'register', createdAt: { $gte: last24h } })
  ]);

  res.json({
    ok: true,
    totalUsers,
    onlineUsers,
    bannedUsers,
    totalLogs,
    last24h: { logins24h, fails24h, regs24h }
  });
});

app.get('/api/admin/top-ips', requireAdmin, async (req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const agg = await IpLog.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: '$ip', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 }
  ]);
  res.json({ ok: true, ips: agg });
});

// ---------- SOCKET.IO ----------
const onlineByUsername = new Map();

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('login', async (user) => {
    const u = await User.findOneAndUpdate(
      { username: user.username },
      { online: true, socketId: socket.id },
      { new: true }
    );
    if (!u) return;
    onlineByUsername.set(u.username, socket.id);
    const onlineUsers = await User.find({ online: true }).select('username display imageUrl -_id').lean();
    io.emit('presence', onlineUsers);
  });

  socket.on('publicMessage', async (msg) => {
    io.emit('publicMessage', { ...msg, time: new Date().toISOString() });
  });

  socket.on('privateMessage', async (pm) => {
    const targetSocket = onlineByUsername.get(pm.to);
    if (targetSocket) {
      io.to(targetSocket).emit('privateMessage', pm);
      io.to(socket.id).emit('privateMessage', pm);
    } else {
      io.to(socket.id).emit('pmError', { to: pm.to, reason: 'User offline' });
    }
  });

  socket.on('disconnect', async () => {
    const u = await User.findOneAndUpdate(
      { socketId: socket.id },
      { online: false, socketId: null },
      { new: true }
    );
    if (u) {
      onlineByUsername.delete(u.username);
      const onlineUsers = await User.find({ online: true }).select('username display imageUrl -_id').lean();
      io.emit('presence', onlineUsers);
    }
    console.log('socket disconnected', socket.id);
  });
});

// ---------- START ----------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
