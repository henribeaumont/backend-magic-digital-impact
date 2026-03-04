# CONTEXT.md — MDI Live SaaS
> Fichier de référence pour Claude Code. À lire EN INTÉGRALITÉ avant toute intervention.
> Dernière mise à jour : mars 2026

---

## 1. PRÉSENTATION DU PROJET

MDI Live est une plateforme SaaS d'overlays interactifs en temps réel pour OBS Studio.
Elle permet à des animateurs (formateurs, présentateurs) de faire interagir leur audience
via Zoom, Teams, Google Meet ou WebinarJam, avec des visuels affichés en direct dans OBS.

**Stack technique :**
- Serveur Node.js + Socket.io → déployé sur **Render**
- Overlays HTML/CSS/JS → déployés sur **Vercel** (un déploiement par overlay)
- Extension Chrome → injection DOM chat Zoom/Meet/Teams/WebinarJam
- Télécommande Web → interface de contrôle animateur (HTML monofichier)
- Base de données → **Supabase** (auth clients + catalogue questions quiz)

---

## 2. STRUCTURE DES REPOS

### Repo BACKEND
Contient : `server.js`, `package.json`, variables d'environnement Render

### Repo FRONTEND
Contient :
- `/overlays/` → tous les overlays HTML
- `/telecommande/` → télécommande animateur
- `/extension/` → extension Chrome (manifest.json, content.js, popup.html, popup.js, socket.io.js, icon.png)

---

## 3. URLs DE PRODUCTION

| Composant | URL |
|-----------|-----|
| Serveur | https://magic-digital-impact-live.onrender.com |
| Health check | https://magic-digital-impact-live.onrender.com/health |
| Overlays | https://[nom-overlay].vercel.app |
| Vercel dashboard | https://vercel.com/dashboard |
| Extension Chrome | chrome://extensions (mode développeur) |

---

## 4. VERSIONS ACTUELLES (production)

| Fichier | Version | Statut |
|---------|---------|--------|
| server.js | V5.16 | ✅ Production |
| telecommande.html | V3.6 | ✅ Production |
| content.js (extension) | V11.5 | ⚠️ Bug Teams (voir section 10) |
| manifest.json | V2.1 | ⚠️ Périmètre trop large (voir section 10) |
| nuage_de_mots.html | V6.7 | ✅ Production |
| roue_loto.html | V6.9 | ✅ Production |
| quiz.html | V3.8 | ✅ Production |
| script_timer_chrono.js | V2.1 | ✅ Production |
| script_commentaires.js | V1.1 | ✅ Production |
| script_match_equipes.js | V1.1 | ✅ Production |

> ⚠️ ATTENTION : La documentation interne référence parfois "V11.8" pour content.js.
> Le fichier réel en production est V11.5. Ne pas se fier aux numéros de version dans les noms de fichiers.

---

## 5. OVERLAYS OPÉRATIONNELS

### Architecture fichiers
- **Monofichier** (ancienne norme) : nuage_de_mots, roue_loto, quiz, tug_of_war, emoji_tornado
- **Triptyque HTML+CSS+JS** (nouvelle norme) : timer_chrono, commentaires, match_equipes
- Migration monofichier → triptyque est en **dette technique connue** — ne pas migrer sans instruction explicite

### Liste des overlays

| # | Nom | Type | Baseline | Stream Deck |
|---|-----|------|----------|-------------|
| 1 | quiz_ou_sondage | Monofichier | NON | OUI (5 actions) |
| 2 | nuage_de_mots | Monofichier | DÉSACTIVÉE | OUI (2 actions) |
| 3 | roue_loto | Monofichier | DÉSACTIVÉE | OUI (8 actions) |
| 4 | tug_of_war | Monofichier | OUI | NON |
| 5 | emoji_tornado | Monofichier | NON | NON |
| 6 | timer_chrono | Triptyque | N/A | OUI (17 actions) |
| 7 | commentaires | Triptyque | N/A | OUI (2 actions) |
| 8 | match_equipes | Triptyque | N/A | OUI (5 actions) |

---

## 6. RÈGLES D'ARCHITECTURE — NE JAMAIS VIOLER

### Règle #1 — Source de vérité serveur
```
❌ Les scripts overlay ne doivent JAMAIS émettre socket.emit() dans overlay:state
✅ Les scripts overlay écoutent socket.on("overlay:state") uniquement
✅ Le serveur est la seule source de vérité
```

