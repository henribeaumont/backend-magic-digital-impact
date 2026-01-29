// ==========================================
// MDI SERVER V3.4 (SAFE + KEY + SUPABASE ON + MULTI-OVERLAY READY)
// - NO REGRESSION: legacy OK (rejoindre_salle / nouveau_vote / commande_quiz)
// - SaaS mode: overlay:join + control:* avec roomKey obligatoire
// - Supabase: clients + questions
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
    // entitlements optionnels. si absent => autorise tout (MVP)
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
  // Table attendue: clients
  // Colonnes attendues: room_id (text), room_key (text), active (bool), entitlements (jsonb optionnel)
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
  // Table attendue: questions
  // Colonnes attendues:
  // room_id (text), question_key (text), type (poll|quiz), prompt (text)
  // option_a/b/c/d (text), correct_option (text nullable), enabled (bool), order_index (int), created_at
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
// Auth / Entitlements
// --------------------
async function getClientConfig(roomId) {
  if (!roomId) return null;

  if (supabaseEnabled) {
    const c = await sbGetClient(roomId);
    return c;
  }

  // fallback
  const fb = FALLBACK_CLIENTS_CONFIG[roomId];
  if (!fb) return null;
  return { room_id: roomId, ...fb };
}

function isActiveClient(client) {
  // active nullable = si NULL => on considère true (pratique en MVP)
  // Si tu veux strict: change en (client.active === true)
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
  // MVP: si pas d’entitlements => autorise tout
  if (!client) return false;
  if (!overlayName) return false;

  const ent = client.entitlements;
  if (!ent) return true;

  // entitlements attendu en jsonb:
  // { quiz_ou_sondage: true, confetti: true, ... }
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
      overlays: {}, // overlayName -> { state, data, updatedAt }
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

// --------------------
// HTTP routes (debug)
// --------------------
app.get("/", (req, res) => {
  res.send("MDI Live Server V3.4 (Safe Key + Legacy Compatible + Supabase)");
});

app.get("/health", async (req, res) => {
  let clientsLoaded = null;
  if (supabaseEnabled) clientsLoaded = await sbCountClients();

  res.json({
    ok: true,
    version: "3.4",
    supabaseEnabled,
    clientsLoaded,
  });
});

// Debug: liste quelques questions d’une room
// Exemple: /debug/questions?room=DEMO_CLIENT
app.get("/debug/questions", async (req, res) => {
  const room = String(req.query.room || "").trim();
  if (!room) return res.status(400).json({ ok: false, error: "missing_room" });

  if (!supabaseEnabled) {
    return res.status(400).json({ ok: false, error: "supabase_off" });
  }

  const { data, error } = await supabase
    .from("questions")
    .select("question_key, type, prompt, enabled, order_index, created_at")
    .eq("room_id", room)
    .order("order_index", { ascending: true })
    .limit(50);

  if (error) return res.status(500).json({ ok: false, error: error.message || String(error) });
  return res.json({ ok: true, room, count: data?.length || 0, data });
});

// --------------------
// Socket.io
// --------------------
io.on("connection", (socket) => {
  console.log("🔌 Nouvelle connexion:", socket.id);

  // --------------------------------------------------
  // 1) LEGACY : rejoindre_salle (NE CASSE RIEN)
  // --------------------------------------------------
  socket.on("rejoindre_salle", async (roomID) => {
    const room = String(roomID || "").trim();
    if (!room) return;

    const client = await getClientConfig(room);

    if (isActiveClient(client)) {
      socket.join(room);
      console.log(`✅ [LEGACY] Accès VALIDÉ pour : ${room}`);
      socket.emit("statut_connexion", "OK");
    } else {
      console.log(`⛔ [LEGACY] Accès REFUSÉ pour : ${room}`);
      socket.emit("statut_connexion", "REFUSE");
    }
  });

  // --------------------------------------------------
  // 2) SAAS : overlay:join (AVEC KEY)
  // payload: { room, key, overlay }
  // --------------------------------------------------
  socket.on("overlay:join", async (payload) => {
    const room = String(payload?.room || "").trim();
    const key = String(payload?.key || "").trim();
    const overlay = String(payload?.overlay || "").trim();

    if (!room || !overlay) return;

    const client = await getClientConfig(room);

    // abonnement
    if (!isActiveClient(client)) {
      console.log(`⛔ [SAAS] overlay:join refusé (inactive): room=${room} overlay=${overlay}`);
      socket.emit("overlay:forbidden", { reason: "inactive_subscription" });
      return;
    }

    // clé
    if (!isValidRoomKey(client, key)) {
      console.log(`⛔ [SAAS] overlay:join refusé (bad_key): room=${room} overlay=${overlay}`);
      socket.emit("overlay:forbidden", { reason: "invalid_key" });
      return;
    }

    // droits overlay
    if (!hasEntitlement(client, overlay)) {
      console.log(`⛔ [SAAS] overlay:join refusé (no_entitlement): room=${room} overlay=${overlay}`);
      socket.emit("overlay:forbidden", { reason: "no_entitlement", overlay });
      return;
    }

    socket.join(room);
    console.log(`✅ [SAAS] join OK: room=${room} overlay=${overlay}`);

    const state = ensureOverlayState(room, overlay);
    socket.emit("overlay:state", { overlay, state: state.state, data: state.data });
  });

  // --------------------------------------------------
  // 3) SAAS : overlay:get_state (AVEC KEY)
  // payload: { room, key, overlay }
  // --------------------------------------------------
  socket.on("overlay:get_state", async (payload) => {
    const room = String(payload?.room || "").trim();
    const key = String(payload?.key || "").trim();
    const overlay = String(payload?.overlay || "").trim();

    if (!room || !overlay) return;

    const client = await getClientConfig(room);
    if (!isActiveClient(client)) return;
    if (!isValidRoomKey(client, key)) return;
    if (!hasEntitlement(client, overlay)) return;

    const state = ensureOverlayState(room, overlay);
    socket.emit("overlay:state", { overlay, state: state.state, data: state.data });
  });

  // --------------------------------------------------
  // 4) LEGACY : votes (extension Chrome)
  // --------------------------------------------------
  socket.on("nouveau_vote", async (data) => {
    if (typeof data !== "object" || !data.room || !data.vote) return;

    const room = String(data.room).trim();
    const vote = String(data.vote).trim();
    if (!room || !vote) return;

    const client = await getClientConfig(room);
    if (!isActiveClient(client)) return;

    io.to(room).emit("mise_a_jour_overlay", vote);
    console.log(`[Salle ${room}] Vote : ${vote}`);
  });

  // --------------------------------------------------
  // 5) LEGACY : télécommande quiz (NE CASSE RIEN)
  // --------------------------------------------------
  socket.on("commande_quiz", async (data) => {
    if (!data || !data.room) return;

    const room = String(data.room).trim();
    const action = String(data.action || "").trim();

    const client = await getClientConfig(room);
    if (!isActiveClient(client)) return;

    console.log(`📱 [LEGACY] Télécommande [${room}] : ${action}`);
    io.to(room).emit("ordre_quiz", action);
  });

  // --------------------------------------------------
  // 6) SAAS : control:set_state (AVEC KEY)
  // payload: { room, key, overlay, state, data }
  // --------------------------------------------------
  socket.on("control:set_state", async (payload) => {
    const room = String(payload?.room || "").trim();
    const key = String(payload?.key || "").trim();
    const overlay = String(payload?.overlay || "").trim();
    const state = String(payload?.state || "").trim();
    const data = payload?.data;

    if (!room || !overlay || !state) return;

    const client = await getClientConfig(room);
    if (!isActiveClient(client)) return;
    if (!isValidRoomKey(client, key)) return;
    if (!hasEntitlement(client, overlay)) return;

    const overlayState = ensureOverlayState(room, overlay);
    overlayState.state = state;
    if (data && typeof data === "object") overlayState.data = data;
    overlayState.updatedAt = Date.now();

    console.log(`🎮 [SAAS] State: room=${room} overlay=${overlay} -> ${state}`);
    io.to(room).emit("overlay:state", {
      overlay,
      state: overlayState.state,
      data: overlayState.data,
    });
  });

  // --------------------------------------------------
  // 7) SAAS : control:load_question (AVEC KEY)
  // payload: { room, key, overlay:"quiz_ou_sondage", question_key }
  // - charge la question depuis Supabase
  // - envoie overlay:state {state:"question"} (question seule)
  // --------------------------------------------------
  socket.on("control:load_question", async (payload) => {
    const room = String(payload?.room || "").trim();
    const key = String(payload?.key || "").trim();
    const overlay = String(payload?.overlay || "").trim();
    const questionKey = String(payload?.question_key || "").trim();

    if (!room || !overlay || !questionKey) return;

    const client = await getClientConfig(room);
    if (!isActiveClient(client)) return;
    if (!isValidRoomKey(client, key)) return;
    if (!hasEntitlement(client, overlay)) return;

    if (!supabaseEnabled) {
      console.warn("⛔ [SAAS] control:load_question impossible: supabase_off");
      return;
    }

    const q = await sbGetQuestion(room, questionKey);
    if (!q || q.enabled === false) {
      console.warn(`⛔ [SAAS] Question introuvable ou disabled: room=${room} key=${questionKey}`);
      // On met idle plutôt que laisser un état “bizarre”
      const overlayState = ensureOverlayState(room, overlay);
      overlayState.state = "idle";
      overlayState.data = {};
      io.to(room).emit("overlay:state", { overlay, state: "idle", data: {} });
      return;
    }

    // Normalisation vers un JSON stable pour l'overlay
    const question = {
      id: q.question_key,
      type: q.type, // "poll" | "quiz"
      prompt: q.prompt,
      options: {
        A: q.option_a || "",
        B: q.option_b || "",
        C: q.option_c || "",
        D: q.option_d || "",
      },
      // quiz: "A"|"B"|"C"|"D" / poll: null
      correct: q.type === "quiz" ? (q.correct_option || null) : null,
    };

    const overlayState = ensureOverlayState(room, overlay);
    overlayState.state = "question";
    overlayState.data = { question };
    overlayState.updatedAt = Date.now();

    console.log(`✅ [SAAS] Question chargée: room=${room} overlay=${overlay} q=${questionKey}`);
    io.to(room).emit("overlay:state", {
      overlay,
      state: overlayState.state,
      data: overlayState.data,
    });
  });

  // --------------------------------------------------
  // 8) SAAS : control:show_options (AVEC KEY)
  // payload: { room, key, overlay:"quiz_ou_sondage" }
  // - passe l'overlay en state "options" (question + options visibles)
  // - le délai d’apparition 1 par 1 sera géré côté overlay (CSS OBS)
  // --------------------------------------------------
  socket.on("control:show_options", async (payload) => {
    const room = String(payload?.room || "").trim();
    const key = String(payload?.key || "").trim();
    const overlay = String(payload?.overlay || "").trim();

    if (!room || !overlay) return;

    const client = await getClientConfig(room);
    if (!isActiveClient(client)) return;
    if (!isValidRoomKey(client, key)) return;
    if (!hasEntitlement(client, overlay)) return;

    const overlayState = ensureOverlayState(room, overlay);

    // Si aucune question n’est chargée, on refuse de passer en options
    if (!overlayState.data?.question) {
      console.warn(`⛔ [SAAS] show_options ignoré: aucune question chargée (room=${room})`);
      return;
    }

    overlayState.state = "options";
    overlayState.updatedAt = Date.now();

    io.to(room).emit("overlay:state", {
      overlay,
      state: overlayState.state,
      data: overlayState.data,
    });
  });

  // --------------------------------------------------
  // 9) SAAS : control:idle (AVEC KEY)
  // payload: { room, key, overlay }
  // - vide total (overlay transparent)
  // --------------------------------------------------
  socket.on("control:idle", async (payload) => {
    const room = String(payload?.room || "").trim();
    const key = String(payload?.key || "").trim();
    const overlay = String(payload?.overlay || "").trim();
    if (!room || !overlay) return;

    const client = await getClientConfig(room);
    if (!isActiveClient(client)) return;
    if (!isValidRoomKey(client, key)) return;
    if (!hasEntitlement(client, overlay)) return;

    const overlayState = ensureOverlayState(room, overlay);
    overlayState.state = "idle";
    overlayState.data = {};
    overlayState.updatedAt = Date.now();

    io.to(room).emit("overlay:state", { overlay, state: "idle", data: {} });
  });
});

// --------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MDI Server V3.4 écoute sur le port ${PORT}`);
});
