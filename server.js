// ============================================================
// MDI SERVER V5.18 - COMPLET
// ✅ Tout V5.17 préservé (ZÉRO RÉGRESSION)
// ✅ CHAT MDI : chat privé par room, token opaque, participants uniques
// ✅ CHAT MDI : gate extension — quand Chat MDI actif, nouveau_vote ignoré
// ✅ CHAT MDI : roue auto-alimentée par participants chat quand actif
// ✅ CHAT MDI : commentaires avec auteur injecté depuis chat
// ✅ CHAT MDI : toggle via télécommande et Stream Deck (chat_toggle)
// ============================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
let createClient;
try { ({ createClient } = require("@supabase/supabase-js")); } catch (e) { createClient = null; }

const app = express();
app.use(express.json());

// CONFIGURATION CORS RIGOUREUSE POUR SAAS
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "x-admin-secret", "x-room-id", "x-room-key"]
}));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- CONFIGURATION ---
const ADMIN_SECRET = process.env.ADMIN_SECRET || "MDI_SUPER_ADMIN_2026";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabaseEnabled = Boolean(SUPABASE_URL) && Boolean(SUPABASE_SERVICE_ROLE_KEY) && typeof createClient === "function";
const supabase = supabaseEnabled ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;

// --- MÉMOIRE VIVE (ROOMS) ---
const ROOMS = Object.create(null);

// --- CHAT MDI : tokens opaques (token → roomId, sans exposer room_id/key dans l'URL) ---
const CHAT_TOKENS = Object.create(null);

