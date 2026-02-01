// ============================================================
// MDI SERVER V5.6 - STABLE & AGNOSTIQUE (ÉDITION SAAS PRO)
// + ADD-ON SAFE : control:chat_display_remote
// ============================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

let createClient;
try { ({ createClient } = require("@supabase/supabase-js")); }
catch (e) { createClient = null; }

const app = express();
app.use(express.json());

// ============================================================
// CORS SAAS
// ============================================================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-admin-secret", "x-room-id", "x-room-key"]
}));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ============================================================
// CONFIG
// ============================================================
const ADMIN_SECRET = process.env.ADMIN_SECRET || "MDI_SUPER_ADMIN_2026";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabaseEnabled =
  Boolean(SUPABASE_URL) &&
  Boolean(SUPABASE_SERVICE_ROLE_KEY) &&
  typeof createClient === "function";

const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    })
  : null;

// ============================================================
// MÉMOIRE VIVE
// ============================================================
const ROOMS = Object.create(null);

function getRoom(id) {
  if (!ROOMS[id]) {
    ROOMS[id] = { overlays: {}, history: [] };
  }
  return ROOMS[id];
}

function ensureOverlayState(roomId, overlay) {
  const r = getRoom(roomId);
  if (!r.overlays[overlay]) {
    r.overlays[overlay] = { state: "idle", data: {} };
  }
  return r.overlays[overlay];
}

// ============================================================
// QUIZ / SONDAGE HELPERS
// ============================================================
function getVoteStats(roomHistory) {
  const stats = { A:0, B:0, C:0, D:0, total:0 };
  roomHistory.forEach(v => {
    if (stats[v.choice] !== undefined) stats[v.choice]++;
    stats.total++;
  });
  return stats;
}

function calculatePercents(stats) {
  const t = stats.total || 1;
  return {
    A: ((stats.A / t) * 100).toFixed(1),
    B: ((stats.B / t) * 100).toFixed(1),
    C: ((stats.C / t) * 100).toFixed(1),
    D: ((stats.D / t) * 100).toFixed(1)
  };
}

// ============================================================
// PATCH ABCD ROBUSTE
// ============================================================
function normalizeVoteText(raw) {
  if (!raw) return "";
  return String(raw)
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function extractChoiceABCD(voteText) {
  const s = normalizeVoteText(voteText);
  if (!s) return null;

  const exact = s.match(/^([ABCD])[\)\]\.\!\?:,\-]*$/);
  if (exact) return exact[1];

  const token = s.match(/(^|[^A-Z0-9])([ABCD])([^A-Z0-9]|$)/);
  if (token) return token[2];

  return null;
}

// ============================================================
// AUTH MIDDLEWARES
// ============================================================
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET) {
    return res.status(403).json({ ok:false, error:"Bad Secret" });
  }
  next();
}

async function requireClientAuth(req, res, next) {
  if (!supabaseEnabled) return res.json({ ok:false, error:"no_db" });

  const roomId = req.headers["x-room-id"];
  const roomKey = req.headers["x-room-key"];

  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("room_id", roomId)
    .limit(1)
    .maybeSingle();

  if (!client) return res.status(404).json({ ok:false, error:"Client inconnu" });
  if (client.room_key !== roomKey) return res.status(403).json({ ok:false, error:"Mauvaise clé" });

  req.client = client;
  next();
}

// ============================================================
// ROUTES API
// ============================================================
app.get("/", (_, res) => res.send("MDI Server V5.6 Pro Online"));

app.get("/debug/questions", async (req, res) => {
  const room = String(req.query.room || "").trim();
  if (!room || !supabaseEnabled) return res.json({ ok:false });

  const { data } = await supabase
    .from("questions")
    .select("*")
    .eq("room_id", room)
    .order("order_index");

  res.json({ ok:true, data:data || [] });
});

