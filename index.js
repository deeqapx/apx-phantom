/**
 * APX-PHANTOM V2.1 - RAILWAY & WAKE-LOCK EDITION
 * Fixes: Sleeping sessions, Stuck /add command, and Handshake loops.
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
const http = require('http');

const TG_TOKEN = '8015795143:AAECh4S2Qf-aCPow05A8Fo9cM6tuFdMkpgY';
const bot = new Telegraf(TG_TOKEN);

const phantomSessions = new Map();
const isConnected = new Map();
const notifiedOnline = new Map();
const heartbeats = new Map();

let ctx_chat_id;

// --- RAILWAY WAKE-LOCK SERVER ---
// Railway puts apps to sleep if they don't have a web port open.
http.createServer((req, res) => {
    res.write("APX-PHANTOM IS ALIVE");
    res.end();
}).listen(process.env.PORT || 8080);

async function startPhantom(phoneNumber) {
    // If it exists but NOT connected, allow it to try again
    if (phantomSessions.has(phoneNumber) && isConnected.get(phoneNumber)) return;

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
        markOnlineOnConnect: true,
        // ENHANCEMENT: Aggressive keep-alive for Railway
        keepAliveIntervalMs: 30000,
        mobile: false
    });

    phantomSessions.set(phoneNumber, sock);

    // --- PAIRING CODE LOGIC (AUTO-RESET ON FAIL) ---
    if (!sock.authState.creds.registered) {
        let hasRequested = false;
        sock.ev.on('connection.update', async (up) => {
            const { connection } = up;
            if (connection === 'connecting' && !hasRequested) {
                hasRequested = true;
                setTimeout(async () => {
                    try {
                        // If still not registered after delay, ask for code
                        if (!sock.authState.creds.registered) {
                            const code = await sock.requestPairingCode(phoneNumber);
                            if (ctx_chat_id) bot.telegram.sendMessage(ctx_chat_id, `👻 *PHANTOM CODE:* \`${code}\``);
                        }
                    } catch (err) {
                        hasRequested = false; // Reset so user can try /add again
                    }
                }, 10000);
            }
        });
    }

    let currentStateIndex = 0;
    const states = ['composing', 'recording', 'recording']; 

    const rotatePresence = async () => {
        if (!isConnected.get(phoneNumber)) return;
        try {
            await sock.sendPresenceUpdate(states[currentStateIndex], 'status@broadcast');
            currentStateIndex = (currentStateIndex + 1) % states.length;
        } catch (e) {
            // If presence fails, the socket might be dead
            isConnected.set(phoneNumber, false);
        }
    };

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect } = u;
        
        if (connection === 'open') {
            isConnected.set(phoneNumber, true);
            if (!notifiedOnline.get(phoneNumber)) {
                if (ctx_chat_id) bot.telegram.sendMessage(ctx_chat_id, `✅ PHANTOM ONLINE: ${phoneNumber}`);
                notifiedOnline.set(phoneNumber, true); 
            }
            if (heartbeats.has(phoneNumber)) clearInterval(heartbeats.get(phoneNumber));
            const interval = setInterval(() => rotatePresence(), 8000);
            heartbeats.set(phoneNumber, interval);
        }

        if (connection === 'close') {
            isConnected.set(phoneNumber, false);
            notifiedOnline.set(phoneNumber, false);
            if (heartbeats.has(phoneNumber)) clearInterval(heartbeats.get(phoneNumber));
            
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect && phantomSessions.has(phoneNumber)) {
                // Cleanup before reconnecting
                setTimeout(() => startPhantom(phoneNumber), 5000);
            } else {
                // If logged out or fatal, clear from maps so /add works again
                phantomSessions.delete(phoneNumber);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
            try { await sock.sendPresenceUpdate(states[currentStateIndex], msg.key.remoteJid); } catch (e) {}
        }
    });
}

bot.on('text', async (ctx) => {
    ctx_chat_id = ctx.chat.id;
    const text = ctx.message.text.trim();

    if (text.startsWith('/add_')) {
        const num = text.split('_')[1].replace(/\D/g, '');
        
        // If it's stuck in a non-connected state, clear it
        if (phantomSessions.has(num) && !isConnected.get(num)) {
            phantomSessions.delete(num);
        }

        if (phantomSessions.has(num)) return ctx.reply("⚠️ This number is already active!");
        
        ctx.reply(`🚀 Deploying Shapeshifter for ${num}...`);
        startPhantom(num);
    }

    if (text.startsWith('/remove_')) {
        const num = text.split('_')[1].replace(/\D/g, '');
        if (phantomSessions.has(num)) {
            const sock = phantomSessions.get(num);
            isConnected.set(num, false);
            if (heartbeats.has(num)) clearInterval(heartbeats.get(num));
            
            try { sock.logout(); } catch (e) {}
            phantomSessions.delete(num);
            fs.removeSync(`./phantom_sessions/${num}`); // Clear data on manual removal
            ctx.reply(`🛑 Session Cleared: ${num}`);
        } else {
            ctx.reply("❌ Number not found.");
        }
    }
});

bot.launch();
console.log("🪬 APX-PHANTOM V2.1 - RAILWAY ENHANCED");

