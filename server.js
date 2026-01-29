// ==========================================
// MDI SERVER V3.3 (SAFE + KEY + Supabase optional)
// - ZÉRO RÉGRESSION : legacy OK (rejoindre_salle / nouveau_vote / commande_quiz)
// - Mode SaaS : overlay:join + control:* avec roomKey obligatoire
// - Supabase (optionnel) : si vars env présentes, validation clients via DB
// ==========================================

require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

let createClient = null;
try {
  ({ createClient } = require("@supabase/supabase-js"));
} catch (e) {
  // optional
}

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (req, res) => {
  res.send("MDI Live Server V3.3 (Safe Key + Legacy Compatible + Supabase optional)");
});

// ==================================================
// 🔒 CONFIG CLIENTS (fallback local)
// ==================================================
const CLIENTS_CONFIG = {
  DEMO_CLIENT: {
    active: true,
    key: "demo_key_123",
    entitlements: {
      quiz_ou_sondage: true,
      wordcloud: true,
      tug_of_war: true,
      confetti: true,
      emoji_tornado: true
    }
  },

  CLIENT_COCA: {
    active: true,
    key: "coca_key_change_me",
    entitlements: { quiz_ou_sondage: true, wordcloud: true, tug_of_war: false, confetti: false }
  },

  CLIENT_PEPSI: {
    active: false,
    key: "pepsi_key_change_me",
    entitlements: { quiz_ou_sondage: false, wordcloud: false, tug_of_war: false, confetti: false }
  },

  TEST_VIP: {
    active: true,
    key: "vip_key_change_me",
    entitlements: { quiz_ou_sondage: true, wordcloud: true, tug_of_war: true, confetti: true }
  }
};

