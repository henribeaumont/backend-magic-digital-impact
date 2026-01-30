// ============================================================
// MDI SERVER V7.0 (AGNOSTIC STORAGE)
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

// --- CONFIG ---
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ADMIN_SECRET = "MDI_SUPER_ADMIN_2026"; 
const supabaseEnabled = Boolean(SUPABASE_URL) && Boolean(SUPABASE_SERVICE_ROLE_KEY) && typeof createClient === "function";
const supabase = supabaseEnabled ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;

// --- MEMORY ---
const ROOMS = Object.create(null);

function getRoom(id) {
  if (!ROOMS[id]) ROOMS[id] = { overlays: {}, history: [] };
  return ROOMS[id];
}

function ensureOverlayState(roomId, overlay) {
  const r = getRoom(roomId);
  if (!r.overlays[overlay]) r.overlays[overlay] = { state: "idle", data: {} };
  return r.overlays[overlay];
}

// --- STATS DYNAMIQUES ---
function getVoteStats(roomHistory) {
  // On ne fixe plus {A:0, B:0}. On crée les clés à la volée.
  // Ex: { A: 12, B: 5, O: 8, N: 3, 1: 4 }
  const stats = { total: 0 };
  roomHistory.forEach(v => {
    if (!stats[v.choice]) stats[v.choice] = 0;
    stats[v.choice]++;
    stats.total++;
  });
  return stats;
}

// Pour le quiz standard (A/B/C/D), on garde un helper de formatage
function formatQuizPercents(stats) {
  const t = stats.total || 1;
  return {
    A: (((stats.A||0) / t) * 100).toFixed(1),
    B: (((stats.B||0) / t) * 100).toFixed(1),
    C: (((stats.C||0) / t) * 100).toFixed(1),
    D: (((stats.D||0) / t) * 100).toFixed(1)
  };
}

// --- SOCKET ---
io.on("connection", (socket) => {
  
  socket.on("overlay:join", async (p) => {
    if(!supabaseEnabled) return;
    const { data: client } = await supabase.from("clients").select("*").eq("room_id", p.room).maybeSingle();
    if (!client || !client.active || client.room_key !== p.key) return socket.emit("overlay:forbidden", {reason:"auth"});
    socket.join(p.room);
    
    const s = ensureOverlayState(p.room, p.overlay);
    const r = getRoom(p.room);
    if (r.history.length > 0) {
      const stats = getVoteStats(r.history);
      s.data.votes = stats; // On envoie TOUT (A, B, O, N...)
      s.data.percents = formatQuizPercents(stats);
    }
    socket.emit("overlay:state", { overlay: p.overlay, state: s.state, data: s.data });
  });

  socket.on("rejoindre_salle", (roomId) => socket.join(roomId));

  // --- VOTES AGNOSTIQUES ---
  socket.on("nouveau_vote", (payload) => {
    const room = payload.room;
    let rawVote = String(payload.vote || "").trim().toUpperCase(); // "O", "N", "A"...
    let user = payload.user || "Anonyme";

    // On accepte tout vote court (1 ou 2 caractères max)
    if (rawVote.length > 0 && rawVote.length <= 2 && room) {
      const r = getRoom(room);
      
      // On stocke
      r.history.push({ user, choice: rawVote, time: Date.now() });
      console.log(`🗳️ VOTE [${room}]: ${rawVote}`);
      
      const stats = getVoteStats(r.history);
      
      // 1. Diffusion générique (Le client triera ce qu'il veut)
      io.to(room).emit("overlay:state", { 
        overlay: "tug_of_war", 
        state: "active", 
        data: { votes: stats } // Contient {O: 5, N: 3, ...}
      });

      // 2. Diffusion Quiz (Rétro-compatibilité)
      const sQuiz = ensureOverlayState(room, "quiz_ou_sondage");
      sQuiz.data.percents = formatQuizPercents(stats);
      io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: sQuiz.state, data: sQuiz.data });
    }
  });

  socket.on("control:load_question", async (p) => {
    const r = getRoom(p.room);
    r.history = []; 
    // Reset global
    io.to(p.room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "question", data: { percents: {A:0}, votes:{} } });
    io.to(p.room).emit("overlay:state", { overlay: "tug_of_war", state: "reset", data: { votes:{} } });
  });
  
  // (Autres commandes remote inchangées...)
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server V7.0 (Agnostic) on ${PORT}`));
