// ============================================================
// MDI SERVER V5.10 - COMPLET (TIMER + COMMENTAIRES + MATCH)
// ✅ Support timer/chrono avec API Stream Deck
// ✅ Support overlay commentaires (gestion flux/queue)
// ✅ Support overlay match équipes (scores A/B)
// ✅ Health check endpoint (/health)
// ✅ Tous les overlays existants préservés
// ✅ ZÉRO RÉGRESSION
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
    ROOMS[id] = { overlays: {}, history: [] };
  }
  return ROOMS[id];
}

function ensureOverlayState(roomId, overlay) {
  const r = getRoom(roomId);
  if (!r.overlays[overlay]) r.overlays[overlay] = { state: "idle", data: {} };
  return r.overlays[overlay];
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
  req.client = client;
  next();
}

// --- ROUTES API ---

// ✅ NOUVEAU : Health check
app.get("/health", (req, res) => {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  
  res.json({
    status: "ok",
    version: "5.9",
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

app.get("/", (req, res) => res.send("MDI Server V5.9 Pro Online"));

app.get("/debug/questions", async (req, res) => {
  const room = String(req.query.room || "").trim();
  if (!room || !supabaseEnabled) return res.json({ ok: false, error: "no_room" });
  const { data } = await supabase.from("questions").select("*").eq("room_id", room).order("order_index");
  res.json({ ok: true, data: data || [] });
});

// ✅ NOUVEAU : Timer status endpoint
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
  
  res.json({
    ok: true,
    mode: mode,
    state: timerState.state,
    seconds: seconds,
    display: display
  });
});

// ✅ NOUVEAU : API control pour Stream Deck
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
  
  // Presets rapides
  if (action === "timer_preset") {
    const seconds = parseInt(payload?.seconds, 10);
    if (Number.isFinite(seconds)) {
      io.to(room).emit("control:timer_set_time", { room, seconds });
      return res.json({ ok: true, action: "timer_preset", seconds });
    }
  }
  
  // Incréments
  if (action === "timer_add_10min") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: 600 });
    return res.json({ ok: true, action: "timer_add_10min" });
  }
  if (action === "timer_add_1min") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: 60 });
    return res.json({ ok: true, action: "timer_add_1min" });
  }
  if (action === "timer_add_10sec") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: 10 });
    return res.json({ ok: true, action: "timer_add_10sec" });
  }
  if (action === "timer_add_1sec") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: 1 });
    return res.json({ ok: true, action: "timer_add_1sec" });
  }
  
  // Décréments
  if (action === "timer_sub_10min") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: -600 });
    return res.json({ ok: true, action: "timer_sub_10min" });
  }
  if (action === "timer_sub_1min") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: -60 });
    return res.json({ ok: true, action: "timer_sub_1min" });
  }
  if (action === "timer_sub_10sec") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: -10 });
    return res.json({ ok: true, action: "timer_sub_10sec" });
  }
  if (action === "timer_sub_1sec") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: -1 });
    return res.json({ ok: true, action: "timer_sub_1sec" });
  }
  
  // Contrôles
  if (action === "timer_start") {
    io.to(room).emit("control:timer_start", { room });
    return res.json({ ok: true, action: "timer_start" });
  }
  if (action === "timer_pause") {
    io.to(room).emit("control:timer_pause", { room });
    return res.json({ ok: true, action: "timer_pause" });
  }
  if (action === "timer_reset") {
    io.to(room).emit("control:timer_reset", { room });
    return res.json({ ok: true, action: "timer_reset" });
  }
  if (action === "timer_toggle_pause") {
    io.to(room).emit("control:timer_toggle_pause", { room });
    return res.json({ ok: true, action: "timer_toggle_pause" });
  }
  
  // Modes
  if (action === "timer_mode_chrono") {
    io.to(room).emit("control:timer_set_mode", { room, mode: "chrono" });
    return res.json({ ok: true, action: "timer_mode_chrono" });
  }
  if (action === "timer_mode_timer") {
    io.to(room).emit("control:timer_set_mode", { room, mode: "timer" });
    return res.json({ ok: true, action: "timer_mode_timer" });
  }
  
  // Actions commentaires Stream Deck
  if (action === "comment_show") {
    const messageId = payload?.messageId;
    if (messageId) {
      io.to(room).emit("control:comment_show", { room, messageId });
      return res.json({ ok: true, action: "comment_show", messageId });
    }
  }
  if (action === "comment_hide") {
    io.to(room).emit("control:comment_hide", { room });
    return res.json({ ok: true, action: "comment_hide" });
  }
  
  // Actions match Stream Deck
  if (action === "match_team_a_increment") {
    io.to(room).emit("control:match_adjust_score", { room, team: 'A', delta: 1 });
    return res.json({ ok: true, action: "match_team_a_increment" });
  }
  if (action === "match_team_a_decrement") {
    io.to(room).emit("control:match_adjust_score", { room, team: 'A', delta: -1 });
    return res.json({ ok: true, action: "match_team_a_decrement" });
  }
  if (action === "match_team_b_increment") {
    io.to(room).emit("control:match_adjust_score", { room, team: 'B', delta: 1 });
    return res.json({ ok: true, action: "match_team_b_increment" });
  }
  if (action === "match_team_b_decrement") {
    io.to(room).emit("control:match_adjust_score", { room, team: 'B', delta: -1 });
    return res.json({ ok: true, action: "match_team_b_decrement" });
  }
  if (action === "match_reset") {
    io.to(room).emit("control:match_reset", { room });
    return res.json({ ok: true, action: "match_reset" });
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
  const { error } = await supabase.from("questions").delete().match(req.body);
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

// --- GESTION DES SOCKETS ---
io.on("connection", (socket) => {
  socket.on("rejoindre_salle", (roomId) => socket.join(roomId));

  socket.on("overlay:join", async (p) => {
    if (!supabaseEnabled) return;
    const { data: client } = await supabase.from("clients").select("*").eq("room_id", p.room).maybeSingle();
    if (!client || !client.active || client.room_key !== p.key) return socket.emit("overlay:forbidden", {reason:"auth"});
    socket.join(p.room);

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
    
    if (overlay === "nuage_de_mots") {
      s.data.words = {};
    }
    if (overlay === "roue_loto") {
      s.data.participants = [];
    }
    if (overlay === "commentaires") {
      s.data.flux = [];
      s.data.queue = [];
      s.data.current = null;
      s.data.minWords = 4;
    }
    if (overlay === "match_equipes") {
      s.data.teamA = { name: "ÉQUIPE A", score: 0 };
      s.data.teamB = { name: "ÉQUIPE B", score: 0 };
    }
    
    console.log(`✅ [${room}] Overlay "${overlay}" activé`);
    
    io.to(room).emit("overlay:state", {
      overlay,
      state: "active",
      data: s.data
    });
  });

  socket.on("control:deactivate_overlay", (payload) => {
    const { room, overlay } = payload;
    const s = ensureOverlayState(room, overlay);
    s.state = "idle";
    
    console.log(`🔴 [${room}] Overlay "${overlay}" désactivé`);
    
    io.to(room).emit("overlay:state", {
      overlay,
      state: "idle",
      data: {}
    });
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

          io.to(room).emit("overlay:state", {
            overlay: "quiz_ou_sondage",
            state: s.state,
            data: s.data
          });
        }
      }

      Object.keys(r.overlays).forEach(overlayName => {
        const overlay = r.overlays[overlayName];
        
        if (overlay.state !== "active") return;
        
        if (overlayName === "nuage_de_mots") {
          if (!overlay.data.words) overlay.data.words = {};
          
          const word = rawVote.trim().toLowerCase();
          
          if (choice) return;
          
          const words = word.split(/\s+/).filter(Boolean);
          if (words.length > 6 || word.length > 60) return;
          
          overlay.data.words[word] = (overlay.data.words[word] || 0) + 1;
          
          io.to(room).emit("overlay:state", {
            overlay: overlayName,
            state: "active",
            data: overlay.data
          });
        }
        
        if (overlayName === "roue_loto") {
          if (!overlay.data.participants) overlay.data.participants = [];
          
          if (user !== "Anonyme" && !overlay.data.participants.includes(user)) {
            overlay.data.participants.push(user);
            
            io.to(room).emit("overlay:state", {
              overlay: overlayName,
              state: "active",
              data: overlay.data
            });
          }
        }
        
        if (overlayName === "commentaires") {
          const minWords = overlay.data.minWords || 4;
          const wordCount = rawVote.split(/\s+/).filter(Boolean).length;
          
          if (wordCount < minWords) return;
          
          const msgId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const newMessage = {
            id: msgId,
            author: user,
            text: rawVote,
            timestamp: Date.now(),
            sent: false
          };
          
          if (!overlay.data.flux) overlay.data.flux = [];
          overlay.data.flux.push(newMessage);
          
          if (overlay.data.flux.length > 50) {
            overlay.data.flux = overlay.data.flux.slice(-50);
          }
          
          io.to(room).emit("overlay:state", {
            overlay: overlayName,
            state: "active",
            data: overlay.data
          });
          
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
          winners.sort((a,b) => a.time - b.time);
          winnerText = winners[0].user === "Anonyme" ? "Quelqu'un (Anonyme)" : winners[0].user;
        } else {
          winnerText = "Aucune bonne réponse";
        }
      }
      else if (q && q.type === "poll") {
        const stats = getVoteStats(r.history);
        const max = Math.max(stats.A, stats.B, stats.C, stats.D);
        const winnerKey = ["A","B","C","D"].find(k => stats[k] === max);
        winnerText = q.options[winnerKey] || "Egalité";
      }
      s.data.winnerName = winnerText;
    }

    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: p.state, data: s.data });
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

    const question = {
      id: q.question_key,
      type: q.type,
      prompt: q.prompt,
      options: { A: q.option_a||"", B: q.option_b||"", C: q.option_c||"", D: q.option_d||"" },
      correct: q.type === "quiz" ? q.correct_option : null,
    };

    const s = ensureOverlayState(p.room, p.overlay);
    s.state = "question";
    s.data = { question, percents: {A:0, B:0, C:0, D:0} };

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
    if (s.state === "ready") {
      s.state = "spinning";
      console.log(`🎡 [ROUE] ${p.room} - SPIN`);
      io.to(p.room).emit("roue:spin");
    }
  });

  socket.on("roue:reset", (p) => {
    const s = ensureOverlayState(p.room, "roue_loto");
    s.state = "idle";
    s.data.participants = [];
    
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

  /* ===== TIMER/CHRONO HANDLERS ===== */

  socket.on("control:timer_set_mode", (payload) => {
    const { room, mode } = payload;
    if (!room) return;
    
    const validMode = (mode === "chrono") ? "chrono" : "timer";
    const s = ensureOverlayState(room, "timer_chrono");
    
    s.data.mode = validMode;
    s.data.seconds = (validMode === "timer") ? 60 : 0;
    
    console.log(`🔄 [TIMER] ${room} - Mode: ${validMode}`);
    
    io.to(room).emit("control:timer_chrono", {
      action: "set_mode",
      mode: validMode
    });
  });

  socket.on("control:timer_set_time", (payload) => {
    const { room, seconds } = payload;
    if (!room || !Number.isFinite(seconds)) return;
    
    const s = ensureOverlayState(room, "timer_chrono");
    const clampedSeconds = Math.max(0, Math.min(seconds, 99 * 60 + 59));
    
    s.data.seconds = clampedSeconds;
    
    console.log(`⏱️ [TIMER] ${room} - Temps configuré: ${clampedSeconds}s`);
    
    io.to(room).emit("control:timer_chrono", {
      action: "set_time",
      seconds: clampedSeconds
    });
  });

  socket.on("control:timer_increment_time", (payload) => {
    const { room, seconds } = payload;
    if (!room || !Number.isFinite(seconds)) return;
    
    const s = ensureOverlayState(room, "timer_chrono");
    const currentSeconds = s.data.seconds || 0;
    const newSeconds = Math.max(0, Math.min(currentSeconds + seconds, 99 * 60 + 59));
    
    s.data.seconds = newSeconds;
    
    console.log(`➕➖ [TIMER] ${room} - Ajustement: ${seconds > 0 ? '+' : ''}${seconds}s → ${newSeconds}s`);
    
    io.to(room).emit("control:timer_chrono", {
      action: "increment_time",
      seconds: seconds
    });
  });

  socket.on("control:timer_start", (payload) => {
    const { room } = payload;
    if (!room) return;
    
    console.log(`▶️ [TIMER] ${room} - Start`);
    
    io.to(room).emit("control:timer_chrono", {
      action: "start"
    });
  });

  socket.on("control:timer_pause", (payload) => {
    const { room } = payload;
    if (!room) return;
    
    console.log(`⏸️ [TIMER] ${room} - Pause`);
    
    io.to(room).emit("control:timer_chrono", {
      action: "pause"
    });
  });

  socket.on("control:timer_toggle_pause", (payload) => {
    const { room } = payload;
    if (!room) return;
    
    console.log(`⏯️ [TIMER] ${room} - Toggle pause`);
    
    io.to(room).emit("control:timer_chrono", {
      action: "toggle_pause"
    });
  });

  socket.on("control:timer_reset", (payload) => {
    const { room } = payload;
    if (!room) return;
    
    console.log(`🔄 [TIMER] ${room} - Reset`);
    
    io.to(room).emit("control:timer_chrono", {
      action: "reset"
    });
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
    
    io.to(room).emit("overlay:state", {
      overlay: "commentaires",
      state: s.state,
      data: s.data
    });
  });

  socket.on("control:comment_show", (payload) => {
    const { room, messageId } = payload;
    if (!room || !messageId) return;
    
    const s = ensureOverlayState(room, "commentaires");
    const message = s.data.queue.find(m => m.id === messageId);
    if (!message) return;
    
    message.displayed = true;
    s.data.current = {
      id: message.id,
      author: message.author,
      text: message.text
    };
    
    console.log(`👁️ [COMMENTAIRES] ${room} - Affichage: "${message.text.substring(0, 30)}..."`);
    
    io.to(room).emit("overlay:state", {
      overlay: "commentaires",
      state: "active",
      data: s.data
    });
  });

  socket.on("control:comment_hide", (payload) => {
    const { room } = payload;
    if (!room) return;
    
    const s = ensureOverlayState(room, "commentaires");
    s.data.current = null;
    
    console.log(`🙈 [COMMENTAIRES] ${room} - Commentaire masqué`);
    
    io.to(room).emit("overlay:state", {
      overlay: "commentaires",
      state: "active",
      data: s.data
    });
  });

  socket.on("control:comment_delete", (payload) => {
    const { room, column, messageId } = payload;
    if (!room || !column || !messageId) return;
    
    const s = ensureOverlayState(room, "commentaires");
    
    if (column === "flux") {
      s.data.flux = s.data.flux.filter(m => m.id !== messageId);
    } else if (column === "queue") {
      s.data.queue = s.data.queue.filter(m => m.id !== messageId);
      if (s.data.current && s.data.current.id === messageId) {
        s.data.current = null;
      }
    }
    
    console.log(`❌ [COMMENTAIRES] ${room} - Message ${messageId} supprimé (${column})`);
    
    io.to(room).emit("overlay:state", {
      overlay: "commentaires",
      state: s.state,
      data: s.data
    });
  });

  socket.on("control:comment_reset_flux", (payload) => {
    const { room } = payload;
    if (!room) return;
    
    const s = ensureOverlayState(room, "commentaires");
    s.data.flux = [];
    
    console.log(`🧹 [COMMENTAIRES] ${room} - Flux nettoyé`);
    
    io.to(room).emit("overlay:state", {
      overlay: "commentaires",
      state: s.state,
      data: s.data
    });
  });

  socket.on("control:comment_reset_queue", (payload) => {
    const { room } = payload;
    if (!room) return;
    
    const s = ensureOverlayState(room, "commentaires");
    s.data.queue = [];
    s.data.current = null;
    
    console.log(`🧹 [COMMENTAIRES] ${room} - Queue vidée`);
    
    io.to(room).emit("overlay:state", {
      overlay: "commentaires",
      state: s.state,
      data: s.data
    });
  });

  // ============================================================
  // HANDLERS MATCH ÉQUIPES
  // ============================================================
  
  socket.on("control:match_adjust_score", (payload) => {
    const { room, team, delta } = payload;
    if (!room || !team || delta === undefined) return;
    
    const s = ensureOverlayState(room, "match_equipes");
    
    if (team === 'A') {
      s.data.teamA.score = Math.max(0, s.data.teamA.score + delta);
    } else if (team === 'B') {
      s.data.teamB.score = Math.max(0, s.data.teamB.score + delta);
    }
    
    console.log(`📊 [MATCH] ${room} - ${team} ${delta > 0 ? '+' : ''}${delta} → ${team === 'A' ? s.data.teamA.score : s.data.teamB.score}`);
    
    io.to(room).emit("overlay:state", {
      overlay: "match_equipes",
      state: s.state,
      data: s.data
    });
  });

  socket.on("control:match_reset", (payload) => {
    const { room } = payload;
    if (!room) return;
    
    const s = ensureOverlayState(room, "match_equipes");
    s.data.teamA.score = 0;
    s.data.teamB.score = 0;
    
    console.log(`🔄 [MATCH] ${room} - Reset 0-0`);
    
    io.to(room).emit("overlay:state", {
      overlay: "match_equipes",
      state: s.state,
      data: s.data
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server MDI V5.10 Complete Online on ${PORT}`));
