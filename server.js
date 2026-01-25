// ==========================================
// MDI SERVER V2.0 (GESTION MULTI-SALLES)
// ==========================================
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" } // Accepte tout le monde
});

app.get('/', (req, res) => {
  res.send('MDI Live Server V2.0 (Rooms Active)');
});

io.on('connection', (socket) => {
  console.log('Nouvelle connexion:', socket.id);

  // 1. REJOINDRE UNE SALLE SPÉCIFIQUE
  // L'extension ou l'Overlay envoie : socket.emit('rejoindre_salle', 'CLIENT_COCA');
  socket.on('rejoindre_salle', (roomID) => {
    if(roomID) {
        socket.join(roomID);
        console.log(`Socket ${socket.id} a rejoint la salle : ${roomID}`);
    }
  });

  // 2. RÉCEPTION ET RENVOI CIBLÉ
  socket.on('nouveau_vote', (data) => {
    
    // CAS A : Mode SaaS (Objet avec Room) -> Futur standard
    if (typeof data === 'object' && data.room && data.vote) {
      // On envoie UNIQUEMENT aux gens dans cette salle
      io.to(data.room).emit('mise_a_jour_overlay', data.vote);
      console.log(`[Salle ${data.room}] Vote relayé : ${data.vote}`);
    }
    
    // CAS B : Mode Ancien (Juste du texte) -> Sécurité
    // Si l'extension envoie juste "A", on l'envoie à tout le monde comme avant.
    else if (typeof data === 'string') {
       io.emit('mise_a_jour_overlay', data); 
       console.log(`[Global] Vote legacy : ${data}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur écoute sur le port ${PORT}`);
});
