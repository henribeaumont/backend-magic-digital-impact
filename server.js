<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>MDI • Admin Cockpit (Secure)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
  <style>
    /* ... (Même CSS qu'avant + Login Screen) ... */
    :root { --bg: #0f172a; --panel: #1e293b; --text: #f1f5f9; --accent: #3b82f6; --danger: #ef4444; }
    body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; margin: 0; padding: 20px; }
    .container { max-width: 1000px; margin: 0 auto; display: none; /* Caché par défaut */ }
    h1 { display: flex; justify-content: space-between; }
    .tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .tab { background: var(--panel); padding: 10px 20px; border-radius: 8px; cursor: pointer; opacity: 0.6; }
    .tab.active { opacity: 1; background: var(--accent); }
    .view { display: none; }
    .view.active { display: block; }
    .card { background: var(--panel); padding: 20px; border-radius: 12px; margin-bottom: 15px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
    label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 4px; }
    input, select, textarea { width: 100%; background: #0f172a; border: 1px solid #334155; color: white; padding: 10px; border-radius: 6px; box-sizing:border-box; }
    button { background: var(--accent); color: white; border: none; padding: 10px 15px; border-radius: 6px; font-weight: bold; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #334155; }
    
    /* LOGIN OVERLAY */
    #login-screen { position: fixed; inset: 0; background: var(--bg); display: flex; justify-content: center; align-items: center; z-index: 999; }
    .login-box { background: var(--panel); padding: 40px; border-radius: 16px; text-align: center; width: 300px; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
  </style>
</head>
<body>

<div id="login-screen">
  <div class="login-box">
    <h2>🔒 Accès Admin</h2>
    <div style="margin-bottom:15px; text-align:left;">
      <label>Mot de passe serveur</label>
      <input type="password" id="adminPass" placeholder="MDI_SUPER_ADMIN..." >
    </div>
    <button onclick="tryLogin()" style="width:100%">Déverrouiller</button>
  </div>
</div>

<div class="container" id="app">
  <h1><span>🚀 MDI Admin</span> <button onclick="logout()" style="background:#334155">Logout</button></h1>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('clients')">👥 Clients</div>
    <div class="tab" onclick="switchTab('questions')">❓ Questions</div>
  </div>

  <div id="view-clients" class="view active">
    <div class="card">
      <h3>Ajouter / Modifier Client</h3>
      <form id="formClient">
        <div class="row">
          <div><label>ID Client</label><input id="c_id" required></div>
          <div><label>Clé Secrète</label><input id="c_key" required></div>
        </div>
        <div><label>Actif ?</label><select id="c_active"><option value="true">OUI</option><option value="false">NON</option></select></div>
        <button type="submit" style="margin-top:10px">💾 Sauvegarder</button>
      </form>
    </div>
    <div class="card">
      <table id="tableClients"><thead><tr><th>Room ID</th><th>Key</th><th>Actif</th><th>Action</th></tr></thead><tbody></tbody></table>
    </div>
  </div>

  <div id="view-questions" class="view">
    <div class="card">
      <h3>Éditer Question</h3>
      <form id="formQuestion">
        <div class="row">
          <div><label>Room ID</label><input id="q_room" required></div>
          <div><label>Code (ex: Q01)</label><input id="q_key" required></div>
        </div>
        <div class="row">
          <div><label>Type</label><select id="q_type"><option value="quiz">Quiz</option><option value="poll">Sondage</option></select></div>
          <div><label>Ordre</label><input type="number" id="q_order" value="1"></div>
        </div>
        <div style="margin-bottom:10px"><label>Question</label><textarea id="q_prompt" rows="2" required></textarea></div>
        <div class="row">
          <div><label>A</label><input id="q_a" required></div>
          <div><label>B</label><input id="q_b" required></div>
        </div>
        <div class="row">
          <div><label>C</label><input id="q_c"></div>
          <div><label>D</label><input id="q_d"></div>
        </div>
        <div style="margin-bottom:10px"><label>Bonne Réponse (Quiz)</label><select id="q_correct"><option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option></select></div>
        <button type="submit">💾 Sauvegarder</button>
      </form>
    </div>
    <div class="card"><table id="tableQuestions"><thead><tr><th>Room</th><th>Key</th><th>Txt</th><th>Action</th></tr></thead><tbody></tbody></table></div>
  </div>
</div>

<script>
const API_URL = "https://magic-digital-impact-live.onrender.com/api/admin";
let SECRET = localStorage.getItem("mdi_admin_secret") || "";

// AUTH
if(SECRET) tryLogin(true);

async function tryLogin(auto=false) {
  if(!auto) SECRET = document.getElementById("adminPass").value;
  // Test simple : on essaie de charger les data
  const res = await apiCall("/data");
  if(res.ok) {
    localStorage.setItem("mdi_admin_secret", SECRET);
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("app").style.display = "block";
    renderData(res);
  } else {
    if(!auto) alert("Mot de passe refusé par le serveur !");
  }
}
function logout() { localStorage.removeItem("mdi_admin_secret"); location.reload(); }

// API
async function apiCall(endpoint, method="GET", body=null) {
  const opts = { method, headers: { "Content-Type": "application/json", "x-admin-secret": SECRET } };
  if(body) opts.body = JSON.stringify(body);
  try { return await (await fetch(API_URL+endpoint, opts)).json(); } catch(e){ return {ok:false}; }
}

async function refresh() { renderData(await apiCall("/data")); }

function renderData(res) {
  if(!res.clients) return;
  window.rawData = res;
  
  // Clients
  document.querySelector("#tableClients tbody").innerHTML = res.clients.map(c => 
    `<tr><td>${c.room_id}</td><td>${c.room_key}</td><td>${c.active?'✅':'❌'}</td><td><button onclick="editClient('${c.room_id}')">Edit</button></td></tr>`
  ).join('');
  
  // Questions
  document.querySelector("#tableQuestions tbody").innerHTML = res.questions.map(q => 
    `<tr><td>${q.room_id}</td><td><b>${q.question_key}</b></td><td>${q.prompt}</td><td><button onclick="editQ('${q.room_id}','${q.question_key}')">Edit</button> <button onclick="delQ('${q.room_id}','${q.question_key}')" style="background:#ef4444">X</button></td></tr>`
  ).join('');
}

// FORMS (CORRECTIF BUG: parseInt sur order_index)
document.getElementById("formClient").onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    room_id: document.getElementById("c_id").value,
    room_key: document.getElementById("c_key").value,
    active: document.getElementById("c_active").value === "true",
    entitlements: {"quiz_ou_sondage":true} 
  };
  await apiCall("/client", "POST", body); refresh();
};

document.getElementById("formQuestion").onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    room_id: document.getElementById("q_room").value,
    question_key: document.getElementById("q_key").value,
    type: document.getElementById("q_type").value,
    order_index: parseInt(document.getElementById("q_order").value) || 1, // <--- ICI LE FIX IMPORTANTE
    prompt: document.getElementById("q_prompt").value,
    option_a: document.getElementById("q_a").value,
    option_b: document.getElementById("q_b").value,
    option_c: document.getElementById("q_c").value,
    option_d: document.getElementById("q_d").value,
    correct_option: document.getElementById("q_correct").value,
    enabled: true
  };
  const res = await apiCall("/question", "POST", body);
  if(!res.ok) alert("Erreur: " + res.error); // On affiche l'erreur si ça plante encore
  refresh();
};

// ACTIONS
window.editClient = (id) => {
  const c = window.rawData.clients.find(x => x.room_id === id);
  if(c) { document.getElementById("c_id").value=c.room_id; document.getElementById("c_key").value=c.room_key; }
};
window.editQ = (rid, qid) => {
  const q = window.rawData.questions.find(x => x.room_id === rid && x.question_key === qid);
  if(q) {
    document.getElementById("q_room").value = q.room_id;
    document.getElementById("q_key").value = q.question_key;
    document.getElementById("q_prompt").value = q.prompt;
    document.getElementById("q_a").value = q.option_a;
    document.getElementById("q_b").value = q.option_b;
    document.getElementById("q_c").value = q.option_c;
    document.getElementById("q_d").value = q.option_d;
    switchTab('questions');
  }
};
window.delQ = async (rid, qid) => {
  if(confirm("Supprimer ?")) { await apiCall("/delete-question", "POST", {room_id:rid, question_key:qid}); refresh(); }
};

function switchTab(t) {
  document.querySelectorAll(".view").forEach(e => e.classList.remove("active"));
  document.getElementById("view-"+t).classList.add("active");
}
</script>
</body>
</html>
