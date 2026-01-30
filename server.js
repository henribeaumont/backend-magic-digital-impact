// ============================================================
// MDI SERVER V5.5 (WINNER = FASTEST USER)
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
  if (!ROOMS[id]) {
    ROOMS[id] = { 
      overlays: {}, 
      // Nouveau : on garde l'historique complet pour savoir QUI est le plus rapide
      history: [] // [{ user: "Bob", choice: "A", time: 123456789 }]
    };
  }
  return ROOMS[id];
}

function ensureOverlayState(roomId, overlay) {
  const r = getRoom(roomId);
  if (!r.overlays[overlay]) r.overlays[overlay] = { state: "idle", data: {} };
  return r.overlays[overlay];
}

// --- HELPER VOTES ---
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

// --- MIDDLEWARES & ROUTES (Inchangés V5.3) ---
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
async function manualSaveQuestion(qData) {
  const { data: existing } = await supabase.from("questions").select("id").eq("room_id", qData.room_id).eq("question_key", qData.question_key).maybeSingle();
  if (existing) return (await supabase.from("questions").update(qData).eq("id", existing.id)).error;
  else return (await supabase.from("questions").insert([qData])).error;
}

app.get("/", (req, res) => res.send("MDI Server V5.5 (Fastest Winner)"));
app.get("/health", (req, res) => res.json({ ok: true, version: "5.5" }));
app.get("/debug/questions", async (req, res) => {
  const room = String(req.query.room || "").trim();
  if (!room || !supabaseEnabled) return res.json({ ok: false, error: "no_room" });
  const { data } = await supabase.from("questions").select("*").eq("room_id", room).order("order_index");
  res.json({ ok: true, data: data || [] });
});

// Admin & Client Routes
app.get("/api/admin/data", requireAdmin, async (req, res) => {
  const { data: c } = await supabase.from("clients").select("*").order("created_at");
  const { data: q } = await supabase.from("questions").select("*").order("room_id").order("order_index");
  res.json({ ok: true, clients: c||[], questions: q||[] });
});
app.post("/api/admin/client", requireAdmin, async (req, res) => {
  const { error } = await supabase.from("clients").upsert({ ...req.body, created_at: new Date() }, { onConflict: "room_id" });
  res.json({ ok: !error, error: error?.message });
});
app.post("/api/admin/question", requireAdmin, async (req, res) => {
  const error = await manualSaveQuestion({ ...req.body, created_at: new Date() });
  res.json({ ok: !error, error: error?.message });
});
app.post("/api/admin/delete-question", requireAdmin, async (req, res) => {
  const { error } = await supabase.from("questions").delete().match(req.body);
  res.json({ ok: !error, error: error?.message });
});
app.get("/api/client/questions", requireClientAuth, async (req, res) => {
  const { data } = await supabase.from("questions").select("*").eq("room_id", req.client.room_id).order("order_index");
  res.json({ ok: true, questions: data || [] });
});
app.post("/api/client/save-question", requireClientAuth, async (req, res) => {
  const q = { ...req.body, room_id: req.client.room_id, created_at: new Date() };
  const error = await manualSaveQuestion(q);
  res.json({ ok: !error, error: error?.message });
});
app.post("/api/client/delete-question", requireClientAuth, async (req, res) => {
  const { error } = await supabase.from("questions").delete().match({ room_id: req.client.room_id, question_key: req.body.question_key });
  res.json({ ok: !error, error: error?.message });
});

// --- SOCKET ---
io.on("connection", (socket) => {
  
  socket.on("overlay:join", async (p) => {
    if(!supabaseEnabled) return;
    const { data: client } = await supabase.from("clients").select("*").eq("room_id", p.room).maybeSingle();
    if (!client || !client.active || client.room_key !== p.key) return socket.emit("overlay:forbidden", {reason:"auth"});
    socket.join(p.room);
    const s = ensureOverlayState(p.room, p.overlay);
    
    // Refresh stats
    const r = getRoom(p.room);
    if (r.history.length > 0) s.data.percents = calculatePercents(getVoteStats(r.history));
    
    socket.emit("overlay:state", { overlay: p.overlay, state: s.state, data: s.data });
  });

  socket.on("rejoindre_salle", (roomId) => {
    console.log(`📡 Watchtower: ${roomId}`);
    socket.join(roomId);
  });

  // --- COEUR DU SYSTÈME DE VOTES ---
  socket.on("nouveau_vote", (payload) => {
    const room = payload.room;
    // On attend maintenant { room: "...", vote: "A", user: "Jean" }
    let rawVote = String(payload.vote || "").trim().toUpperCase();
    let user = payload.user || "Anonyme"; // Si l'extension n'envoie pas de nom

    let choice = null;
    if (rawVote.startsWith("A") || rawVote.includes(" A ")) choice = "A";
    else if (rawVote.startsWith("B") || rawVote.includes(" B ")) choice = "B";
    else if (rawVote.startsWith("C") || rawVote.includes(" C ")) choice = "C";
    else if (rawVote.startsWith("D") || rawVote.includes(" D ")) choice = "D";

    if (choice && room) {
      const r = getRoom(room);
      
      // Anti-Spam : On vérifie si ce user a déjà voté pour cette question
      const alreadyVoted = r.history.find(v => v.user === user && user !== "Anonyme");
      
      if (!alreadyVoted) {
        // Enregistrement avec TIMESTAMP pour le chrono
        r.history.push({ 
          user, 
          choice, 
          time: Date.now() 
        });
        
        console.log(`🗳️ VOTE: ${user} -> ${choice}`);
        
        const s = ensureOverlayState(room, "quiz_ou_sondage");
        s.data.percents = calculatePercents(getVoteStats(r.history));
        
        // On préserve l'état (si options affichées, elles le restent)
        io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: s.state, data: s.data });
      }
    }
  });

  // --- LOGIQUE GAGNANT ---
  socket.on("control:set_state", (p) => {
    const s = ensureOverlayState(p.room, p.overlay);
    s.state = p.state;

    // CALCUL DU GAGNANT
    if (p.state === "winner") {
      const q = s.data.question;
      const r = getRoom(p.room);
      let winnerText = "Personne";

      if (q && q.type === "quiz" && q.correct) {
        // QUIZ : On filtre ceux qui ont bon
        const winners = r.history.filter(v => v.choice === q.correct);
        
        if (winners.length > 0) {
          // On trie par temps (le plus petit timestamp = le plus rapide)
          winners.sort((a,b) => a.time - b.time);
          // Le gagnant est le premier
          winnerText = winners[0].user; 
          // Si c'est "Anonyme", on met un message sympa
          if(winnerText === "Anonyme") winnerText = "Quelqu'un (Anonyme)";
        } else {
          winnerText = "Aucune bonne réponse";
        }
      } 
      else if (q && q.type === "poll") {
        // SONDAGE : Majorité
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
    r.history = []; // RESET TOTAL des votes pour la nouvelle question
    
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
server.listen(PORT, () => console.log(`🚀 Server V5.5 (Fastest Winner) on ${PORT}`));
