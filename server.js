// ==========================================
// MDI SERVER V3.0 (SAAS + SÉCURITÉ VIP)
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
  res.send('MDI Live Server V3.0 (Secured)');
});

// --- 🔒 LISTE DES ABONNÉS (WHITELIST) ---
// true = Accès autorisé
// false = Accès bloqué (Impayé / Résilié)
const CLIENTS_ACTIFS = {
    "DEMO_CLIENT": true,    // Ton accès perso
    "CLIENT_COCA": true,    // Exemple client actif
    "CLIENT_PEPSI": false,  // Exemple client bloqué
    "TEST_VIP": true
};

io.on('connection', (socket) => {
  console.log('Nouvelle connexion entrante:', socket.id);

  // 1. DEMANDE D'ACCÈS À UNE SALLE
  socket.on('rejoindre_salle', (roomID) => {
    
    // VÉRIFICATION DE SÉCURITÉ
    // On regarde si le client est dans la liste ET s'il est à "true"
    if (CLIENTS_ACTIFS[roomID] === true) {
        
        // ✅ ACCÈS AUTORISÉ
        socket.join(roomID);
        console.log(`✅ Accès VALIDÉ pour : ${roomID}`);
        socket.emit('statut_connexion', 'OK'); 
        
    } else {
        
        // ⛔ ACCÈS REFUSÉ
        console.log(`⛔ Accès REFUSÉ pour : ${roomID} (Inconnu ou bloqué)`);
        socket.emit('statut_connexion', 'REFUSE');
        // Note: On ne le fait PAS rejoindre la socket.join()
    }
  });

  // 2. RÉCEPTION DES VOTES (inchangé)
  socket.on('nouveau_vote', (data) => {
    if (typeof data === 'object' && data.room && data.vote) {
      // On vérifie quand même que la salle émettrice est active (double sécurité)
      if (CLIENTS_ACTIFS[data.room] === true) {
          io.to(data.room).emit('mise_a_jour_overlay', data.vote);
          console.log(`[Salle ${data.room}] Vote : ${data.vote}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur Sécurisé écoute sur le port ${PORT}`);
});
