/**
 * APX-PHANTOM V1.9 - STABILIZED SHAPESHIFTER
 * Redesign: Spam-lock for TG & Clean Handshake
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
const notifiedOnline = new Map(); // GATEKEEPER: Prevents TG spam
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

    // --- PAIRING LOGIC (With Guard) ---
    if (!sock.authState.creds.registered) {
        let hasRequested = false;
        sock.ev.on('connection.update', async (up) => {
            if (up.connection === 'connecting' && !hasRequested) {
                hasRequested = true;
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(phoneNumber);
                        if (ctx_chat_id) bot.telegram.sendMessage(ctx_chat_id, `👻 *PHANTOM CODE:* \`${code}\``);
                    } catch { hasRequested = false; }
                }, 10000);
            }
        });
    }

    // --- PRESENCE ROTATION ENGINE ---
    let currentStateIndex = 0;
    const states = ['composing', 'recording', 'recording']; 

    const rotatePresence = async (jid = 'status@broadcast') => {
        if (!isConnected.get(phoneNumber)) return;
        try {
            await sock.sendPresenceUpdate(states[currentStateIndex], jid);
            currentStateIndex = (currentStateIndex + 1) % states.length;
        } catch (e) {
            currentStateIndex = (currentStateIndex + 1) % states.length;
        }
    };

    let heartbeat;

    // --- CONNECTION HANDLER (REDESIGNED) ---
    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect } = u;
        
        if (connection === 'open') {
            isConnected.set(phoneNumber, true);
            
            // Notification Gate: Only send the "Online" message once per session
            if (!notifiedOnline.get(phoneNumber)) {
                if (ctx_chat_id) {
                    bot.telegram.sendMessage(ctx_chat_id, `✅ PHANTOM ONLINE: ${phoneNumber}\nPresence Rotation: Active 🔄`);
                }
                notifiedOnline.set(phoneNumber, true); 
            }

            if (heartbeat) clearInterval(heartbeat);
            heartbeat = setInterval(() => rotatePresence(), 8000);
        }

        if (connection === 'close') {
            isConnected.set(phoneNumber, false);
            notifiedOnline.set(phoneNumber, false); // Reset gate for real reconnects
            if (heartbeat) clearInterval(heartbeat);
            
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                // Wait 5s to prevent reconnect spam loops
                setTimeout(() => startPhantom(phoneNumber), 5000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // --- REACTIVE VISIBILITY ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
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
console.log("🪬 APX-PHANTOM V1.9 - STABILIZED LIVE");

