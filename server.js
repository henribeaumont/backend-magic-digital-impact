const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");

// Configuration CORS (Autorise tout le monde à se connecter)
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// Page d'accueil pour vérifier que le serveur est vivant
app.get('/', (req, res) => {
  res.send('<h1>Magic Digital Impact : SERVER ONLINE 🟢</h1>');
});

io.on('connection', (socket) => {
  console.log('Nouvelle connexion : ' + socket.id);

  socket.on('nouveau_vote', (choix) => {
    // On renvoie l'info à tous les overlays connectés
    io.emit('mise_a_jour_overlay', choix);
  });
});

// IMPORTANT : Render nous donne un port spécifique, on l'utilise ici
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});
