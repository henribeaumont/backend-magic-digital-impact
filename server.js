// ============================================================
// MDI SERVER V5.7 — SAFE, SAAS, DEBUGGABLE
// ============================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

let createClient;
try { ({ createClient } = require("@supabase/supabase-js")); }
catch { createClient = null; }

// ------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(cors({ origin: "*", methods: ["GET","POST"] }));

const server = http.createServer(app);
const io = new Server(server, { cors:{ origin:"*" } });

// ------------------------------------------------------------
// CONFIG
const ADMIN_SECRET = process.env.ADMIN_SECRET || "MDI_SUPER_ADMIN_2026";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabaseEnabled =
  Boolean(SUPABASE_URL) &&
  Boolean(SUPABASE_SERVICE_ROLE_KEY) &&
  typeof createClient === "function";

const supabase = supabaseEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth:{ persistSession:false }})
  : null;

// ------------------------------------------------------------
// ROOMS MEMORY
const ROOMS = Object.create(null);

function getRoom(id){
  if(!ROOMS[id]) ROOMS[id] = { overlays:{}, history:[] };
  return ROOMS[id];
}
function ensureOverlayState(room, overlay){
  const r = getRoom(room);
  if(!r.overlays[overlay]) r.overlays[overlay] = { state:"idle", data:{} };
  return r.overlays[overlay];
}

// ------------------------------------------------------------
// UTILS QUIZ
function normalizeVoteText(raw){
  return String(raw||"")
    .replace(/\u00A0/g," ")
    .replace(/\s+/g," ")
    .trim()
    .toUpperCase();
}
function extractChoiceABCD(txt){
  const s = normalizeVoteText(txt);
  if(!s) return null;
  const exact = s.match(/^([ABCD])[\)\]\.\!\?:,\-]*$/);
  if(exact) return exact[1];
  const token = s.match(/(^|[^A-Z0-9])([ABCD])([^A-Z0-9]|$)/);
  return token ? token[2] : null;
}
function getVoteStats(hist){
  const s={A:0,B:0,C:0,D:0,total:0};
  hist.forEach(v=>{
    if(s[v.choice]!=null) s[v.choice]++;
    s.total++;
  });
  return s;
}
function calculatePercents(st){
  const t = st.total || 1;
  return {
    A:((st.A/t)*100).toFixed(1),
    B:((st.B/t)*100).toFixed(1),
    C:((st.C/t)*100).toFixed(1),
    D:((st.D/t)*100).toFixed(1),
  };
}

// ------------------------------------------------------------
// ROUTES
app.get("/", (_,res)=>res.send("MDI Server V5.7 Online"));

app.get("/debug/questions", async (req,res)=>{
  if(!supabaseEnabled) return res.json({ok:false});
  const room = String(req.query.room||"").trim();
  if(!room) return res.json({ok:false});
  const { data } = await supabase
    .from("questions")
    .select("*")
    .eq("room_id", room)
    .order("order_index");
  res.json({ok:true,data:data||[]});
});

// ------------------------------------------------------------
// SOCKETS
io.on("connection",(socket)=>{
  console.log("✅ connected", socket.id);

  socket.on("rejoindre_salle",(room)=>socket.join(room));

  // ============================
  // AUTH OVERLAY
  socket.on("overlay:join", async(p)=>{
    if(!supabaseEnabled) return;
    const { data:client } = await supabase
      .from("clients")
      .select("*")
      .eq("room_id", p.room)
      .maybeSingle();

    if(!client || !client.active || client.room_key !== p.key){
      return socket.emit("overlay:forbidden",{reason:"auth"});
    }

    socket.join(p.room);

    const s = ensureOverlayState(p.room,p.overlay);
    if(p.overlay==="quiz_ou_sondage"){
      const r=getRoom(p.room);
      if(r.history.length){
        s.data.percents = calculatePercents(getVoteStats(r.history));
      }
    }

    socket.emit("overlay:state",{ overlay:p.overlay, state:s.state, data:s.data });
  });

  // ============================
  // 🔥 NOUVEL ÉVÉNEMENT SOURCE CHAT
  socket.on("chat:message",(p)=>{
    if(!p?.room || !p?.text) return;

    console.log("📥 chat:message",{
      room:p.room,
      user:p.user,
      source:p.source,
      text:p.text
    });

    // rebroadcast brut (source de vérité)
    io.to(p.room).emit("chat:raw",{
      room:p.room,
      user:p.user||"Anonyme",
      text:p.text,
      source:p.source||"unknown",
      ts:p.ts||Date.now()
    });
  });

  // ============================
  // LEGACY — COMPATIBILITÉ TOTALE
  socket.on("nouveau_vote",(payload)=>{
    const room = payload.room;
    const user = payload.user || "Anonyme";
    const rawVote = normalizeVoteText(payload.vote||"");
    if(!room || !rawVote) return;

    const r = getRoom(room);
    const choice = extractChoiceABCD(rawVote);

    if(choice){
      r.history.push({ user, choice, time:Date.now() });
      const s = ensureOverlayState(room,"quiz_ou_sondage");
      s.data.percents = calculatePercents(getVoteStats(r.history));
      io.to(room).emit("overlay:state",{ overlay:"quiz_ou_sondage", state:s.state, data:s.data });
    }

    // canal universel existant
    io.to(room).emit("raw_vote",{ user, vote:rawVote });
  });

  // ============================
  socket.on("control:set_state",(p)=>{
    const s = ensureOverlayState(p.room,p.overlay);
    s.state = p.state;
    io.to(p.room).emit("overlay:state",{ overlay:p.overlay, state:p.state, data:s.data });
  });

  socket.on("control:idle",(p)=>{
    const s = ensureOverlayState(p.room,p.overlay);
    s.state="idle"; s.data={};
    io.to(p.room).emit("overlay:state",{ overlay:p.overlay, state:"idle", data:{} });
  });
});

// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`🚀 MDI Server V5.7 on ${PORT}`));
