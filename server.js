// ==========================================
// MDI SERVER V3.5 (STREAM DECK READY + HTTP API)
// - NO REGRESSION: legacy OK
// - SaaS mode: WebSocket overlay:join sécurisé
// - API HTTP: Pour pilotage Stream Deck (Web Request) sans navigateur
// - Supabase: Intégration active
// ==========================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// Supabase (optionnel mais recommandé)
let createClient;
try {
  ({ createClient } = require("@supabase/supabase-js"));
} catch (e) {
  createClient = null;
}

const app = express();

// IMPORTANT: Permet de lire le JSON envoyé par Stream Deck (POST)
app.use(express.json()); 
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --------------------
// ENV (Render)
// --------------------
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Supabase ON si les deux variables existent + lib dispo
const supabaseEnabled =
  Boolean(SUPABASE_URL) &&
  Boolean(SUPABASE_SERVICE_ROLE_KEY) &&
  typeof createClient === "function";

const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  : null;

console.log(`🧩 Supabase mode: ${supabaseEnabled ? "ON" : "OFF"} (${supabaseEnabled ? "db" : "fallback"})`);

// --------------------
// Fallback (si Supabase OFF)
// --------------------
const FALLBACK_CLIENTS_CONFIG = {
  DEMO_CLIENT: {
    active: true,
    room_key: "demo_key_123",
    entitlements: {
      quiz_ou_sondage: true,
      wordcloud: true,
      tug_of_war: true,
      confetti: true,
      emoji_tornado: true,
    },
  },
};

// --------------------
// Helpers Supabase
// --------------------
async function sbGetClient(roomId) {
  const { data, error } = await supabase
    .from("clients")
    .select("room_id, room_key, active, entitlements")
    .eq("room_id", roomId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("⚠️ [SB] clients fetch error:", error.message || error);
    return null;
  }
  return data || null;
}

async function sbCountClients() {
  const { count, error } = await supabase
    .from("clients")
    .select("*", { count: "exact", head: true });

  if (error) return null;
  return typeof count === "number" ? count : null;
}

async function sbGetQuestion(roomId, questionKey) {
  const { data, error } = await supabase
    .from("questions")
    .select(
      "room_id, question_key, type, prompt, option_a, option_b, option_c, option_d, correct_option, enabled, order_index, created_at"
    )
    .eq("room_id", roomId)
    .eq("question_key", questionKey)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("⚠️ [SB] questions fetch error:", error.message || error);
    return null;
  }
  return data || null;
}

// --------------------
// Auth / Entitlements logic
// --------------------
async function getClientConfig(roomId) {
  if (!roomId) return null;
  if (supabaseEnabled) {
    const c = await sbGetClient(roomId);
    return c;
  }
  const fb = FALLBACK_CLIENTS_CONFIG[roomId];
  if (!fb) return null;
  return { room_id: roomId, ...fb };
}

function isActiveClient(client) {
  if (!client) return false;
  if (client.active === null || typeof client.active === "undefined") return true;
  return client.active === true;
}

function isValidRoomKey(client, key) {
  if (!client) return false;
  if (typeof key !== "string" || key.trim().length === 0) return false;
  return String(client.room_key || "").trim() === key.trim();
}

function hasEntitlement(client, overlayName) {
  if (!client) return false;
  if (!overlayName) return false;
  const ent = client.entitlements;
  if (!ent) return true; // Si pas de restrictions définies, tout est permis (MVP)
  return ent?.[overlayName] === true;
}

// --------------------
// Mémoire serveur (resync OBS)
// --------------------
const ROOMS = Object.create(null);

function getRoom(roomId) {
  if (!ROOMS[roomId]) {
    ROOMS[roomId] = {
      meta: { roomId, createdAt: Date.now() },
      overlays: {}, 
    };
    console.log(`🆕 [ROOM] Créée: ${roomId}`);
  }
  return ROOMS[roomId];
}

function ensureOverlayState(roomId, overlay) {
  const room = getRoom(roomId);
  if (!room.overlays[overlay]) {
    room.overlays[overlay] = { state: "idle", data: {}, updatedAt: Date.now() };
  }
  return room.overlays[overlay];
}

// ==========================================
// ROUTES HTTP (Browser + STREAM DECK API)
// ==========================================

