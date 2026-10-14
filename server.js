'use strict';
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const https = require('node:https');
const { timingSafeEqual } = require('node:crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const WA_VERSION = require('whatsapp-web.js/package.json').version;

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const GROUP_ID = process.env.WHATSAPP_GROUP_ID || '';
const TEST_GROUP_ID = process.env.WHATSAPP_TEST_GROUP_ID || '';
const SESSION_PATH = process.env.SESSION_PATH || '/data/whatsapp';
const STATE_DIR = process.env.STATE_PATH || '/data/state';
const SENT_FILE = path.join(STATE_DIR, 'sent.json');
const RETRY_MS = 30000;
const BIRTHDAY_SYNC_TOKEN = process.env.JJR_BIRTHDAY_SYNC_TOKEN || '';
const BIRTHDAY_MESSAGE_TEMPLATE = process.env.JJR_BIRTHDAY_MESSAGE || '🎂 Joyeux anniversaire à {prenom} {nom} ! 🎉';
function birthdayMessage(entry) {
  return BIRTHDAY_MESSAGE_TEMPLATE.replace(/\\n/g, '\n').replace(/\{prenom\}/g, () => entry.prenom.trim()).replace(/\{nom\}/g, () => entry.nom.trim());
}
const BIRTHDAY_FILE = path.join(STATE_DIR, 'birthdays.json');
const BIRTHDAY_LOG_FILE = path.join(STATE_DIR, 'birthday_delivery.json');
let birthdayTimer = null;
let birthdayRunning = false;
function parisClock() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`,
    monthDay: `${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.error('[birthdays] Lecture fichier:', file, e.message); return fallback; }
}
function writeJsonAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function validBirthdayPhoto(photo) {
  if (photo === null || photo === undefined) return true;
  if (!photo || photo.mimetype !== 'image/jpeg' || typeof photo.data !== 'string' || photo.data.length > 90000) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(photo.data) && photo.data.length % 4 === 0;
}
function validBirthday(item) {
  if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || item.id > 2147483647) return false;
  if (typeof item.prenom !== 'string' || !item.prenom.trim() || item.prenom.length > 150) return false;
  if (typeof item.nom !== 'string' || !item.nom.trim() || item.nom.length > 150) return false;
  return validBirthdayPhoto(item.photo) && (item.month_day === null || (typeof item.month_day === 'string' &&
    /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/.test(item.month_day) &&
    !Number.isNaN(Date.parse('2024-' + item.month_day + 'T12:00:00Z'))) );
}
let birthdays = readJson(BIRTHDAY_FILE, {});
let birthdayDelivery = readJson(BIRTHDAY_LOG_FILE, {});
if (!birthdays || typeof birthdays !== 'object' || Array.isArray(birthdays)) birthdays = {};
if (!birthdayDelivery || typeof birthdayDelivery !== 'object' || Array.isArray(birthdayDelivery)) birthdayDelivery = {};
async function checkDailyBirthdays() {
  if (stopping || birthdayRunning) return;
  const clock = parisClock();
  if (clock.hour < 6 || !ready || !client || !GROUP_ID) return;
  birthdayRunning = true;
  try {
    const matches = Object.values(birthdays).filter(e => e.month_day === clock.monthDay);
    for (const entry of matches) {
      if (stopping || !ready || !client) break;
      const key = `birthday:${clock.date}:${entry.id}`;
      if (birthdayDelivery[key]) continue;
      const message = birthdayMessage(entry);
      try {
        let result;
        let deliveryMode = 'texte';
        if (entry.photo && validBirthdayPhoto(entry.photo)) {
          try {
            const media = new MessageMedia(entry.photo.mimetype, entry.photo.data, 'anniversaire.jpg');
            result = await client.sendMessage(GROUP_ID, media, { caption: message });
            deliveryMode = 'photo';
          } catch (photoError) {
            console.warn('[birthdays] Photo indisponible, repli texte eleve', entry.id, photoError.message);
            result = await client.sendMessage(GROUP_ID, message);
          }
        } else {
          result = await client.sendMessage(GROUP_ID, message);
        }
        birthdayDelivery[key] = { ts: Date.now(), messageId: result?.id?._serialized || null };
        writeJsonAtomic(BIRTHDAY_LOG_FILE, birthdayDelivery);
        console.log('[birthdays] Envoyé', clock.date, 'eleve', entry.id, 'mode=' + deliveryMode);
      } catch (e) {
        console.error('[birthdays] Echec envoi eleve', entry.id, e.message);
      }
    }
  } finally { birthdayRunning = false; }
}
function startBirthdayScheduler() {
  console.log('[birthdays] Planificateur Railway activé (Europe/Paris, dès 06:00)');
  console.log('[birthdays] Message personnalisé:', !!process.env.JJR_BIRTHDAY_MESSAGE, '| photos stockées:', Object.values(birthdays).filter(e => e.photo && validBirthdayPhoto(e.photo)).length);
  birthdayTimer = setInterval(() => checkDailyBirthdays().catch(e => console.error('[birthdays]', e)), 10000);
  checkDailyBirthdays().catch(e => console.error('[birthdays]', e));
}

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
// En-têtes de sécurité pour les réponses de la passerelle.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  next();
});

