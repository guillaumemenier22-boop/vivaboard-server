const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// salles : code → { prof: ws, eleves: Map<id, {ws, nom, groupe}> }
const salles = new Map();

function genCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function sendToEleve(eleve, msg) {
  if (eleve.ws.readyState === WebSocket.OPEN) {
    eleve.ws.send(JSON.stringify(msg));
  }
}

function sendToProf(salle, msg) {
  if (salle.prof && salle.prof.readyState === WebSocket.OPEN) {
    salle.prof.send(JSON.stringify(msg));
  }
}

function broadcastEleves(salle, msg, excludeId = null) {
  salle.eleves.forEach((eleve, id) => {
    if (id !== excludeId) sendToEleve(eleve, msg);
  });
}

wss.on('connection', (ws) => {
  ws._salleCode = null;
  ws._role = null;
  ws._eleveId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── PROF : créer une salle ──
    if (msg.type === 'prof_init') {
      let code = genCode();
      while (salles.has(code)) code = genCode();
      const salle = { prof: ws, eleves: new Map(), groupes: msg.groupes || [] };
      salles.set(code, salle);
      ws._salleCode = code;
      ws._role = 'prof';
      ws.send(JSON.stringify({ type: 'salle_creee', code }));
      console.log(`Salle créée : ${code}`);
      return;
    }

    // ── ÉLÈVE : rejoindre ──
    if (msg.type === 'eleve_join') {
      const salle = salles.get(msg.code);
      if (!salle) {
        ws.send(JSON.stringify({ type: 'erreur', message: 'Code invalide' }));
        return;
      }
      const eleveId = Date.now().toString(36) + Math.random().toString(36).slice(2);
      ws._salleCode = msg.code;
      ws._role = 'eleve';
      ws._eleveId = eleveId;
      salle.eleves.set(eleveId, { ws, nom: msg.nom || 'Élève', groupe: msg.groupe || null });
      ws.send(JSON.stringify({ type: 'join_ok', eleveId, groupes: salle.groupes }));
      sendToProf(salle, { type: 'eleve_connecte', eleveId, nom: msg.nom || 'Élève', groupe: msg.groupe || null });
      console.log(`${msg.nom} rejoint salle ${msg.code}`);
      return;
    }

    const salle = ws._salleCode ? salles.get(ws._salleCode) : null;
    if (!salle) return;

    // ── PROF → envoyer activité ──
    if (msg.type === 'envoyer_activite' && ws._role === 'prof') {
      salle.eleves.forEach((eleve) => {
        if (!msg.groupes || msg.groupes.includes(eleve.groupe)) {
          const consigne = msg.consignes?.[eleve.groupe] || msg.consigneGlobale || '';
          sendToEleve(eleve, { type: 'activite', titre: msg.titre, consigne, media: msg.media || null });
        }
      });
      return;
    }

    // ── PROF → partage d'écran ──
    if (msg.type === 'screen_share' && ws._role === 'prof') {
      broadcastEleves(salle, { type: 'screen_share', data: msg.data });
      return;
    }
    if (msg.type === 'screen_share_stop' && ws._role === 'prof') {
      broadcastEleves(salle, { type: 'screen_share_stop' });
      return;
    }

    // ── PROF → envoyer média ──
    if (msg.type === 'envoyer_media' && ws._role === 'prof') {
      broadcastEleves(salle, { type: 'media', url: msg.url, mediaType: msg.mediaType });
      return;
    }

    // ── ÉLÈVE → j'ai fini ──
    if (msg.type === 'j_ai_fini' && ws._role === 'eleve') {
      const eleve = salle.eleves.get(ws._eleveId);
      sendToProf(salle, { type: 'eleve_fini', eleveId: ws._eleveId, nom: eleve?.nom || 'Élève', titre: msg.titre || null });
      return;
    }

    // ── ÉLÈVE → changer de groupe ──
    if (msg.type === 'set_groupe' && ws._role === 'eleve') {
      const eleve = salle.eleves.get(ws._eleveId);
      if (eleve) {
        eleve.groupe = msg.groupe;
        sendToProf(salle, { type: 'eleve_groupe_update', eleveId: ws._eleveId, groupe: msg.groupe });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!ws._salleCode) return;
    const salle = salles.get(ws._salleCode);
    if (!salle) return;

    if (ws._role === 'prof') {
      broadcastEleves(salle, { type: 'salle_fermee' });
      salles.delete(ws._salleCode);
      console.log(`Salle ${ws._salleCode} fermée`);
    } else if (ws._role === 'eleve') {
      salle.eleves.delete(ws._eleveId);
      sendToProf(salle, { type: 'eleve_deconnecte', eleveId: ws._eleveId });
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Vivaboard server on port ${PORT}`));
