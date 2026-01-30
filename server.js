// ==========================================
// MDI SERVER V3.6 (DEBUG MODE - FULL REPAIR)
// ==========================================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// Supabase (optionnel)
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

console.log(`🧩 Supabase mode: ${supabaseEnabled ? "ON" : "OFF"}`);

// --- HELPERS DB ---
async function sbGetClient(roomId) {
  if(!supabaseEnabled) return null;
  const { data, error } = await supabase.from("clients").select("*").eq("room_id", roomId).limit(1).maybeSingle();
  if (error) console.error("⚠️ DB Error Client:", error.message);
  return data;
}

async function sbGetQuestion(roomId, questionKey) {
  if(!supabaseEnabled) return null;
  const { data, error } = await supabase.from("questions").select("*").eq("room_id", roomId).eq("question_key", questionKey).limit(1).maybeSingle();
  if (error) console.error("⚠️ DB Error Question:", error.message);
  return data;
}

// --- LOGIC AUTH ---
async function getClientConfig(roomId) {
  if (!roomId) return null;
  if (supabaseEnabled) return await sbGetClient(roomId);
  return null; 
}

// --- MEMORY ---
const ROOMS = Object.create(null);
function ensureOverlayState(roomId, overlay) {
  if (!ROOMS[roomId]) ROOMS[roomId] = { overlays: {} };
  if (!ROOMS[roomId].overlays[overlay]) ROOMS[roomId].overlays[overlay] = { state: "idle", data: {} };
  return ROOMS[roomId].overlays[overlay];
}

// --- ROUTES HTTP (C'est ce qui manquait !) ---
app.get("/", (req, res) => {
  res.send("MDI Live Server V3.6 OK");
});

app.get("/health", async (req, res) => {
  res.json({ ok: true, version: "3.6", supabaseEnabled });
});

app.get("/debug/questions", async (req, res) => {
  const room = String(req.query.room || "").trim();
  if (!room || !supabaseEnabled) return res.json({ ok: false, error: "no_room_or_supabase" });
  
  const { data, error } = await supabase
    .from("questions")
    .select("question_key, type, prompt, enabled, order_index")
    .eq("room_id", room)
    .order("order_index", { ascending: true });
    
  res.json({ ok: !error, data: data || [] });
});

// --- SOCKET ---
io.on("connection", (socket) => {
  console.log("🔌 Connect:", socket.id);

  socket.on("overlay:join", async (payload) => {
    const { room, key, overlay } = payload || {};
    const client = await getClientConfig(room);
    
    // Auth basique
    if (!client || !client.active || client.room_key !== key) {
      socket.emit("overlay:forbidden", { reason: "auth_failed" });
      return;
    }
    socket.join(room);
    const state = ensureOverlayState(room, overlay);
    socket.emit("overlay:state", { overlay, state: state.state, data: state.data });
  });

  socket.on("control:load_question", async (payload) => {
    const { room, key, overlay, question_key } = payload || {};
    
    console.log(`🔍 [DEBUG] Reçu load_question: Room=${room} Key=${question_key}`);

    const client = await getClientConfig(room);
    if (!client) { console.log("❌ [DEBUG] Client introuvable"); return; }
    if (client.room_key !== key) { console.log("❌ [DEBUG] Mauvaise Room Key"); return; }
    
    const ent = client.entitlements || {};
    // On vérifie le droit, mais on autorise si entitlements est vide (mode cool)
    if (Object.keys(ent).length > 0 && ent[overlay] !== true) { 
        console.log(`❌ [DEBUG] Pas de droit pour l'overlay: ${overlay}`); 
        return; 
    }

    const q = await sbGetQuestion(room, question_key);
    
    if (!q) {
      console.log(`❌ [DEBUG] Question introuvable DB`);
      return;
    }

    const question = {
      id: q.question_key,
      type: q.type,
      prompt: q.prompt,
      options: { A: q.option_a||"", B: q.option_b||"", C: q.option_c||"", D: q.option_d||"" },
      correct: q.type === "quiz" ? q.correct_option : null,
    };

    console.log(`✅ [DEBUG] Question envoyée: "${q.prompt}"`);

    const overlayState = ensureOverlayState(room, overlay);
    overlayState.state = "question";
    overlayState.data = { question };
    
    io.to(room).emit("overlay:state", { overlay, state: "question", data: { question } });
  });

  socket.on("control:show_options", async (p) => {
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "options", data: ensureOverlayState(p.room, p.overlay).data });
  });
  socket.on("control:set_state", async (p) => {
    const os = ensureOverlayState(p.room, p.overlay);
    os.state = p.state;
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: p.state, data: os.data });
  });
  socket.on("control:idle", async (p) => {
    io.to(p.room).emit("overlay:state", { overlay: p.overlay, state: "idle", data: {} });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server V3.6 (DEBUG) on ${PORT}`));
