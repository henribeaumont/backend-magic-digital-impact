// ============================================================
// MDI SERVER V5.1 (MANUAL SAVE + NO ORDER LOGIC)
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

// --- HELPER SAUVEGARDE MANUELLE (La Solution Alternative) ---
async function manualSaveQuestion(qData) {
  // 1. On vérifie si elle existe
  const { data: existing } = await supabase.from("questions")
    .select("id")
    .eq("room_id", qData.room_id)
    .eq("question_key", qData.question_key)
    .maybeSingle();

  if (existing) {
    // UPDATE
    const { error } = await supabase.from("questions").update(qData).eq("id", existing.id);
    return error;
  } else {
    // INSERT
    const { error } = await supabase.from("questions").insert([qData]);
    return error;
  }
}

// --- API ADMIN ---
app.get("/api/admin/data", requireAdmin, async (req, res) => {
  if (!supabaseEnabled) return res.json({ ok: false });
  const { data: c } = await supabase.from("clients").select("*").order("created_at");
  const { data: q } = await supabase.from("questions").select("*").order("room_id").order("order_index");
  res.json({ ok: true, clients: c||[], questions: q||[] });
});
app.post("/api/admin/client", requireAdmin, async (req, res) => {
  const { error } = await supabase.from("clients").upsert({ ...req.body, created_at: new Date() }, { onConflict: "room_id" });
  if (error) return res.json({ ok: false, error: error.message });
  res.json({ ok: true });
});
app.post("/api/admin/question", requireAdmin, async (req, res) => {
  // Utilise la sauvegarde manuelle
  const error = await manualSaveQuestion({ ...req.body, created_at: new Date() });
  if (error) return res.json({ ok: false, error: error.message });
  res.json({ ok: true });
});
app.post("/api/admin/delete-question", requireAdmin, async (req, res) => {
  const { error } = await supabase.from("questions").delete().match(req.body);
  if (error) return res.json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// --- API CLIENT ---
app.get("/api/client/questions", requireClientAuth, async (req, res) => {
  const { data } = await supabase.from("questions").select("*").eq("room_id", req.client.room_id).order("order_index");
  res.json({ ok: true, questions: data || [] });
});
app.post("/api/client/save-question", requireClientAuth, async (req, res) => {
  const q = req.body;
  q.room_id = req.client.room_id; // Force ID
  q.created_at = new Date();
  
  // Sauvegarde manuelle robuste
  const error = await manualSaveQuestion(q);
  
  if (error) return res.json({ ok: false, error: error.message });
  res.json({ ok: true });
});
app.post("/api/client/delete-question", requireClientAuth, async (req, res) => {
  const { error } = await supabase.from("questions").delete().match({ room_id: req.client.room_id, question_key: req.body.question_key });
  if (error) return res.json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// --- ROUTES ---
app.get("/", (req, res) => res.send("MDI Server V5.1 (Manual Save)"));
app.get("/health", (req, res) => res.json({ ok: true, version: "5.1", supabase: supabaseEnabled }));
app.get("/debug/questions", async (req, res) => {
  const room = String(req.query.room || "").trim();
  if (!room || !supabaseEnabled) return res.json({ ok: false });
  const { data } = await supabase.from("questions").select("*").eq("room_id", room).order("order_index");
  res.json({ ok: true, data: data || [] });
});

// --- SOCKET (INCHANGÉ) ---
const ROOMS = Object.create(null);
function ensureOverlayState(roomId, overlay) {
  if (!ROOMS[roomId]) ROOMS[roomId] = { overlays: {} };
  if (!ROOMS[roomId].overlays[overlay]) ROOMS[roomId].overlays[overlay] = { state: "idle", data: {} };
  return ROOMS[roomId].overlays[overlay];
}
io.on("connection", (socket) => {
  socket.on("overlay:join", async (p) => {
    if(!supabaseEnabled) return;
    const { data: client } = await supabase.from("clients").select("*").eq("room_id", p.room).maybeSingle();
    if (!client || !client.active || client.room_key !== p.key) return socket.emit("overlay:forbidden", {reason:"auth"});
    socket.join(p.room);
    const s = ensureOverlayState(p.room, p.overlay);
    socket.emit("overlay:state", { overlay: p.overlay, state: s.state, data: s.data });
  });
  socket.on("control:load_question", async (p) => {
    if(!supabaseEnabled) return;
    const { data: q } = await supabase.from("questions").select("*").eq("room_id", p.room).eq("question_key", p.question_key).maybeSingle();
    if (!q) return;
    const question = {
      id: q.question_key, type: q.type, prompt: q.prompt,
      options: { A: q.option_a||"", B: q.option_b||"", C: q.option_c||"", D: q.option_d||"" },
      correct: q.type === "quiz" ? q.correct_option : null,
    };
    const s = ensureOverlayState(p.room, p.overlay); s.state = "question"; s.data = { question };
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "question", data: s.data });
  });
  socket.on("control:show_options", (p) => io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "options", data: ensureOverlayState(p.room, p.overlay).data }));
  socket.on("control:set_state", (p) => {
    const s = ensureOverlayState(p.room, p.overlay); s.state = p.state;
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: p.state, data: s.data });
  });
  socket.on("control:idle", (p) => io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "idle", data: {} }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server V5.1 on ${PORT}`));