app.get("/", (req, res) => {
  res.send("MDI Live Server V3.5 (HTTP API + Stream Deck Ready)");
});

app.get("/health", async (req, res) => {
  let clientsLoaded = null;
  if (supabaseEnabled) clientsLoaded = await sbCountClients();
  res.json({ ok: true, version: "3.5", supabaseEnabled, clientsLoaded });
});

app.get("/debug/questions", async (req, res) => {
  const room = String(req.query.room || "").trim();
  if (!room) return res.status(400).json({ ok: false, error: "missing_room" });
  if (!supabaseEnabled) return res.status(400).json({ ok: false, error: "supabase_off" });

  const { data, error } = await supabase
    .from("questions")
    .select("question_key, type, prompt, enabled, order_index, created_at")
    .eq("room_id", room)
    .order("order_index", { ascending: true })
    .limit(50);

  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, room, count: data?.length || 0, data });
});

// --------------------------------------------------------
// [NOUVEAU] API ENDPOINT POUR STREAM DECK (Web Request)
// Méthode: POST
// URL: https://ton-url-render/api/trigger
// Body JSON: { "room": "...", "key": "...", "overlay": "...", "action": "...", "payload": {...} }
// --------------------------------------------------------
app.post("/api/trigger", async (req, res) => {
  const { room, key, overlay, action, payload } = req.body;

  // 1. Validation de base
  if (!room || !key || !overlay || !action) {
    return res.status(400).json({ ok: false, error: "missing_params" });
  }

  // 2. Auth via Supabase
  const client = await getClientConfig(room);
  
  if (!isActiveClient(client)) {
    return res.status(403).json({ ok: false, error: "client_inactive" });
  }
  if (!isValidRoomKey(client, key)) {
    return res.status(403).json({ ok: false, error: "invalid_key" });
  }
  if (!hasEntitlement(client, overlay)) {
    return res.status(403).json({ ok: false, error: "no_entitlement" });
  }

  // 3. Exécution de l'action (Mapping vers Socket logic)
  try {
    const overlayState = ensureOverlayState(room, overlay);

    if (action === "set_state") {
      // payload attendu: { state: "...", data: {...} }
      if (!payload?.state) return res.status(400).json({ ok: false, error: "missing_state" });
      
      overlayState.state = payload.state;
      if (payload.data) overlayState.data = payload.data;
      overlayState.updatedAt = Date.now();
      
      io.to(room).emit("overlay:state", { overlay, state: overlayState.state, data: overlayState.data });
      console.log(`📱 [API] set_state: ${room}/${overlay} -> ${payload.state}`);
    
    } else if (action === "load_question") {
      // payload attendu: { question_key: "..." }
      const qKey = payload?.question_key;
      if (!qKey) return res.status(400).json({ ok: false, error: "missing_question_key" });

      if (supabaseEnabled) {
        const q = await sbGetQuestion(room, qKey);
        if (q && q.enabled !== false) {
          const question = {
            id: q.question_key,
            type: q.type,
            prompt: q.prompt,
            options: { A: q.option_a||"", B: q.option_b||"", C: q.option_c||"", D: q.option_d||"" },
            correct: q.type === "quiz" ? (q.correct_option || null) : null,
          };
          overlayState.state = "question";
          overlayState.data = { question };
          io.to(room).emit("overlay:state", { overlay, state: "question", data: { question } });
          console.log(`📱 [API] load_question: ${room} -> ${qKey}`);
        } else {
           return res.status(404).json({ ok: false, error: "question_not_found" });
        }
      } else {
        return res.status(503).json({ ok: false, error: "supabase_off" });
      }

    } else if (action === "show_options") {
       if (overlayState.data?.question) {
         overlayState.state = "options";
         io.to(room).emit("overlay:state", { overlay, state: "options", data: overlayState.data });
         console.log(`📱 [API] show_options: ${room}`);
       }

    } else if (action === "idle") {
      overlayState.state = "idle";
      overlayState.data = {};
      io.to(room).emit("overlay:state", { overlay, state: "idle", data: {} });
      console.log(`📱 [API] idle: ${room}`);
    }

    // Réponse succès au Stream Deck
    return res.json({ ok: true, action });

  } catch (err) {
    console.error("API Error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ==========================================
// SOCKET.IO (Navigateurs & Overlays)
// ==========================================
io.on("connection", (socket) => {
  console.log("🔌 Nouvelle connexion Socket:", socket.id);

  // 1) LEGACY
  socket.on("rejoindre_salle", async (roomID) => {
    const room = String(roomID || "").trim();
    if (!room) return;
    const client = await getClientConfig(room);
    if (isActiveClient(client)) {
      socket.join(room);
      socket.emit("statut_connexion", "OK");
    } else {
      socket.emit("statut_connexion", "REFUSE");
    }
  });

  socket.on("nouveau_vote", async (data) => {
    if (typeof data !== "object" || !data.room || !data.vote) return;
    const room = String(data.room).trim();
    const client = await getClientConfig(room);
    if (isActiveClient(client)) {
      io.to(room).emit("mise_a_jour_overlay", String(data.vote).trim());
    }
  });

  socket.on("commande_quiz", async (data) => {
    if (!data || !data.room) return;
    const room = String(data.room).trim();
    const client = await getClientConfig(room);
    if (isActiveClient(client)) {
      io.to(room).emit("ordre_quiz", String(data.action || "").trim());
    }
  });

  // 2) SAAS MODE (Secure)
  socket.on("overlay:join", async (payload) => {
    const { room, key, overlay } = payload || {};
    if (!room || !overlay) return;

    const client = await getClientConfig(room);
    
    if (!isActiveClient(client)) {
      socket.emit("overlay:forbidden", { reason: "inactive_subscription" });
      return;
    }
    if (!isValidRoomKey(client, key)) {
      socket.emit("overlay:forbidden", { reason: "invalid_key" });
      return;
    }
    if (!hasEntitlement(client, overlay)) {
      socket.emit("overlay:forbidden", { reason: "no_entitlement", overlay });
      return;
    }

    socket.join(room);
    const state = ensureOverlayState(room, overlay);
    socket.emit("overlay:state", { overlay, state: state.state, data: state.data });
  });

  socket.on("overlay:get_state", async (payload) => {
    const { room, key, overlay } = payload || {};
    if (!room || !overlay) return;
    const client = await getClientConfig(room);
    if (isActiveClient(client) && isValidRoomKey(client, key) && hasEntitlement(client, overlay)) {
      const state = ensureOverlayState(room, overlay);
      socket.emit("overlay:state", { overlay, state: state.state, data: state.data });
    }
  });

  // Pilotage via WebSocket (Télécommande Web)
  socket.on("control:set_state", async (payload) => {
    const { room, key, overlay, state, data } = payload || {};
    if (!room || !overlay || !state) return;

    const client = await getClientConfig(room);
    if (!isActiveClient(client) || !isValidRoomKey(client, key) || !hasEntitlement(client, overlay)) return;

    const overlayState = ensureOverlayState(room, overlay);
    overlayState.state = state;
    if (data && typeof data === "object") overlayState.data = data;
    overlayState.updatedAt = Date.now();

    io.to(room).emit("overlay:state", { overlay, state: overlayState.state, data: overlayState.data });
  });

  socket.on("control:load_question", async (payload) => {
    // Identique logique que API mais via Socket
    const { room, key, overlay, question_key } = payload || {};
    if (!room || !overlay || !question_key) return;

    const client = await getClientConfig(room);
    if (!isActiveClient(client) || !isValidRoomKey(client, key) || !hasEntitlement(client, overlay)) return;
    if (!supabaseEnabled) return;

    const q = await sbGetQuestion(room, question_key);
    if (!q || q.enabled === false) return; // ou envoyer erreur

    const question = {
      id: q.question_key,
      type: q.type,
      prompt: q.prompt,
      options: { A: q.option_a||"", B: q.option_b||"", C: q.option_c||"", D: q.option_d||"" },
      correct: q.type === "quiz" ? (q.correct_option || null) : null,
    };

    const overlayState = ensureOverlayState(room, overlay);
    overlayState.state = "question";
    overlayState.data = { question };
    
    io.to(room).emit("overlay:state", { overlay, state: "question", data: { question } });
  });
});

// --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server V3.5 (API+Socket) listening on ${PORT}`);
});