function generateChatToken() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let t = "";
  for (let i = 0; i < 10; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

function getRoom(id) {
  if (!ROOMS[id]) {
    ROOMS[id] = { overlays: {}, history: [], presence: {} };
  }
  // Initialisation défensive du chat (backward-compat avec rooms déjà en mémoire)
  if (!ROOMS[id].chat) {
    ROOMS[id].chat = { active: false, token: null, participants: {}, messages: [] };
  }
  return ROOMS[id];
}

// Helper : snapshot participants pour broadcast (sans les clés internes)
function chatParticipantsList(room) {
  const r = ROOMS[room];
  if (!r || !r.chat) return [];
  return Object.values(r.chat.participants).map(p => ({ prenom: p.prenom, nom: p.nom }));
}

function ensureOverlayState(roomId, overlay) {
  const r = getRoom(roomId);
  if (!r.overlays[overlay]) r.overlays[overlay] = { state: "idle", data: {} };
  return r.overlays[overlay];
}

// --- Throttle nuage : évite de saturer la room à chaque vote ---
const _nuageThrottle = Object.create(null);

function emitNuageState(room) {
  const key = room;
  if (_nuageThrottle[key]) return; // déjà planifié
  _nuageThrottle[key] = setTimeout(() => {
    delete _nuageThrottle[key];
    const s = ensureOverlayState(room, "nuage_de_mots");
    if (s.state !== "active") return;
    io.to(room).emit("overlay:state", {
      overlay: "nuage_de_mots",
      state: "active",
      data: s.data
    });
  }, 1000);
}

// --- LOGIQUE CALCULS QUIZ ---
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

// --- MIDDLEWARES D'AUTH ---
function requireAdmin(req, res, next) {
  const incomingSecret = req.headers["x-admin-secret"];
  if (incomingSecret !== ADMIN_SECRET) {
    console.warn(`[AUTH] Admin Refusé. Reçu: ${incomingSecret}`);
    return res.status(403).json({ ok: false, error: "Bad Secret" });
  }
  next();
}

async function requireClientAuth(req, res, next) {
  if (!supabaseEnabled) return res.json({ ok: false, error: "no_db" });
  const roomId = req.headers["x-room-id"];
  const roomKey = req.headers["x-room-key"];
  const { data: client } = await supabase.from("clients").select("*").eq("room_id", roomId).limit(1).maybeSingle();
  if (!client) return res.status(404).json({ ok: false, error: "Client inconnu" });
  if (client.room_key !== roomKey) return res.status(403).json({ ok: false, error: "Mauvaise clé" });
  if (!client.active) return res.status(403).json({ ok: false, error: "Compte désactivé" });
  if (client.expires_at && new Date(client.expires_at) < new Date()) return res.status(403).json({ ok: false, error: "Accès expiré" });
  req.client = client;
  next();
}

// --- ROUTES API ---

app.get("/health", (req, res) => {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  res.json({
    status: "ok",
    version: "5.18",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(uptime),
    memory: {
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + " MB",
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + " MB"
    },
    supabase: supabaseEnabled ? "connected" : "disabled",
    rooms: Object.keys(ROOMS).length
  });
});

app.get("/", (req, res) => res.send("MDI Server V5.18 Online"));

// Validation token Chat MDI (appelé par la page chat au chargement)
app.get("/api/chat/validate", (req, res) => {
  const { t } = req.query;
  if (!t) return res.status(400).json({ ok: false, error: "missing_token" });
  const tokenData = CHAT_TOKENS[t];
  if (!tokenData) return res.status(404).json({ ok: false, error: "invalid_token" });
  const r = ROOMS[tokenData.room];
  if (!r || !r.chat || !r.chat.active) return res.status(410).json({ ok: false, error: "chat_inactive" });
  return res.json({ ok: true, active: true });
});

app.get("/debug/questions", requireAdmin, async (req, res) => {
  const room = String(req.query.room || "").trim();
  if (!room || !supabaseEnabled) return res.json({ ok: false, error: "no_room" });
  const { data } = await supabase.from("questions").select("*").eq("room_id", room).order("order_index");
  res.json({ ok: true, data: data || [] });
});

app.get("/api/timer/status", async (req, res) => {
  const roomId = req.headers["x-room-id"];
  const roomKey = req.headers["x-room-key"];

  if (!supabaseEnabled) {
    return res.status(503).json({ ok: false, error: "no_db" });
  }

  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("room_id", roomId)
    .limit(1)
    .maybeSingle();

  if (!client || client.room_key !== roomKey) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }

  const room = getRoom(roomId);
  const timerState = room.overlays["timer_chrono"] || { state: "idle", data: {} };
  const mode = timerState.data.mode || "timer";
  const seconds = timerState.data.seconds || 0;
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  const display = mode === "timer"
    ? `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `00:00:00`;

  res.json({ ok: true, mode, state: timerState.state, seconds, display });
});

// API control pour Stream Deck
app.post("/api/control", async (req, res) => {
  const roomId = req.headers["x-room-id"];
  const roomKey = req.headers["x-room-key"];
  const { action, payload } = req.body;

  if (!supabaseEnabled) {
    return res.status(503).json({ ok: false, error: "no_db" });
  }

  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("room_id", roomId)
    .limit(1)
    .maybeSingle();

  if (!client || client.room_key !== roomKey) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }

  console.log(`🎮 [API] ${roomId} - Action: ${action}`, payload);

  const room = roomId;

  if (action === "timer_preset") {
    const seconds = parseInt(payload?.seconds, 10);
    if (Number.isFinite(seconds)) {
      const s = ensureOverlayState(room, "timer_chrono");
      s.data.seconds = seconds;
      io.to(room).emit("control:timer_chrono", { action: "set_time", seconds });
      return res.json({ ok: true, action: "timer_preset", seconds });
    }
  }
  if (action === "timer_add_10min") { io.to(room).emit("control:timer_chrono", { action: "increment_time", seconds:  600 }); return res.json({ ok: true, action }); }
  if (action === "timer_add_1min")  { io.to(room).emit("control:timer_chrono", { action: "increment_time", seconds:   60 }); return res.json({ ok: true, action }); }
  if (action === "timer_add_10sec") { io.to(room).emit("control:timer_chrono", { action: "increment_time", seconds:   10 }); return res.json({ ok: true, action }); }
  if (action === "timer_add_1sec")  { io.to(room).emit("control:timer_chrono", { action: "increment_time", seconds:    1 }); return res.json({ ok: true, action }); }
  if (action === "timer_sub_10min") { io.to(room).emit("control:timer_chrono", { action: "increment_time", seconds: -600 }); return res.json({ ok: true, action }); }
  if (action === "timer_sub_1min")  { io.to(room).emit("control:timer_chrono", { action: "increment_time", seconds:  -60 }); return res.json({ ok: true, action }); }
  if (action === "timer_sub_10sec") { io.to(room).emit("control:timer_chrono", { action: "increment_time", seconds:  -10 }); return res.json({ ok: true, action }); }
  if (action === "timer_sub_1sec")  { io.to(room).emit("control:timer_chrono", { action: "increment_time", seconds:   -1 }); return res.json({ ok: true, action }); }
  if (action === "timer_start")        { io.to(room).emit("control:timer_chrono", { action: "start" });        return res.json({ ok: true, action }); }
  if (action === "timer_pause")        { io.to(room).emit("control:timer_chrono", { action: "pause" });        return res.json({ ok: true, action }); }
  if (action === "timer_reset")        { io.to(room).emit("control:timer_chrono", { action: "reset" });        return res.json({ ok: true, action }); }
  if (action === "timer_toggle_pause") { io.to(room).emit("control:timer_chrono", { action: "toggle_pause" }); return res.json({ ok: true, action }); }
  if (action === "timer_mode_chrono") {
    const s = ensureOverlayState(room, "timer_chrono"); s.data.mode = "chrono";
    io.to(room).emit("control:timer_chrono", { action: "set_mode", mode: "chrono" }); return res.json({ ok: true, action });
  }
  if (action === "timer_mode_timer") {
    const s = ensureOverlayState(room, "timer_chrono"); s.data.mode = "timer";
    io.to(room).emit("control:timer_chrono", { action: "set_mode", mode: "timer" }); return res.json({ ok: true, action });
  }

  if (action === "comment_show") {
    const messageId = payload?.messageId;
    if (messageId) {
      const s = ensureOverlayState(room, "commentaires");
      if (!s.data.queue) s.data.queue = [];
      const msg = s.data.queue.find(m => m.id === messageId);
      if (!msg) return res.status(404).json({ ok: false, error: "message_not_found", messageId });
      msg.displayed = true;
      s.data.current = { id: msg.id, author: msg.author, text: msg.text };
      io.to(room).emit("overlay:state", { overlay: "commentaires", state: s.state, data: s.data });
      return res.json({ ok: true, action, messageId });
    }
  }
  if (action === "comment_hide") {
    const s = ensureOverlayState(room, "commentaires");
    s.data.current = null;
    io.to(room).emit("overlay:state", { overlay: "commentaires", state: s.state, data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "commentaires_on") {
    const s = ensureOverlayState(room, "commentaires");
    s.state = "active";
    s.data.activatedAt = Date.now();
    if (!s.data.flux)    s.data.flux    = [];
    if (!s.data.queue)   s.data.queue   = [];
    if (!s.data.current) s.data.current = null;
    if (!s.data.minWords) s.data.minWords = 4;
    console.log(`🎮 [API] ${room} - Commentaires ON`);
    io.to(room).emit("overlay:state", { overlay: "commentaires", state: "active", data: s.data });
    return res.json({ ok: true, action });
  }
  if (action === "commentaires_off") {
    const s = ensureOverlayState(room, "commentaires");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Commentaires OFF`);
    io.to(room).emit("overlay:state", { overlay: "commentaires", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "match_team_a_increment" || action === "match_team_a_decrement" ||
      action === "match_team_b_increment" || action === "match_team_b_decrement") {
    const team  = action.includes("_a_") ? 'A' : 'B';
    const delta = action.includes("_increment") ? 1 : -1;
    const s = ensureOverlayState(room, "match_equipes");
    if (!s.data.teamA) s.data.teamA = { name: "ÉQUIPE A", score: 0 };
    if (!s.data.teamB) s.data.teamB = { name: "ÉQUIPE B", score: 0 };
    if (team === 'A') s.data.teamA.score = Math.max(0, s.data.teamA.score + delta);
    else              s.data.teamB.score = Math.max(0, s.data.teamB.score + delta);
    // Auto-activation : si l'overlay est idle (pas de match_on préalable depuis la télécommande),
    // on active automatiquement pour que le Stream Deck puisse piloter sans pré-requis.
    if (s.state === "idle") s.state = "active";
    console.log(`📊 [MATCH] ${room} - ${team} ${delta > 0 ? '+' : ''}${delta} → ${team === 'A' ? s.data.teamA.score : s.data.teamB.score}`);
    io.to(room).emit("overlay:state", { overlay: "match_equipes", state: s.state, data: s.data });
    return res.json({ ok: true, action });
  }
  if (action === "match_reset") {
    const s = ensureOverlayState(room, "match_equipes");
    if (!s.data.teamA) s.data.teamA = { name: "", score: 0, color: "" };
    if (!s.data.teamB) s.data.teamB = { name: "", score: 0, color: "" };
    s.data.teamA.score = 0;
    s.data.teamB.score = 0;
    console.log(`🔄 [MATCH] ${room} - Reset 0-0`);
    io.to(room).emit("overlay:state", { overlay: "match_equipes", state: s.state, data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "match_on") {
    const s = ensureOverlayState(room, "match_equipes");
    s.state = "active";
    s.data.activatedAt = Date.now();
    if (!s.data.teamA) s.data.teamA = { name: "ÉQUIPE A", score: 0 };
    if (!s.data.teamB) s.data.teamB = { name: "ÉQUIPE B", score: 0 };
    console.log(`🎮 [API] ${room} - Match ON (scores A:${s.data.teamA.score} B:${s.data.teamB.score})`);
    io.to(room).emit("overlay:state", { overlay: "match_equipes", state: "active", data: s.data });
    return res.json({ ok: true, action, scoreA: s.data.teamA.score, scoreB: s.data.teamB.score });
  }

  if (action === "nuage_on") {
    const sRoue = ensureOverlayState(room, "roue_loto");
    if (sRoue.state !== "idle" && sRoue.state !== "standby") {
      sRoue.state = "idle";
      io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "idle", data: {} });
    }
    const sQuiz = ensureOverlayState(room, "quiz_ou_sondage");
    if (sQuiz.state !== "idle") {
      sQuiz.state = "idle";
      io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "idle", data: {} });
    }
    const s = ensureOverlayState(room, "nuage_de_mots");
    s.state = "active";
    s.data.activatedAt = Date.now();
    s.data.words = {};
    console.log(`🎮 [API] ${room} - Nuage ON`);
    io.to(room).emit("overlay:state", { overlay: "nuage_de_mots", state: "active", data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "nuage_off") {
    const s = ensureOverlayState(room, "nuage_de_mots");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Nuage OFF`);
    io.to(room).emit("overlay:state", { overlay: "nuage_de_mots", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "roue_on") {
    const sNuage = ensureOverlayState(room, "nuage_de_mots");
    if (sNuage.state !== "idle") {
      sNuage.state = "idle";
      io.to(room).emit("overlay:state", { overlay: "nuage_de_mots", state: "idle", data: {} });
    }
    const sQuiz = ensureOverlayState(room, "quiz_ou_sondage");
    if (sQuiz.state !== "idle") {
      sQuiz.state = "idle";
      io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "idle", data: {} });
    }
    const s = ensureOverlayState(room, "roue_loto");
    s.state = "standby";
    s.data.activatedAt = Date.now();
    if (!s.data.participants)         s.data.participants         = [];
    if (!s.data.remote_participants)  s.data.remote_participants  = [];
    if (!s.data.feed_mode)            s.data.feed_mode            = "chat";
    if (!s.data.consecutifMode)       s.data.consecutifMode       = false;
    console.log(`🎮 [API] ${room} - Roue ON (standby)`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "standby", data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "roue_off") {
    const s = ensureOverlayState(room, "roue_loto");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Roue OFF`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "roue_show") {
    const s = ensureOverlayState(room, "roue_loto");
    if (s.state !== "standby") return res.status(409).json({ ok: false, error: "roue_not_in_standby", state: s.state });
    if (!s.data.remote_participants) s.data.remote_participants = [];
    if (!s.data.feed_mode || s.data.feed_mode === "chat") {
      s.state = "collecting";
      s.data.participants = [];
      s.data.winnerName = null;
      console.log(`🎮 [API] ${room} - Roue SHOW (chat → collecting)`);
      io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "collecting", data: s.data });
    } else {
      s.data.participants = [...s.data.remote_participants];
      s.state = "ready";
      s.data.winnerName = null;
      console.log(`🎮 [API] ${room} - Roue SHOW (remote → ready, ${s.data.participants.length} participants)`);
      io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "ready", data: s.data });
    }
    return res.json({ ok: true, action });
  }

  if (action === "roue_hide") {
    const s = ensureOverlayState(room, "roue_loto");
    s.state = "standby";
    console.log(`🎮 [API] ${room} - Roue HIDE (→ standby)`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "standby", data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "roue_reopen_collect") {
    const s = ensureOverlayState(room, "roue_loto");
    if (s.state === "collecting") return res.json({ ok: true, action, already: true });
    s.state = "collecting";
    console.log(`🎮 [API] ${room} - Roue reopen collect (sans vider les participants)`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "collecting", data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "roue_set_feed_mode") {
    const mode = payload?.mode;
    if (mode !== "chat" && mode !== "remote") return res.status(400).json({ ok: false, error: "mode_invalide, valeurs: chat|remote" });
    const s = ensureOverlayState(room, "roue_loto");
    s.data.feed_mode = mode;
    s.data.participants = [];
    if (s.state !== "idle" && s.state !== "standby") s.state = "standby";
    console.log(`🎮 [API] ${room} - Roue feed mode: ${mode}`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
    return res.json({ ok: true, action, mode });
  }

  if (action === "roue_clear_remote_participants") {
    const s = ensureOverlayState(room, "roue_loto");
    s.data.remote_participants = [];
    console.log(`🎮 [API] ${room} - Roue: liste organisateur vidée`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "roue_start_collect") {
    const s = ensureOverlayState(room, "roue_loto");
    // Rétrocompatibilité Stream Deck : ouvre la collecte sans vider les participants
    s.state = "collecting";
    console.log(`🎮 [API] ${room} - Roue start collect (rétrocompat)`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "collecting", data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "roue_stop_collect") {
    const s = ensureOverlayState(room, "roue_loto");
    if (s.state === "collecting") {
      s.state = "ready";
      console.log(`🎮 [API] ${room} - Roue stop collect`);
      io.to(room).emit("roue:stop_collect");
      io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "ready", data: s.data });
    }
    return res.json({ ok: true, action });
  }

  if (action === "roue_spin") {
    const s = ensureOverlayState(room, "roue_loto");
    // Étape 1 : winner → ready (retrait gagnant si mode consécutif)
    if (s.state === "winner") {
      if (s.data.consecutifMode && s.data.winnerName && s.data.participants) {
        const idx = s.data.participants.findIndex(pp => {
          const n = typeof pp === "string" ? pp : pp.name;
          return n === s.data.winnerName;
        });
        if (idx !== -1) s.data.participants.splice(idx, 1);
      }
      s.state = "ready";
      s.data.winnerName = null;
      console.log(`🎮 [API] ${room} - Roue: winner → ready`);
      io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "ready", data: s.data });
      return res.json({ ok: true, action, transitioned: "winner_to_ready" });
    }
    // Étape 2 : ready → spinning
    if (s.state !== "ready") {
      return res.status(409).json({ ok: false, error: "roue_not_ready", state: s.state });
    }
    s.state = "spinning";
    console.log(`🎮 [API] ${room} - Roue SPIN`);
    io.to(room).emit("roue:spin");
    return res.json({ ok: true, action });
  }

  if (action === "roue_reset") {
    const s = ensureOverlayState(room, "roue_loto");
    s.state = "standby";
    s.data.participants = [];
    s.data.winnerName = null;
    // remote_participants conservée intentionnellement
    console.log(`🎮 [API] ${room} - Roue reset (→ standby, liste organisateur conservée)`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "standby", data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "roue_consecutif_on") {
    const s = ensureOverlayState(room, "roue_loto");
    s.data.consecutifMode = true;
    console.log(`🎮 [API] ${room} - Roue mode consécutif ON`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "roue_consecutif_off") {
    const s = ensureOverlayState(room, "roue_loto");
    s.data.consecutifMode = false;
    console.log(`🎮 [API] ${room} - Roue mode consécutif OFF`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
    return res.json({ ok: true, action });
  }

  // Stream Deck : toggle Chat MDI ON/OFF
  if (action === "chat_toggle" || action === "chat_on" || action === "chat_off") {
    const r = getRoom(room);
    const shouldActivate = action === "chat_on"  ? true
                         : action === "chat_off" ? false
                         : !r.chat.active; // toggle

    if (!shouldActivate) {
      // --- Désactivation ---
      if (!r.chat.active) return res.json({ ok: true, action, active: false, noop: true });
      if (r.chat.token) delete CHAT_TOKENS[r.chat.token];
      r.chat.active = false;
      r.chat.token  = null;
      r.chat.participants = {};
      r.chat.messages = [];
      const roue = r.overlays.roue_loto;
      if (roue && roue.state === "collecting") {
        roue.state = "standby";
        roue.data.participants = [];
        io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "standby", data: roue.data });
      }
      console.log(`🎮 [API] ${room} - Chat MDI OFF (Stream Deck)`);
      io.to(room).emit("chat:state", { active: false, token: null, participants: [], messages: [] });
      return res.json({ ok: true, action, active: false });
    } else {
      // --- Activation ---
      if (r.chat.active) return res.json({ ok: true, action, active: true, token: r.chat.token, noop: true });
      let token;
      do { token = generateChatToken(); } while (CHAT_TOKENS[token]);
      CHAT_TOKENS[token] = { room };
      r.chat.active = true;
      r.chat.token  = token;
      r.chat.participants = {};
      r.chat.messages = [];
      const roue = r.overlays.roue_loto;
      if (roue && roue.state !== "idle") {
        roue.state = "collecting";
        if (!roue.data.participants) roue.data.participants = [];
        io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "collecting", data: roue.data });
      }
      console.log(`🎮 [API] ${room} - Chat MDI ON (Stream Deck, token: ${token})`);
      io.to(room).emit("chat:state", { active: true, token, participants: [], messages: [] });
      return res.json({ ok: true, action, active: true, token });
    }
  }

  if (action === "quiz_load") {
    const questionKey = payload?.question_key;
    if (!questionKey) {
      return res.status(400).json({ ok: false, error: "question_key_required" });
    }
    const sNuage = ensureOverlayState(room, "nuage_de_mots");
    if (sNuage.state !== "idle") {
      sNuage.state = "idle";
      io.to(room).emit("overlay:state", { overlay: "nuage_de_mots", state: "idle", data: {} });
    }
    const sRoue = ensureOverlayState(room, "roue_loto");
    if (sRoue.state !== "idle" && sRoue.state !== "standby") {
      sRoue.state = "idle";
      io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "idle", data: {} });
    }
    const r = getRoom(room);
    r.history = [];
    const { data: q } = await supabase
      .from("questions")
      .select("*")
      .eq("room_id", room)
      .eq("question_key", questionKey)
      .maybeSingle();
    if (!q) {
      return res.status(404).json({ ok: false, error: "question_not_found", question_key: questionKey });
    }
    const question = {
      id: q.question_key,
      type: q.type,
      prompt: q.prompt,
      options: { A: q.option_a||"", B: q.option_b||"", C: q.option_c||"", D: q.option_d||"" },
      correct: q.type === "quiz" ? q.correct_option : null,
    };
    const s = ensureOverlayState(room, "quiz_ou_sondage");
    s.state = "question";
    s.data = { question, percents: { A:0, B:0, C:0, D:0 } };
    console.log(`🎮 [API] ${room} - Quiz chargé: ${questionKey}`);
    io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "question", data: s.data });
    return res.json({ ok: true, action, question_key: questionKey, type: q.type });
  }

  if (action === "quiz_show_options") {
    const s = ensureOverlayState(room, "quiz_ou_sondage");
    if (s.state === "idle") {
      return res.status(409).json({ ok: false, error: "quiz_not_loaded" });
    }
    s.state = "options";
    console.log(`🎮 [API] ${room} - Quiz show options`);
    io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "options", data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "quiz_show_results") {
    const s = ensureOverlayState(room, "quiz_ou_sondage");
    if (s.state === "idle") {
      return res.status(409).json({ ok: false, error: "quiz_not_loaded" });
    }
    s.state = "results";
    console.log(`🎮 [API] ${room} - Quiz show results`);
    io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "results", data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "quiz_reveal") {
    const s = ensureOverlayState(room, "quiz_ou_sondage");
    if (s.state === "idle") {
      return res.status(409).json({ ok: false, error: "quiz_not_loaded" });
    }
    if (s.data.question?.type === "poll") {
      return res.status(409).json({ ok: false, error: "cannot_reveal_poll" });
    }
    s.state = "reveal";
    console.log(`🎮 [API] ${room} - Quiz reveal`);
    io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "reveal", data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "quiz_reset") {
    const s = ensureOverlayState(room, "quiz_ou_sondage");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Quiz reset`);
    io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "match_off") {
    const s = ensureOverlayState(room, "match_equipes");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Match OFF`);
    io.to(room).emit("overlay:state", { overlay: "match_equipes", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "timer_on") {
    const s = ensureOverlayState(room, "timer_chrono");
    s.state = "active";
    s.data.activatedAt = Date.now();
    console.log(`🎮 [API] ${room} - Timer ON`);
    io.to(room).emit("overlay:state", { overlay: "timer_chrono", state: "active", data: s.data });
    return res.json({ ok: true, action });
  }
  if (action === "timer_off") {
    const s = ensureOverlayState(room, "timer_chrono");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Timer OFF`);
    io.to(room).emit("overlay:state", { overlay: "timer_chrono", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "mot_magique_on") {
    const s = ensureOverlayState(room, "mot_magique");
    s.state = "active";
    s.data.activatedAt = Date.now();
    console.log(`🎮 [API] ${room} - Mot Magique ON`);
    io.to(room).emit("overlay:state", { overlay: "mot_magique", state: "active", data: s.data });
    return res.json({ ok: true, action });
  }
  if (action === "mot_magique_off") {
    const s = ensureOverlayState(room, "mot_magique");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Mot Magique OFF`);
    io.to(room).emit("overlay:state", { overlay: "mot_magique", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "tug_of_war_on") {
    const s = ensureOverlayState(room, "tug_of_war");
    s.state = "active";
    s.data.activatedAt = Date.now();
    console.log(`🎮 [API] ${room} - Tug of War ON`);
    io.to(room).emit("overlay:state", { overlay: "tug_of_war", state: "active", data: s.data });
    return res.json({ ok: true, action });
  }
  if (action === "tug_of_war_off") {
    const s = ensureOverlayState(room, "tug_of_war");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Tug of War OFF`);
    io.to(room).emit("overlay:state", { overlay: "tug_of_war", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "decompte_bonhomme_on") {
    const s = ensureOverlayState(room, "decompte_bonhomme");
    s.state = "active";
    s.data.activatedAt = Date.now();
    console.log(`🎮 [API] ${room} - Décompte Bonhomme ON`);
    io.to(room).emit("overlay:state", { overlay: "decompte_bonhomme", state: "active", data: s.data });
    return res.json({ ok: true, action });
  }
  if (action === "decompte_bonhomme_off") {
    const s = ensureOverlayState(room, "decompte_bonhomme");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Décompte Bonhomme OFF`);
    io.to(room).emit("overlay:state", { overlay: "decompte_bonhomme", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "decompte_poker_on") {
    const s = ensureOverlayState(room, "decompte_poker");
    s.state = "active";
    s.data.activatedAt = Date.now();
    console.log(`🎮 [API] ${room} - Décompte Poker ON`);
    io.to(room).emit("overlay:state", { overlay: "decompte_poker", state: "active", data: s.data });
    return res.json({ ok: true, action });
  }
  if (action === "decompte_poker_off") {
    const s = ensureOverlayState(room, "decompte_poker");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Décompte Poker OFF`);
    io.to(room).emit("overlay:state", { overlay: "decompte_poker", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "emojis_tornado_on") {
    const s = ensureOverlayState(room, "emojis_tornado");
    s.state = "active";
    s.data.activatedAt = Date.now();
    console.log(`🎮 [API] ${room} - Tornade Emojis ON`);
    io.to(room).emit("overlay:state", { overlay: "emojis_tornado", state: "active", data: s.data });
    return res.json({ ok: true, action });
  }
  if (action === "emojis_tornado_off") {
    const s = ensureOverlayState(room, "emojis_tornado");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Tornade Emojis OFF`);
    io.to(room).emit("overlay:state", { overlay: "emojis_tornado", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "confettis_on") {
    const s = ensureOverlayState(room, "confettis");
    s.state = "active";
    s.data.activatedAt = Date.now();
    console.log(`🎮 [API] ${room} - Confettis ON`);
    io.to(room).emit("overlay:state", { overlay: "confettis", state: "active", data: s.data });
    return res.json({ ok: true, action });
  }
  if (action === "confettis_off") {
    const s = ensureOverlayState(room, "confettis");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Confettis OFF`);
    io.to(room).emit("overlay:state", { overlay: "confettis", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }
  if (action === "confettis_explosion") {
    console.log(`🎮 [API] ${room} - Confettis explosion`);
    io.to(room).emit("declencher_explosion");
    return res.json({ ok: true, action });
  }

  if (action === "quiz_on") {
    const s = ensureOverlayState(room, "quiz_ou_sondage");
    if (s.state !== "idle") {
      io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: s.state, data: s.data });
    }
    return res.json({ ok: true, action, currentState: s.state });
  }
  if (action === "quiz_off") {
    const s = ensureOverlayState(room, "quiz_ou_sondage");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Quiz OFF`);
    io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  res.status(400).json({ ok: false, error: "unknown_action", action });
});

// Admin API
app.get("/api/admin/data", requireAdmin, async (req, res) => {
  const { data: c } = await supabase.from("clients").select("*").order("created_at");
  const { data: q } = await supabase.from("questions").select("*").order("room_id").order("order_index");
  res.json({ ok: true, clients: c||[], questions: q||[] });
});

app.post("/api/admin/client", requireAdmin, async (req, res) => {
  const { error } = await supabase.from("clients").upsert(req.body, { onConflict: "room_id" });
  res.json({ ok: !error, error: error?.message });
});

app.post("/api/admin/question", requireAdmin, async (req, res) => {
  const qData = req.body;
  const { data: existing } = await supabase.from("questions").select("id").eq("room_id", qData.room_id).eq("question_key", qData.question_key).maybeSingle();
  let error;
  if (existing) { error = (await supabase.from("questions").update(qData).eq("id", existing.id)).error; }
  else { error = (await supabase.from("questions").insert([qData])).error; }
  res.json({ ok: !error, error: error?.message });
});

app.post("/api/admin/delete-question", requireAdmin, async (req, res) => {
  const { room_id, question_key } = req.body;
  if (!room_id || !question_key) return res.status(400).json({ ok: false, error: "room_id et question_key requis" });
  const { error } = await supabase.from("questions").delete().match({ room_id, question_key });
  res.json({ ok: !error, error: error?.message });
});

// Client API
app.get("/api/client/questions", requireClientAuth, async (req, res) => {
  const { data } = await supabase.from("questions").select("*").eq("room_id", req.client.room_id).order("order_index");
  res.json({ ok: true, questions: data || [] });
});

app.post("/api/client/save-question", requireClientAuth, async (req, res) => {
  const qData = { ...req.body, room_id: req.client.room_id };
  const { data: existing } = await supabase.from("questions").select("id").eq("room_id", qData.room_id).eq("question_key", qData.question_key).maybeSingle();
  let error;
  if (existing) { error = (await supabase.from("questions").update(qData).eq("id", existing.id)).error; }
  else { error = (await supabase.from("questions").insert([qData])).error; }
  res.json({ ok: !error, error: error?.message });
});

app.post("/api/client/delete-question", requireClientAuth, async (req, res) => {
  const { error } = await supabase.from("questions").delete().match({ room_id: req.client.room_id, question_key: req.body.question_key });
  res.json({ ok: !error, error: error?.message });
});

// ============================================================
// GESTION DES SOCKETS
// ============================================================
io.on("connection", (socket) => {
  const socketOverlays = [];

  socket.on("rejoindre_salle", (roomId) => {
    socket.join(roomId);
    // Renvoyer l'état de présence actuel à ce socket (télécommande qui se reconnecte)
    const r = getRoom(roomId);
    Object.entries(r.presence || {}).forEach(([overlay, state]) => {
      socket.emit("overlay:presence", { overlay, ...state });
    });
  });

  // ============================================================
  // PRÉSENCE OVERLAYS — V5.15
  // ============================================================

  socket.on("overlay:online", (p) => {
    const { room, overlay } = p;
    if (!room || !overlay) return;
    if (!socketOverlays.find(o => o.room === room && o.overlay === overlay)) {
      socketOverlays.push({ room, overlay });
    }
    const r = getRoom(room);
    if (!r.presence[overlay]) r.presence[overlay] = { online: false, displaying: false };
    r.presence[overlay].online = true;
    console.log(`🟢 [PRÉSENCE] ${room} - ${overlay} : en ligne`);
    io.to(room).emit("overlay:presence", { overlay, online: true });
  });

  socket.on("overlay:offline", (p) => {
    const { room, overlay } = p;
    if (!room || !overlay) return;
    const r = getRoom(room);
    if (r.presence[overlay]) { r.presence[overlay].online = false; r.presence[overlay].displaying = false; }
    console.log(`🔴 [PRÉSENCE] ${room} - ${overlay} : hors ligne (explicite)`);
    io.to(room).emit("overlay:presence", { overlay, online: false, displaying: false });
  });

  socket.on("overlay:presence_update", (p) => {
    const { room, overlay, displaying } = p;
    if (!room || !overlay) return;
    const r = getRoom(room);
    if (!r.presence[overlay]) r.presence[overlay] = { online: false, displaying: false };
    r.presence[overlay].displaying = Boolean(displaying);
    console.log(`📺 [PRÉSENCE] ${room} - ${overlay} : affichage = ${displaying}`);
    io.to(room).emit("overlay:presence", { overlay, displaying: Boolean(displaying) });
  });

  socket.on("disconnect", () => {
    // Nettoyage présence overlays (comportement inchangé)
    for (const { room, overlay } of socketOverlays) {
      const r = getRoom(room);
      if (r.presence[overlay]) { r.presence[overlay].online = false; r.presence[overlay].displaying = false; }
      console.log(`🔴 [PRÉSENCE] ${room} - ${overlay} : hors ligne (disconnect)`);
      io.to(room).emit("overlay:presence", { overlay, online: false, displaying: false });
    }

    // Nettoyage Chat MDI si ce socket était un participant
    if (socket._chatRoom) {
      const r = ROOMS[socket._chatRoom];
      if (r && r.chat && r.chat.participants[socket.id]) {
        const p = r.chat.participants[socket.id];
        delete r.chat.participants[socket.id];
        console.log(`💬 [CHAT MDI] ${socket._chatRoom} - ${p.prenom} ${p.nom} déconnecté`);
        io.to(socket._chatRoom).emit("chat:state", {
          active: r.chat.active,
          token: r.chat.token,
          participants: chatParticipantsList(socket._chatRoom),
          messages: r.chat.messages.slice(-50)
        });
      }
    }
  });

  socket.on("overlay:join", async (p) => {
    console.log(`🔌 [overlay:join] room=${p.room} overlay=${p.overlay} key=${p.key}`);
    if (supabaseEnabled) {
      const { data: client } = await supabase.from("clients").select("*").eq("room_id", p.room).maybeSingle();
      if (!client || !client.active || client.room_key !== p.key) {
        console.log(`❌ [overlay:join] REFUSÉ — room=${p.room} overlay=${p.overlay}`);
        return socket.emit("overlay:forbidden", { reason: "auth" });
      }
      if (client.expires_at && new Date(client.expires_at) < new Date()) {
        console.log(`❌ [overlay:join] EXPIRÉ — room=${p.room}`);
        return socket.emit("overlay:forbidden", { reason: "expired" });
      }
    }
    socket.join(p.room);
    console.log(`✅ [overlay:join] ACCEPTÉ — room=${p.room} overlay=${p.overlay}`);
    const s = ensureOverlayState(p.room, p.overlay);
    if (p.overlay === "quiz_ou_sondage") {
      const r = getRoom(p.room);
      if (r.history.length > 0) s.data.percents = calculatePercents(getVoteStats(r.history));
    }
    socket.emit("overlay:state", { overlay: p.overlay, state: s.state, data: s.data });
  });

  socket.on("control:activate_overlay", (payload) => {
    const { room, overlay } = payload;
    const s = ensureOverlayState(room, overlay);
    s.data.activatedAt = Date.now();
    if (overlay === "nuage_de_mots") { s.state = "active"; s.data.words = {}; }
    if (overlay === "roue_loto") {
      s.state = "standby";
      s.data.participants = [];
      s.data.consecutifMode = false;
      if (!s.data.remote_participants) s.data.remote_participants = [];
      if (!s.data.feed_mode) s.data.feed_mode = "chat";
    }
    if (overlay === "commentaires") { s.state = "active"; s.data.flux = []; s.data.queue = []; s.data.current = null; s.data.minWords = 4; }
    if (overlay === "match_equipes") {
      s.state = "active";
      // Préserver les noms et couleurs personnalisés ; uniquement réinitialiser les scores
      if (!s.data.teamA) s.data.teamA = { name: "", score: 0, color: "" };
      if (!s.data.teamB) s.data.teamB = { name: "", score: 0, color: "" };
      s.data.teamA.score = 0;
      s.data.teamB.score = 0;
    }
    if (!["nuage_de_mots", "roue_loto", "commentaires", "match_equipes"].includes(overlay)) s.state = "active";
    console.log(`✅ [${room}] Overlay "${overlay}" activé (état: ${s.state})`);
    io.to(room).emit("overlay:state", { overlay, state: s.state, data: s.data });
  });

  socket.on("control:deactivate_overlay", (payload) => {
    const { room, overlay } = payload;
    const s = ensureOverlayState(room, overlay);
    s.state = "idle";
    // Annuler tout throttle nuage en cours si on désactive
    if (overlay === "nuage_de_mots" && _nuageThrottle[room]) {
      clearTimeout(_nuageThrottle[room]);
      delete _nuageThrottle[room];
    }
    console.log(`🔴 [${room}] Overlay "${overlay}" désactivé`);
    io.to(room).emit("overlay:state", { overlay, state: "idle", data: {} });
  });

  socket.on("nouveau_vote", (payload) => {
    const room = payload.room;
    const user = payload.user || "Anonyme";
    const rawVoteOriginal = String(payload.vote || "");
    const rawVote = normalizeVoteText(rawVoteOriginal);

    if (room && rawVote) {
      const r = getRoom(room);

      // === CHAT MDI GATE ===
      // Quand Chat MDI est actif, la porte de l'extension est FERMÉE.
      // Aucun nouveau_vote ne passe — aucun fonctionnement hybride possible.
      if (r.chat && r.chat.active) return;

      const choice = extractChoiceABCD(rawVote);
      if (choice) {
        const alreadyVoted = r.history.find(v => v.user === user && user !== "Anonyme");
        if (!alreadyVoted) {
          r.history.push({ user, choice, time: Date.now() });
          const s = ensureOverlayState(room, "quiz_ou_sondage");
          s.data.percents = calculatePercents(getVoteStats(r.history));
          io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: s.state, data: s.data });
        }
      }

      Object.keys(r.overlays).forEach(overlayName => {
        const overlay = r.overlays[overlayName];

        if (overlayName === "nuage_de_mots") {
          if (overlay.state !== "active") return;
          if (!overlay.data.words) overlay.data.words = {};
          const word = rawVote.trim().toLowerCase();
          if (choice) return;
          // ✅ FIX V5.16 : longueur minimum 2 caractères
          if (word.length < 2) return;
          const wordParts = word.split(/\s+/).filter(Boolean);
          if (wordParts.length > 6 || word.length > 60) return;
          overlay.data.words[word] = (overlay.data.words[word] || 0) + 1;
          // ✅ FIX V5.16 : throttle 1s — évite de saturer la room à chaque vote
          emitNuageState(room);
        }

        if (overlayName === "roue_loto") {
          // N'accepte des participants que si la collecte est ouverte ET en mode chat
          if (overlay.state !== "collecting") return;
          if (overlay.data.feed_mode === "remote") return;
          if (!overlay.data.participants) overlay.data.participants = [];
          const participantName = (user !== "Anonyme") ? user : rawVoteOriginal.trim();
          if (!participantName) return;
          const key = participantName.toLowerCase();
          if (!overlay.data.participants.some(pp => (typeof pp === "string" ? pp : pp.name).toLowerCase() === key)) {
            overlay.data.participants.push({ name: participantName, key });
            io.to(room).emit("overlay:state", { overlay: overlayName, state: overlay.state, data: overlay.data });
          }
        }

        if (overlayName === "commentaires") {
          if (overlay.state !== "active") return;
          const minWords = overlay.data.minWords || 4;
          const wordCount = rawVote.split(/\s+/).filter(Boolean).length;
          if (wordCount < minWords) return;
          const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const newMessage = { id: msgId, author: user, text: rawVote, timestamp: Date.now(), sent: false };
          if (!overlay.data.flux) overlay.data.flux = [];
          overlay.data.flux.push(newMessage);
          if (overlay.data.flux.length > 50) overlay.data.flux = overlay.data.flux.slice(-50);
          io.to(room).emit("overlay:state", { overlay: overlayName, state: "active", data: overlay.data });
          console.log(`💬 [COMMENTAIRES] ${room} - Nouveau: "${rawVote.substring(0, 30)}..."`);
        }
      });

      io.to(room).emit("raw_vote", { user, vote: rawVote });
    }
  });

  socket.on("control:set_state", (p) => {
    const s = ensureOverlayState(p.room, p.overlay);
    s.state = p.state;
    if (p.state === "winner" && p.overlay === "quiz_ou_sondage") {
      const q = s.data.question;
      const r = getRoom(p.room);
      let winnerText = "Personne";
      if (q && q.type === "quiz" && q.correct) {
        const winners = r.history.filter(v => v.choice === q.correct);
        if (winners.length > 0) {
          winners.sort((a, b) => a.time - b.time);
          winnerText = winners[0].user === "Anonyme" ? "Quelqu'un (Anonyme)" : winners[0].user;
        } else {
          winnerText = "Aucune bonne réponse";
        }
      } else if (q && q.type === "poll") {
        const stats = getVoteStats(r.history);
        const max = Math.max(stats.A, stats.B, stats.C, stats.D);
        const winnerKey = ["A","B","C","D"].find(k => stats[k] === max);
        winnerText = q.options[winnerKey] || "Egalité";
      }
      s.data.winnerName = winnerText;
    }
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: p.state, data: s.data });
  });

  // NOTE CLIENT : la télécommande doit inclure { room, key, overlay, question_key }
  socket.on("control:load_question", async (p) => {
    console.log(`🎮 [load_question] room=${p.room} key=${p.key} question_key=${p.question_key} overlay=${p.overlay}`);
    if (!supabaseEnabled) { console.log("❌ [load_question] Supabase désactivé"); return; }
    const { data: clientAuth } = await supabase
      .from("clients").select("room_key, active").eq("room_id", p.room).maybeSingle();
    if (!clientAuth) { console.log("❌ [load_question] client inconnu pour room:", p.room); return; }
    if (!clientAuth.active) { console.log("❌ [load_question] client inactif"); return; }
    if (clientAuth.room_key !== p.key) { console.log("❌ [load_question] mauvaise clé"); return; }
    const r = getRoom(p.room);
    r.history = [];
    const { data: q } = await supabase
      .from("questions").select("*")
      .eq("room_id", p.room).eq("question_key", p.question_key).maybeSingle();
    if (!q) { console.log(`❌ [load_question] question introuvable: ${p.question_key} dans room ${p.room}`); return; }
    const question = {
      id: q.question_key, type: q.type, prompt: q.prompt,
      options: { A: q.option_a||"", B: q.option_b||"", C: q.option_c||"", D: q.option_d||"" },
      correct: q.type === "quiz" ? q.correct_option : null,
    };
    const s = ensureOverlayState(p.room, p.overlay);
    s.state = "question";
    s.data = { question, percents: { A:0, B:0, C:0, D:0 } };
    const socketsInRoom = await io.in(p.room).allSockets();
    console.log(`✅ [load_question] Émission overlay:state → room ${p.room} (${socketsInRoom.size} sockets)`);
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "question", data: s.data });
  });

  socket.on("control:show_options", (p) => {
    const s = ensureOverlayState(p.room, p.overlay);
    s.state = "options";
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "options", data: s.data });
  });

  socket.on("control:idle", (p) => {
    const s = ensureOverlayState(p.room, p.overlay);
    s.state = "idle";
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "idle", data: {} });
  });

  socket.on("control:fire_confetti", (p) => {
    io.to(p.room).emit("declencher_explosion");
  });

  // ============================================================
  // HANDLERS ROUE LOTO
  // ============================================================

  socket.on("roue:show", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    if (s.state !== "standby") return;
    if (!s.data.remote_participants) s.data.remote_participants = [];
    if (!s.data.feed_mode || s.data.feed_mode === "chat") {
      s.state = "collecting";
      s.data.participants = [];
      s.data.winnerName = null;
      console.log(`🎡 [ROUE] ${p.room} - SHOW (chat → collecting)`);
      io.to(p.room).emit("overlay:state", { overlay: "roue_loto", state: "collecting", data: s.data });
    } else {
      s.data.participants = [...s.data.remote_participants];
      s.state = "ready";
      s.data.winnerName = null;
      console.log(`🎡 [ROUE] ${p.room} - SHOW (remote → ready, ${s.data.participants.length} participants)`);
      io.to(p.room).emit("overlay:state", { overlay: "roue_loto", state: "ready", data: s.data });
    }
  });

  socket.on("roue:hide", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    s.state = "standby";
    console.log(`🎡 [ROUE] ${p.room} - HIDE (→ standby)`);
    io.to(p.room).emit("overlay:state", { overlay: "roue_loto", state: "standby", data: s.data });
  });

  socket.on("roue:reopen_collect", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    if (s.state === "collecting") return;
    s.state = "collecting";
    console.log(`📝 [ROUE] ${p.room} - Réouverture collecte (participants conservés)`);
    io.to(p.room).emit("overlay:state", { overlay: "roue_loto", state: "collecting", data: s.data });
  });

  socket.on("roue:set_feed_mode", (p) => {
    const { room, mode } = p;
    if (!room || (mode !== "chat" && mode !== "remote")) return;
    const s = ensureOverlayState(room, "roue_loto");
    s.data.feed_mode = mode;
    s.data.participants = [];
    if (s.state !== "idle" && s.state !== "standby") s.state = "standby";
    console.log(`🎡 [ROUE] ${room} - Feed mode: ${mode}`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
  });

  socket.on("roue:add_remote_participant", (p) => {
    const { room, name } = p;
    if (!room || !name) return;
    const s = ensureOverlayState(room, "roue_loto");
    if (!s.data.remote_participants) s.data.remote_participants = [];
    const clean = String(name).trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (!s.data.remote_participants.some(pp => (typeof pp === "string" ? pp : pp.name).toLowerCase() === key)) {
      s.data.remote_participants.push({ name: clean, key });
      console.log(`➕ [ROUE] ${room} - Participant organisateur: "${clean}" (total: ${s.data.remote_participants.length})`);
      io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
    }
  });

  socket.on("roue:remove_remote_participant", (p) => {
    const { room, name, index } = p;
    if (!room) return;
    const s = ensureOverlayState(room, "roue_loto");
    if (!s.data.remote_participants) return;
    let idx = -1;
    if (index !== undefined && index !== null && index >= 0 && index < s.data.remote_participants.length) idx = index;
    else if (name) idx = s.data.remote_participants.findIndex(pp => (typeof pp === "string" ? pp : pp.name) === name);
    if (idx === -1) return;
    const removed = s.data.remote_participants[idx];
    s.data.remote_participants.splice(idx, 1);
    const removedName = typeof removed === "string" ? removed : removed.name;
    console.log(`❌ [ROUE] ${room} - Participant organisateur supprimé: "${removedName}"`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
  });

  socket.on("roue:edit_remote_participant", (p) => {
    const { room, index, newName } = p;
    if (!room || !newName) return;
    const s = ensureOverlayState(room, "roue_loto");
    if (!s.data.remote_participants || index < 0 || index >= s.data.remote_participants.length) return;
    const clean = String(newName).trim();
    if (!clean) return;
    const old = s.data.remote_participants[index];
    s.data.remote_participants[index] = { name: clean, key: clean.toLowerCase() };
    console.log(`✏️ [ROUE] ${room} - Participant organisateur: "${typeof old === "string" ? old : old.name}" → "${clean}"`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
  });

  socket.on("roue:clear_remote_participants", (p) => {
    if (!p.room) return;
    const s = ensureOverlayState(p.room, "roue_loto");
    s.data.remote_participants = [];
    console.log(`🗑️ [ROUE] ${p.room} - Liste organisateur vidée`);
    io.to(p.room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
  });

  socket.on("roue:clear_participants", (p) => {
    if (!p.room) return;
    const s = ensureOverlayState(p.room, "roue_loto");
    s.data.participants = [];
    s.data.winnerName = null;
    console.log(`🗑️ [ROUE] ${p.room} - Participants roue vidés`);
    io.to(p.room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
  });

  socket.on("roue:start_collect", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    // Rétrocompatibilité : ouvre la collecte sans vider les participants
    s.state = "collecting";
    console.log(`📝 [ROUE] ${p.room} - Démarrage/réouverture collecte`);
    io.to(p.room).emit("overlay:state", { overlay: "roue_loto", state: "collecting", data: s.data });
  });

  socket.on("roue:stop_collect", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    if (s.state === "collecting") {
      s.state = "ready";
      console.log(`🔒 [ROUE] ${p.room} - Fermeture collecte`);
      io.to(p.room).emit("roue:stop_collect");
      io.to(p.room).emit("overlay:state", { overlay: "roue_loto", state: "ready", data: s.data });
    }
  });

  socket.on("roue:spin", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    // Étape 1 : winner → ready (retrait gagnant si mode consécutif)
    if (s.state === "winner") {
      if (s.data.consecutifMode && s.data.winnerName && s.data.participants) {
        const idx = s.data.participants.findIndex(pp => {
          const n = typeof pp === "string" ? pp : pp.name;
          return n === s.data.winnerName;
        });
        if (idx !== -1) s.data.participants.splice(idx, 1);
      }
      s.state = "ready";
      s.data.winnerName = null;
      console.log(`🎡 [ROUE] ${p.room} - winner → ready`);
      io.to(p.room).emit("overlay:state", { overlay: "roue_loto", state: "ready", data: s.data });
      return;
    }
    // Étape 2 : ready → spinning
    if (s.state !== "ready") return;
    s.state = "spinning";
    console.log(`🎡 [ROUE] ${p.room} - SPIN`);
    io.to(p.room).emit("roue:spin");
  });

  socket.on("roue:reset", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    s.state = "standby";
    s.data.participants = [];
    s.data.winnerName = null;
    // remote_participants conservée intentionnellement
    console.log(`🔄 [ROUE] ${p.room} - Reset (→ standby, liste organisateur conservée)`);
    io.to(p.room).emit("overlay:state", { overlay: "roue_loto", state: "standby", data: s.data });
  });

  socket.on("roue:add_participant", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    if (s.state === "collecting") {
      if (!s.data.participants) s.data.participants = [];
      const name = String(p.name || "").trim();
      if (name && !s.data.participants.includes(name)) {
        s.data.participants.push(name);
        io.to(p.room).emit("roue:participant_added", { name });
      }
    }
  });

  socket.on("control:roue_add_participant_manual", (p) => {
    const { room, name } = p;
    if (!room || !name) return;
    const s = ensureOverlayState(room, "roue_loto");
    if (!s.data.participants) s.data.participants = [];
    const cleanName = String(name).trim();
    if (!cleanName) return;
    const key = cleanName.toLowerCase();
    const exists = s.data.participants.some(pp => {
      const n = typeof pp === "string" ? pp : pp.name;
      return n.toLowerCase() === key;
    });
    if (!exists) {
      s.data.participants.push({ name: cleanName, key });
      console.log(`➕ [ROUE] ${room} - Ajout manuel: "${cleanName}" (total: ${s.data.participants.length})`);
      io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
    }
  });

  socket.on("control:roue_edit_participant", (p) => {
    const { room, index, oldName, newName } = p;
    if (!room || !newName) return;
    const s = ensureOverlayState(room, "roue_loto");
    if (!s.data.participants) return;
    const cleanNew = String(newName).trim();
    if (!cleanNew) return;
    let idx = (index !== undefined && index !== null) ? index : -1;
    if (idx < 0 && oldName) {
      idx = s.data.participants.findIndex(pp => {
        const n = typeof pp === "string" ? pp : pp.name;
        return n === oldName;
      });
    }
    if (idx < 0 || idx >= s.data.participants.length) return;
    const old = s.data.participants[idx];
    const oldStr = typeof old === "string" ? old : old.name;
    s.data.participants[idx] = { name: cleanNew, key: cleanNew.toLowerCase() };
    console.log(`✏️ [ROUE] ${room} - "${oldStr}" → "${cleanNew}"`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
  });

  socket.on("control:roue_remove_participant", (p) => {
    const { room, name, index } = p;
    if (!room) return;
    const s = ensureOverlayState(room, "roue_loto");
    if (!s.data.participants) return;
    let idx = -1;
    if (index !== undefined && index !== null && index >= 0 && index < s.data.participants.length) {
      idx = index;
    } else if (name) {
      idx = s.data.participants.findIndex(pp => {
        const n = typeof pp === "string" ? pp : pp.name;
        return n === name;
      });
    }
    if (idx === -1) return;
    const removed = s.data.participants[idx];
    s.data.participants.splice(idx, 1);
    const removedName = typeof removed === "string" ? removed : removed.name;
    console.log(`❌ [ROUE] ${room} - Participant supprimé: "${removedName}" (index ${idx})`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
  });

  socket.on("roue:set_consecutif", (p) => {
    const { room, enabled } = p;
    if (!room) return;
    const s = ensureOverlayState(room, "roue_loto");
    s.data.consecutifMode = Boolean(enabled);
    console.log(`🔁 [ROUE] ${room} - Mode consécutif: ${enabled ? "ON" : "OFF"}`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
  });

  socket.on("roue:winner_selected", (p) => {
    const { room, winnerName } = p;
    if (!room || !winnerName) return;
    const s = ensureOverlayState(room, "roue_loto");
    s.state = "winner";
    s.data.winnerName = winnerName;
    console.log(`🏆 [ROUE] ${room} - Gagnant: "${winnerName}" (état=winner, retrait au prochain spin)`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "winner", data: s.data });
  });

  // ============================================================
  // HANDLERS NUAGE DE MOTS
  // ============================================================

  socket.on("control:nuage_word_increment", (p) => {
    const { room, word } = p;
    if (!room || !word) return;
    const s = ensureOverlayState(room, "nuage_de_mots");
    if (!s.data.words) s.data.words = {};
    const key = String(word).trim().toLowerCase();
    if (!key) return;
    s.data.words[key] = (s.data.words[key] || 0) + 1;
    console.log(`+1 [NUAGE] ${room} - "${key}" → ${s.data.words[key]}`);
    io.to(room).emit("overlay:state", { overlay: "nuage_de_mots", state: s.state, data: s.data });
  });

  socket.on("control:nuage_word_decrement", (p) => {
    const { room, word } = p;
    if (!room || !word) return;
    const s = ensureOverlayState(room, "nuage_de_mots");
    if (!s.data.words) return;
    const key = String(word).trim().toLowerCase();
    if (!key || !s.data.words[key]) return;
    s.data.words[key] = Math.max(1, s.data.words[key] - 1);
    console.log(`-1 [NUAGE] ${room} - "${key}" → ${s.data.words[key]}`);
    io.to(room).emit("overlay:state", { overlay: "nuage_de_mots", state: s.state, data: s.data });
  });

  socket.on("control:nuage_remove_word", (p) => {
    const { room, word } = p;
    if (!room || !word) return;
    const s = ensureOverlayState(room, "nuage_de_mots");
    if (!s.data.words) return;
    const key = String(word).trim().toLowerCase();
    delete s.data.words[key];
    console.log(`❌ [NUAGE] ${room} - Mot supprimé: "${key}"`);
    io.to(room).emit("overlay:state", { overlay: "nuage_de_mots", state: s.state, data: s.data });
  });

  socket.on("control:nuage_clear_all", (p) => {
    const { room } = p;
    if (!room) return;
    const s = ensureOverlayState(room, "nuage_de_mots");
    s.data.words = {};
    console.log(`🧹 [NUAGE] ${room} - Nuage vidé`);
    io.to(room).emit("overlay:state", { overlay: "nuage_de_mots", state: s.state, data: s.data });
  });

  // ============================================================
  // HANDLERS TIMER/CHRONO
  // ============================================================

  socket.on("control:timer_set_mode", (payload) => {
    const { room, mode } = payload;
    if (!room) return;
    const validMode = (mode === "chrono") ? "chrono" : "timer";
    const s = ensureOverlayState(room, "timer_chrono");
    s.data.mode = validMode;
    s.data.seconds = (validMode === "timer") ? 60 : 0;
    console.log(`🔄 [TIMER] ${room} - Mode: ${validMode}`);
    io.to(room).emit("control:timer_chrono", { action: "set_mode", mode: validMode });
  });

  socket.on("control:timer_set_time", (payload) => {
    const { room, seconds } = payload;
    if (!room || !Number.isFinite(seconds)) return;
    const s = ensureOverlayState(room, "timer_chrono");
    const clampedSeconds = Math.max(0, Math.min(seconds, 99 * 60 + 59));
    s.data.seconds = clampedSeconds;
    console.log(`⏱️ [TIMER] ${room} - Temps configuré: ${clampedSeconds}s`);
    io.to(room).emit("control:timer_chrono", { action: "set_time", seconds: clampedSeconds });
  });

  socket.on("control:timer_increment_time", (payload) => {
    const { room, seconds } = payload;
    if (!room || !Number.isFinite(seconds)) return;
    const s = ensureOverlayState(room, "timer_chrono");
    const currentSeconds = s.data.seconds || 0;
    const newSeconds = Math.max(0, Math.min(currentSeconds + seconds, 99 * 60 + 59));
    s.data.seconds = newSeconds;
    console.log(`➕➖ [TIMER] ${room} - Ajustement: ${seconds > 0 ? '+' : ''}${seconds}s → ${newSeconds}s`);
    io.to(room).emit("control:timer_chrono", { action: "increment_time", seconds });
  });

  socket.on("control:timer_start", (payload) => {
    const { room } = payload;
    if (!room) return;
    console.log(`▶️ [TIMER] ${room} - Start`);
    io.to(room).emit("control:timer_chrono", { action: "start" });
  });

  socket.on("control:timer_pause", (payload) => {
    const { room } = payload;
    if (!room) return;
    console.log(`⏸️ [TIMER] ${room} - Pause`);
    io.to(room).emit("control:timer_chrono", { action: "pause" });
  });

  socket.on("control:timer_toggle_pause", (payload) => {
    const { room } = payload;
    if (!room) return;
    console.log(`⏯️ [TIMER] ${room} - Toggle pause`);
    io.to(room).emit("control:timer_chrono", { action: "toggle_pause" });
  });

  socket.on("control:timer_reset", (payload) => {
    const { room } = payload;
    if (!room) return;
    console.log(`🔄 [TIMER] ${room} - Reset`);
    io.to(room).emit("control:timer_chrono", { action: "reset" });
  });

  // ============================================================
  // HANDLERS COMMENTAIRES
  // ============================================================

  socket.on("control:comment_to_queue", (payload) => {
    const { room, messageId } = payload;
    if (!room || !messageId) return;
    const s = ensureOverlayState(room, "commentaires");
    const msgIndex = s.data.flux.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return;
    const message = s.data.flux[msgIndex];
    message.sent = true;
    if (!s.data.queue) s.data.queue = [];
    s.data.queue.push({ ...message, displayed: false });
    console.log(`→ [COMMENTAIRES] ${room} - Message ${messageId} → queue`);
    io.to(room).emit("overlay:state", { overlay: "commentaires", state: s.state, data: s.data });
  });

  socket.on("control:comment_show", (payload) => {
    const { room, messageId } = payload;
    if (!room || !messageId) return;
    const s = ensureOverlayState(room, "commentaires");
    const message = s.data.queue.find(m => m.id === messageId);
    if (!message) return;
    message.displayed = true;
    s.data.current = { id: message.id, author: message.author, text: message.text };
    console.log(`👁️ [COMMENTAIRES] ${room} - Affichage: "${message.text.substring(0, 30)}..."`);
    io.to(room).emit("overlay:state", { overlay: "commentaires", state: "active", data: s.data });
  });

  socket.on("control:comment_hide", (payload) => {
    const { room } = payload;
    if (!room) return;
    const s = ensureOverlayState(room, "commentaires");
    s.data.current = null;
    console.log(`🙈 [COMMENTAIRES] ${room} - Commentaire masqué`);
    io.to(room).emit("overlay:state", { overlay: "commentaires", state: "active", data: s.data });
  });

  socket.on("control:comment_delete", (payload) => {
    const { room, column, messageId } = payload;
    if (!room || !column || !messageId) return;
    const s = ensureOverlayState(room, "commentaires");
    if (column === "flux") {
      s.data.flux = s.data.flux.filter(m => m.id !== messageId);
    } else if (column === "queue") {
      s.data.queue = s.data.queue.filter(m => m.id !== messageId);
      if (s.data.current && s.data.current.id === messageId) s.data.current = null;
    }
    console.log(`❌ [COMMENTAIRES] ${room} - Message ${messageId} supprimé (${column})`);
    io.to(room).emit("overlay:state", { overlay: "commentaires", state: s.state, data: s.data });
  });

  socket.on("control:comment_reset_flux", (payload) => {
    const { room } = payload;
    if (!room) return;
    const s = ensureOverlayState(room, "commentaires");
    s.data.flux = [];
    console.log(`🧹 [COMMENTAIRES] ${room} - Flux nettoyé`);
    io.to(room).emit("overlay:state", { overlay: "commentaires", state: s.state, data: s.data });
  });

  socket.on("control:comment_reset_queue", (payload) => {
    const { room } = payload;
    if (!room) return;
    const s = ensureOverlayState(room, "commentaires");
    s.data.queue = [];
    s.data.current = null;
    console.log(`🧹 [COMMENTAIRES] ${room} - Queue vidée`);
    io.to(room).emit("overlay:state", { overlay: "commentaires", state: s.state, data: s.data });
  });

  // ============================================================
  // HANDLERS MATCH ÉQUIPES
  // ============================================================

  socket.on("control:match_adjust_score", (payload) => {
    const { room, team, delta } = payload;
    if (!room || !team || delta === undefined) return;
    const s = ensureOverlayState(room, "match_equipes");
    if (team === 'A') { s.data.teamA.score = Math.max(0, s.data.teamA.score + delta); }
    else if (team === 'B') { s.data.teamB.score = Math.max(0, s.data.teamB.score + delta); }
    console.log(`📊 [MATCH] ${room} - ${team} ${delta > 0 ? '+' : ''}${delta} → ${team === 'A' ? s.data.teamA.score : s.data.teamB.score}`);
    io.to(room).emit("overlay:state", { overlay: "match_equipes", state: s.state, data: s.data });
  });

  socket.on("control:match_reset", (payload) => {
    const { room } = payload;
    if (!room) return;
    const s = ensureOverlayState(room, "match_equipes");
    if (!s.data.teamA) s.data.teamA = { name: "", score: 0, color: "" };
    if (!s.data.teamB) s.data.teamB = { name: "", score: 0, color: "" };
    s.data.teamA.score = 0;
    s.data.teamB.score = 0;
    console.log(`🔄 [MATCH] ${room} - Reset 0-0`);
    io.to(room).emit("overlay:state", { overlay: "match_equipes", state: s.state, data: s.data });
  });

  socket.on("control:match_update_teams", (payload) => {
    const { room, teamA, teamB } = payload;
    if (!room) return;
    const s = ensureOverlayState(room, "match_equipes");
    if (!s.data.teamA) s.data.teamA = { name: "", score: 0, color: "" };
    if (!s.data.teamB) s.data.teamB = { name: "", score: 0, color: "" };
    // Chaîne vide = la télécommande ne surcharge pas (CSS OBS reprend le contrôle)
    if (teamA?.name !== undefined) s.data.teamA.name = teamA.name;
    if (teamA?.color !== undefined) s.data.teamA.color = teamA.color;
    if (teamB?.name !== undefined) s.data.teamB.name = teamB.name;
    if (teamB?.color !== undefined) s.data.teamB.color = teamB.color;
    console.log(`🎨 [MATCH] ${room} - A:"${s.data.teamA.name}" B:"${s.data.teamB.name}"`);
    io.to(room).emit("overlay:state", { overlay: "match_equipes", state: s.state, data: s.data });
  });

  socket.on("control:mot_magique_update_config", (payload) => {
    const { room, word, trigger, threshold } = payload;
    if (!room) return;
    const s = ensureOverlayState(room, "mot_magique");
    if (word      !== undefined) s.data.word      = word;
    if (trigger   !== undefined) s.data.trigger   = trigger;
    if (threshold !== undefined) s.data.threshold = threshold;
    console.log(`✨ [MOT] ${room} - word:"${s.data.word}" trigger:"${s.data.trigger}" threshold:${s.data.threshold}`);
    io.to(room).emit("overlay:state", { overlay: "mot_magique", state: s.state, data: s.data });
  });

  socket.on("control:tug_update_config", (payload) => {
    const { room, nameLeft, nameRight, colorLeft, colorRight, triggerLeft, triggerRight } = payload;
    if (!room) return;
    const s = ensureOverlayState(room, "tug_of_war");
    if (nameLeft    !== undefined) s.data.nameLeft    = nameLeft;
    if (nameRight   !== undefined) s.data.nameRight   = nameRight;
    if (colorLeft   !== undefined) s.data.colorLeft   = colorLeft;
    if (colorRight  !== undefined) s.data.colorRight  = colorRight;
    if (triggerLeft !== undefined) s.data.triggerLeft = triggerLeft;
    if (triggerRight!== undefined) s.data.triggerRight= triggerRight;
    console.log(`🎨 [TUG] ${room} - L:"${s.data.nameLeft}" R:"${s.data.nameRight}"`);
    io.to(room).emit("overlay:state", { overlay: "tug_of_war", state: s.state, data: s.data });
  });

  // ============================================================
  // CHAT MDI — Système de chat privé par room (V5.18)
  // ============================================================

  // --- Toggle Chat MDI (appelé par la télécommande) ---
  socket.on("chat:toggle", (p) => {
    const { room } = p;
    if (!room) return;
    const r = getRoom(room);

    if (r.chat.active) {
      // Désactivation : révoquer le token, vider les participants
      if (r.chat.token) delete CHAT_TOKENS[r.chat.token];
      r.chat.active = false;
      r.chat.token = null;
      r.chat.participants = {};
      r.chat.messages = [];

      // La roue repasse en standby propre (plus de participants MDI)
      const roue = r.overlays.roue_loto;
      if (roue && roue.state === "collecting") {
        roue.state = "standby";
        roue.data.participants = [];
        io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "standby", data: roue.data });
      }

      console.log(`💬 [CHAT MDI] ${room} - Désactivé`);
      io.to(room).emit("chat:state", { active: false, token: null, participants: [], messages: [] });

    } else {
      // Activation : générer un token opaque, réinitialiser le chat
      let token;
      do { token = generateChatToken(); } while (CHAT_TOKENS[token]);
      CHAT_TOKENS[token] = { room };
      r.chat.active = true;
      r.chat.token = token;
      r.chat.participants = {};
      r.chat.messages = [];

      // Si la roue est déjà active, la passer en collecting (auto-alimentation)
      const roue = r.overlays.roue_loto;
      if (roue && roue.state !== "idle") {
        roue.state = "collecting";
        if (!roue.data.participants) roue.data.participants = [];
        io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "collecting", data: roue.data });
      }

      console.log(`💬 [CHAT MDI] ${room} - Activé (token: ${token})`);
      io.to(room).emit("chat:state", { active: true, token, participants: [], messages: [] });
    }
  });

  // --- Inscription participant (depuis la page chat) ---
  socket.on("chat:join", (p) => {
    const { token, prenom, nom } = p;
    if (!token || !prenom || !nom) {
      return socket.emit("chat:join_error", { reason: "missing_fields" });
    }

    const tokenData = CHAT_TOKENS[token];
    if (!tokenData) return socket.emit("chat:join_error", { reason: "invalid_token" });

    const room = tokenData.room;
    const r = getRoom(room);
    if (!r.chat.active) return socket.emit("chat:join_error", { reason: "chat_inactive" });

    const prenomClean = String(prenom).trim().substring(0, 30);
    const nomClean    = String(nom).trim().substring(0, 30);
    if (!prenomClean || !nomClean) return socket.emit("chat:join_error", { reason: "invalid_name" });

    // Unicité stricte sur le couple prénom+nom
    const participantKey = `${prenomClean.toLowerCase()}_${nomClean.toLowerCase()}`;
    const alreadyExists = Object.values(r.chat.participants).some(pp => pp.key === participantKey);
    if (alreadyExists) return socket.emit("chat:join_error", { reason: "duplicate_name" });

    // Enregistrement
    r.chat.participants[socket.id] = { prenom: prenomClean, nom: nomClean, key: participantKey, joinedAt: Date.now() };
    socket._chatRoom  = room;
    socket._chatToken = token;
    socket.join(room);

    socket.emit("chat:join_ok", { prenom: prenomClean, nom: nomClean });

    // Broadcast état à la télécommande
    io.to(room).emit("chat:state", {
      active: true,
      token: r.chat.token,
      participants: chatParticipantsList(room),
      messages: r.chat.messages.slice(-50)
    });

    // Auto-alimentation roue loto si en cours de collecte
    const roue = r.overlays.roue_loto;
    if (roue && roue.state === "collecting") {
      const fullName = `${prenomClean} ${nomClean}`;
      const nameKey  = fullName.toLowerCase();
      if (!roue.data.participants) roue.data.participants = [];
      const alreadyOnRoue = roue.data.participants.some(pp =>
        (typeof pp === "string" ? pp : pp.name).toLowerCase() === nameKey
      );
      if (!alreadyOnRoue) {
        roue.data.participants.push({ name: fullName, key: nameKey });
        io.to(room).emit("overlay:state", { overlay: "roue_loto", state: roue.state, data: roue.data });
      }
    }

    console.log(`💬 [CHAT MDI] ${room} - ${prenomClean} ${nomClean} rejoint (${Object.keys(r.chat.participants).length} connectés)`);
  });

  // --- Message participant ---
  socket.on("chat:message", (p) => {
    const { token, text } = p;
    if (!token || !text) return;

    const tokenData = CHAT_TOKENS[token];
    if (!tokenData) return socket.emit("chat:error", { reason: "invalid_token" });

    const room = tokenData.room;
    const r    = getRoom(room);
    if (!r.chat.active) return;

    const participant = r.chat.participants[socket.id];
    if (!participant) return socket.emit("chat:error", { reason: "not_joined" });

    const cleanText = String(text).trim().substring(0, 500);
    if (!cleanText) return;

    const msgId  = `cmdi_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const author = `${participant.prenom} ${participant.nom}`;
    const message = { id: msgId, author, prenom: participant.prenom, nom: participant.nom, text: cleanText, timestamp: Date.now() };

    // Buffer circulaire (100 messages max)
    r.chat.messages.push(message);
    if (r.chat.messages.length > 100) r.chat.messages = r.chat.messages.slice(-100);

    // Broadcast à tous dans la room (participants + télécommande)
    io.to(room).emit("chat:broadcast", message);

    // Injection dans l'overlay commentaires si actif (auteur réel préservé)
    const commentaires = r.overlays.commentaires;
    if (commentaires && commentaires.state === "active") {
      const wordCount = cleanText.split(/\s+/).filter(Boolean).length;
      const minWords  = commentaires.data.minWords || 4;
      if (wordCount >= minWords) {
        const cid   = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const cMsg  = { id: cid, author, text: cleanText, timestamp: Date.now(), sent: false };
        if (!commentaires.data.flux) commentaires.data.flux = [];
        commentaires.data.flux.push(cMsg);
        if (commentaires.data.flux.length > 50) commentaires.data.flux = commentaires.data.flux.slice(-50);
        io.to(room).emit("overlay:state", { overlay: "commentaires", state: "active", data: commentaires.data });
        console.log(`💬 [COMMENTAIRES ← CHAT MDI] ${room} - ${author}: "${cleanText.substring(0, 30)}"`);
      }
    }

    console.log(`💬 [CHAT MDI] ${room} - ${author}: "${cleanText.substring(0, 50)}"`);
  });

  // --- Demande état chat (télécommande se reconnecte) ---
  socket.on("chat:get_state", (p) => {
    const { room } = p;
    if (!room) return;
    const r = getRoom(room);
    socket.emit("chat:state", {
      active: r.chat.active,
      token: r.chat.token,
      participants: chatParticipantsList(room),
      messages: r.chat.messages.slice(-50)
    });
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server MDI V5.18 Online on ${PORT}`));
