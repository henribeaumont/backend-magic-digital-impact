// ============================================================
// MDI SERVER V5.3 (SAAS + WATCHTOWER + REMOTE FIX)
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

// --- MEMORY (Votes RAM) ---
const ROOMS = Object.create(null);
function getRoom(id) {
  if (!ROOMS[id]) ROOMS[id] = { overlays: {}, votes: { A:0, B:0, C:0, D:0, total:0 } };
  return ROOMS[id];
}
function ensureOverlayState(roomId, overlay) {
  const r = getRoom(roomId);
  if (!r.overlays[overlay]) r.overlays[overlay] = { state: "idle", data: {} };
  return r.overlays[overlay];
}

// --- MIDDLEWARES ---
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

// --- HELPER DB ---
async function manualSaveQuestion(qData) {
  const { data: existing } = await supabase.from("questions").select("id").eq("room_id", qData.room_id).eq("question_key", qData.question_key).maybeSingle();
  if (existing) return (await supabase.from("questions").update(qData).eq("id", existing.id)).error;
  else return (await supabase.from("questions").insert([qData])).error;
}

// --- ROUTES ---
app.get("/", (req, res) => res.send("MDI Server V5.3 (Remote Fixed)"));
app.get("/health", (req, res) => res.json({ ok: true, version: "5.3" }));

// C'EST CETTE ROUTE QUI MANQUAIT POUR LA TÉLÉCOMMANDE !
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

// Client API
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
  
  // 1. Overlay & Remote
  socket.on("overlay:join", async (p) => {
    if(!supabaseEnabled) return;
    const { data: client } = await supabase.from("clients").select("*").eq("room_id", p.room).maybeSingle();
    if (!client || !client.active || client.room_key !== p.key) return socket.emit("overlay:forbidden", {reason:"auth"});
    socket.join(p.room);
    const s = ensureOverlayState(p.room, p.overlay);
    // Renvoi des votes actuels si existants
    const r = getRoom(p.room);
    if (r.votes.total > 0) s.data.percents = calculatePercents(r.votes);
    socket.emit("overlay:state", { overlay: p.overlay, state: s.state, data: s.data });
  });

  // 2. Watchtower (Extension)
  socket.on("rejoindre_salle", (roomId) => {
    console.log(`📡 Watchtower: ${roomId}`);
    socket.join(roomId);
  });

  // 3. Votes (Watchtower)
  socket.on("nouveau_vote", (payload) => {
    const room = payload.room;
    let rawVote = String(payload.vote || "").trim().toUpperCase();
    let choice = null;
    if (rawVote.startsWith("A") || rawVote.includes(" A ")) choice = "A";
    else if (rawVote.startsWith("B") || rawVote.includes(" B ")) choice = "B";
    else if (rawVote.startsWith("C") || rawVote.includes(" C ")) choice = "C";
    else if (rawVote.startsWith("D") || rawVote.includes(" D ")) choice = "D";

    if (choice && room) {
      const r = getRoom(room);
      r.votes[choice]++;
      r.votes.total++;
      console.log(`🗳️ VOTE: ${choice} (Total: ${r.votes.total})`);
      const s = ensureOverlayState(room, "quiz_ou_sondage");
      s.data.percents = calculatePercents(r.votes);
      io.to(room).emit("overlay:state", { overlay: "quiz_ou_sondage", state: s.state, data: s.data });
    }
  });

  // 4. Remote Controls
  socket.on("control:load_question", async (p) => {
    const r = getRoom(p.room);
    r.votes = { A:0, B:0, C:0, D:0, total:0 }; // Reset votes
    
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

  socket.on("control:show_options", (p) => io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "options", data: ensureOverlayState(p.room, p.overlay).data }));
  socket.on("control:set_state", (p) => {
    const s = ensureOverlayState(p.room, p.overlay); s.state = p.state;
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: p.state, data: s.data });
  });
  socket.on("control:idle", (p) => io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "idle", data: {} }));
});

function calculatePercents(votes) {
  const t = votes.total || 1;
  return {
    A: ((votes.A / t) * 100).toFixed(1),
    B: ((votes.B / t) * 100).toFixed(1),
    C: ((votes.C / t) * 100).toFixed(1),
    D: ((votes.D / t) * 100).toFixed(1)
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server V5.3 (Fixed) on ${PORT}`));
