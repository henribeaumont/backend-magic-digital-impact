// ============================================================
// MDI SERVER V9.0 (PRODUCTION MASTER)
// - API Routes (Quiz Remote) : RESTAURÉES
// - Socket.io (Realtime) : ACTIF
// - Supabase (Auth/DB) : ACTIF
// - Logique Agnostique : Accepte tout (A/B, O/N, 1/2...)
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
const io = new Server(server, { 
  cors: { origin: "*" },
  transports: ["websocket", "polling"] 
});

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseEnabled = Boolean(SUPABASE_URL) && Boolean(SUPABASE_SERVICE_ROLE_KEY) && typeof createClient === "function";
const supabase = supabaseEnabled ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;

// --- MÉMOIRE VIVE (RAM) ---
const ROOMS = Object.create(null);

function getRoom(id) {
  if (!ROOMS[id]) ROOMS[id] = { history: [] };
  return ROOMS[id];
}

// Helper : Calcule les stats brutes (ex: {A:12, B:5, O:3})
function getVoteStats(roomHistory) {
  const stats = { total: 0 };
  roomHistory.forEach(v => {
    if (!stats[v.choice]) stats[v.choice] = 0;
    stats[v.choice]++;
    stats.total++;
  });
  return stats;
}

// Helper : Formate pour le Quiz (Pourcentages A/B/C/D uniquement)
function formatQuizPercents(stats) {
  const t = stats.total || 1;
  return {
    A: (((stats.A||0) / t) * 100).toFixed(1),
    B: (((stats.B||0) / t) * 100).toFixed(1),
    C: (((stats.C||0) / t) * 100).toFixed(1),
    D: (((stats.D||0) / t) * 100).toFixed(1)
  };
}

// --- ROUTES API (C'est ce qui manquait !) ---
app.get("/", (req, res) => res.send("MDI Server V9.0 Running"));

// Route essentielle pour la télécommande (Remote)
app.get("/debug/questions", async (req, res) => {
  const room = String(req.query.room || "").trim();
  
  if (!supabaseEnabled) return res.json({ ok: false, error: "Supabase missing" });
  if (!room) return res.json({ ok: false, error: "No room specified" });

  try {
    // Récupère les questions liées à la ROOM_ID
    const { data, error } = await supabase
      .from("questions")
      .select("*")
      .eq("room_id", room)
      .order("order_index");

    if (error) throw error;
    res.json({ ok: true, data: data || [] });
  } catch (err) {
    console.error("DB Error:", err);
    res.json({ ok: false, error: err.message });
  }
});

// --- SOCKET.IO ---
io.on("connection", (socket) => {
  
  // 1. Authentification & Connexion des Overlays
  socket.on("overlay:join", async (p) => {
    if(!supabaseEnabled) return;
    
    // Vérification stricte (Client ID + Clé Secrète)
    const { data: client } = await supabase
      .from("clients")
      .select("*")
      .eq("room_id", p.room)
      .maybeSingle();

    if (!client || !client.active || client.room_key !== p.key) {
      return socket.emit("overlay:forbidden", {reason:"auth_failed"});
    }

    socket.join(p.room);
    
    // Envoi de l'état actuel (si l'overlay a été rafraîchi)
    const r = getRoom(p.room);
    if (r.history.length > 0) {
      const stats = getVoteStats(r.history);
      socket.emit("overlay:state", { 
        overlay: p.overlay, 
        state: "active", 
        data: { 
          votes: stats, // Pour Tug of War / Nuage de mots
          percents: formatQuizPercents(stats) // Pour Quiz
        } 
      });
    }
  });

  // Pour l'extension (pas d'auth stricte, juste room ID)
  socket.on("rejoindre_salle", (roomId) => socket.join(roomId));

  // 2. Gestion des Votes (Universelle)
  socket.on("nouveau_vote", (payload) => {
    const room = payload.room;
    // On nettoie : Majuscule, pas d'espace
    let rawVote = String(payload.vote || "").trim().toUpperCase();
    let user = payload.user || "Anonyme";

    // Sécurité basique : vote court uniquement
    if (rawVote.length > 0 && rawVote.length <= 10 && room) {
      const r = getRoom(room);
      r.history.push({ user, choice: rawVote, time: Date.now() });
      
      const stats = getVoteStats(r.history);
      
      // Diffusion GLOBALE à la Room
      // Chaque overlay prendra ce qu'il veut dans "votes" ou "percents"
      io.to(room).emit("overlay:state", { 
        overlay: "broadcast", // Tous les overlays écoutent
        state: "active", 
        data: { 
          votes: stats,
          percents: formatQuizPercents(stats)
        } 
      });
      
      // Rétro-compatibilité Quiz (si besoin)
      io.to(room).emit("mise_a_jour_votes", formatQuizPercents(stats));
    }
  });

  // 3. Commandes Télécommande (Remote)
  
  // RESET (Effacer tout)
  socket.on("control:reset_room", (room) => {
    if(!room) return;
    const r = getRoom(room);
    r.history = []; // Vide la RAM
    console.log(`🧹 RESET ROOM: ${room}`);
    
    // Notifie tout le monde
    io.to(room).emit("overlay:state", { state: "reset", data: { votes: {}, percents: {A:0} } });
  });

  // LOAD QUESTION (Quiz)
  socket.on("control:load_question", (p) => {
    const r = getRoom(p.room);
    r.history = []; // On efface les votes précédents
    io.to(p.room).emit("overlay:state", { 
      overlay: "quiz_ou_sondage", 
      state: "question", 
      data: { question: p.question, percents: {A:0} } 
    });
    // On reset aussi les autres overlays pour éviter la confusion
    io.to(p.room).emit("overlay:state", { overlay: "tug_of_war", state: "reset" });
  });

  // SHOW OPTIONS / ANSWER / WINNER
  socket.on("control:show_options", (p) => io.to(p.room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "options" }));
  socket.on("control:show_answer", (p) => io.to(p.room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "answer" }));
  socket.on("control:show_winner", (p) => io.to(p.room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: "winner" }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
