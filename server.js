// ============================================================
// MDI SERVER V5.5 - STABLE & AGNOSTIQUE
// Priorité : Stabilité Quiz + Ouverture Tug of War
// ============================================================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
let createClient;
try { ({ createClient } = require("@supabase/supabase-js")); } catch (e) { createClient = null; }

const app = express();
app.use(express.json()); 
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ADMIN_SECRET = "MDI_SUPER_ADMIN_2026"; 

const supabaseEnabled = Boolean(SUPABASE_URL) && Boolean(SUPABASE_SERVICE_ROLE_KEY) && typeof createClient === "function";
const supabase = supabaseEnabled ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;

// --- MÉMOIRE VIVE (ROOMS) ---
const ROOMS = Object.create(null);

function getRoom(id) {
  if (!ROOMS[id]) {
    ROOMS[id] = { 
      overlays: {}, 
      history: [] // Stocke { user, choice, time }
    };
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
    if(stats[v.choice] !== undefined) stats[v.choice]++;
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

// --- ROUTES API ---

app.get("/", (req, res) => res.send("MDI Server V5.5 - Ready for Quiz & TugOfWar"));
app.get("/health", (req, res) => res.json({ ok: true, version: "5.5" }));

// Debug pour la télécommande
app.get("/debug/questions", async (req, res) => {
  const room = String(req.query.room || "").trim();
  if (!room || !supabaseEnabled) return res.json({ ok: false, error: "no_room" });
  const { data } = await supabase.from("questions").select("*").eq("room_id", room).order("order_index");
  res.json({ ok: true, data: data || [] });
});

// Middlewares Auth
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET) return res.status(403).json({ ok: false, error: "Bad Secret" });
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

// --- GESTION DES SOCKETS ---

io.on("connection", (socket) => {
  
  // Rejoindre une salle (Standard)
  socket.on("rejoindre_salle", (roomId) => {
    socket.join(roomId);
  });

  // Authentification des Overlays
  socket.on("overlay:join", async (p) => {
    if(!supabaseEnabled) return;
    const { data: client } = await supabase.from("clients").select("*").eq("room_id", p.room).maybeSingle();
    if (!client || !client.active || client.room_key !== p.key) return socket.emit("overlay:forbidden", {reason:"auth"});
    
    socket.join(p.room);
    const s = ensureOverlayState(p.room, p.overlay);
    
    // Si Quiz : envoyer stats actuelles
    if (p.overlay === "quiz_ou_sondage") {
        const r = getRoom(p.room);
        if (r.history.length > 0) s.data.percents = calculatePercents(getVoteStats(r.history));
    }
    
    socket.emit("overlay:state", { overlay: p.overlay, state: s.state, data: s.data });
  });

  // --- RÉCEPTION DES VOTES ---
  socket.on("nouveau_vote", (payload) => {
    const room = payload.room;
    const user = payload.user || "Anonyme";
    const rawVote = String(payload.vote || "").trim().toUpperCase();

    if (room && rawVote) {
      const r = getRoom(room);

      // 1. Canal Quiz (L'existant reste compatible)
      let choice = null;
      if (rawVote.startsWith("A") || rawVote.includes(" A ")) choice = "A";
      else if (rawVote.startsWith("B") || rawVote.includes(" B ")) choice = "B";
      else if (rawVote.startsWith("C") || rawVote.includes(" C ")) choice = "C";
      else if (rawVote.startsWith("D") || rawVote.includes(" D ")) choice = "D";

      if (choice) {
        const alreadyVoted = r.history.find(v => v.user === user && user !== "Anonyme");
        if (!alreadyVoted) {
          r.history.push({ user, choice, time: Date.now() });
          const s = ensureOverlayState(room, "quiz_ou_sondage");
          s.data.percents = calculatePercents(getVoteStats(r.history));
          io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: s.state, data: s.data });
        }
      }

      // 2. Canal Agnostique (Pour Tug of War et futurs overlays)
      // On diffuse le vote brut sans le filtrer
      io.to(room).emit("raw_vote", { user, vote: rawVote });
    }
  });

  // --- TÉLÉCOMMANDE ---
  socket.on("control:set_state", (p) => {
    const s = ensureOverlayState(p.room, p.overlay);
    s.state = p.state;

    // Calcul du gagnant pour le Quiz (Design Winner)
    if (p.state === "winner" && p.overlay === "quiz_ou_sondage") {
      const q = s.data.question;
      const r = getRoom(p.room);
      let winnerText = "Personne";

      if (q && q.type === "quiz" && q.correct) {
        const winners = r.history.filter(v => v.choice === q.correct);
        if (winners.length > 0) {
          winners.sort((a,b) => a.time - b.time);
          winnerText = winners[0].user === "Anonyme" ? "Quelqu'un (Anonyme)" : winners[0].user;
        } else { winnerText = "Aucune bonne réponse"; }
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
    r.history = []; // Reset des votes pour la nouvelle question
    
    const { data: q } = await supabase.from("questions").select("*").eq("room_id", p.room).eq("question_key", p.question_key).maybeSingle();
    if (!q) return;
    
    const question = {
      id: q.question_key, type: q.type, prompt: q.prompt,
      options: { A: q.option_a||"", B: q.option_b||"", C: q.option_c||"", D: q.option_d||"" },
      correct: q.type === "quiz" ? q.correct_option : null,
    };
    
    const s = ensureOverlayState(p.room, p.overlay); 
    s.state = "question"; 
    s.data = { question, percents: {A:0, B:0, C:0, D:0} };
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "question", data: s.data });
  });

  socket.on("control:show_options", (p) => {
    const s = ensureOverlayState(p.room, p.overlay); s.state = "options";
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "options", data: s.data });
  });
  
  socket.on("control:idle", (p) => {
    const s = ensureOverlayState(p.room, p.overlay); s.state = "idle";
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "idle", data: {} });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server MDI V5.5 Ready on ${PORT}`));