### Règle #2 — Auth overlay
```javascript
// Toujours au démarrage du script overlay :
socket.emit("overlay:join", { room, key, overlay: "nom_overlay" });
// En cas d'échec → socket.on("overlay:forbidden") → afficher "ACCESS DENIED" fond rouge
```

### Règle #3 — Source Browser OBS
```
✅ La source Browser OBS doit toujours rester visible (👁️ jamais désactivée)
✅ L'overlay se masque lui-même via classList + fondu CSS
✅ La télécommande pilote via control:activate_overlay / control:deactivate_overlay
```

### Règle #4 — CSS OBS
```css
/* Copier UNIQUEMENT ça dans OBS — rien d'autre */
:root {
  --room-id: "VOTRE_ID";   /* AVEC guillemets */
  --room-key: "VOTRE_CLE"; /* AVEC guillemets */
}
html, body {
  background: rgba(0,0,0,0) !important;
}
```
> ⚠️ Ne jamais copier les commentaires pédagogiques dans OBS — OBS ne parse pas correctement les CSS longs.

### Règle #5 — Baseline désactivée
```
⚠️ La baseline anti-pollution est DÉSACTIVÉE sur nuage et roue
⚠️ Ne pas réactiver sans corriger le bug de blocage des votes répétés
✅ Solution actuelle : protocole F5 + flux control télécommande
```

### Règle #6 — Throttle nuage
```
✅ overlay:state nuage émis max 1 fois/seconde (throttle V5.16)
⚠️ Ne pas supprimer ce throttle — sans lui le toggle OFF ne répond plus sous charge
```

---

## 7. STRUCTURE ÉTAT SERVEUR (RAM)

```javascript
ROOMS[room].overlays[overlay] = {
  state: "idle" | "active" | "collecting" | "ready" | "spinning",
  data: {
    activatedAt: timestamp,
    words: { "mot": count },          // Nuage — mots ≥ 2 chars uniquement
    participants: [{name, key}],       // Roue
    consecutifMode: false,             // Roue
    question: {...},                   // Quiz
    percents: {A, B, C, D},           // Quiz
    mode: "timer" | "chrono",         // Timer
    seconds: 300,                      // Timer
    flux: [{id, author, text, timestamp, sent}],  // Commentaires
    queue: [{id, author, text, displayed}],        // Commentaires
    current: {id, author, text} | null,            // Commentaires
    minWords: 4,                       // Commentaires
    teamA: {name: "ÉQUIPE A", score: 0}, // Match
    teamB: {name: "ÉQUIPE B", score: 0}  // Match
  }
}
```

---

## 8. AUTHENTIFICATION & SUPABASE

### Flux d'authentification client
1. Client saisit `room_id` dans le popup de l'extension Chrome
2. Client saisit `room_id` + `room_key` dans le CSS personnalisé OBS (par overlay)
3. Client saisit `room_id` + `room_key` dans la télécommande web
4. **Le serveur vérifie `room_id` + `room_key` dans Supabase à chaque connexion overlay**

### Ce qui existe dans Supabase
- Table clients/rooms : `room_id`, `room_key`, et données associées
- Catalogue questions quiz (isolé par client)
- Accès admin protégé par `ADMIN_SECRET` (pour alimenter le catalogue)

### Règles de sécurité critiques
```
✅ Vérification room_id + room_key AVANT tout traitement de données
✅ Un client ne peut pas accéder aux données d'une autre room
✅ SUPABASE_SERVICE_ROLE_KEY uniquement côté serveur — jamais exposé côté client
✅ Routes admin protégées par ADMIN_SECRET, pas par room_key
```

### Variables d'environnement Render (ne jamais committer)
```
ADMIN_SECRET=MDI_SUPER_ADMIN_2026
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJxxx...
PORT=3000
```

### Dette technique Supabase connue
- Gestion des plans clients (accès limité par overlay selon le plan) : **non implémenté**
- Expiration des accès clients : **non implémenté**
- Logs de connexion par client : **non implémenté**

---

## 9. EXTENSION CHROME — ÉTAT ET RÈGLES

### Fichiers
| Fichier | Rôle |
|---------|------|
| manifest.json | Permissions + déclaration content scripts |
| content.js | Observer DOM + envoi Socket.io |
| socket.io.js | Librairie Socket.io bundlée |
| popup.html + popup.js | UI saisie room_id |

### Logique de détection (ne pas modifier sans raison explicite)
- **Quiz** : regex stricte `/^([ABCD])[\)\]\.\!\?:,\-\s]*$/` — seulement A/B/C/D seul, jamais dans un mot
- **Word Cloud** : 1-2 mots, max 15 chars/mot
- **Commentaires** : 4+ mots, max 500 chars
- **Zone grise** : 3 mots, max 100 chars → envoyé, le serveur filtre

