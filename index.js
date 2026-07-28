require('dotenv').config();
const FormData = require('form-data');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require("cors");

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



// ---------- MIDDLEWARE ----------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https://i.ibb.co", "https://ibb.co", "https://*.ibb.co"],
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
app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || '';

  const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(ua);

  if (isMobile) {
    return res.sendFile(__dirname + '/public/mobile.html');
  }

  return res.sendFile(__dirname + '/public/index.html');
});

app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use(cors({ origin: true, credentials: true }));


// ---------- DB ----------
if (!MONGO_URI) {
  console.warn('Warning: MONGO_URI is not set. Database features will fail until it is configured.');
}
mongoose.connect(MONGO_URI || 'mongodb://127.0.0.1:27017/malecyberfighters')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// ---------- ADMIN AUTH ----------
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_KEY) {
    return res.status(500).json({ ok: false, error: 'admin_not_configured' });
  }
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// ---------- SCHEMAS ----------
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true, index: true },
  email:    { type: String, unique: true, required: true, index: true },
  passwordHash: { type: String },
  password: { type: String },
  display:  { type: String },
  age:      { type: Number },
  stats:    { type: Object, default: {} },
  info:     { type: String },
  color:    { type: String },
  language: { type: String },
  imageUrl: { type: String },
  blockedUsers: { type: [String], default: [] },
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

  // original text (sender's language)
  originalText: { type: String, required: false },

  // image message
  imageUrl: { type: String },

  relationshipId: { type: String },
  storyId: { type: String },
  // system / approval / normal
  type: { type: String, default: "normal" },
  // values:
  // "normal"        → regular DM
  // "image"         → image DM
  // "storyApproval" → approval request DM
  // "system"        → system notifications

  // timestamp
  time: { type: Date, default: Date.now }
});

