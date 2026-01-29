// ==========================================
// MDI SERVER V3.3 (SAFE KEY + LEGACY + SUPABASE OPTIONAL)
// - AUCUNE RÉGRESSION : legacy OK (rejoindre_salle / nouveau_vote / commande_quiz)
// - Nouveau mode SaaS : overlay:join + control:set_state avec roomKey obligatoire
// - Supabase optionnel : si variables présentes, charge la table "clients"
// ==========================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// dotenv (optionnel) : utile en local, inoffensif sur Render
try {
  require("dotenv").config();
} catch (_) {}

const { createClient } = require("@supabase/supabase-js");

// --------------------
// Config de base serveur
// --------------------
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (req, res) => {
  res.send("MDI Live Server V3.3 (Safe Key + Legacy Compatible + Supabase optional)");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "3.3",
    supabaseEnabled: isSupabaseEnabled(),
    clientsLoaded: Object.keys(CLIENTS_CONFIG).length
  });
});

// ==================================================
// 🔒 CONFIG CLIENTS (mémoire serveur)
// - Si Supabase ON : on remplit depuis la table "clients"
// - Sinon : fallback hardcodé (pour ne pas tout casser)
// ==================================================
let CLIENTS_CONFIG = {
  // fallback minimal : te permet de tester même si Supabase est OFF
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
  }
};

function isSupabaseEnabled() {
  return (
    typeof process.env.SUPABASE_URL === "string" &&
    process.env.SUPABASE_URL.length > 10 &&
    typeof process.env.SUPABASE_SERVICE_ROLE_KEY === "string" &&
    process.env.SUPABASE_SERVICE_ROLE_KEY.length > 20
  );
}

function getSupabaseClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// Charge clients depuis Supabase (table: clients)
// Colonnes attendues : room_id (text), active (bool)
// Optionnelles : room_key (text), entitlements (json/jsonb)
async function refreshClientsFromSupabase() {
  if (!isSupabaseEnabled()) return;

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("clients")
    .select("room_id, active, room_key, entitlements");

  if (error) {
    console.error("[SUPABASE] load clients error:", error.message || error);
    return;
  }

  const next = {};
  for (const row of data || []) {
    const roomId = row.room_id;
    if (!roomId) continue;

    next[roomId] = {
      active: row.active === true,
      key: typeof row.room_key === "string" ? row.room_key : null,
      entitlements: (row.entitlements && typeof row.entitlements === "object") ? row.entitlements : {}
    };
  }

  CLIENTS_CONFIG = next;
  console.log(`[SUPABASE] clients loaded: ${Object.keys(CLIENTS_CONFIG).length}`);
}

// ✅ Compat : garde l’ancienne whitelist booléenne sans casser l’existant
function isLegacyActive(roomId) {
  return CLIENTS_CONFIG?.[roomId]?.active === true;
}

// Mode strict : exige une key si définie en base
function isValidKey(roomId, key) {
  const expected = CLIENTS_CONFIG?.[roomId]?.key;

  // Si aucune key en base -> on refuse le mode strict (sécurité)
  if (!expected) return false;

  return typeof key === "string" && key.length > 0 && key === expected;
}

function hasEntitlement(roomId, overlay) {
  const ent = CLIENTS_CONFIG?.[roomId]?.entitlements;

  // Si pas de droits définis -> par défaut false (sécurité)
  if (!ent) return false;
  return ent?.[overlay] === true;
}

// ==================================================
// 🧠 MÉMOIRE SERVEUR (multi-overlays / resync OBS)
// ==================================================
const ROOMS = Object.create(null);

