/**
 * APX-PHANTOM V2.3 - STABILITY OVERHAUL
 * Fixes: Multiple Pairing Codes, Railway Sleep, & Persistent Sessions
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
const pairingLocks = new Map(); // NEW: Prevents multiple code requests

let ctx_chat_id;

// --- 1. RAILWAY WAKE-LOCK SERVER ---
http.createServer((req, res) => {
    res.writeHead(200);
    res.end("APX-PHANTOM RUNNING");
}).listen(process.env.PORT || 8080);

async function startPhantom(phoneNumber, forceReset = false) {
    const sessionDir = `./phantom_sessions/${phoneNumber}`;

    if (forceReset) {
        if (phantomSessions.has(phoneNumber)) {
            try { phantomSessions.get(phoneNumber).end(); } catch (e) {}
        }
        phantomSessions.delete(phoneNumber);
        isConnected.delete(phoneNumber);
        pairingLocks.delete(phoneNumber);
        fs.removeSync(sessionDir);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 20000 // Very aggressive to stop sleeping
    });

    phantomSessions.set(phoneNumber, sock);

    // --- 2. SMART PAIRING LOGIC (Single Code Guarantee) ---
    if (!sock.authState.creds.registered && !pairingLocks.has(phoneNumber)) {
        pairingLocks.set(phoneNumber, true); // Lock it immediately
        
        setTimeout(async () => {
            try {
                if (!sock.authState.creds.registered) {
                    const code = await sock.requestPairingCode(phoneNumber);
                    if (ctx_chat_id) bot.telegram.sendMessage(ctx_chat_id, `👻 *PHANTOM CODE:* \`${code}\``);
                }
            } catch (err) {
                pairingLocks.delete(phoneNumber); // Unlock on error so user can retry
            }
        }, 6000); // Shorter wait for better response
    }

    let currentStateIndex = 0;
    const states = ['composing', 'recording', 'recording']; 

    const rotatePresence = async () => {
        if (!isConnected.get(phoneNumber)) return;
        try {
            await sock.sendPresenceUpdate(states[currentStateIndex], 'status@broadcast');
            currentStateIndex = (currentStateIndex + 1) % states.length;
        } catch (e) {}
    };

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect } = u;
        
        if (connection === 'open') {
            isConnected.set(phoneNumber, true);
            pairingLocks.delete(phoneNumber); // Clear lock once successful
            
            if (!notifiedOnline.get(phoneNumber)) {
                if (ctx_chat_id) bot.telegram.sendMessage(ctx_chat_id, `✅ PHANTOM ONLINE: ${phoneNumber}\nRotation: Active 🔄`);
                notifiedOnline.set(phoneNumber, true); 
            }

            if (heartbeats.has(phoneNumber)) clearInterval(heartbeats.get(phoneNumber));
            heartbeats.set(phoneNumber, setInterval(() => rotatePresence(), 8000));
        }

        if (connection === 'close') {
            isConnected.set(phoneNumber, false);
            notifiedOnline.set(phoneNumber, false);
            if (heartbeats.has(phoneNumber)) clearInterval(heartbeats.get(phoneNumber));
            
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && phantomSessions.has(phoneNumber)) {
                setTimeout(() => startPhantom(phoneNumber), 5000);
            } else {
                phantomSessions.delete(phoneNumber);
                pairingLocks.delete(phoneNumber);
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

// --- 3. COMMAND CENTER ---
bot.on('text', async (ctx) => {
    ctx_chat_id = ctx.chat.id;
    const text = ctx.message.text.trim();

    if (text.startsWith('/add_')) {
        const num = text.split('_')[1].replace(/\D/g, '');
        if (isConnected.get(num)) return ctx.reply("⚠️ This phantom is already live!");
        
        ctx.reply(`🚀 Preparing connection for ${num}...`);
        startPhantom(num, true); // Always force fresh start on new add
    }

    if (text.startsWith('/remove_')) {
        const num = text.split('_')[1].replace(/\D/g, '');
        if (phantomSessions.has(num)) {
            const sock = phantomSessions.get(num);
            try { sock.logout(); } catch (e) {}
            
            if (heartbeats.has(num)) clearInterval(heartbeats.get(num));
            
            phantomSessions.delete(num);
            isConnected.delete(num);
            pairingLocks.delete(num);
            fs.removeSync(`./phantom_sessions/${num}`);
            
            ctx.reply(`🛑 Session Nuked: ${num}\nYou can now re-add if needed.`);
        } else {
            ctx.reply("❌ Number not found in active list.");
        }
    }

    if (text === '/list') {
        let res = "📑 *CURRENT PHANTOMS:*\n\n";
        phantomSessions.forEach((_, num) => {
            res += `${isConnected.get(num) ? '🟢' : '🟡'} ${num}\n`;
        });
        ctx.replyWithMarkdown(res === "📑 *CURRENT PHANTOMS:*\n\n" ? "No active phantoms." : res);
    }
});

bot.launch();
console.log("🪬 APX-PHANTOM V2.3 - ULTRA STABLE");