### Blacklist UI (textes ignorés)
```javascript
"RÉUNION AVEC", "MEETING WITH", "AUCUN MESSAGE POUR LE MOMENT",
"TAPEZ UN NOUVEAU MESSAGE", "TYPE A NEW MESSAGE",
"MODIFIER", "SUPPRIMER", "RÉPONDRE",
"KEEP", "EPINGLER", "ÉPINGLER",
"AUCUN COMMENTAIRE EN ATTENTE", "NO COMMENTS PENDING",
"AUCUN COMMENTAIRE", "NO COMMENT", "EN ATTENTE", "PENDING"
```

---

## 10. BUGS CONNUS À CORRIGER (extension Chrome)

### Bug #1 — Teams : silence total (PRIORITÉ HAUTE)
**Cause** : Teams Web 2024 ne rend plus les messages dans `<p>` ou `div[dir='auto']`.
Les messages sont dans des éléments `data-tid="message-body"` ou `class*="ui-chat__item"`.
**Fichier** : `content.js` — bloc `// === TEAMS ===`
**Solution** : Cibler `[data-tid="message-body"]` en premier, avec fallbacks.

### Bug #2 — Capture d'autres onglets Chrome (PRIORITÉ HAUTE)
**Cause 1** : `manifest.json` déclare `"matches": ["<all_urls>"]` → injection sur tous les onglets.
**Cause 2** : `content.js` contient un bloc `// FALLBACK GENERIC` qui capture n'importe quel DOM.
**Solution** :
- Restreindre `matches` aux domaines ciblés uniquement (zoom.us, meet.google.com, teams.microsoft.com, teams.live.com, webinarjam.com, everwebinar.com)
- Supprimer `all_frames: true`
- Supprimer le bloc FALLBACK GENERIC entièrement

### Contraintes de correction (ne pas toucher)
```
✅ Ne pas modifier cleanAndValidate() — fonctionne
✅ Ne pas modifier extractQuizToken() — regex stricte volontaire
✅ Ne pas modifier le bloc Zoom (extractZoomTextPreserveEmojis est critique)
✅ Ne pas modifier le bloc Google Meet
✅ Ne pas modifier la logique Socket.io
```

---

## 11. HANDLERS SOCKET.IO SERVEUR (référence complète)

### Nuage de mots
- `control:nuage_word_increment` → +1 vote sur un mot
- `control:nuage_remove_word` → Retire un mot
- `control:nuage_clear_all` → Vide tout le nuage

### Roue loto
- `roue:start_collect` → state → "collecting"
- `roue:stop_collect` → state → "ready"
- `roue:spin` → state → "spinning"
- `roue:reset` → state → "idle"
- `control:roue_add_participant_manual` → Ajout sans contrainte d'état
- `control:roue_edit_participant` → Éditer (index ou nom)
- `control:roue_remove_participant` → Retirer (index ou nom)
- `roue:set_consecutif` → Mode consécutif ON/OFF
- `roue:winner_selected` → Retour "ready" + retrait si consécutif

### Commentaires
- `control:comment_to_queue` → Flux → Queue
- `control:comment_show` → Afficher sur overlay
- `control:comment_hide` → Masquer
- `control:comment_delete` → Supprimer
- `control:comment_reset_flux` → Vider flux
- `control:comment_reset_queue` → Vider queue

### Match équipes
- `control:match_adjust_score` → +1/-1 équipe A ou B (min 0)
- `control:match_reset` → Reset 0-0

### Timer
- `control:timer_set_time` → Définir temps (secondes)
- `control:timer_increment_time` → +/- temps
- `control:timer_start` → Démarrer
- `control:timer_pause` → Pause
- `control:timer_toggle_pause` → Toggle pause
- `control:timer_reset` → Reset
- `control:timer_set_mode` → "timer" ou "chrono"

### Quiz
- `control:load_question` → Charger question
- `control:show_options` → Afficher options
- `control:set_state` → Changer état
- `control:idle` → Reset

### Présence overlays
- `overlay:online` → Overlay connecté
- `overlay:offline` → Overlay déconnecté
- `overlay:presence_update` → Mise à jour `{ displaying: true/false }`

---

## 12. API REST STREAM DECK

```
POST /api/control
Headers : x-room-id, x-room-key
Body : { "action": "...", "payload": {} }
```

