// ============================================================
// MDI SERVER V5.7 - STABLE & AGNOSTIQUE (ÉDITION SAAS PRO)
// ✅ NOUVEAU : Système d'état unifié pour nuage_de_mots et roue_loto
// ✅ CONSERVÉ : Tous les overlays existants (quiz, tug_of_war, emoji_tornado)
// ✅ ZÉRO RÉGRESSION : raw_vote toujours émis pour compatibilité
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

/* ============================================================
   ✅ PATCH IMPORTANT : extraction de choix A/B/C/D robuste
   - supporte : "A", "a", "A)", "A.", "Henri : A", "Réponse A"
   - évite les faux positifs dans des mots (ex: "CAB" ne doit pas matcher B)
============================================================ */
function normalizeVoteText(raw) {
  if (!raw) return "";
  // Normalise espaces (inclut NBSP) + trims
  return String(raw)
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function extractChoiceABCD(voteText) {
  const s = normalizeVoteText(voteText);
  if (!s) return null;

  // 1) Si c'est exactement A/B/C/D (ou avec ponctuation)
  const exact = s.match(/^([ABCD])[\)\]\.\!\?:,\-]*$/);
  if (exact) return exact[1];

  // 2) Token isolé (bordures non alphanum)
  // ex: "HENRI : A", "REPONSE B", "(C)", "=> D"
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
app.get("/", (req, res) => res.send("MDI Server V5.7 Pro Online"));

app.get("/debug/questions", async (req, res) => {
  const room = String(req.query.room || "").trim();
  if (!room || !supabaseEnabled) return res.json({ ok: false, error: "no_room" });
  const { data } = await supabase.from("questions").select("*").eq("room_id", room).order("order_index");
  res.json({ ok: true, data: data || [] });
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

  /* ============================================================
     ✅ NOUVEAU : Activation/désactivation des overlays
     - Utilisé par nuage_de_mots et roue_loto
     - Reset les données au moment de l'activation
  ============================================================ */
  socket.on("control:activate_overlay", (payload) => {
    const { room, overlay } = payload;
    const s = ensureOverlayState(room, overlay);
    
    s.state = "active";
    s.data.activatedAt = Date.now(); // Timestamp serveur
    
    // ✅ Reset des données spécifiques selon l'overlay
    if (overlay === "nuage_de_mots") {
      s.data.words = {}; // Vide le nuage
    }
    if (overlay === "roue_loto") {
      s.data.participants = []; // Vide la roue
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

  /* ============================================================
     ✅ MODIFIÉ : nouveau_vote dispatch vers overlays actifs
     - Conserve le comportement existant pour quiz
     - Ajoute dispatch conditionnel pour nuage_de_mots et roue_loto
     - ✅ CONSERVE l'émission raw_vote (compatibilité totale)
  ============================================================ */
  socket.on("nouveau_vote", (payload) => {
    const room = payload.room;
    const user = payload.user || "Anonyme";
    const rawVoteOriginal = String(payload.vote || "");
    const rawVote = normalizeVoteText(rawVoteOriginal);

    if (room && rawVote) {
      const r = getRoom(room);

      // ✅ CONSERVÉ : logique quiz existante (pas de changement)
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

      // ✅ NOUVEAU : dispatch vers overlays actifs (nuage_de_mots, roue_loto)
      Object.keys(r.overlays).forEach(overlayName => {
        const overlay = r.overlays[overlayName];
        
        // ❌ Ignore si l'overlay n'est pas en état "active"
        if (overlay.state !== "active") return;
        
        // ✅ Traitement nuage de mots
        if (overlayName === "nuage_de_mots") {
          if (!overlay.data.words) overlay.data.words = {};
          
          // Nettoyer et valider le mot
          const word = rawVote.trim().toLowerCase();
          
          // Ignorer si c'est un vote quiz A/B/C/D
          if (choice) return;
          
          // Ignorer les mots trop longs ou avec trop de mots
          const words = word.split(/\s+/).filter(Boolean);
          if (words.length > 6 || word.length > 60) return;
          
          // Ajouter ou incrémenter le mot
          overlay.data.words[word] = (overlay.data.words[word] || 0) + 1;
          
          io.to(room).emit("overlay:state", {
            overlay: overlayName,
            state: "active",
            data: overlay.data
          });
        }
        
        // ✅ Traitement roue loto
        if (overlayName === "roue_loto") {
          if (!overlay.data.participants) overlay.data.participants = [];
          
          // Ajouter le participant s'il n'existe pas déjà
          if (user !== "Anonyme" && !overlay.data.participants.includes(user)) {
            overlay.data.participants.push(user);
            
            io.to(room).emit("overlay:state", {
              overlay: overlayName,
              state: "active",
              data: overlay.data
            });
          }
        }
      });

      // ✅ CONSERVÉ : canal universel raw_vote (compatibilité totale)
      // Utilisé par emoji_tornado, tug_of_war, et autres overlays existants
      io.to(room).emit("raw_vote", { user, vote: rawVote });
    }
  });

  /* ============================================================
     ✅ CONSERVÉ : Tous les events existants (pas de changement)
  ============================================================ */
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server MDI V5.7 Pro Online on ${PORT}`));