function getRoom(roomId) {
  if (!ROOMS[roomId]) {
    ROOMS[roomId] = {
      meta: { roomId, createdAt: Date.now() },
      overlays: {},       // overlayName -> { state, data, updatedAt }
      participants: {},
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
// 🔌 SOCKETS
// ==================================================
io.on("connection", (socket) => {
  console.log("Nouvelle connexion:", socket.id);

  // --------------------------------------------------
  // 1) LEGACY : rejoindre_salle (overlay & télécommande)
  // --------------------------------------------------
  socket.on("rejoindre_salle", (roomID) => {
    if (isLegacyActive(roomID)) {
      socket.join(roomID);
      console.log(`✅ [LEGACY] Accès VALIDÉ pour : ${roomID}`);
      socket.emit("statut_connexion", "OK");
    } else {
      console.log(`⛔ [LEGACY] Accès REFUSÉ : ${roomID}`);
      socket.emit("statut_connexion", "REFUSE");
    }
  });

  // --------------------------------------------------
  // 2) SAAS : overlay:join (mode strict avec key)
  // payload: { room, key, overlay }
  // --------------------------------------------------
  socket.on("overlay:join", (payload) => {
    const room = payload?.room;
    const key = payload?.key;
    const overlay = payload?.overlay;

    if (!room || !overlay) {
      socket.emit("overlay:forbidden");
      return;
    }

    // 1) abonnement actif
    if (!isLegacyActive(room)) {
      socket.emit("overlay:forbidden");
      console.log(`⛔ [SAAS] join refusé (inactive): room=${room} overlay=${overlay}`);
      return;
    }

    // 2) key valide
    if (!isValidKey(room, key)) {
      socket.emit("overlay:forbidden");
      console.log(`⛔ [SAAS] join refusé (bad key): room=${room} overlay=${overlay}`);
      return;
    }

    // 3) droit overlay (si tu veux démarrer sans droits, mets tout à true en base)
    if (!hasEntitlement(room, overlay)) {
      socket.emit("overlay:forbidden");
      console.log(`⛔ [SAAS] join refusé (no entitlement): room=${room} overlay=${overlay}`);
      return;
    }

    socket.join(room);

    // On envoie l’état courant pour “débloquer” l’overlay côté client
    const st = ensureOverlayState(room, overlay);
    socket.emit("overlay:state", { overlay, state: st.state, data: st.data });

    console.log(`✅ [SAAS] join OK: room=${room} overlay=${overlay}`);
  });

  // --------------------------------------------------
  // 3) LEGACY : votes (extension Chrome)
  // --------------------------------------------------
  socket.on("nouveau_vote", (data) => {
    if (typeof data === "object" && data.room && data.vote) {
      if (isLegacyActive(data.room)) {
        io.to(data.room).emit("mise_a_jour_overlay", data.vote);
        console.log(`[Salle ${data.room}] Vote : ${data.vote}`);
      }
    }
  });

  // --------------------------------------------------
  // 4) LEGACY : télécommande quiz
  // --------------------------------------------------
  socket.on("commande_quiz", (data) => {
    if (data && data.room && isLegacyActive(data.room)) {
      console.log(`📱 [LEGACY] Télécommande [${data.room}] : ${data.action}`);
      io.to(data.room).emit("ordre_quiz", data.action);
    }
  });

  // --------------------------------------------------
  // 5) SAAS : control:set_state (AVEC KEY)
  // payload: { room, key, overlay, state, data }
  // --------------------------------------------------
  socket.on("control:set_state", (payload) => {
    const room = payload?.room;
    const key = payload?.key;
    const overlay = payload?.overlay;
    const state = payload?.state;
    const data = payload?.data;

    if (!room || !overlay || !state) return;
    if (!isLegacyActive(room)) return;
    if (!isValidKey(room, key)) return;
    if (!hasEntitlement(room, overlay)) return;

    const overlayState = ensureOverlayState(room, overlay);
    overlayState.state = state;
    if (data && typeof data === "object") overlayState.data = data;
    overlayState.updatedAt = Date.now();

    console.log(`🎮 [SAAS] State: room=${room} overlay=${overlay} -> ${state}`);
    io.to(room).emit("overlay:state", { overlay, state: overlayState.state, data: overlayState.data });
  });
});

// ==================================================
// 🚀 START
// ==================================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`🚀 MDI Server V3.3 écoute sur le port ${PORT}`);

  if (isSupabaseEnabled()) {
    console.log("🧩 Supabase mode: ON");
    await refreshClientsFromSupabase();

    // refresh régulier (simple + robuste)
    setInterval(() => {
      refreshClientsFromSupabase().catch(() => {});
    }, 60_000);
  } else {
    console.log("🧩 Supabase mode: OFF (fallback hardcodé actif)");
  }
});
