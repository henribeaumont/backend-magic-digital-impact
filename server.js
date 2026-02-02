// ============================================================
// MDI SERVER V5.9 - PATCH TIMER/CHRONO
// ============================================================
// Ce fichier contient les modifications à apporter à server.js V5.8
// pour supporter le nouvel overlay timer_chrono
// ============================================================

/* ============================================================
   ÉTAPE 1 : AJOUTER timer_chrono AUX OVERLAYS CONNUS
   ============================================================
   Trouver la section où les overlays sont listés et ajouter :
*/

const KNOWN_OVERLAYS = [
  "nuage_de_mots",
  "roue_loto",
  "quiz_ou_sondage",
  "tug_of_war",
  "emoji_tornado",
  "decompte_poker",
  "mot_magique",
  "decompte_bonhomme",
  "timer_chrono"  // ← NOUVEAU
];

/* ============================================================
   ÉTAPE 2 : AJOUTER LES EVENT HANDLERS TIMER
   ============================================================
   Ajouter ces handlers dans la section io.on("connection")
   APRÈS les handlers existants (roue, quiz, etc.)
*/

/* ===== TIMER/CHRONO HANDLERS ===== */

// Changer le mode (timer/chrono)
socket.on("control:timer_set_mode", (payload) => {
  const { room, mode } = payload;
  if (!room) return;
  
  const validMode = (mode === "chrono") ? "chrono" : "timer";
  const s = ensureOverlayState(room, "timer_chrono");
  
  s.data.mode = validMode;
  s.data.seconds = (validMode === "timer") ? 60 : 0; // Reset au défaut
  
  console.log(`🔄 [TIMER] ${room} - Mode: ${validMode}`);
  
  io.to(room).emit("control:timer_chrono", {
    action: "set_mode",
    mode: validMode
  });
});

// Configurer le temps (en secondes)
socket.on("control:timer_set_time", (payload) => {
  const { room, seconds } = payload;
  if (!room || !Number.isFinite(seconds)) return;
  
  const s = ensureOverlayState(room, "timer_chrono");
  const clampedSeconds = Math.max(0, Math.min(seconds, 99 * 60 + 59)); // Max 99:59
  
  s.data.seconds = clampedSeconds;
  
  console.log(`⏱️ [TIMER] ${room} - Temps configuré: ${clampedSeconds}s`);
  
  io.to(room).emit("control:timer_chrono", {
    action: "set_time",
    seconds: clampedSeconds
  });
});

// Incrémenter/décrémenter le temps
socket.on("control:timer_increment_time", (payload) => {
  const { room, seconds } = payload;
  if (!room || !Number.isFinite(seconds)) return;
  
  const s = ensureOverlayState(room, "timer_chrono");
  const currentSeconds = s.data.seconds || 0;
  const newSeconds = Math.max(0, Math.min(currentSeconds + seconds, 99 * 60 + 59));
  
  s.data.seconds = newSeconds;
  
  console.log(`➕➖ [TIMER] ${room} - Ajustement: ${seconds > 0 ? '+' : ''}${seconds}s → ${newSeconds}s`);
  
  io.to(room).emit("control:timer_chrono", {
    action: "increment_time",
    seconds: seconds
  });
});

// Démarrer
socket.on("control:timer_start", (payload) => {
  const { room } = payload;
  if (!room) return;
  
  console.log(`▶️ [TIMER] ${room} - Start`);
  
  io.to(room).emit("control:timer_chrono", {
    action: "start"
  });
});

// Pause
socket.on("control:timer_pause", (payload) => {
  const { room } = payload;
  if (!room) return;
  
  console.log(`⏸️ [TIMER] ${room} - Pause`);
  
  io.to(room).emit("control:timer_chrono", {
    action: "pause"
  });
});

// Toggle pause/resume
socket.on("control:timer_toggle_pause", (payload) => {
  const { room } = payload;
  if (!room) return;
  
  console.log(`⏯️ [TIMER] ${room} - Toggle pause`);
  
  io.to(room).emit("control:timer_chrono", {
    action: "toggle_pause"
  });
});

// Reset
socket.on("control:timer_reset", (payload) => {
  const { room } = payload;
  if (!room) return;
  
  console.log(`🔄 [TIMER] ${room} - Reset`);
  
  io.to(room).emit("control:timer_chrono", {
    action: "reset"
  });
});

/* ============================================================
   ÉTAPE 3 : AJOUTER LA ROUTE API /api/timer/status
   ============================================================
   Ajouter cette route AVANT app.post("/api/admin/...")
   Cette route permet au Stream Deck d'afficher le temps actuel
*/

