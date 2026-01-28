// ==========================================
// MDI SERVER V3.2 (SAFE + KEY + PREP MULTI-OVERLAY)
// - AUCUNE RÉGRESSION : legacy OK (rejoindre_salle / nouveau_vote / commande_quiz)
// - Nouveau mode SaaS : overlay:join + control:* avec roomKey obligatoire
// ==========================================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (req, res) => {
  res.send("MDI Live Server V3.2 (Safe Key + Legacy Compatible)");
});

// ==================================================
// 🔒 CONFIG CLIENTS (SaaS)
// - active: autorisé ou non (abonnement)
// - key: secret (roomKey)
// - entitlements: droits par overlay (prépare le futur store/bundles)
// ==================================================
const CLIENTS_CONFIG = {
  DEMO_CLIENT: {
    active: true,
    key: "demo_key_123",
    entitlements: {
      quiz: true,
      wordcloud: true,
      tug_of_war: true,
      confetti: true,
      emoji_tornado: true
    }
  },

  CLIENT_COCA: {
    active: true,
    key: "coca_key_change_me",
    entitlements: { quiz: true, wordcloud: true, tug_of_war: false, confetti: false }
  },

  CLIENT_PEPSI: {
    active: false, // bloqué
    key: "pepsi_key_change_me",
    entitlements: { quiz: false, wordcloud: false, tug_of_war: false, confetti: false }
  },

  TEST_VIP: {
    active: true,
    key: "vip_key_change_me",
    entitlements: { quiz: true, wordcloud: true, tug_of_war: true, confetti: true }
  }
};

// ✅ Compat : garde l’ancienne whitelist booléenne sans casser l’existant
// (on la calcule depuis CLIENTS_CONFIG)
function isLegacyActive(roomId) {
  return CLIENTS_CONFIG?.[roomId]?.active === true;
}

function isValidKey(roomId, key) {
  return typeof key === "string" && key.length > 0 && CLIENTS_CONFIG?.[roomId]?.key === key;
}

function hasEntitlement(roomId, overlay) {
  const ent = CLIENTS_CONFIG?.[roomId]?.entitlements;
  // si pas défini : par défaut false (sécurité)
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
// 🔌 SOCKET.IO
// ==================================================
io.on("connection", (socket) => {
  console.log("🔌 Nouvelle connexion:", socket.id);

  // --------------------------------------------------
  // 1) LEGACY : rejoindre_salle (NE CASSE RIEN)
  // --------------------------------------------------
  socket.on("rejoindre_salle", (roomID) => {
    if (isLegacyActive(roomID)) {
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
  socket.on("overlay:join", (payload) => {
    const room = payload?.room;
    const key = payload?.key;
    const overlay = payload?.overlay;

    if (!room || !overlay) return;

    // 2.1 abonnement
    if (!isLegacyActive(room)) {
      console.log(`⛔ [SAAS] overlay:join refusé (inactive): room=${room} overlay=${overlay}`);
      socket.emit("overlay:forbidden", { reason: "inactive_subscription" });
      return;
    }

    // 2.2 clé
    if (!isValidKey(room, key)) {
      console.log(`⛔ [SAAS] overlay:join refusé (bad_key): room=${room} overlay=${overlay}`);
      socket.emit("overlay:forbidden", { reason: "invalid_key" });
      return;
    }

    // 2.3 droits overlay (bientôt store/bundles)
    if (!hasEntitlement(room, overlay)) {
      console.log(`⛔ [SAAS] overlay:join refusé (no_entitlement): room=${room} overlay=${overlay}`);
      socket.emit("overlay:forbidden", { reason: "no_entitlement", overlay });
      return;
    }

    socket.join(room);
    console.log(`🖥️ [SAAS] Overlay connecté: room=${room} overlay=${overlay}`);

    // renvoi d’état courant (resync OBS friendly)
    const state = ensureOverlayState(room, overlay);
    socket.emit("overlay:state", { overlay, state: state.state, data: state.data });
  });

  // --------------------------------------------------
  // 3) SAAS : overlay:get_state (AVEC KEY)
  // payload: { room, key, overlay }
  // --------------------------------------------------
  socket.on("overlay:get_state", (payload) => {
    const room = payload?.room;
    const key = payload?.key;
    const overlay = payload?.overlay;
    if (!room || !overlay) return;

    if (!isLegacyActive(room)) return;
    if (!isValidKey(room, key)) return;
    if (!hasEntitlement(room, overlay)) return;

    const state = ensureOverlayState(room, overlay);
    socket.emit("overlay:state", { overlay, state: state.state, data: state.data });
  });

  // --------------------------------------------------
  // 4) LEGACY : votes (extension Chrome)
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
  // 5) LEGACY : télécommande quiz (NE CASSE RIEN)
  // --------------------------------------------------
  socket.on("commande_quiz", (data) => {
    if (data && data.room && isLegacyActive(data.room)) {
      console.log(`📱 [LEGACY] Télécommande [${data.room}] : ${data.action}`);
      io.to(data.room).emit("ordre_quiz", data.action);
    }
  });

  // --------------------------------------------------
  // 6) SAAS PRO : control:set_state (AVEC KEY)
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MDI Server V3.2 écoute sur le port ${PORT}`);
});
