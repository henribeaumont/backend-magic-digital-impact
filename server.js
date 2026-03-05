// ============================================================
// MDI SERVER V5.16 - COMPLET
// ✅ Tout V5.15 préservé (ZÉRO RÉGRESSION)
// ✅ FIX NUAGE : longueur minimum 2 caractères (filtre "x", "❌", etc.)
// ✅ FIX NUAGE : throttle 1s sur overlay:state pour éviter saturation
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

function getRoom(id) {
  if (!ROOMS[id]) {
    ROOMS[id] = { overlays: {}, history: [], presence: {} };
  }
  return ROOMS[id];
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
    version: "5.16",
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

app.get("/", (req, res) => res.send("MDI Server V5.16 Online"));

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
      io.to(room).emit("control:timer_set_time", { room, seconds });
      return res.json({ ok: true, action: "timer_preset", seconds });
    }
  }
  if (action === "timer_add_10min") { io.to(room).emit("control:timer_increment_time", { room, seconds: 600 });  return res.json({ ok: true, action }); }
  if (action === "timer_add_1min")  { io.to(room).emit("control:timer_increment_time", { room, seconds: 60 });   return res.json({ ok: true, action }); }
  if (action === "timer_add_10sec") { io.to(room).emit("control:timer_increment_time", { room, seconds: 10 });   return res.json({ ok: true, action }); }
  if (action === "timer_add_1sec")  { io.to(room).emit("control:timer_increment_time", { room, seconds: 1 });    return res.json({ ok: true, action }); }
  if (action === "timer_sub_10min") { io.to(room).emit("control:timer_increment_time", { room, seconds: -600 }); return res.json({ ok: true, action }); }
  if (action === "timer_sub_1min")  { io.to(room).emit("control:timer_increment_time", { room, seconds: -60 });  return res.json({ ok: true, action }); }
  if (action === "timer_sub_10sec") { io.to(room).emit("control:timer_increment_time", { room, seconds: -10 });  return res.json({ ok: true, action }); }
  if (action === "timer_sub_1sec")  { io.to(room).emit("control:timer_increment_time", { room, seconds: -1 });   return res.json({ ok: true, action }); }
  if (action === "timer_start")        { io.to(room).emit("control:timer_start", { room });        return res.json({ ok: true, action }); }
  if (action === "timer_pause")        { io.to(room).emit("control:timer_pause", { room });        return res.json({ ok: true, action }); }
  if (action === "timer_reset")        { io.to(room).emit("control:timer_reset", { room });        return res.json({ ok: true, action }); }
  if (action === "timer_toggle_pause") { io.to(room).emit("control:timer_toggle_pause", { room }); return res.json({ ok: true, action }); }
  if (action === "timer_mode_chrono")  { io.to(room).emit("control:timer_set_mode", { room, mode: "chrono" }); return res.json({ ok: true, action }); }
  if (action === "timer_mode_timer")   { io.to(room).emit("control:timer_set_mode", { room, mode: "timer" });  return res.json({ ok: true, action }); }

  if (action === "comment_show") {
    const messageId = payload?.messageId;
    if (messageId) {
      io.to(room).emit("control:comment_show", { room, messageId });
      return res.json({ ok: true, action, messageId });
    }
  }
  if (action === "comment_hide") { io.to(room).emit("control:comment_hide", { room }); return res.json({ ok: true, action }); }

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

  if (action === "match_team_a_increment") { io.to(room).emit("control:match_adjust_score", { room, team: 'A', delta: 1 });  return res.json({ ok: true, action }); }
  if (action === "match_team_a_decrement") { io.to(room).emit("control:match_adjust_score", { room, team: 'A', delta: -1 }); return res.json({ ok: true, action }); }
  if (action === "match_team_b_increment") { io.to(room).emit("control:match_adjust_score", { room, team: 'B', delta: 1 });  return res.json({ ok: true, action }); }
  if (action === "match_team_b_decrement") { io.to(room).emit("control:match_adjust_score", { room, team: 'B', delta: -1 }); return res.json({ ok: true, action }); }
  if (action === "match_reset")            { io.to(room).emit("control:match_reset", { room }); return res.json({ ok: true, action }); }

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
    if (sRoue.state !== "idle") {
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
    s.state = "active";
    s.data.activatedAt = Date.now();
    if (!s.data.participants)   s.data.participants   = [];
    if (!s.data.consecutifMode) s.data.consecutifMode = false;
    console.log(`🎮 [API] ${room} - Roue ON`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "active", data: s.data });
    return res.json({ ok: true, action });
  }

  if (action === "roue_off") {
    const s = ensureOverlayState(room, "roue_loto");
    s.state = "idle";
    console.log(`🎮 [API] ${room} - Roue OFF`);
    io.to(room).emit("overlay:state", { overlay: "roue_loto", state: "idle", data: {} });
    return res.json({ ok: true, action });
  }

  if (action === "roue_start_collect") {
    const s = ensureOverlayState(room, "roue_loto");
    s.state = "collecting";
    s.data.participants = [];
    console.log(`🎮 [API] ${room} - Roue start collect`);
    io.to(room).emit("roue:start_collect");
    return res.json({ ok: true, action });
  }

  if (action === "roue_stop_collect") {
    const s = ensureOverlayState(room, "roue_loto");
    if (s.state === "collecting") {
      s.state = "ready";
      console.log(`🎮 [API] ${room} - Roue stop collect`);
      io.to(room).emit("roue:stop_collect");
    }
    return res.json({ ok: true, action });
  }

  if (action === "roue_spin") {
    const s = ensureOverlayState(room, "roue_loto");
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
    s.state = "idle";
    s.data.participants = [];
    s.data.consecutifMode = false;
    console.log(`🎮 [API] ${room} - Roue reset`);
    io.to(room).emit("roue:reset");
    return res.json({ ok: true, action });
  }

  if (action === "roue_consecutif_on") {
    const s = ensureOverlayState(room, "roue_loto");
    s.data.consecutifMode = true;
    console.log(`🎮 [API] ${room} - Roue mode consécutif ON`);
    return res.json({ ok: true, action });
  }

  if (action === "roue_consecutif_off") {
    const s = ensureOverlayState(room, "roue_loto");
    s.data.consecutifMode = false;
    console.log(`🎮 [API] ${room} - Roue mode consécutif OFF`);
    return res.json({ ok: true, action });
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
    if (sRoue.state !== "idle") {
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
    for (const { room, overlay } of socketOverlays) {
      const r = getRoom(room);
      if (r.presence[overlay]) { r.presence[overlay].online = false; r.presence[overlay].displaying = false; }
      console.log(`🔴 [PRÉSENCE] ${room} - ${overlay} : hors ligne (disconnect)`);
      io.to(room).emit("overlay:presence", { overlay, online: false, displaying: false });
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
    s.state = "active";
    s.data.activatedAt = Date.now();
    if (overlay === "nuage_de_mots") { s.data.words = {}; }
    if (overlay === "roue_loto") { s.data.participants = []; s.data.consecutifMode = false; }
    if (overlay === "commentaires") { s.data.flux = []; s.data.queue = []; s.data.current = null; s.data.minWords = 4; }
    if (overlay === "match_equipes") { s.data.teamA = { name: "ÉQUIPE A", score: 0 }; s.data.teamB = { name: "ÉQUIPE B", score: 0 }; }
    console.log(`✅ [${room}] Overlay "${overlay}" activé`);
    io.to(room).emit("overlay:state", { overlay, state: "active", data: s.data });
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
        if (overlay.state !== "active") return;

        if (overlayName === "nuage_de_mots") {
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
          if (!overlay.data.participants) overlay.data.participants = [];
          if (user !== "Anonyme" && !overlay.data.participants.includes(user)) {
            overlay.data.participants.push(user);
            io.to(room).emit("overlay:state", { overlay: overlayName, state: "active", data: overlay.data });
          }
        }

        if (overlayName === "commentaires") {
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

  // ============================================================
  // HANDLERS ROUE LOTO
  // ============================================================

  socket.on("roue:start_collect", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    s.state = "collecting";
    s.data.participants = [];
    console.log(`📝 [ROUE] ${p.room} - Démarrage collecte`);
    io.to(p.room).emit("roue:start_collect");
  });

  socket.on("roue:stop_collect", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    if (s.state === "collecting") {
      s.state = "ready";
      console.log(`🔒 [ROUE] ${p.room} - Fermeture collecte`);
      io.to(p.room).emit("roue:stop_collect");
    }
  });

  socket.on("roue:spin", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    if (s.state !== "ready") return;
    s.state = "spinning";
    console.log(`🎡 [ROUE] ${p.room} - SPIN`);
    io.to(p.room).emit("roue:spin");
  });

  socket.on("roue:reset", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    s.state = "idle";
    s.data.participants = [];
    s.data.consecutifMode = false;
    console.log(`🔄 [ROUE] ${p.room} - Reset`);
    io.to(p.room).emit("roue:reset");
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
  });

  socket.on("roue:winner_selected", (p) => {
    const { room, winnerName } = p;
    if (!room || !winnerName) return;
    const s = ensureOverlayState(room, "roue_loto");
    s.state = "ready";
    if (!s.data.consecutifMode) {
      console.log(`🏆 [ROUE] ${room} - Gagnant: "${winnerName}" (mode consécutif OFF, liste inchangée)`);
      return;
    }
    if (!s.data.participants) return;
    const idx = s.data.participants.findIndex(pp => {
      const n = typeof pp === "string" ? pp : pp.name;
      return n === winnerName;
    });
    if (idx !== -1) {
      s.data.participants.splice(idx, 1);
      console.log(`🏆 [ROUE] ${room} - Mode consécutif: "${winnerName}" retiré (reste ${s.data.participants.length})`);
      io.to(room).emit("overlay:state", { overlay: "roue_loto", state: s.state, data: s.data });
    }
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
    s.data.teamA.score = 0;
    s.data.teamB.score = 0;
    console.log(`🔄 [MATCH] ${room} - Reset 0-0`);
    io.to(room).emit("overlay:state", { overlay: "match_equipes", state: s.state, data: s.data });
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server MDI V5.16 Online on ${PORT}`));