// ============================================================
// SOCKET.IO
// ============================================================
io.on("connection", (socket) => {

  socket.on("rejoindre_salle", (roomId) => {
    socket.join(roomId);
  });

  socket.on("overlay:join", async (p) => {
    if (!supabaseEnabled) return;

    const { data: client } = await supabase
      .from("clients")
      .select("*")
      .eq("room_id", p.room)
      .maybeSingle();

    if (!client || !client.active || client.room_key !== p.key) {
      socket.emit("overlay:forbidden", { reason:"auth" });
      return;
    }

    socket.join(p.room);

    const s = ensureOverlayState(p.room, p.overlay);
    if (p.overlay === "quiz_ou_sondage") {
      const r = getRoom(p.room);
      if (r.history.length > 0) {
        s.data.percents = calculatePercents(getVoteStats(r.history));
      }
    }

    socket.emit("overlay:state", {
      overlay: p.overlay,
      state: s.state,
      data: s.data
    });
  });

  // ============================================================
  // VOTES
  // ============================================================
  socket.on("nouveau_vote", (payload) => {
    const room = payload.room;
    const user = payload.user || "Anonyme";
    const rawVote = normalizeVoteText(payload.vote || "");

    if (!room || !rawVote) return;
    const r = getRoom(room);

    const choice = extractChoiceABCD(rawVote);
    if (choice) {
      const already = r.history.find(v => v.user === user && user !== "Anonyme");
      if (!already) {
        r.history.push({ user, choice, time: Date.now() });

        const s = ensureOverlayState(room, "quiz_ou_sondage");
        s.data.percents = calculatePercents(getVoteStats(r.history));

        io.to(room).emit("overlay:state", {
          overlay: "quiz_ou_sondage",
          state: s.state,
          data: s.data
        });
      }
    }

    // 🔥 CANAL UNIVERSEL
    io.to(room).emit("raw_vote", { user, vote: rawVote });
  });

  // ============================================================
  // CONTROLS EXISTANTS
  // ============================================================
  socket.on("control:set_state", (p) => {
    const s = ensureOverlayState(p.room, p.overlay);
    s.state = p.state;
    io.to(p.room).emit("overlay:state", {
      overlay: p.overlay,
      state: s.state,
      data: s.data
    });
  });

  socket.on("control:load_question", async (p) => {
    const r = getRoom(p.room);
    r.history = [];

    const { data: q } = await supabase
      .from("questions")
      .select("*")
      .eq("room_id", p.room)
      .eq("question_key", p.question_key)
      .maybeSingle();

    if (!q) return;

    const s = ensureOverlayState(p.room, p.overlay);
    s.state = "question";
    s.data = {
      question: {
        id: q.question_key,
        type: q.type,
        prompt: q.prompt,
        options: {
          A: q.option_a||"",
          B: q.option_b||"",
          C: q.option_c||"",
          D: q.option_d||""
        },
        correct: q.type === "quiz" ? q.correct_option : null
      },
      percents: { A:0, B:0, C:0, D:0 }
    };

    io.to(p.room).emit("overlay:state", {
      overlay: p.overlay,
      state: "question",
      data: s.data
    });
  });

  socket.on("control:idle", (p) => {
    const s = ensureOverlayState(p.room, p.overlay);
    s.state = "idle";
    s.data = {};
    io.to(p.room).emit("overlay:state", {
      overlay: p.overlay,
      state: "idle",
      data: {}
    });
  });

  // ============================================================
  // ✅ ADD-ON SAFE : TELECOMMANDE CHAT -> OVERLAY
  // ============================================================
  socket.on("control:chat_display_remote", (p) => {
    try {
      const room = String(p?.room || "").trim();
      if (!room) return;
      io.to(room).emit("control:chat_display_remote", p);
    } catch (e) {
      console.warn("[chat_display_remote] error", e);
    }
  });

});

// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 MDI Server V5.6 Pro Online on ${PORT}`)
);