// Limitation en mémoire des échecs d'authentification par adresse réseau.
// Pas de dépendance supplémentaire, et aucun impact sur les requêtes valides.
const authFailures = new Map();
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 20;
function authBucket(req) {
  // Ne pas faire confiance à un X-Forwarded-For fourni par le client.
  return req.socket.remoteAddress || 'unknown';
}
function authBlocked(req, res) {
  const key = authBucket(req);
  const item = authFailures.get(key);
  if (!item) return false;
  if (Date.now() - item.start >= AUTH_WINDOW_MS) {
    authFailures.delete(key);
    return false;
  }
  if (item.count < AUTH_MAX_FAILURES) return false;
  res.set('Retry-After', String(Math.ceil((AUTH_WINDOW_MS - (Date.now() - item.start)) / 1000)));
  res.status(429).json({ ok: false, error: 'too_many_attempts' });
  return true;
}
function authFailure(req) {
  const key = authBucket(req);
  const now = Date.now();
  const item = authFailures.get(key);
  if (!item || now - item.start >= AUTH_WINDOW_MS) authFailures.set(key, { start: now, count: 1 });
  else item.count++;
  if (authFailures.size > 5000) {
    for (const [k, v] of authFailures) {
      if (now - v.start >= AUTH_WINDOW_MS) authFailures.delete(k);
    }
  }
}
function secretMatches(received, expected) {
  if (!expected || typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function apiAuth(req, res, next) {
  if (authBlocked(req, res)) return;
  if (!secretMatches(req.get('X-JJR-API-Key'), API_KEY)) {
    authFailure(req);
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}
// Accès QR par authentification HTTP Basic (identifiant admin, mot de passe ADMIN_KEY).
// La clé ne figure plus dans l'URL, contrairement à l'ancien paramètre ?key=.
function adminAuth(req, res, next) {
  if (authBlocked(req, res)) return;
  const header = req.get('authorization') || '';
  let username = '', password = '';
  if (header.startsWith('Basic ')) {
    try {
      const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = raw.indexOf(':');
      if (separator !== -1) {
        username = raw.slice(0, separator);
        password = raw.slice(separator + 1);
      }
    } catch (_) {}
  }
  if (username !== 'admin' || !secretMatches(password, ADMIN_KEY)) {
    authFailure(req);
    res.set('WWW-Authenticate', 'Basic realm="JJR WhatsApp QR", charset="UTF-8"');
    return res.status(401).send('Authentification requise');
  }
  next();
}

// Synchronisation sortante PHP -> Railway, protégée par un secret distinct de API_KEY.
app.post('/birthdays/sync', (req, res) => {
  const auth = req.get('authorization') || '';
  if (authBlocked(req, res)) return;
  if (!secretMatches(auth, 'Bearer ' + BIRTHDAY_SYNC_TOKEN) || !BIRTHDAY_SYNC_TOKEN) {
    authFailure(req);
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const body = req.body;
  const bulk = Array.isArray(body?.students) && body?.replace === true;
  const items = bulk ? body.students : [body];
  if (items.length > 10000 || !items.every(validBirthday))
    return res.status(400).json({ ok: false, error: 'invalid_birthday_payload' });
  try {
    const next = bulk ? {} : { ...birthdays };
    for (const item of items) {
      if (item.month_day === null) delete next[item.id];
      else next[item.id] = { id: item.id, prenom: item.prenom.trim(), nom: item.nom.trim(), month_day: item.month_day,
        photo: item.photo === undefined ? (next[item.id]?.photo || null) : item.photo };
    }
    writeJsonAtomic(BIRTHDAY_FILE, next);
    birthdays = next;
    console.log('[birthdays] Synchronisation', bulk ? 'complète' : 'unitaire', 'total', Object.keys(birthdays).length, 'photos=' + Object.values(birthdays).filter(e => e.photo && validBirthdayPhoto(e.photo)).length, 'photoEleve=' + (bulk ? 'lot' : (body.photo === undefined ? 'inchangée' : body.photo ? 'présente' : 'absente')));
    res.json({ ok: true, total: Object.keys(birthdays).length });
    checkDailyBirthdays().catch(e => console.error('[birthdays]', e));
  } catch (e) {
    console.error('[birthdays] Erreur stockage:', e.message);
    res.status(500).json({ ok: false, error: 'storage_failed' });
  }
});
// Test manuel admin : envoi réel au groupe, sans modifier l'historique des anniversaires.
// Même secret que la synchronisation PHP ; limiter les essais pour éviter les abus.
let lastBirthdayTestAt = 0;
app.post('/birthdays/test', async (req, res) => {
  const auth = req.get('authorization') || '';
  if (authBlocked(req, res)) return;
  if (!secretMatches(auth, 'Bearer ' + BIRTHDAY_SYNC_TOKEN) || !BIRTHDAY_SYNC_TOKEN) {
    authFailure(req);
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const id = Number(req.body?.id);
  if (!Number.isSafeInteger(id) || id < 1)
    return res.status(400).json({ ok: false, error: 'invalid_id' });
  const entry = birthdays[id];
  if (!entry) return res.status(404).json({ ok: false, error: 'student_not_synced' });
  if (!TEST_GROUP_ID || TEST_GROUP_ID === GROUP_ID || !TEST_GROUP_ID.endsWith('@g.us'))
    return res.status(503).json({ ok: false, error: 'test_group_not_configured_or_unsafe' });
  if (!ready || !client)
    return res.status(503).json({ ok: false, error: 'whatsapp_not_ready' });
  if (Date.now() - lastBirthdayTestAt < 60000)
    return res.status(429).json({ ok: false, error: 'wait_60_seconds' });
  lastBirthdayTestAt = Date.now();
  console.log('[birthdays/test] Destination groupe test:', TEST_GROUP_ID, '| whatsapp-web.js:', WA_VERSION);

  // Diagnostic en lecture seule : inspecte les API WhatsApp Web sans envoyer de message.
  try {
    const diagnostic = await client.pupPage.evaluate(() => ({
      whatsappVersion: window.Debug?.VERSION || null,
      storeAvailable: !!window.Store,
      chatStoreAvailable: !!window.Store?.Chat,
      chatGetAvailable: typeof window.Store?.Chat?.get,
      chatFindAvailable: typeof window.Store?.Chat?.find,
      widFactoryAvailable: !!window.Store?.WidFactory
    }));
    console.log('[birthdays/test] Diagnostic WhatsApp Web:', JSON.stringify(diagnostic));
  } catch (diagnosticError) {
    console.warn('[birthdays/test] Diagnostic WhatsApp Web échoué:', diagnosticError?.message || diagnosticError);
  }

  const message = '🧪 TEST ANNIVERSAIRE — ' + birthdayMessage(entry);
  try {
    let result, mode = 'texte';
    if (entry.photo && validBirthdayPhoto(entry.photo)) {
      try {
        const media = new MessageMedia(entry.photo.mimetype, entry.photo.data, 'anniversaire-test.jpg');
        result = await client.sendMessage(TEST_GROUP_ID, media, { caption: message });
        mode = 'photo';
      } catch (e) {
        console.warn('[birthdays/test] Envoi image échoué élève', id, e?.stack || e);
        // Essai en tant que document JPEG : contournement possible des erreurs
        // de préparation d'image dans certaines versions de WhatsApp Web.
        try {
          const document = new MessageMedia(entry.photo.mimetype, entry.photo.data, 'anniversaire-test.jpg');
          result = await client.sendMessage(TEST_GROUP_ID, document, {
            caption: message,
            sendMediaAsDocument: true
          });
          mode = 'document';
        } catch (documentError) {
          console.warn('[birthdays/test] Envoi document échoué élève', id, documentError?.stack || documentError);
          result = await client.sendMessage(TEST_GROUP_ID, message);
        }
      }
    } else {
      result = await client.sendMessage(TEST_GROUP_ID, message);
    }
    console.log('[birthdays] TEST envoyé élève', id, 'mode=' + mode);
    return res.json({ ok: true, mode, photoStored: !!entry.photo,
      messageId: result?.id?._serialized || null });
  } catch (e) {
    console.error('[birthdays] TEST erreur élève', id, e.message);
    return res.status(502).json({ ok: false, error: 'send_failed' });
  }
});

// Diagnostic lecture seule : ne declenche aucun message WhatsApp.
// Acces protege par X-JJR-API-Key (meme cle que /groups).
app.get('/birthdays/wa-diagnostic', apiAuth, async (req, res) => {
  if (!ready || !client || !client.pupPage)
    return res.status(503).json({ ok: false, error: 'whatsapp_not_ready' });
  try {
    const diagnostic = await client.pupPage.evaluate((testGroupId) => {
      const out = {
        whatsappVersion: window.Debug?.VERSION || null,
        storeAvailable: !!window.Store,
        requireAvailable: typeof window.require === 'function',
        collectionsAvailable: false,
        chatModels: null,
        testGroupFoundInModels: false,
        testGroupModelIdType: null,
        testGroupModelHasId: false,
        collectionError: null
      };
      try {
        if (typeof window.require === 'function') {
          const collection = window.require('WAWebCollections');
          out.collectionsAvailable = !!collection;
          const models = collection?.Chat?.getModelsArray?.();
          if (Array.isArray(models)) {
            out.chatModels = models.length;
            const group = models.find(chat => {
              const id = chat?.id;
              const serialized = typeof id === 'string' ? id : id?._serialized ||
                (id?.user && id?.server ? `${id.user}@${id.server}` : '');
              return serialized === testGroupId;
            });
            out.testGroupFoundInModels = !!group;
            if (group) {
              out.testGroupModelIdType = typeof group.id;
              out.testGroupModelHasId = !!group.id;
            }
          }
        }
      } catch (e) { out.collectionError = String(e?.message || e).slice(0, 300); }
      return out;
    }, TEST_GROUP_ID);
    console.log('[WA-DIAG] Lecture seule:', JSON.stringify(diagnostic));
    return res.json({ ok: true, diagnostic, whatsappWebJsVersion: WA_VERSION,
      testGroupConfigured: !!TEST_GROUP_ID, testGroupDifferentFromOfficial: !!TEST_GROUP_ID && TEST_GROUP_ID !== GROUP_ID });
  } catch (e) {
    console.error('[WA-DIAG] Echec:', e?.message || e);
    return res.status(500).json({ ok: false, error: 'diagnostic_failed' });
  }
});

app.get('/birthdays/status', apiAuth, (req, res) => {
  const clock = parisClock();
  res.json({ ok: true, date: clock.date, parisHour: clock.hour,
    students: Object.keys(birthdays).length,
    photos: Object.values(birthdays).filter(e => e.photo && validBirthdayPhoto(e.photo)).length,
    messageCustomized: !!process.env.JJR_BIRTHDAY_MESSAGE,
    today: Object.values(birthdays).filter(e => e.month_day === clock.monthDay).length,
    sentToday: Object.keys(birthdayDelivery).filter(k => k.startsWith('birthday:' + clock.date + ':')).length,
    whatsappReady: ready });
});

app.get('/', (req, res) => res.json({ ok: true }));
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
    console.log('[GROUPS] Diagnostic brut WAWebCollections (sans getChatModel)');
    const diagnostic = await client.pupPage.evaluate(() => {
      const collection = window.require('WAWebCollections');
      const chats = collection.Chat.getModelsArray();
      const groups = chats.map(chat => {
        const rawId = chat.id;
        const id = typeof rawId === 'string' ? rawId
          : (rawId?._serialized || (rawId?.user && rawId?.server ? `${rawId.user}@${rawId.server}` : ''));
        return {
          id,
          name: chat.name || chat.formattedTitle || '',
          isGroup: Boolean(chat.groupMetadata) || id.endsWith('@g.us')
        };
      }).filter(chat => chat.isGroup && chat.id)
        .map(({ id, name }) => ({ id, name }));
      return { total: chats.length, groups };
    });
    console.log('[GROUPS] Diagnostic brut:', JSON.stringify(diagnostic));
    return res.json({ ok: true, ...diagnostic });
  } catch (e) {
    console.error('[GROUPS] ERREUR DIAGNOSTIC BRUT:', e?.stack || e);
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
  if (birthdayTimer) clearInterval(birthdayTimer);
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
  startBirthdayScheduler();
  startWhatsApp().catch(e => console.error('[WA] Erreur de démarrage:', e));
});