app.get("/api/timer/status", async (req, res) => {
  const roomId = req.headers["x-room-id"];
  const roomKey = req.headers["x-room-key"];
  
  if (!supabaseEnabled) {
    return res.status(503).json({ ok: false, error: "no_db" });
  }
  
  // Vérification auth
  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("room_id", roomId)
    .limit(1)
    .maybeSingle();
  
  if (!client || client.room_key !== roomKey) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }
  
  // Récupérer l'état timer
  const room = getRoom(roomId);
  const timerState = room.overlays["timer_chrono"] || { state: "idle", data: {} };
  
  const mode = timerState.data.mode || "timer";
  const seconds = timerState.data.seconds || 0;
  
  // Formatter pour affichage
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  const display = mode === "timer" 
    ? `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `00:00:00`; // Chrono démarre toujours à 0
  
  res.json({
    ok: true,
    mode: mode,
    state: timerState.state,
    seconds: seconds,
    display: display
  });
});

/* ============================================================
   ÉTAPE 4 : AJOUTER LA ROUTE API /api/control (STREAM DECK)
   ============================================================
   Ajouter cette route AVANT app.post("/api/admin/...")
   Cette route unifie tous les contrôles pour Stream Deck
*/

app.post("/api/control", async (req, res) => {
  const roomId = req.headers["x-room-id"];
  const roomKey = req.headers["x-room-key"];
  const { action, payload } = req.body;
  
  if (!supabaseEnabled) {
    return res.status(503).json({ ok: false, error: "no_db" });
  }
  
  // Vérification auth
  const { data: client } = await supabase
    .from("clients")
    .select("*")
    .eq("room_id", roomId)
    .limit(1)
    .maybeSingle();
  
  if (!client || client.room_key !== roomKey) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }
  
  console.log(`🎮 [API] ${roomId} - Action: ${action}`, payload);
  
  // Router l'action vers le bon handler
  const room = roomId;
  
  // ===== TIMER/CHRONO ACTIONS =====
  
  // Presets rapides
  if (action === "timer_preset") {
    const seconds = parseInt(payload?.seconds, 10);
    if (Number.isFinite(seconds)) {
      io.to(room).emit("control:timer_set_time", { room, seconds });
      return res.json({ ok: true, action: "timer_preset", seconds });
    }
  }
  
  // Incréments spécifiques (boutons +/-)
  if (action === "timer_add_10min") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: 600 });
    return res.json({ ok: true, action: "timer_add_10min" });
  }
  if (action === "timer_add_1min") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: 60 });
    return res.json({ ok: true, action: "timer_add_1min" });
  }
  if (action === "timer_add_10sec") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: 10 });
    return res.json({ ok: true, action: "timer_add_10sec" });
  }
  if (action === "timer_add_1sec") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: 1 });
    return res.json({ ok: true, action: "timer_add_1sec" });
  }
  
  // Décréments spécifiques (boutons -)
  if (action === "timer_sub_10min") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: -600 });
    return res.json({ ok: true, action: "timer_sub_10min" });
  }
  if (action === "timer_sub_1min") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: -60 });
    return res.json({ ok: true, action: "timer_sub_1min" });
  }
  if (action === "timer_sub_10sec") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: -10 });
    return res.json({ ok: true, action: "timer_sub_10sec" });
  }
  if (action === "timer_sub_1sec") {
    io.to(room).emit("control:timer_increment_time", { room, seconds: -1 });
    return res.json({ ok: true, action: "timer_sub_1sec" });
  }
  
  // Contrôles
  if (action === "timer_start") {
    io.to(room).emit("control:timer_start", { room });
    return res.json({ ok: true, action: "timer_start" });
  }
  if (action === "timer_pause") {
    io.to(room).emit("control:timer_pause", { room });
    return res.json({ ok: true, action: "timer_pause" });
  }
  if (action === "timer_reset") {
    io.to(room).emit("control:timer_reset", { room });
    return res.json({ ok: true, action: "timer_reset" });
  }
  if (action === "timer_toggle_pause") {
    io.to(room).emit("control:timer_toggle_pause", { room });
    return res.json({ ok: true, action: "timer_toggle_pause" });
  }
  
  // Modes
  if (action === "timer_mode_chrono") {
    io.to(room).emit("control:timer_set_mode", { room, mode: "chrono" });
    return res.json({ ok: true, action: "timer_mode_chrono" });
  }
  if (action === "timer_mode_timer") {
    io.to(room).emit("control:timer_set_mode", { room, mode: "timer" });
    return res.json({ ok: true, action: "timer_mode_timer" });
  }
  
  // Action inconnue
  res.status(400).json({ ok: false, error: "unknown_action", action });
});

/* ============================================================
   ✅ INSTALLATION COMPLÈTE
   ============================================================
   
   1. Copier les sections ci-dessus dans server.js V5.8
   2. Redémarrer le serveur
   3. Tester avec la télécommande ou Stream Deck
   
   🎯 EVENTS DISPONIBLES :
   
   Socket.io (interne) :
   - control:timer_set_mode
   - control:timer_set_time
   - control:timer_increment_time
   - control:timer_start
   - control:timer_pause
   - control:timer_toggle_pause
   - control:timer_reset
   
   API REST (Stream Deck) :
   - POST /api/control avec actions timer_*
   - GET /api/timer/status pour affichage
   
   ============================================================ */
