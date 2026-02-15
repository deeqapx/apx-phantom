/**
 * APX-PHANTOM V2.0 - CONTROL & ROTATION
 * Logic: Typing -> Audio -> Video (Permanent Loop)
 * Added: /remove_[number] to kill specific sessions
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

const phantomSessions = new Map(); // Stores Socket
const isConnected = new Map();     // Stores Online Status
const notifiedOnline = new Map(); // Stores TG Notification Gate
const heartbeats = new Map();     // Stores presence intervals for removal

let ctx_chat_id;

async function startPhantom(phoneNumber) {
    // If a session already exists, don't start a duplicate
    if (phantomSessions.has(phoneNumber)) return;

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

    let currentStateIndex = 0;
    const states = ['composing', 'recording', 'recording']; 

    const rotatePresence = async () => {
        if (!isConnected.get(phoneNumber)) return;
        try {
            // Cycle: Typing -> Audio -> Video (Recording handles both Audio/Video notes in WA)
            await sock.sendPresenceUpdate(states[currentStateIndex], 'status@broadcast');
            currentStateIndex = (currentStateIndex + 1) % states.length;
        } catch (e) {}
    };

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect } = u;
        
        if (connection === 'open') {
            isConnected.set(phoneNumber, true);
            if (!notifiedOnline.get(phoneNumber)) {
                if (ctx_chat_id) bot.telegram.sendMessage(ctx_chat_id, `✅ PHANTOM ONLINE: ${phoneNumber}\nRotation: ON 🔄`);
                notifiedOnline.set(phoneNumber, true); 
            }

            // Start & store interval so we can kill it later
            if (heartbeats.has(phoneNumber)) clearInterval(heartbeats.get(phoneNumber));
            const interval = setInterval(() => rotatePresence(), 8000);
            heartbeats.set(phoneNumber, interval);
        }

        if (connection === 'close') {
            isConnected.set(phoneNumber, false);
            notifiedOnline.set(phoneNumber, false);
            if (heartbeats.has(phoneNumber)) {
                clearInterval(heartbeats.get(phoneNumber));
                heartbeats.delete(phoneNumber);
            }
            
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            // Only reconnect if the session wasn't manually removed
            if (shouldReconnect && phantomSessions.has(phoneNumber)) {
                setTimeout(() => startPhantom(phoneNumber), 5000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

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
        if (phantomSessions.has(num)) return ctx.reply("⚠️ This number is already active!");
        ctx.reply(`🚀 Deploying Shapeshifter for ${num}...`);
        startPhantom(num);
    }

    if (text.startsWith('/remove_')) {
        const num = text.split('_')[1].replace(/\D/g, '');
        if (phantomSessions.has(num)) {
            const sock = phantomSessions.get(num);
            isConnected.set(num, false);
            
            // Clean up heartbeat
            if (heartbeats.has(num)) {
                clearInterval(heartbeats.get(num));
                heartbeats.delete(num);
            }

            // Close connection & remove from maps
            sock.logout(); 
            phantomSessions.delete(num);
            ctx.reply(`🛑 Phantom Stopped & Session Cleared: ${num}`);
        } else {
            ctx.reply("❌ That number is not active.");
        }
    }
});

bot.launch();
console.log("🪬 APX-PHANTOM V2.0 - COMMAND CENTER LIVE");

