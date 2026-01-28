// ==========================================
// MDI SERVER V4.0 (SAAS PRO / MULTI-OVERLAY)
// Compatible V3.1 (AUCUNE RÉGRESSION)
// ==========================================
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.get('/', (req, res) => {
  res.send('MDI Live Server V4.0 (SaaS Multi-Overlay)');
});

// ==================================================
// 🔒 LISTE DES CLIENTS ACTIFS (SaaS)
// ==================================================
const CLIENTS_ACTIFS = {
  "DEMO_CLIENT": true,
  "CLIENT_COCA": true,
  "CLIENT_PEPSI": false,
  "TEST_VIP": true
};

// ==================================================
// 🧠 MÉMOIRE SERVEUR (ROOMS)
// ==================================================
const ROOMS = Object.create(null);

function getRoom(roomId) {
  if (!ROOMS[roomId]) {
    ROOMS[roomId] = {
      meta: {
        roomId,
        createdAt: Date.now()
      },
      overlays: {},        // quiz, tug_of_war, word_cloud...
      participants: {},    // votes dédupliqués
      timestamps: {}
    };
    console.log(`🆕 Room créée : ${roomId}`);
  }
  return ROOMS[roomId];
}

// ==================================================
// 🔌 SOCKET.IO
// ==================================================
io.on('connection', (socket) => {
  console.log('🔌 Nouvelle connexion:', socket.id);

  // --------------------------------------------------
  // 1️⃣ ANCIENNE MÉTHODE (COMPATIBILITÉ)
  // --------------------------------------------------
  socket.on('rejoindre_salle', (roomID) => {
    if (CLIENTS_ACTIFS[roomID] === true) {
      socket.join(roomID);
      console.log(`✅ Accès VALIDÉ (legacy) : ${roomID}`);
      socket.emit('statut_connexion', 'OK');
    } else {
      console.log(`⛔ Accès REFUSÉ (legacy) : ${roomID}`);
      socket.emit('statut_connexion', 'REFUSE');
    }
  });

  // --------------------------------------------------
  // 2️⃣ NOUVELLE CONNEXION OVERLAY (SAAS)
  // --------------------------------------------------
  socket.on('overlay:join', ({ room, overlay }) => {
    if (!room || !overlay) return;

    if (CLIENTS_ACTIFS[room] !== true) {
      console.log(`⛔ Overlay refusé : ${room}`);
      socket.emit('overlay:forbidden', { reason: 'inactive_subscription' });
      return;
    }

    socket.join(room);
    const roomState = getRoom(room);

    // Initialisation overlay si absent
    if (!roomState.overlays[overlay]) {
      roomState.overlays[overlay] = {
        state: "idle",
        data: {}
      };
    }

    console.log(`🖥️ Overlay connecté : ${overlay} @ ${room}`);

    // Envoi immédiat de l’état courant
    socket.emit('overlay:state', {
      overlay,
      ...roomState.overlays[overlay]
    });
  });

  // --------------------------------------------------
  // 3️⃣ RESYNC OVERLAY (OBS reload)
  // --------------------------------------------------
  socket.on('overlay:get_state', ({ room, overlay }) => {
    const roomState = ROOMS[room];
    if (roomState && roomState.overlays[overlay]) {
      socket.emit('overlay:state', {
        overlay,
        ...roomState.overlays[overlay]
      });
    }
  });

  // --------------------------------------------------
  // 4️⃣ VOTES (EXTENSION CHROME - INCHANGÉ)
  // --------------------------------------------------
  socket.on('nouveau_vote', (data) => {
    if (!data || !data.room || !data.vote) return;
    if (CLIENTS_ACTIFS[data.room] !== true) return;

    io.to(data.room).emit('mise_a_jour_overlay', data.vote);
    console.log(`[Salle ${data.room}] Vote : ${data.vote}`);
  });

  // --------------------------------------------------
  // 5️⃣ FUTURE COMMANDE STREAM DECK
  // --------------------------------------------------
  socket.on('control:set_state', ({ room, overlay, state, data }) => {
    if (CLIENTS_ACTIFS[room] !== true) return;

    const roomState = getRoom(room);
    if (!roomState.overlays[overlay]) {
      roomState.overlays[overlay] = { state: "idle", data: {} };
    }

    roomState.overlays[overlay].state = state;
    if (data) roomState.overlays[overlay].data = data;

    console.log(`🎮 State changé : ${overlay} -> ${state}`);

    io.to(room).emit('overlay:state', {
      overlay,
      state,
      data: roomState.overlays[overlay].data
    });
  });

  // --------------------------------------------------
  // 6️⃣ ANCIENNE TÉLÉCOMMANDE (COMPATIBILITÉ)
  // --------------------------------------------------
  socket.on('commande_quiz', (data) => {
    if (data && data.room && CLIENTS_ACTIFS[data.room] === true) {
      console.log(`📱 Télécommande legacy [${data.room}] : ${data.action}`);
      io.to(data.room).emit('ordre_quiz', data.action);
    }
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 MDI Server V4.0 écoute sur le port ${PORT}`);
});
