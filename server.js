'use strict';
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || '';
const SESSION_PATH = process.env.SESSION_PATH || '/data/whatsapp';
const STATE_DIR = process.env.STATE_PATH || '/data/state';
const SENT_FILE = path.join(STATE_DIR, 'sent.json');
const RETRY_MS = 30000;

fs.mkdirSync(SESSION_PATH, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
let sent = {};
try { sent = JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')); } catch (_) {}
function saveSent() { fs.writeFileSync(SENT_FILE, JSON.stringify(sent, null, 2)); }
function prune() {
  const cutoff = Date.now() - 90 * 86400000;
  for (const [key, value] of Object.entries(sent)) {
    if ((value.ts || 0) < cutoff) delete sent[key];
  }
  saveSent();
}
prune();

let ready = false;
let lastQr = null;
let lastQrAt = null;
let client = null;
let stopping = false;
let starting = false;
let retryTimer = null;
let startupAttempt = 0;

function makeClient() {
  const instance = new Client({
    authStrategy: new LocalAuth({ clientId: 'jjr', dataPath: SESSION_PATH }),
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });
  instance.on('qr', qr => {
    if (client !== instance) return;
    lastQr = qr;
    lastQrAt = new Date().toISOString();
    ready = false;
    console.log('[WA] Nouveau QR disponible');
  });
  instance.on('authenticated', () => console.log('[WA] Authentifié'));
  instance.on('ready', () => {
    if (client !== instance) return;
    ready = true;
    lastQr = null;
    console.log('WhatsApp READY');
  });
  instance.on('auth_failure', msg => {
    ready = false;
    console.error('[WA] Echec authentification:', msg);
  });
  instance.on('disconnected', reason => {
    if (client !== instance) return;
    ready = false;
    console.error('[WA] Déconnecté:', reason);
  });
  return instance;
}

function scheduleRetry() {
  if (stopping || retryTimer) return;
  console.log(`[WA] Nouvelle tentative dans ${RETRY_MS / 1000}s (sans effacer la session)`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    startWhatsApp().catch(e => console.error('[WA] Relance:', e));
  }, RETRY_MS);
}

async function startWhatsApp() {
  if (starting || stopping || ready) return;
  starting = true;
  startupAttempt++;
  const instance = makeClient();
  client = instance;
  console.log(`[WA] Démarrage tentative ${startupAttempt}; profil ${SESSION_PATH}/session-jjr`);
  try {
    await instance.initialize();
    console.log('[WA] Chromium initialisé');
  } catch (error) {
    ready = false;
    console.error('[WA] Impossible de démarrer Chromium:', error?.stack || error);
    // Ne jamais supprimer automatiquement SingletonLock : un ancien conteneur
    // peut encore utiliser ce profil sur le volume partagé Railway.
    try { await instance.destroy(); } catch (cleanupError) {
      console.warn('[WA] Nettoyage après échec:', cleanupError?.message || cleanupError);
    }
    if (client === instance) client = null;
    scheduleRetry();
  } finally {
    starting = false;
  }
}

const app = express();
app.use(express.json({ limit: '128kb' }));
function apiAuth(req, res, next) {
  if (!API_KEY || req.get('X-JJR-API-Key') !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}
function adminAuth(req, res, next) {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(401).send('Unauthorized');
  next();
}

app.get('/', (req, res) => res.json({ service: 'JJR WhatsApp Gateway', ok: true, whatsappReady: ready }));
app.get('/health', apiAuth, (req, res) => res.json({
  ok: true, whatsappReady: ready, groupConfigured: !!GROUP_ID, lastQrAt,
  starting, startupAttempt
}));
app.get('/qr', adminAuth, async (req, res) => {
  if (ready) return res.send('<h2>WhatsApp est déjà connecté.</h2>');
  if (!lastQr) return res.send('<h2>QR pas encore disponible. Rechargez dans quelques secondes.</h2>');
  try {
    const data = await QRCode.toDataURL(lastQr, { width: 360 });
    return res.send(`<meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;text-align:center;background:#111;color:#fff"><h2>Connexion WhatsApp JJR</h2><img src="${data}"><p>WhatsApp → Appareils connectés → Connecter un appareil</p></body>`);
  } catch (e) {
    console.error('[QR]', e);
    return res.status(500).send('Erreur de génération QR');
  }
});
app.get('/groups', apiAuth, async (req, res) => {
  if (!ready || !client) return res.status(503).json({ ok: false, error: 'whatsapp_not_ready' });
  try {
    console.log('[GROUPS] Début getChats()');
    const chats = await client.getChats();
    const groups = chats.filter(chat => chat.isGroup).map(chat => ({
      id: chat.id._serialized, name: chat.name
    }));
    console.log('[GROUPS] Groupes trouvés:', groups.length);
    return res.json({ ok: true, groups });
  } catch (e) {
    console.error('[GROUPS] ERREUR COMPLETE:', e?.stack || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e), type: e?.name || 'UnknownError' });
  }
});
app.post('/send', apiAuth, async (req, res) => {
  const notificationId = String(req.body?.notification_id || '').trim();
  const message = String(req.body?.message || '').trim();
  if (!notificationId || !message) return res.status(400).json({ ok: false, error: 'notification_id_and_message_required' });
  if (sent[notificationId]) return res.json({ ok: true, duplicate: true, messageId: sent[notificationId].messageId });
  if (!GROUP_ID) return res.status(503).json({ ok: false, error: 'group_not_configured' });
  if (!ready || !client) return res.status(503).json({ ok: false, error: 'whatsapp_not_ready' });
  try {
    const result = await client.sendMessage(GROUP_ID, message);
    const messageId = result?.id?._serialized || null;
    sent[notificationId] = { messageId, ts: Date.now() };
    saveSent();
    return res.json({ ok: true, duplicate: false, messageId });
  } catch (e) {
    console.error('[SEND] ERREUR:', e?.stack || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  ready = false;
  console.log(`[WA] ${signal}: arrêt propre`);
  if (retryTimer) clearTimeout(retryTimer);
  const forceExit = setTimeout(() => process.exit(0), 8000);
  forceExit.unref();
  try { if (client) await client.destroy(); }
  catch (e) { console.warn('[WA] Arrêt Chromium:', e?.message || e); }
  process.exit(0);
}
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });

app.listen(PORT, '0.0.0.0', () => {
  console.log('Gateway on', PORT);
  startWhatsApp().catch(e => console.error('[WA] Erreur de démarrage:', e));
});
