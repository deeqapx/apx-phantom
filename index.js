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

// --- 1. WAKE-LOCK (STOPS RAILWAY FROM SLEEPING) ---
http.createServer((req, res) => {
    res.write("PHANTOM STATUS: ACTIVE");
    res.end();
}).listen(process.env.PORT || 8080);

async function startPhantom(phoneNumber, forceReset = false) {
    const sessionDir = `./phantom_sessions/${phoneNumber}`;

    // --- 2. DEEP CLEANER LOGIC ---
    if (forceReset || (phantomSessions.has(phoneNumber) && !isConnected.get(phoneNumber))) {
        try {
            if (phantomSessions.has(phoneNumber)) {
                phantomSessions.get(phoneNumber).end();
            }
        } catch (e) {}
        phantomSessions.delete(phoneNumber);
        isConnected.delete(phoneNumber);
        fs.removeSync(sessionDir); 
    }

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
        keepAliveIntervalMs: 30000 // Keep connection hot
    });

    phantomSessions.set(phoneNumber, sock);

    // --- 3. PAIRING LOGIC ---
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                if (!sock.authState.creds.registered) {
                    const code = await sock.requestPairingCode(phoneNumber);
                    if (ctx_chat_id) bot.telegram.sendMessage(ctx_chat_id, `👻 *PHANTOM CODE:* \`${code}\``);
                }
            } catch (err) {
                phantomSessions.delete(phoneNumber);
            }
        }, 10000);
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
            if (!notifiedOnline.get(phoneNumber)) {
                if (ctx_chat_id) bot.telegram.sendMessage(ctx_chat_id, `✅ PHANTOM ONLINE: ${phoneNumber}`);
                notifiedOnline.set(phoneNumber, true); 
            }
            if (heartbeats.has(phoneNumber)) clearInterval(heartbeats.get(phoneNumber));
            heartbeats.set(phoneNumber, setInterval(() => rotatePresence(), 8000));
        }
        if (connection === 'close') {
            isConnected.set(phoneNumber, false);
            notifiedOnline.set(phoneNumber, false);
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && phantomSessions.has(phoneNumber)) {
                setTimeout(() => startPhantom(phoneNumber), 5000);
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

// --- 4. COMMAND CENTER ---
bot.on('text', async (ctx) => {
    ctx_chat_id = ctx.chat.id;
    const text = ctx.message.text.trim();

    if (text.startsWith('/add_')) {
        const num = text.split('_')[1].replace(/\D/g, '');
        const isStuck = phantomSessions.has(num) && !isConnected.get(num);
        if (phantomSessions.has(num) && isConnected.get(num)) return ctx.reply("⚠️ Active!");
        ctx.reply(`🚀 Deploying for ${num}...`);
        startPhantom(num, isStuck);
    }

    if (text.startsWith('/remove_')) {
        const num = text.split('_')[1].replace(/\D/g, '');
        if (phantomSessions.has(num)) {
            try { phantomSessions.get(num).logout(); } catch (e) {}
            phantomSessions.delete(num);
            isConnected.delete(num);
            fs.removeSync(`./phantom_sessions/${num}`);
            ctx.reply(`🛑 Removed: ${num}`);
        }
    }

    if (text === '/list') {
        let list = "📑 *PHANTOM SESSIONS:*\n\n";
        phantomSessions.forEach((_, num) => {
            const status = isConnected.get(num) ? "🟢 Online" : "🔴 Stuck/Connecting";
            list += `👤 ${num}: ${status}\n`;
        });
        ctx.replyWithMarkdown(list || "No active sessions.");
    }
});

bot.launch();
console.log("🪬 APX-PHANTOM V2.2 - FULLY STABILIZED");