// ==================================================
// 🧩 SUPABASE (optionnel)
// ==================================================
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const USE_SUPABASE = Boolean(createClient && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const supabase = USE_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

// Cache pour éviter de spammer Supabase à chaque connexion overlay
const CLIENT_CACHE = new Map(); // roomId -> { ts, data }
const CLIENT_CACHE_TTL_MS = 15_000;

async function getClientFromSupabase(roomId) {
  const now = Date.now();
  const cached = CLIENT_CACHE.get(roomId);
  if (cached && now - cached.ts < CLIENT_CACHE_TTL_MS) return cached.data;

  // ⚠️ IMPORTANT: ta table doit contenir au minimum:
  // - room_id (text, unique)
  // - active (bool)
  // - room_key (text)  <-- si tu ne l'as pas encore, ajoute-la dans Supabase !
  //
  // (Optionnel pour plus tard) :
  // - entitlements (jsonb) ex: {"quiz_ou_sondage": true, "confetti": true, ...}
  const { data, error } = await supabase
    .from("clients")
    .select("room_id, active, room_key, entitlements")
    .eq("room_id", roomId)
    .maybeSingle();

  if (error) {
    console.log("⛔ [SUPABASE] error clients:", error.message);
    CLIENT_CACHE.set(roomId, { ts: now, data: null });
    return null;
  }

  CLIENT_CACHE.set(roomId, { ts: now, data });
  return data;
}

// ==================================================
// ✅ Helpers d’autorisation (SUPABASE si dispo, sinon fallback local)
// ==================================================
async function isActive(roomId) {
  if (USE_SUPABASE) {
    const c = await getClientFromSupabase(roomId);
    return c?.active === true;
  }
  return CLIENTS_CONFIG?.[roomId]?.active === true;
}

async function isValidKey(roomId, key) {
  if (typeof key !== "string" || key.length === 0) return false;

  if (USE_SUPABASE) {
    const c = await getClientFromSupabase(roomId);
    // si room_key est absent (colonne non créée), ça refusera TOUJOURS
    return typeof c?.room_key === "string" && c.room_key.length > 0 && c.room_key === key;
  }

  return CLIENTS_CONFIG?.[roomId]?.key === key;
}

async function hasEntitlement(roomId, overlay) {
  if (!overlay) return false;

  if (USE_SUPABASE) {
    const c = await getClientFromSupabase(roomId);
    // si entitlements n’existe pas encore, on sécurise : false par défaut
    // => à toi de mettre entitlements en DB, ou alors on peut décider "true par défaut" (moins safe).
    const ent = c?.entitlements;
    if (ent && typeof ent === "object") return ent?.[overlay] === true;
    return false;
  }

  const ent = CLIENTS_CONFIG?.[roomId]?.entitlements;
  return ent?.[overlay] === true;
}

// ==================================================
// 🧠 MÉMOIRE SERVEUR (prépare multi-overlays / resync OBS)
// ==================================================
const ROOMS = Object.create(null);

function getRoom(roomId) {
  if (!ROOMS[roomId]) {
    ROOMS[roomId] = {
      meta: { roomId, createdAt: Date.now() },
      overlays: {},       // overlayName -> { state, data, updatedAt }
      participants: {},   // futur : dédup / votes
      timestamps: {}
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

// ==================================================
// (OPTION) API REST pour télécommande / debug
// - tu pourras l’utiliser plus tard côté télécommande SaaS
// ==================================================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, supabase: USE_SUPABASE });
});

// Exemple: /api/questions?room=DEMO_CLIENT&key=demo_key_123
app.get("/api/questions", async (req, res) => {
  if (!USE_SUPABASE) return res.status(501).json({ error: "supabase_not_configured" });

  const room = String(req.query.room || "");
  const key = String(req.query.key || "");

  if (!room) return res.status(400).json({ error: "missing_room" });

  const active = await isActive(room);
  if (!active) return res.status(403).json({ error: "inactive" });

  const okKey = await isValidKey(room, key);
  if (!okKey) return res.status(403).json({ error: "invalid_key" });

  // Table "questions" attendue
  const { data, error } = await supabase
    .from("questions")
    .select("*")
    .eq("room_id", room)
    .eq("enabled", true)
    .order("order_index", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ room, questions: data || [] });
});

// ==================================================
// 🔌 SOCKET.IO
// ==================================================
io.on("connection", (socket) => {
  console.log("🔌 Nouvelle connexion:", socket.id);

  // --------------------------------------------------
  // 1) LEGACY : rejoindre_salle (NE CASSE RIEN)
  // --------------------------------------------------
  socket.on("rejoindre_salle", async (roomID) => {
    const ok = await isActive(roomID);
    if (ok) {
      socket.join(roomID);
      console.log(`✅ [LEGACY] Accès VALIDÉ : ${roomID}`);
      socket.emit("statut_connexion", "OK");
    } else {
      console.log(`⛔ [LEGACY] Accès REFUSÉ : ${roomID}`);
      socket.emit("statut_connexion", "REFUSE");
    }
  });

  // --------------------------------------------------
  // 2) SAAS PRO : overlay:join (AVEC KEY)
  // payload: { room, key, overlay }
  // --------------------------------------------------
  socket.on("overlay:join", async (payload) => {
    const room = payload?.room;
    const key = payload?.key;
    const overlay = payload?.overlay;

    if (!room || !overlay) return;

    // abonnement
    if (!(await isActive(room))) {
      console.log(`⛔ [SAAS] overlay:join refusé (inactive): room=${room} overlay=${overlay}`);
      socket.emit("overlay:forbidden", { reason: "inactive_subscription" });
      return;
    }

    // clé
    if (!(await isValidKey(room, key))) {
      console.log(`⛔ [SAAS] overlay:join refusé (bad_key): room=${room} overlay=${overlay}`);
      socket.emit("overlay:forbidden", { reason: "invalid_key" });
      return;
    }

    // entitlement
    if (!(await hasEntitlement(room, overlay))) {
      console.log(`⛔ [SAAS] overlay:join refusé (no_entitlement): room=${room} overlay=${overlay}`);
      socket.emit("overlay:forbidden", { reason: "no_entitlement", overlay });
      return;
    }

    socket.join(room);
    console.log(`🖥️ [SAAS] Overlay connecté: room=${room} overlay=${overlay}`);

    const state = ensureOverlayState(room, overlay);
    socket.emit("overlay:state", { overlay, state: state.state, data: state.data });
  });

  // --------------------------------------------------
  // 3) SAAS : overlay:get_state (AVEC KEY)
  // payload: { room, key, overlay }
  // --------------------------------------------------
  socket.on("overlay:get_state", async (payload) => {
    const room = payload?.room;
    const key = payload?.key;
    const overlay = payload?.overlay;
    if (!room || !overlay) return;

    if (!(await isActive(room))) return;
    if (!(await isValidKey(room, key))) return;
    if (!(await hasEntitlement(room, overlay))) return;

    const state = ensureOverlayState(room, overlay);
    socket.emit("overlay:state", { overlay, state: state.state, data: state.data });
  });

  // --------------------------------------------------
  // 4) LEGACY : votes (extension Chrome)
  // --------------------------------------------------
  socket.on("nouveau_vote", async (data) => {
    if (typeof data === "object" && data.room && data.vote) {
      if (await isActive(data.room)) {
        io.to(data.room).emit("mise_a_jour_overlay", data.vote);
        console.log(`[Salle ${data.room}] Vote : ${data.vote}`);
      }
    }
  });

  // --------------------------------------------------
  // 5) LEGACY : télécommande quiz (NE CASSE RIEN)
  // --------------------------------------------------
  socket.on("commande_quiz", async (data) => {
    if (data && data.room && (await isActive(data.room))) {
      console.log(`📱 [LEGACY] Télécommande [${data.room}] : ${data.action}`);
      io.to(data.room).emit("ordre_quiz", data.action);
    }
  });

  // --------------------------------------------------
  // 6) SAAS PRO : control:set_state (AVEC KEY)
  // payload: { room, key, overlay, state, data }
  // --------------------------------------------------
  socket.on("control:set_state", async (payload) => {
    const room = payload?.room;
    const key = payload?.key;
    const overlay = payload?.overlay;
    const state = payload?.state;
    const data = payload?.data;

    if (!room || !overlay || !state) return;

    if (!(await isActive(room))) return;
    if (!(await isValidKey(room, key))) return;
    if (!(await hasEntitlement(room, overlay))) return;

    const overlayState = ensureOverlayState(room, overlay);
    overlayState.state = state;
    if (data && typeof data === "object") overlayState.data = data;
    overlayState.updatedAt = Date.now();

    console.log(`🎮 [SAAS] State: room=${room} overlay=${overlay} -> ${state}`);
    io.to(room).emit("overlay:state", { overlay, state: overlayState.state, data: overlayState.data });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MDI Server V3.3 écoute sur le port ${PORT}`);
  console.log(`ℹ️ Supabase mode: ${USE_SUPABASE ? "ON" : "OFF (fallback CLIENTS_CONFIG)"}`);
});