| Overlay | Actions disponibles |
|---------|-------------------|
| Timer | timer_preset, timer_add/sub_10min/1min/10sec/1sec, timer_start, timer_pause, timer_reset, timer_toggle_pause, timer_mode_timer, timer_mode_chrono |
| Commentaires | comment_show (payload: {messageId}), comment_hide, commentaires_on, commentaires_off |
| Match | match_team_a_increment, match_team_a_decrement, match_team_b_increment, match_team_b_decrement, match_reset, match_on |
| Nuage | nuage_on, nuage_off |
| Roue | roue_on, roue_off, roue_start_collect, roue_stop_collect, roue_spin, roue_reset, roue_consecutif_on, roue_consecutif_off |
| Quiz | quiz_load (payload: {question_key}), quiz_show_options, quiz_show_results, quiz_reveal, quiz_reset |

---

## 13. BUGS RÉSOLUS — NE PAS RÉINTRODUIRE

| Bug | Solution appliquée | Version fix |
|-----|--------------------|-------------|
| Messages fantômes DOM | Protocole F5 + flux control (baseline abandonnée) | V5.8 |
| Anti-collision nuage | AABB + marge 15px | V6.7 |
| Roue ne s'affiche pas | drawWheel() explicite + fondu | V6.7 |
| Taille nuage insuffisante | 30px→120px | V6.7 |
| "A" détecté dans "ça" | Regex quiz stricte | V11.8 |
| Panel commentaires trop carré | min-width 600px, max-width 1200px | V1.1 |
| Nuage saturé par "x"/❌ | Filtre longueur min 2 chars + throttle 1s | V5.16 |
| Toggle nuage OFF inopérant | Throttle serveur + clearTimeout au deactivate | V5.16 |
| Toggle consécutif roue mal centré | CSS flex corrigé | V3.6 |
| Nouveau_vote dans télécommande → boucle | Handler supprimé, overlay:state suffit | V3.6 |

---

## 14. DETTE TECHNIQUE CONNUE (classée par priorité)

### HAUTE
- **Extension Chrome Teams** : silence total — sélecteurs DOM obsolètes (voir section 10)
- **Extension Chrome capture tous les onglets** : manifest trop permissif + fallback générique (voir section 10)
- **Baseline anti-pollution** : désactivée car bug blocage votes répétés — besoin solution WeakSet sur nodes DOM

### MOYENNE
- **Migration monofichier → triptyque** : nuage, roue, quiz, tug, emoji à migrer
- **Gestion plans clients Supabase** : accès par overlay selon plan non implémenté
- **Pollution résiduelle** : possible si protocole F5 non respecté

### BASSE
- **Exclusion mutuelle overlays** : gérée manuellement par animateur
- **Expiration accès clients** : non implémenté dans Supabase
- **Logs connexion par client** : non implémentés

---

## 15. WORKFLOW LIVE (référence animateur)

### Setup (1 fois)
1. Créer sources Browser OBS pour chaque overlay
2. Coller CSS personnalisé dans Filtres OBS (JUSTE le `:root{}`)
3. Vérifier sources visibles (👁️)
4. Ouvrir télécommande web

### Avant chaque exercice
1. Fermer le chat Zoom/Meet/Teams
2. **Actualiser la page web (F5) ← OBLIGATOIRE**
3. Rouvrir le chat
4. Scroller tout en bas
5. Activer overlay via télécommande

---

## 16. DEBUGGING RAPIDE

### Logs attendus (tout va bien)
```
✅ [MDI] Connecté. Join room: H_Perso        (Extension Chrome)
✅ [NUAGE] Connecté                           (Overlay nuage)
✅ [TIMER] Connecté au serveur               (Overlay timer)
🟢 [PRÉSENCE] room - overlay : en ligne      (Serveur)
```

### Erreurs communes
```
❌ overlay:forbidden     → Room ID ou Key incorrect (vérifier guillemets dans CSS OBS)
❌ Overlay invisible     → Vérifier voyant "Données OBS" 🟢 dans télécommande
❌ Extension spamme      → Vérifier extension installée, actualiser page Zoom
❌ Messages fantômes     → Appliquer protocole F5 + scroll en bas
❌ Teams silencieux      → Bug connu V11.5 — voir section 10
❌ Autres onglets capturés → Bug connu V11.5 — voir section 10
```

---

*Ce fichier est la source de vérité du projet. En cas de conflit entre ce fichier et un autre fichier du repo, ce fichier fait référence. Le mettre à jour à chaque changement significatif.*
