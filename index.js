/**
 * APX-PHANTOM V1.8 - PERPETUAL PRESENCE ROTATION
 * Logic: Typing -> Recording Audio -> Recording Video (Cycle on failure/timeout)
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const { Telegraf } = require('telegraf');
const pino = require("pino");
const fs = require('fs-extra');

const TG_TOKEN = '8015795143:AAECh4S2Qf-aCPow05A8Fo9cM6tuFdMkpgY';
const bot = new Telegraf(TG_TOKEN);
const phantomSessions = new Map();
const isConnected = new Map();
let ctx_chat_id;

async function startPhantom(phoneNumber) {
    const sessionDir = `./phantom_sessions/${phoneNumber}`;
    await fs.ensureDir(sessionDir);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        markOnlineOnConnect: true
    });

    phantomSessions.set(phoneNumber, sock);

    // --- PRESENCE ROTATION ENGINE ---
    let currentStateIndex = 0;
    const states = ['composing', 'recording', 'recording']; // Baileys uses 'recording' for both audio/video context
    
    const rotatePresence = async (jid = 'status@broadcast') => {
        if (!isConnected.get(phoneNumber)) return;
        
        try {
            const mode = states[currentStateIndex];
            await sock.sendPresenceUpdate(mode, jid);
            
            // Cycle logic
            currentStateIndex = (currentStateIndex + 1) % states.length;
        } catch (e) {
            console.log("Presence cycle rotation triggered due to socket lag.");
            // If it "crashes" or fails, move to next state immediately
            currentStateIndex = (currentStateIndex + 1) % states.length;
        }
    };

    let heartbeat;

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === 'open') {
            isConnected.set(phoneNumber, true);
            if (ctx_chat_id) bot.telegram.sendMessage(ctx_chat_id, `✅ PHANTOM ONLINE: ${phoneNumber}\nPresence Rotation: Active 🔄`);
            
            if (heartbeat) clearInterval(heartbeat);
            heartbeat = setInterval(() => rotatePresence(), 8000);
        }
        if (connection === 'close') {
            isConnected.set(phoneNumber, false);
            if (heartbeat) clearInterval(heartbeat);
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                startPhantom(phoneNumber);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // --- REACTIVE VISIBILITY ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
            // When someone texts, hit them with the current rotation state immediately
            try {
                await sock.sendPresenceUpdate(states[currentStateIndex], msg.key.remoteJid);
            } catch (e) {}
        }
    });
}

bot.on('text', async (ctx) => {
    ctx_chat_id = ctx.chat.id;
    const text = ctx.message.text.trim();
    if (text.startsWith('/add_')) {
        const num = text.split('_')[1].replace(/\D/g, '');
        ctx.reply(`🚀 Deploying Shapeshifter Phantom for ${num}...`);
        startPhantom(num);
    }
});

bot.launch();
console.log("🪬 APX-PHANTOM V1.8 - SHAPESHIFTER LIVE");

