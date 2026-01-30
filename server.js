// ==========================================
// MDI SERVER V4.0 (ADMIN API + SAAS READY)
// ==========================================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// Supabase
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
const supabaseEnabled = Boolean(SUPABASE_URL) && Boolean(SUPABASE_SERVICE_ROLE_KEY) && typeof createClient === "function";
const supabase = supabaseEnabled ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;

// SECRET ADMIN (Change-le si tu veux plus de sécu, mais suffisant pour commencer)
const ADMIN_SECRET = "MDI_SUPER_ADMIN_2026";

console.log(`🧩 Supabase mode: ${supabaseEnabled ? "ON" : "OFF"}`);

// --- HELPERS DB ---
async function sbGetClient(roomId) {
  if(!supabaseEnabled) return null;
  const { data } = await supabase.from("clients").select("*").eq("room_id", roomId).limit(1).maybeSingle();
  return data;
}
async function sbGetQuestion(roomId, questionKey) {
  if(!supabaseEnabled) return null;
  const { data } = await supabase.from("questions").select("*").eq("room_id", roomId).eq("question_key", questionKey).limit(1).maybeSingle();
  return data;
}

// --- API ADMIN (NOUVEAU V4.0) ---
// Middleware de sécurité simple
function requireAdmin(req, res, next) {
  const secret = req.headers["x-admin-secret"];
  if (secret !== ADMIN_SECRET) return res.status(403).json({ ok: false, error: "Forbidden: Bad Secret" });
  next();
}

// 1. Lister tout (Clients + Questions)
app.get("/api/admin/data", requireAdmin, async (req, res) => {
  if (!supabaseEnabled) return res.json({ ok: false, error: "no_db" });
  
  const { data: clients } = await supabase.from("clients").select("*").order("created_at", { ascending: false });
  const { data: questions } = await supabase.from("questions").select("*").order("room_id").order("order_index");
  
  res.json({ ok: true, clients: clients || [], questions: questions || [] });
});

// 2. Créer/Modifier Client
app.post("/api/admin/client", requireAdmin, async (req, res) => {
  const { room_id, room_key, entitlements, active } = req.body;
  if (!supabaseEnabled) return res.json({ ok: false, error: "no_db" });

  // Upsert (Insert ou Update si existe)
  const { error } = await supabase.from("clients").upsert({
    room_id, room_key, active, entitlements, created_at: new Date()
  }, { onConflict: "room_id" });

  if (error) return res.json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// 3. Créer/Modifier Question
app.post("/api/admin/question", requireAdmin, async (req, res) => {
  const q = req.body; // doit contenir room_id, question_key, etc.
  if (!supabaseEnabled) return res.json({ ok: false, error: "no_db" });

  // On force created_at pour l'ordre si nouveau
  const payload = { ...q, created_at: new Date() };
  
  const { error } = await supabase.from("questions").upsert(payload, { onConflict: "room_id, question_key" });
  if (error) return res.json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// 4. Supprimer Question
app.post("/api/admin/delete-question", requireAdmin, async (req, res) => {
  const { room_id, question_key } = req.body;
  if (!supabaseEnabled) return res.json({ ok: false, error: "no_db" });

  const { error } = await supabase.from("questions").delete().match({ room_id, question_key });
  if (error) return res.json({ ok: false, error: error.message });
  res.json({ ok: true });
});


// --- ROUTES PUBLIC ---
app.get("/", (req, res) => res.send("MDI Live Server V4.0 (Admin Ready)"));
app.get("/health", (req, res) => res.json({ ok: true, version: "4.0", supabaseEnabled }));
app.get("/debug/questions", async (req, res) => {
  const room = String(req.query.room || "").trim();
  if (!room || !supabaseEnabled) return res.json({ ok: false, error: "no_room_or_supabase" });
  const { data } = await supabase.from("questions").select("*").eq("room_id", room).order("order_index");
  res.json({ ok: true, data: data || [] });
});

// --- SOCKET LOGIC ---
async function getClientConfig(roomId) {
  if (!roomId || !supabaseEnabled) return null;
  return await sbGetClient(roomId);
}
const ROOMS = Object.create(null);
function ensureOverlayState(roomId, overlay) {
  if (!ROOMS[roomId]) ROOMS[roomId] = { overlays: {} };
  if (!ROOMS[roomId].overlays[overlay]) ROOMS[roomId].overlays[overlay] = { state: "idle", data: {} };
  return ROOMS[roomId].overlays[overlay];
}

io.on("connection", (socket) => {
  console.log("🔌 Connect:", socket.id);

  socket.on("overlay:join", async (p) => {
    const { room, key, overlay } = p || {};
    const client = await getClientConfig(room);
    if (!client || !client.active || client.room_key !== key) return socket.emit("overlay:forbidden", { reason: "auth" });
    const ent = client.entitlements || {};
    if (Object.keys(ent).length > 0 && ent[overlay] !== true) return socket.emit("overlay:forbidden", { reason: "entitlements" });
    
    socket.join(room);
    const s = ensureOverlayState(room, overlay);
    socket.emit("overlay:state", { overlay, state: s.state, data: s.data });
  });

  socket.on("control:load_question", async (p) => {
    const { room, key, overlay, question_key } = p || {};
    console.log(`🔍 Load Q: ${room} / ${question_key}`);
    const client = await getClientConfig(room);
    if (!client || client.room_key !== key) return;
    
    const q = await sbGetQuestion(room, question_key);
    if (!q) return console.log("❌ Q not found");

    const question = {
      id: q.question_key,
      type: q.type,
      prompt: q.prompt,
      options: { A: q.option_a||"", B: q.option_b||"", C: q.option_c||"", D: q.option_d||"" },
      correct: q.type === "quiz" ? q.correct_option : null,
    };
    const s = ensureOverlayState(room, overlay);
    s.state = "question"; s.data = { question };
    io.to(room).emit("overlay:state", { overlay, state: "question", data: s.data });
  });

  // Helpers
  socket.on("control:show_options", (p) => io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "options", data: ensureOverlayState(p.room, p.overlay).data }));
  socket.on("control:set_state", (p) => {
    const s = ensureOverlayState(p.room, p.overlay);
    s.state = p.state;
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: p.state, data: s.data });
  });
  socket.on("control:idle", (p) => io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "idle", data: {} }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server V4.0 (Admin) on ${PORT}`));