const storySchema = new mongoose.Schema({
  owner: { type: String, required: true },
  partner: { type: String, required: true },
  story: { type: String, required: true },

  approvalOwner: { type: Boolean, default: true },
  approvalPartner: { type: Boolean, default: false },

  approved: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

const relationshipSchema = new mongoose.Schema({
  requester: { type: String, required: true },
  target: { type: String, required: true },

  type: { type: String, required: true }, 
  // rival, friend, opponent, tagteam, dating, married, sibling, parent, owner

  approvedRequester: { type: Boolean, default: true },
  approvedTarget: { type: Boolean, default: false },

  approved: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

const Relationship = mongoose.model("Relationship", relationshipSchema);
const Story = mongoose.model("Story", storySchema);
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
  try {
    const sockets = await io.in(roomId).fetchSockets();

    const members = (
      await Promise.all(
        sockets.map(async s => {
          if (!s.username) return null;
          const user = await User.findOne({ username: s.username }).lean();
          if (!user) return null;
          return {
            username: user.username,
            display: user.display || user.username,
            imageUrl: user.imageUrl,
            online: user.online
          };
        })
      )
    ).filter(Boolean);

    io.to(roomId).emit("roomMembers", members);
  } catch (err) {
    console.error("updateRoomMembers error:", err);
  }
}

app.post("/api/story/save", async (req, res) => {
  const { owner, partner, story } = req.body;

  const saved = await Story.create({
    owner,
    partner,
    story,
    approvalOwner: true,
    approvalPartner: false,
    approved: false
  });

  const partnerUser = await User.findOne({ username: partner }).lean();

  // If partner is online → real-time popup
  if (partnerUser?.socketId) {
    io.to(partnerUser.socketId).emit("storyApprovalRequest", {
      storyId: saved._id,
      from: owner
    });
  } else {
    // If partner is offline → send DM notification
    await DM.create({
      from: "SYSTEM",
      to: partner,
      text: `${owner} created a story involving your messages. Please approve it.`,
      type: "storyApproval",
      storyId: saved._id,
      time: new Date()
    });
  }

  res.json({ ok: true, storyId: saved._id });
});


app.post("/api/story/approve", async (req, res) => {
  const { storyId } = req.body;

  const story = await Story.findById(storyId);
  if (!story) return res.json({ ok: false });

  story.approvalPartner = true;

  if (story.approvalOwner && story.approvalPartner) {
    story.approved = true;
  }

  await story.save();

  res.json({ ok: true, approved: story.approved });
});

app.get("/api/story/pending", async (req, res) => {
  const { username } = req.query;

  const stories = await Story.find({
    owner: username,
    approved: false
  }).sort({ createdAt: -1 }).lean();

  res.json({ ok: true, stories });
});

app.post("/api/story/resend", async (req, res) => {
  const { storyId } = req.body;

  const story = await Story.findById(storyId);
  if (!story) return res.json({ ok: false });

  const partnerUser = await User.findOne({ username: story.partner }).lean();
  if (partnerUser?.socketId) {
    io.to(partnerUser.socketId).emit("storyApprovalRequest", {
      storyId,
      from: story.owner
    });
  }

  res.json({ ok: true });
});

app.post("/api/relationship/request", async (req, res) => {
  const { requester, target, type } = req.body;

  const rel = await Relationship.create({
    requester,
    target,
    type,
    approvedRequester: true,
    approvedTarget: false,
    approved: false
  });

  const targetUser = await User.findOne({ username: target }).lean();

  if (targetUser?.socketId) {
    io.to(targetUser.socketId).emit("relationshipApprovalRequest", {
      relationshipId: rel._id,
      from: requester,
      type
    });
  } else {
    await DM.create({
  from: "SYSTEM",
  to: target,
  text: `${requester} wants to add a relationship: ${type}.`,
  type: "relationshipApproval",
  relationshipId: rel._id,
  time: new Date()
});

  }

  res.json({ ok: true });
});

app.post("/api/relationship/approve", async (req, res) => {
  const { relationshipId } = req.body;

  const rel = await Relationship.findById(relationshipId);
  if (!rel) return res.json({ ok: false });

  rel.approvedTarget = true;

  if (rel.approvedRequester && rel.approvedTarget) {
    rel.approved = true;
  }

  await rel.save();

  res.json({ ok: true, approved: rel.approved });
});

app.get("/api/relationship/list", async (req, res) => {
  const { username } = req.query;

  const rels = await Relationship.find({
    approved: true,
    $or: [
      { requester: username },
      { target: username }
    ]
  }).lean();

  res.json({ ok: true, relationships: rels });
});

app.get("/api/relationship/pending", async (req, res) => {
  const { username } = req.query;

  const rels = await Relationship.find({
    requester: username,
    approved: false
  }).lean();

  res.json({ ok: true, relationships: rels });
});

// ---------- API: RELATIONSHIP TIMELINE ----------
app.get("/api/relationship/timeline", async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.json({ ok: false, error: "missing_username" });
  }

  try {
    const rels = await Relationship.find({
      approved: true,
      $or: [
        { requester: username },
        { target: username }
      ]
    })
    .sort({ createdAt: 1 })  // oldest → newest
    .lean();

    // map to a simple timeline structure
    const timeline = rels.map(rel => {
      const isRequester = rel.requester === username;
      const other =
        isRequester ? rel.target : rel.requester;

      return {
        id: rel._id,
        type: rel.type,
        with: other,
        role: isRequester ? "requester" : "target",
        approvedAt: rel.createdAt
      };
    });

    res.json({ ok: true, timeline });
  } catch (err) {
    console.error("relationship timeline error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/block-user", async (req, res) => {
  const { username, target } = req.body;

  if (!username || !target) {
    return res.json({ ok: false, error: "missing_fields" });
  }

  try {
    await User.updateOne(
      { username },
      { $addToSet: { blockedUsers: target } }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("block-user error:", err);
    return res.json({ ok: false, error: "server_error" });
  }
});

app.post("/api/unblock-user", async (req, res) => {
  const { username, target } = req.body;

  if (!username || !target) {
    return res.json({ ok: false, error: "missing_fields" });
  }

  try {
    await User.updateOne(
      { username },
      { $pull: { blockedUsers: target } }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("unblock-user error:", err);
    return res.json({ ok: false, error: "server_error" });
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await User.find()
      .select("username display email imageUrl info stats color language age role banned online createdAt")
      .lean();

    res.json({ ok: true, users });
  } catch (err) {
    console.error("Admin user fetch error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/ban", requireAdmin, async (req, res) => {
  try {
    const { username, banned } = req.body;
    if (!username) return res.status(400).json({ ok: false, error: "missing_username" });

    const update = { banned: !!banned };
    if (banned) {
      update.online = false;
      update.socketId = null;
    }

    const user = await User.findOneAndUpdate(
      { username },
      update,
      { new: true }
    );

    if (!user) return res.status(404).json({ ok: false, error: "not_found" });

    // Kick banned user if currently connected
    if (banned) {
      const live = [...io.sockets.sockets.values()].find(s => s.username === username);
      if (live) {
        live.emit("forceLogout", { reason: "banned" });
        live.disconnect(true);
      }
    }

    const onlineUsers = await User.find({ online: true })
      .select("username display imageUrl info stats color language age createdAt -_id")
      .lean();
    io.emit("presence", onlineUsers);

    res.json({ ok: true, user: { username: user.username, banned: user.banned } });
  } catch (err) {
    console.error("admin ban error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/reset-password", requireAdmin, async (req, res) => {
  try {
    const { username, newPassword } = req.body;
    if (!username || !newPassword) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    const user = await User.findOneAndUpdate(
      { username },
      { 
        $set: { passwordHash: hash },
        $unset: { password: 1 }
      },
      { new: true }
    );

    if (!user) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("admin reset-password error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/delete-user", requireAdmin, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ ok: false, error: "missing_username" });

    const user = await User.findOneAndDelete({ username });
    if (!user) return res.status(404).json({ ok: false, error: "not_found" });

    if (user.socketId) {
      const sock = io.sockets.sockets.get(user.socketId);
      if (sock) sock.disconnect(true);
    }

    // Clean related data
    await Promise.all([
      DM.deleteMany({ $or: [{ from: username }, { to: username }] }),
      Relationship.deleteMany({ $or: [{ requester: username }, { target: username }] }),
      Story.deleteMany({ $or: [{ owner: username }, { partner: username }] }),
      PublicMessage.deleteMany({ from: username }),
      RoomMessage.deleteMany({ from: username })
    ]);

    const onlineUsers = await User.find({ online: true })
      .select("username display imageUrl info stats color language age createdAt -_id")
      .lean();
    io.emit("presence", onlineUsers);

    res.json({ ok: true });
  } catch (err) {
    console.error("admin delete-user error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [totalUsers, onlineUsers, bannedUsers, totalLogs, logins24h, fails24h, regs24h] =
      await Promise.all([
        User.countDocuments(),
        User.countDocuments({ online: true }),
        User.countDocuments({ banned: true }),
        IpLog.countDocuments(),
        IpLog.countDocuments({ action: "login_success", createdAt: { $gte: since } }),
        IpLog.countDocuments({
          action: { $in: ["login_fail", "login_banned", "login_error"] },
          createdAt: { $gte: since }
        }),
        IpLog.countDocuments({ action: "register", createdAt: { $gte: since } })
      ]);

    res.json({
      ok: true,
      totalUsers,
      onlineUsers,
      bannedUsers,
      totalLogs,
      last24h: { logins24h, fails24h, regs24h }
    });
  } catch (err) {
    console.error("admin stats error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/admin/top-ips", requireAdmin, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const ips = await IpLog.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: "$ip", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ]);

    res.json({ ok: true, ips });
  } catch (err) {
    console.error("admin top-ips error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/story/load", async (req, res) => {
  const { a, b, fromDate } = req.body;

  const messages = await DM.find({
    $or: [
      { from: a, to: b },
      { from: b, to: a }
    ],
    time: { $gte: new Date(fromDate) }
  }).sort({ time: 1 }).lean();

  res.json({ ok: true, messages });
});


app.get("/api/story/list", async (req, res) => {
  const { username } = req.query;

  const stories = await Story.find({
    owner: username,
    approved: true
  }).sort({ createdAt: -1 }).lean();

  res.json({ ok: true, stories });
});


app.post("/api/check-availability", async (req, res) => {
  try {
    const username = (req.body.username || "").trim().toLowerCase();
    const email = (req.body.email || "").trim().toLowerCase();

    const conflict = {
      username: false,
      email: false
    };

    if (!username && !email) {
      return res.json({ ok: true, conflict });
    }

    const or = [];
    if (username) or.push({ username });
    if (email) or.push({ email });

    const matches = await User.find({ $or: or }).lean();

    for (const user of matches) {
      if (username && user.username?.toLowerCase() === username) conflict.username = true;
      if (email && user.email?.toLowerCase() === email) conflict.email = true;
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

app.post("/api/send-dm", async (req, res) => {
  const { from, to, text } = req.body;

  const dm = await DM.create({
    from,
    to,
    text,
    time: new Date(),
    type: "supportReport"
  });

  const target = await User.findOne({ username: to }).lean();

  if (target?.socketId) {
    io.to(target.socketId).emit("privateMessage", dm);
  }

  res.json({ ok: true });
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
  let { username, email, password, display, age, stats, info, color, language, imageUrl } = req.body;
  username = (username || '').trim().toLowerCase();
  email = (email || '').trim().toLowerCase();

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
  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password;
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

    let match = false;
    if (user.passwordHash && user.passwordHash.startsWith('$2')) {
      try {
        match = await bcrypt.compare(password, user.passwordHash);
      } catch (err) {
        console.error('Bcrypt compare error:', err);
      }
    }

    // Fallback for plain text or old field name, including MD5
    if (!match) {
      const storedPassword = user.passwordHash || user.password;
      if (storedPassword) {
        if (storedPassword === password) {
          match = true;
        } else {
          // Check for MD5
          const md5 = crypto.createHash('md5').update(password).digest('hex');
          if (storedPassword === md5) {
            match = true;
          }
        }
      }

      // If matched via fallback, upgrade to bcrypt
      if (match) {
        console.log(`Upgrading password for user: ${username}`);
        const newHash = await bcrypt.hash(password, 10);
        await User.updateOne(
          { _id: user._id },
          { 
            $set: { passwordHash: newHash },
            $unset: { password: 1 } 
          }
        );
      }
    }

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

  if (!a || !b) {
    return res.json({ ok: false, messages: [] });
  }

  // Conversation between a and b, plus system notices delivered to either party
  // that are related to this pair (story/relationship approvals)
  const messages = await DM.find({
    $or: [
      { from: a, to: b },
      { from: b, to: a },
      { from: "SYSTEM", to: a, type: { $in: ["storyApproval", "relationshipApproval", "system"] } },
      { from: "SYSTEM", to: b, type: { $in: ["storyApproval", "relationshipApproval", "system"] } }
    ]
  })
    .sort({ time: 1 })
    .lean();

  // Filter system messages that don't mention the other party when possible
  const filtered = messages.filter(m => {
    if (m.from !== "SYSTEM") return true;
    // Keep system messages addressed to the requesting user (a) about the partner (b)
    if (m.to === a && m.text && m.text.toLowerCase().includes(String(b).toLowerCase())) return true;
    if (m.to === a && (m.type === "storyApproval" || m.type === "relationshipApproval")) return true;
    return false;
  });

  res.json({ ok: true, messages: filtered });
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
    if (m.from && m.from !== username && m.from !== "SYSTEM") partners.add(m.from);
    if (m.to && m.to !== username && m.to !== "SYSTEM") partners.add(m.to);
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
      .select("username display imageUrl info stats color language age createdAt")
      .lean();

    // Flatten wins/losses for clients that expect top-level fields
    const normalized = users.map(u => ({
      ...u,
      wins: u.stats?.wins ?? 0,
      losses: u.stats?.losses ?? 0
    }));

    res.json({ success: true, users: normalized });
  } catch (err) {
    console.error("Error fetching all users:", err);
    res.status(500).json({ success: false });
  }
});

// ---------- API: JSON 404 HANDLER ----------
// Any /api/* path that matched no route above returns a consistent JSON 404
// instead of Express's default HTML "Cannot GET ..." page, so API consumers
// always get a parseable JSON response.
app.use('/api', (req, res) => {
  return res.status(404).json({
    ok: false,
    error: 'not_found',
    message: `No API endpoint matches ${req.method} ${req.originalUrl}`
  });
});


// ---------- SOCKET.IO ----------
const onlineByUsername = new Map();

io.on("connection", async (socket) => {
  console.log("socket connected", socket.id);

  const rooms = await Room.find().lean();
  socket.emit("roomsList", rooms);

  async function emitPresence() {
    const onlineUsers = await User.find({ online: true })
      .select("username display imageUrl info stats color language age createdAt -_id")
      .lean();

    const normalized = onlineUsers.map(u => ({
      ...u,
      wins: u.stats?.wins ?? 0,
      losses: u.stats?.losses ?? 0
    }));

    io.emit("presence", normalized);
  }

  socket.on("login", async (user) => {
    if (!user?.username) return;
    socket.username = user.username;
    const u = await User.findOneAndUpdate(
      { username: user.username },
      { online: true, socketId: socket.id },
      { new: true }
    );
    if (!u) return;
    if (u.banned) {
      socket.emit("forceLogout", { reason: "banned" });
      socket.disconnect(true);
      return;
    }
    await emitPresence();
  });

  socket.on("chatClosed", async ({ username }) => {
    if (!username) return;

    await User.findOneAndUpdate(
      { username },
      { online: false }
    );

    await emitPresence();
  });

  socket.on("forceLogout", async ({ username }) => {
    if (!username) return;

    await User.findOneAndUpdate(
      { username },
      { online: false, socketId: null }
    );

    await emitPresence();
  });

  socket.on("requestRoomMembers", async ({ room }) => {
    if (!room) return;
    await updateRoomMembers(room);
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

    // ⭐ Fetch sender avatar ONCE
    const sender = await User.findOne({ username: msg.from }).lean();
    const avatarUrl = sender?.imageUrl || null;

    // ⭐ Send Discord webhook
    await sendDiscordWebhookMessage(
      msg.display || msg.from,
      msg.text,
      avatarUrl
    );

    // ⭐ Fetch fresh online users right before emitting
    const onlineUsers = await User.find({ online: true }).lean();

    // ⭐ Use Promise.all to await all translations in parallel
    await Promise.all(
      onlineUsers.map(async u => {
        if (!u.socketId) return; // Skip if no active socket
        
        const translated = await translateText(enriched.text, u.language || "en");

        io.to(u.socketId).emit("publicMessage", {
          ...enriched,
          text: translated,
          avatar: avatarUrl
        });
      })
    );

  } catch (err) {
    console.error("Error in publicMessage:", err);
  }
});


  socket.on("privateMessage", async pm => {
    try {
      if (!pm?.from || !pm?.to) return;

      const sender = await User.findOne({ username: pm.from }).lean();
      const receiver = await User.findOne({ username: pm.to }).lean();

      if (!receiver) {
        socket.emit("pmError", { reason: "User not found" });
        return;
      }

      // Block checks (either direction)
      if (receiver.blockedUsers?.includes(pm.from) || sender?.blockedUsers?.includes(pm.to)) {
        console.log(`DM blocked: ${pm.from} → ${pm.to}`);
        socket.emit("pmError", { reason: "User unavailable" });
        return;
      }

      // IMAGE MESSAGE
      if (pm.imageUrl) {
        const saved = await DM.create({
          from: pm.from,
          to: pm.to,
          imageUrl: pm.imageUrl,
          text: null,
          originalText: null,
          type: "image"
        });

        const payload = {
          from: pm.from,
          to: pm.to,
          imageUrl: pm.imageUrl,
          type: "image",
          time: saved.time
        };

        if (receiver.socketId) io.to(receiver.socketId).emit("privateMessage", payload);
        if (sender?.socketId) io.to(sender.socketId).emit("privateMessage", payload);
        return;
      }

      if (!pm.text) return;

      // TEXT MESSAGE
      const translated = await translateText(pm.text, receiver.language || "en");

      const saved = await DM.create({
        from: pm.from,
        to: pm.to,
        originalText: pm.text,
        text: translated,
        type: "normal"
      });

      if (receiver.socketId) {
        io.to(receiver.socketId).emit("privateMessage", {
          from: pm.from,
          to: pm.to,
          text: translated,
          type: "normal",
          time: saved.time
        });
      }

      if (sender?.socketId) {
        io.to(sender.socketId).emit("privateMessage", {
          from: pm.from,
          to: pm.to,
          text: pm.text,
          type: "normal",
          time: saved.time
        });
      }
    } catch (err) {
      console.error("privateMessage error:", err);
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
    if (!msg?.room) return;

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

    // Only emit to sockets currently in this room
    const sockets = await io.in(msg.room).fetchSockets();

    if (msg.imageUrl) {
      io.to(msg.room).emit("roomMessage", enriched);
      return;
    }

    await Promise.all(
      sockets.map(async s => {
        if (!s.username) {
          io.to(s.id).emit("roomMessage", enriched);
          return;
        }
        const u = await User.findOne({ username: s.username }).lean();
        const translated = await translateText(enriched.text, u?.language || "en");
        io.to(s.id).emit("roomMessage", {
          ...enriched,
          text: translated
        });
      })
    );
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

  socket.on("createRoom", async ({ name, private: isPrivate }) => {
    if (!name || !socket.username) return;

    const room = await Room.create({
      name: String(name).trim().slice(0, 64),
      private: !!isPrivate,
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


  socket.on("disconnect", async () => {
    const u = await User.findOneAndUpdate(
      { socketId: socket.id },
      { online: false, socketId: null }
    );

    if (u) {
      await emitPresence();
    }

    if (socket.currentRoom) {
      updateRoomMembers(socket.currentRoom);
    }

    console.log("socket disconnected", socket.id);
  });
});

// ---------- START ----------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
