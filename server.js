const express=require('express');
const QRCode=require('qrcode');
const fs=require('fs');
const path=require('path');
const {Client,LocalAuth}=require('whatsapp-web.js');

const PORT=Number(process.env.PORT||3000);
const API_KEY=process.env.API_KEY||'';
const ADMIN_KEY=process.env.ADMIN_KEY||'';
const GROUP_ID=process.env.WHATSAPP_GROUP_ID||'';
const SESSION_PATH=process.env.SESSION_PATH||'/data/whatsapp';
const STATE_DIR=process.env.STATE_PATH||'/data/state';
const SENT_FILE=path.join(STATE_DIR,'sent.json');

fs.mkdirSync(SESSION_PATH,{recursive:true});
fs.mkdirSync(STATE_DIR,{recursive:true});
let sent={};
try{sent=JSON.parse(fs.readFileSync(SENT_FILE,'utf8'))}catch{}
function saveSent(){fs.writeFileSync(SENT_FILE,JSON.stringify(sent,null,2))}
function prune(){
 const cutoff=Date.now()-90*86400000;
 for(const [k,v] of Object.entries(sent)) if((v.ts||0)<cutoff) delete sent[k];
 saveSent();
}
prune();

let ready=false, lastQr=null, lastQrAt=null;
const client=new Client({
 authStrategy:new LocalAuth({clientId:'jjr',dataPath:SESSION_PATH}),
 puppeteer:{
   executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',
   headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
 }
});
client.on('qr',q=>{lastQr=q;lastQrAt=new Date().toISOString();ready=false});
client.on('authenticated',()=>{});
client.on('ready',()=>{ready=true;lastQr=null;console.log('WhatsApp READY')});
client.on('disconnected',r=>{ready=false;console.log('Disconnected',r)});

const app=express();
app.use(express.json({limit:'128kb'}));
function apiAuth(req,res,next){
 if(!API_KEY || req.get('X-JJR-API-Key')!==API_KEY) return res.status(401).json({ok:false,error:'unauthorized'});
 next();
}
function adminAuth(req,res,next){
 if(!ADMIN_KEY || req.query.key!==ADMIN_KEY) return res.status(401).send('Unauthorized');
 next();
}

app.get('/',(req,res)=>res.json({service:'JJR WhatsApp Gateway',ok:true,whatsappReady:ready}));
app.get('/health',apiAuth,(req,res)=>res.json({ok:true,whatsappReady:ready,groupConfigured:!!GROUP_ID,lastQrAt}));
app.get('/qr',adminAuth,async(req,res)=>{
 if(ready) return res.send('<h2>WhatsApp est déjà connecté.</h2>');
 if(!lastQr) return res.send('<h2>QR pas encore disponible. Rechargez dans quelques secondes.</h2>');
 const data=await QRCode.toDataURL(lastQr,{width:360});
 res.send(`<meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;text-align:center;background:#111;color:#fff"><h2>Connexion WhatsApp JJR</h2><img src="${data}"><p>WhatsApp → Appareils connectés → Connecter un appareil</p></body>`);
});
app.get('/groups', apiAuth, async (req, res) => {
    if (!ready) {
        return res.status(503).json({
            ok: false,
            error: 'whatsapp_not_ready'
        });
    }

    try {
        console.log('[GROUPS] Récupération des groupes...');

        const chats = await client.getChats();

        const groups = chats
            .filter(chat => chat.isGroup)
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name
            }));

        console.log('[GROUPS] Groupes trouvés :', groups.length);

        res.json({
            ok: true,
            groups
        });

    } catch (e) {
        console.error('[GROUPS] ERREUR :', e);
        console.error('[GROUPS] STACK :', e?.stack);

        res.status(500).json({
            ok: false,
            error: String(e?.message || e),
            type: e?.name || 'UnknownError'
        });
    }
});
app.post('/send',apiAuth,async(req,res)=>{
 const notificationId=String(req.body?.notification_id||'').trim();
 const message=String(req.body?.message||'').trim();
 if(!notificationId||!message) return res.status(400).json({ok:false,error:'notification_id_and_message_required'});
 if(sent[notificationId]) return res.json({ok:true,duplicate:true,messageId:sent[notificationId].messageId});
 if(!GROUP_ID) return res.status(503).json({ok:false,error:'group_not_configured'});
 if(!ready) return res.status(503).json({ok:false,error:'whatsapp_not_ready'});
 try{
   const m=await client.sendMessage(GROUP_ID,message);
   const messageId=m?.id?._serialized||null;
   sent[notificationId]={messageId,ts:Date.now()};
   saveSent();
   res.json({ok:true,duplicate:false,messageId});
 }catch(e){res.status(500).json({ok:false,error:e.message})}
});
app.listen(PORT,'0.0.0.0',()=>{console.log('Gateway on',PORT);client.initialize()});
