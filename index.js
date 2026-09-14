// --- Web Crypto polyfill ---
// @whiskeysockets/baileys expects a global `crypto` (Web Crypto API) to be
// present, but Node 18 does not expose it as a global by default (only
// Node 19+ does automatically). Without this, pairing-code generation
// throws "ReferenceError: crypto is not defined" from deep inside
// Baileys' internals and the socket loops connecting/closing forever.
// This must run before Baileys is required.
const nodeCrypto = require('crypto');
if (!globalThis.crypto) {
    globalThis.crypto = nodeCrypto.webcrypto;
}

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const figlet = require('figlet');

const app = express();
const PORT = process.env.PORT || 3000;
// On Railway, container disk is wiped on every redeploy/restart unless a
// Volume is attached and mounted at a path (Railway sets this in
// RAILWAY_VOLUME_MOUNT_PATH when a volume exists). If a volume is present we
// store the session there so re-pairing isn't required after every deploy;
// otherwise we fall back to local disk (fine for dev, but will require
// re-pairing on Railway restarts without a volume).
const SESSION_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const OWNER_NUMBER = ((process.env.OWNER_NUMBER || '94752120756').replace(/[^0-9]/g, '')) || '94752120756';
const BOT_NAME = 'MADUSHANKA MD';
const OWNER_NAME = 'Madushanka Dev';
const BOT_LOGO_PATH = path.join(__dirname, 'public', 'logo.jpg');
const getBotLogo = () => { try { return fs.readFileSync(BOT_LOGO_PATH); } catch (e) { return null; } };
const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb89retDjiOduGm51n1g';
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR, { maxAge: '7d', etag: true }));

// ---- Multi-Session Bot Manager ----
// Each browser that opens the pairing page gets its own WhatsApp session, so
// any number of bots can be paired concurrently from the same deployment.
// sessionId -> { sock, isConnected, currentQR, reconnectAttempts, reconnectTimer,
//                pairingInProgress, sessionDir, createdAt }
const sessions = new Map();
const MAX_RECONNECT_DELAY_MS = 60000; // cap backoff at 60s
const startTime = Date.now();

function newSessionId() {
    return nodeCrypto.randomBytes(6).toString('hex');
}
function getSession(id) {
    return id ? sessions.get(id) : undefined;
}
function activeBotCount() {
    let n = 0;
    for (const s of sessions.values()) if (s.isConnected) n++;
    return n;
}

// In-memory (non-persistent) per-group settings — reset on restart.
// Fine for toggles like antilink/warn counts; not meant as a database.
const groupSettings = {}; // jid -> { antilink: bool, rules: string, warns: { participantJid: count } }
function getGroupSettings(jid) {
    if (!groupSettings[jid]) groupSettings[jid] = { antilink: false, rules: '', warns: {} };
    return groupSettings[jid];
}
// Auto Status View/React default — applied per-session below so every bot
// that gets paired through this deployment has it ON out of the box,
// independently of any other bot paired on the same server.
const AUTO_STATUS_DEFAULT = { view: true, react: true, emoji: '💚' };

// ---- Web Pairing Portal ----
// Serve the pairing portal (static file — see public/pair.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'pair.html'));
});

// Creates a brand-new bot session so a new device/browser can pair its own
// WhatsApp number without disturbing any bot that's already connected.
app.post('/api/new-session', async (req, res) => {
    try {
        const id = newSessionId();
        await startBotSession(id);
        res.json({ sessionId: id });
    } catch (e) {
        console.log('Error creating session:', e);
        res.status(500).json({ error: 'Failed to create a new session.' });
    }
});

// Live count of currently-connected bots + total sessions ever started this run.
app.get('/api/stats', (req, res) => {
    res.json({ active: activeBotCount(), total: sessions.size });
});

app.get('/health', (req, res) => {
    const s = getSession(req.query.session);
    if (!s) return res.json({ status: 'ok', connected: false, exists: false });
    res.json({ status: 'ok', connected: s.isConnected, exists: true });
});

app.get('/qr', async (req, res) => {
    const s = getSession(req.query.session);
    if (!s) return res.status(404).json({ error: 'Session not found. Refresh the page to start a new one.' });
    if (s.isConnected) return res.status(404).json({ error: 'Bot is already connected!' });
    if (!s.currentQR) return res.status(404).json({ error: 'No QR available yet. Try again in a few seconds.' });
    try {
        const buffer = await QRCode.toBuffer(s.currentQR, { width: 320, margin: 1 });
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(buffer);
    } catch (e) {
        res.status(500).json({ error: 'Failed to render QR code.' });
    }
});

app.get('/code', async (req, res) => {
    const s = getSession(req.query.session);
    const phoneNumber = req.query.phone;
    if (!phoneNumber) return res.json({ error: 'Phone number is required!' });
    if (!s) return res.json({ error: 'Session not found. Refresh the page to start a new one.' });
    if (s.isConnected) return res.json({ error: 'Bot is already connected!' });
    if (s.pairingInProgress) return res.json({ error: 'A pairing request is already in progress. Please wait.' });
    if (!s.sock) return res.json({ error: 'Bot socket is not ready yet. Try again in a few seconds.' });

    s.pairingInProgress = true;
    try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (!cleanNumber) return res.json({ error: 'Invalid phone number.' });
        if (s.sock.authState.creds.registered) return res.json({ error: 'Number already registered!' });

        let code = await s.sock.requestPairingCode(cleanNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        const masked = cleanNumber.slice(0, -4).replace(/./g, '*') + cleanNumber.slice(-4);
        console.log(`🔑 Pairing code issued for ${masked} at ${new Date().toISOString()}: ${code}`);
        res.json({ code });
    } catch (err) {
        console.log('Error generating pairing code:', err);
        res.json({ error: 'Error generating code. Try again!' });
    } finally {
        s.pairingInProgress = false;
    }
});

// =========================================================================
// Helpers
// =========================================================================
function safeCalculate(expression) {
    const sanitized = expression.replace(/\s+/g, '');
    if (!/^[0-9+\-*/().%]+$/.test(sanitized)) throw new Error('Invalid characters in expression');
    if (sanitized.length > 100) throw new Error('Expression too long');
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${sanitized});`)();
    if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('Invalid result');
    return result;
}
function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${d}d ${h}h ${m}m ${sec}s`;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function genPassword(len = 12) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let out = '';
    for (let i = 0; i < len; i++) out += chars[randInt(0, chars.length - 1)];
    return out;
}

// =========================================================================
// Static content banks
// =========================================================================
const QUOTES = [
    'Success is not final; failure is not fatal: It is the courage to continue that counts.',
    'Code is like humor. When you have to explain it, it’s bad.',
    'Stay focused, work hard, and make it happen!',
    'The only way to do great work is to love what you do.',
    'Don’t watch the clock; do what it does. Keep going.'
];
const JOKES = [
    'Why do programmers prefer dark mode? Because light attracts bugs! 🐛',
    'There are 10 types of people in the world: those who understand binary, and those who don\'t.',
    'Why did the developer go broke? Because he used up all his cache.',
    'I would tell you a UDP joke, but you might not get it.',
    'A SQL query walks into a bar, walks up to two tables and asks: "Can I join you?"'
];
const FACTS = [
    'Honey never spoils — archaeologists have found 3000-year-old honey that’s still edible.',
    'Bananas are berries, but strawberries aren’t.',
    'A day on Venus is longer than a year on Venus.',
    'Octopuses have three hearts and blue blood.',
    'The first computer bug was an actual moth stuck in a relay in 1947.'
];
const CATFACTS = [
    'Cats spend 70% of their lives sleeping.',
    'A group of cats is called a clowder.',
    'Cats can\'t taste sweetness.'
];
const DOGFACTS = [
    'A dog\'s nose print is unique, like a human fingerprint.',
    'Puppies are born deaf, blind, and toothless.',
    'Dogs have three eyelids.'
];
const RIDDLES = [
    { q: 'What has keys but no locks, space but no room, and you can enter but not go in?', a: 'A keyboard' },
    { q: 'The more you take, the more you leave behind. What am I?', a: 'Footsteps' },
    { q: 'What has a head, a tail, is brown, and has no legs?', a: 'A penny' }
];
const WISDOM = [
    'A smooth sea never made a skilled sailor.',
    'Fall seven times, stand up eight.',
    'The best time to plant a tree was 20 years ago. The second best time is now.'
];
const PROVERBS = [
    'Actions speak louder than words.',
    'Where there’s a will, there’s a way.',
    'A bird in hand is worth two in the bush.'
];
const ROASTS = [
    'You bring everyone so much joy... when you leave the room. 😏',
    'You\'re not stupid, you just have bad luck thinking. 😂'
];
const PRAISES = [
    'You\'re doing amazing, keep shining! ✨',
    'Your energy today is unmatched! 🔥'
];
const COMPLIMENTS = [
    'You have a great sense of humor! 😄',
    'You\'re one of a kind! 🌟'
];
const TRUTHS = [
    'What is your biggest fear?',
    'What is the most embarrassing thing that happened to you?'
];
const DARES = [
    'Send a voice note singing your favorite song.',
    'Text your crush "hi" right now.'
];
const WOULD = [
    'Would you rather have the ability to fly or be invisible?',
    'Would you rather live without music or without TV?'
];
const TRIVIA = [
    { q: 'What is the capital of Japan?', a: 'Tokyo' },
    { q: 'How many continents are there?', a: '7' }
];
const HOROSCOPES = {
    aries: 'Today calls for bold decisions.', taurus: 'Patience will pay off today.',
    gemini: 'A good day for conversations.', cancer: 'Focus on family and comfort.',
    leo: 'Your confidence shines today.', virgo: 'Details matter — stay sharp.',
    libra: 'Balance work and rest today.', scorpio: 'Trust your instincts.',
    sagittarius: 'Adventure calls, say yes.', capricorn: 'Discipline brings results.',
    aquarius: 'Innovative ideas flow easily.', pisces: 'Your intuition is strong today.'
};
const MOTIVATE = [
    'Push yourself, because no one else is going to do it for you.',
    'Great things never come from comfort zones.'
];

// =========================================================================
// Command registry
// commands: canonical name -> { category, desc, adminOnly, groupOnly, ownerOnly, aliases: [], run(ctx) }
// =========================================================================
const commands = {};
function reg(name, def) { commands[name] = def; (def.aliases || []).forEach(a => { commands[a] = def; }); }

// ---- SYSTEM ----
reg('ping', { category: 'System', desc: '.ping', aliases: ['speed'], run: async ({ sock, from, msg }) => {
    const start = Date.now();
    const chi = await sock.sendMessage(from, { text: '⚡ *Pinging server...*' }, { quoted: msg });
    const latency = Date.now() - start;
    await sock.sendMessage(from, { text: `🚀 *Response Speed:* \`${latency}ms\`\n💎 *Status:* Ultra High Speed ⚡` }, { quoted: chi });
}});
reg('alive', { category: 'System', desc: '.alive', run: async ({ sock, from, msg, reply }) => {
    const uptimeSec = Math.floor(process.uptime());
    const h = Math.floor(uptimeSec / 3600), m = Math.floor((uptimeSec % 3600) / 60), s = uptimeSec % 60;
    const caption = '```\n' + generateArt('MD') + '\n```\n' + `${toItalic(greeting())}\n\n┏━━⪩ ${toBoldScript(BOT_NAME)} ⪨━━┓\n┃ ✅ ${toProFont('Status')}: Online & Active\n┃ 🤖 ${toProFont('Mode')}: Multi-Device Power Bot\n┃ 💎 ${toProFont('Version')}: 6.0.0 Ultimate\n┃ ⏱️ ${toProFont('Uptime')}: ${h}h ${m}m ${s}s\n┃ 👑 ${toProFont('Owner')}: ${toFraktur(OWNER_NAME)}\n┃ 📢 ${toProFont('Channel')}: ${CHANNEL_LINK}\n┗━━━━━━━━━━━━━━━━━┛\n\n✨ Type *.menu* to see all commands!`;
    const logo = getBotLogo();
    if (logo) await sock.sendMessage(from, { image: logo, caption }, { quoted: msg });
    else await reply(caption);
}});
reg('runtime', { category: 'System', desc: '.runtime', aliases: ['uptime'], run: async ({ reply }) => {
    await reply(`⏱️ *Uptime:* ${fmtDuration(Date.now() - startTime)}`);
}});
reg('owner', { category: 'System', desc: '.owner', run: async ({ reply }) => {
    await reply(OWNER_NUMBER ? `╭━━━〔 👑 ${toBoldScript('OWNER INFO')} 〕━━━┈⊷\n┃ 👤 ${toProFont('Name')}: ${toFraktur(OWNER_NAME)}\n┃ 📞 ${toProFont('Contact')}: wa.me/${OWNER_NUMBER}\n┃ 📢 ${toProFont('Channel')}: ${CHANNEL_LINK}\n╰━━━━━━━━━━━━━━━━━━━━━━━┈⊷` : '👑 Owner number not configured (set OWNER_NUMBER env var).');
}});
reg('autostatus', { category: 'Owner', desc: '.autostatus [view/react/emoji] [on/off/emoji]', ownerOnly: true, run: async ({ reply, args, session }) => {
    const mode = (args[0] || '').toLowerCase();
    const val = (args[1] || '').toLowerCase();
    if (!mode) {
        return reply(`👁️ *Auto Status Settings*\n┃ View: ${session.autoStatus.view ? '✅ ON' : '❌ OFF'}\n┃ React: ${session.autoStatus.react ? '✅ ON' : '❌ OFF'}\n┃ Emoji: ${session.autoStatus.emoji}\n\n📌 Usage:\n.autostatus view on/off\n.autostatus react on/off\n.autostatus emoji 🔥`);
    }
    if (mode === 'view' || mode === 'react') {
        if (val !== 'on' && val !== 'off') return reply('❌ Use on or off.');
        session.autoStatus[mode] = val === 'on';
        return reply(`✅ Auto status *${mode}* turned *${val.toUpperCase()}*.`);
    }
    if (mode === 'emoji') {
        if (!val) return reply('❌ Provide an emoji, e.g. .autostatus emoji 🔥');
        session.autoStatus.emoji = args[1];
        return reply(`✅ Auto status react emoji set to ${session.autoStatus.emoji}`);
    }
    await reply('❌ Unknown option. Use view / react / emoji.');
}});
reg('support', { category: 'System', desc: '.support', aliases: ['report', 'feedback'], run: async ({ reply }) => {
    await reply('🛠️ For support or feedback, please contact the bot owner via `.owner`.');
}});
reg('script', { category: 'System', desc: '.script', run: async ({ reply }) => {
    await reply(`📜 *${BOT_NAME}* is a Baileys-based WhatsApp bot. Ask the owner for the repository link.`);
}});
reg('donate', { category: 'System', desc: '.donate', run: async ({ reply }) => {
    await reply('💗 If you enjoy this bot, consider supporting the developer!');
}});
reg('credits', { category: 'System', desc: '.credits', run: async ({ reply }) => {
    await reply(`✨ *${BOT_NAME}* — built on @whiskeysockets/baileys. Developed by Madushanka Dev.`);
}});
reg('about', { category: 'System', desc: '.about', aliases: ['botinfo'], run: async ({ reply }) => {
    await reply(`🤖 *${BOT_NAME}*\nA multi-device WhatsApp bot with 100+ commands: system tools, fun, group management and more.`);
}});
reg('id', { category: 'System', desc: '.id', run: async ({ reply, from }) => { await reply(`🆔 Chat ID: ${from}`); }});
reg('mention', { category: 'System', desc: '.mention', run: async ({ reply, sender }) => { await reply(`👤 Your ID: ${sender}`); }});
reg('menu', { category: 'System', desc: '.menu [category]', aliases: ['help'], run: async ({ sock, from, msg, reply, q }) => {
    const logo = getBotLogo();
    if (logo) await sock.sendMessage(from, { image: logo, caption: buildMenu(q) }, { quoted: msg });
    else await reply(buildMenu(q));
}});

// ---- FUN ----
reg('quote', { category: 'Fun', desc: '.quote', run: async ({ reply }) => await reply(`💬 *Motivation Quote:*\n\n"${pick(QUOTES)}" ✨`) });
reg('joke', { category: 'Fun', desc: '.joke', run: async ({ reply }) => await reply(`🎭 *Funny Joke:*\n\n${pick(JOKES)}`) });
reg('fact', { category: 'Fun', desc: '.fact', run: async ({ reply }) => await reply(`🧠 *Random Fact:*\n\n${pick(FACTS)}`) });
reg('catfact', { category: 'Fun', desc: '.catfact', run: async ({ reply }) => await reply(`🐱 *Cat Fact:*\n\n${pick(CATFACTS)}`) });
reg('dogfact', { category: 'Fun', desc: '.dogfact', run: async ({ reply }) => await reply(`🐶 *Dog Fact:*\n\n${pick(DOGFACTS)}`) });
reg('riddle', { category: 'Fun', desc: '.riddle', run: async ({ reply }) => { const r = pick(RIDDLES); await reply(`🧩 *Riddle:*\n${r.q}\n\n_Reply .riddle again for another one!_\n||Answer: ${r.a}||`); }});
reg('wisdom', { category: 'Fun', desc: '.wisdom', run: async ({ reply }) => await reply(`🦉 *Wisdom:*\n\n${pick(WISDOM)}`) });
reg('proverb', { category: 'Fun', desc: '.proverb', run: async ({ reply }) => await reply(`📖 *Proverb:*\n\n${pick(PROVERBS)}`) });
reg('motivate', { category: 'Fun', desc: '.motivate', run: async ({ reply }) => await reply(`🔥 *Motivation:*\n\n${pick(MOTIVATE)}`) });
reg('goodmorning', { category: 'Fun', desc: '.goodmorning', run: async ({ reply }) => await reply('☀️ Good Morning! Wishing you a fantastic day ahead! 🌸') });
reg('goodnight', { category: 'Fun', desc: '.goodnight', run: async ({ reply }) => await reply('🌙 Good Night! Sleep well and sweet dreams! ✨') });
reg('roast', { category: 'Fun', desc: '.roast', run: async ({ reply }) => await reply(`🔥 *Roast:*\n\n${pick(ROASTS)}`) });
reg('praise', { category: 'Fun', desc: '.praise', run: async ({ reply }) => await reply(`🙌 *Praise:*\n\n${pick(PRAISES)}`) });
reg('compliment', { category: 'Fun', desc: '.compliment', run: async ({ reply }) => await reply(`💖 *Compliment:*\n\n${pick(COMPLIMENTS)}`) });
reg('truth', { category: 'Fun', desc: '.truth', run: async ({ reply }) => await reply(`🤫 *Truth:*\n\n${pick(TRUTHS)}`) });
reg('dare', { category: 'Fun', desc: '.dare', run: async ({ reply }) => await reply(`😈 *Dare:*\n\n${pick(DARES)}`) });
reg('8ball', { category: 'Fun', desc: '.8ball [question]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Ask a question! Example: `.8ball Will I be rich?`');
    const answers = ['Yes, definitely.', 'No way.', 'Ask again later.', 'Absolutely!', 'Very doubtful.', 'It is certain.'];
    await reply(`🎱 ${pick(answers)}`);
}});
reg('roll', { category: 'Fun', desc: '.roll', run: async ({ reply }) => await reply(`🎲 You rolled a *${randInt(1, 6)}*!`) });
reg('flip', { category: 'Fun', desc: '.flip', run: async ({ reply }) => await reply(`🪙 It's *${pick(['Heads', 'Tails'])}*!`) });
reg('rps', { category: 'Fun', desc: '.rps [rock/paper/scissors]', run: async ({ reply, q }) => {
    const choices = ['rock', 'paper', 'scissors'];
    const user = q.toLowerCase().trim();
    if (!choices.includes(user)) return reply('❌ Choose rock, paper, or scissors. Example: `.rps rock`');
    const bot = pick(choices);
    let result;
    if (bot === user) result = "It's a tie!";
    else if ((user === 'rock' && bot === 'scissors') || (user === 'paper' && bot === 'rock') || (user === 'scissors' && bot === 'paper')) result = 'You win! 🎉';
    else result = 'I win! 🤖';
    await reply(`✊✋✌️ You: ${user} | Bot: ${bot}\n${result}`);
}});
reg('ship', { category: 'Fun', desc: '.ship', aliases: ['lovecalc'], run: async ({ reply }) => await reply(`💘 Love Match: *${randInt(0, 100)}%*`) });
reg('horoscope', { category: 'Fun', desc: '.horoscope [sign]', run: async ({ reply, q }) => {
    const sign = q.toLowerCase().trim();
    if (!HOROSCOPES[sign]) return reply('❌ Provide a valid zodiac sign. Example: `.horoscope leo`');
    await reply(`🔮 *${sign.charAt(0).toUpperCase() + sign.slice(1)} Horoscope:*\n${HOROSCOPES[sign]}`);
}});
reg('fortune', { category: 'Fun', desc: '.fortune', run: async ({ reply }) => await reply(`🥠 *Fortune:* ${pick(WISDOM.concat(PROVERBS))}`) });
reg('burn', { category: 'Fun', desc: '.burn', run: async ({ reply }) => await reply(`🔥 ${pick(ROASTS)}`) });

// ---- TOOLS ----
reg('date', { category: 'Tools', desc: '.date', run: async ({ reply }) => await reply(`📅 Current Date: ${new Date().toDateString()}`) });
reg('text2hex', { category: 'Tools', desc: '.text2hex [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(`🔢 ${Buffer.from(q).toString('hex')}`);
}});
reg('hex2text', { category: 'Tools', desc: '.hex2text [hex]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide hex.');
    try { await reply(`🔤 ${Buffer.from(q.replace(/\s+/g, ''), 'hex').toString('utf-8')}`); } catch (e) { await reply('❌ Invalid hex string.'); }
}});
reg('text2binary', { category: 'Tools', desc: '.text2binary [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(q.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' '));
}});
reg('binary2text', { category: 'Tools', desc: '.binary2text [binary]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide binary.');
    try { await reply(q.trim().split(/\s+/).map(b => String.fromCharCode(parseInt(b, 2))).join('')); } catch (e) { await reply('❌ Invalid binary string.'); }
}});
reg('urlencode', { category: 'Tools', desc: '.urlencode [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(encodeURIComponent(q));
}});
reg('urldecode', { category: 'Tools', desc: '.urldecode [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    try { await reply(decodeURIComponent(q)); } catch (e) { await reply('❌ Invalid encoded string.'); }
}});
reg('capitalize', { category: 'Tools', desc: '.capitalize [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(q.replace(/\b\w/g, c => c.toUpperCase()));
}});
reg('countchar', { category: 'Tools', desc: '.countchar [text]', run: async ({ reply, q }) => { if (!q) return reply('❌ Provide text.'); await reply(`🔡 Characters: ${q.length}`); }});
reg('countword', { category: 'Tools', desc: '.countword [text]', run: async ({ reply, q }) => { if (!q) return reply('❌ Provide text.'); await reply(`📝 Words: ${q.trim().split(/\s+/).length}`); }});
reg('palindrome', { category: 'Tools', desc: '.palindrome [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    const clean = q.toLowerCase().replace(/[^a-z0-9]/g, '');
    await reply(clean === clean.split('').reverse().join('') ? '✅ That is a palindrome!' : '❌ Not a palindrome.');
}});
reg('ascii', { category: 'Tools', desc: '.ascii [text]', aliases: ['asciiart'], run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text (short words work best).');
    figlet(q.slice(0, 15), (err, data) => { if (err || !data) return reply('❌ Could not generate ASCII art.'); reply('```' + data + '```'); });
}});
reg('qr', { category: 'Tools', desc: '.qr [text]', run: async ({ sock, from, msg, reply, q }) => {
    if (!q) return reply('❌ Provide text or a URL to encode.');
    try {
        const buffer = await QRCode.toBuffer(q, { width: 400 });
        await sock.sendMessage(from, { image: buffer, caption: `📷 QR Code for: ${q}` }, { quoted: msg });
    } catch (e) { await reply('❌ Failed to generate QR code.'); }
}});
reg('randomnumber', { category: 'Tools', desc: '.randomnumber [min] [max]', run: async ({ reply, args }) => {
    const min = parseInt(args[0]) || 1, max = parseInt(args[1]) || 100;
    await reply(`🎲 Random Number: ${randInt(min, max)}`);
}});
reg('randomcolor', { category: 'Tools', desc: '.randomcolor', run: async ({ reply }) => {
    const hex = '#' + randInt(0, 0xFFFFFF).toString(16).padStart(6, '0');
    await reply(`🎨 Random Color: ${hex}`);
}});
reg('lorem', { category: 'Tools', desc: '.lorem [paragraphs]', run: async ({ reply, q }) => {
    const n = Math.min(Math.max(parseInt(q) || 1, 1), 5);
    const p = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
    await reply(new Array(n).fill(p).join('\n\n'));
}});
reg('remind', { category: 'Tools', desc: '.remind [seconds] [message]', run: async ({ reply, sock, from, args }) => {
    const seconds = parseInt(args[0]);
    const text = args.slice(1).join(' ');
    if (!seconds || seconds <= 0 || seconds > 3600 || !text) return reply('❌ Usage: `.remind 60 Drink water` (max 3600 seconds)');
    await reply(`⏰ Reminder set for ${seconds}s from now.`);
    setTimeout(() => { sock.sendMessage(from, { text: `⏰ *Reminder:* ${text}` }).catch(() => {}); }, seconds * 1000);
}});

// ---- PUBLIC APIS (free, no key required) ----
reg('weather', { category: 'Tools', desc: '.weather [city]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide a city name. Example: `.weather Colombo`');
    try {
        const geo = await axios.get('https://geocoding-api.open-meteo.com/v1/search', { params: { name: q, count: 1 }, timeout: 10000 });
        const place = geo.data?.results?.[0];
        if (!place) return reply('❌ City not found.');
        const w = await axios.get('https://api.open-meteo.com/v1/forecast', { params: { latitude: place.latitude, longitude: place.longitude, current_weather: true }, timeout: 10000 });
        const cw = w.data?.current_weather;
        if (!cw) return reply('❌ Weather data unavailable.');
        await reply(`🌤️ *Weather in ${place.name}, ${place.country || ''}*\n🌡️ Temp: ${cw.temperature}°C\n💨 Wind: ${cw.windspeed} km/h`);
    } catch (e) { await reply('⚠️ Weather service unavailable right now.'); }
}});
reg('crypto', { category: 'Tools', desc: '.crypto [coin]', aliases: ['price'], run: async ({ reply, q }) => {
    const coin = (q || 'bitcoin').toLowerCase().trim();
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', { params: { ids: coin, vs_currencies: 'usd' }, timeout: 10000 });
        const price = res.data?.[coin]?.usd;
        if (!price) return reply('❌ Coin not found. Try the full name, e.g. `.crypto ethereum`');
        await reply(`💰 *${coin.toUpperCase()}:* $${price}`);
    } catch (e) { await reply('⚠️ Price service unavailable right now.'); }
}});
reg('ai', { category: 'Tools', desc: '.ai [prompt]', aliases: ['gpt'], run: async ({ reply, q }) => {
    if (!q) return reply('❌ *Please provide a prompt!* \n📌 *Example:* `.ai Who is Albert Einstein?`');
    try {
        const aiRes = await axios.get(`https://api.siputzx.my.id/api/ai/chatbot?content=${encodeURIComponent(q)}`, { timeout: 15000 });
        const answer = aiRes.data?.data || aiRes.data?.result || 'No response from AI server.';
        await reply(`🤖 *Madushanka AI Assistant* ✨\n\n${answer}`);
    } catch (e) { await reply('⚠️ *AI service is currently busy. Please try again later!*'); }
}});

// ---- GROUP MANAGEMENT (admin-only) ----
reg('tagall', { category: 'Group', desc: '.tagall', groupOnly: true, adminOnly: true, run: async ({ sock, from, groupMetadata, msg }) => {
    const mentions = groupMetadata.participants.map(p => p.id);
    const text = '📢 *Attention everyone!*\n\n' + mentions.map(m => `@${m.split('@')[0]}`).join('\n');
    await sock.sendMessage(from, { text, mentions }, { quoted: msg });
}});
reg('hidetag', { category: 'Group', desc: '.hidetag [message]', groupOnly: true, adminOnly: true, run: async ({ sock, from, groupMetadata, msg, q }) => {
    const mentions = groupMetadata.participants.map(p => p.id);
    await sock.sendMessage(from, { text: q || '📢 Notice', mentions }, { quoted: msg });
}});
reg('groupinfo', { category: 'Group', desc: '.groupinfo', groupOnly: true, run: async ({ reply, groupMetadata }) => {
    await reply(`📋 *Group Info*\n👥 Name: ${groupMetadata.subject}\n🆔 ID: ${groupMetadata.id}\n👤 Members: ${groupMetadata.participants.length}\n📝 Description: ${groupMetadata.desc || 'None'}`);
}});
reg('kick', { category: 'Group', desc: '.kick (reply/mention)', groupOnly: true, adminOnly: true, run: async ({ sock, from, msg, reply }) => {
    const target = msg.message?.extendedTextMessage?.contextInfo?.participant || (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [])[0];
    if (!target) return reply('❌ Reply to or mention the user you want to kick.');
    await sock.groupParticipantsUpdate(from, [target], 'remove');
    await reply('✅ User removed.');
}});
reg('add', { category: 'Group', desc: '.add [number]', groupOnly: true, adminOnly: true, run: async ({ sock, from, reply, q }) => {
    const num = q.replace(/[^0-9]/g, '');
    if (!num) return reply('❌ Provide a number. Example: `.add 94771234567`');
    await sock.groupParticipantsUpdate(from, [`${num}@s.whatsapp.net`], 'add');
    await reply('✅ Invite sent.');
}});
reg('promote', { category: 'Group', desc: '.promote (reply/mention)', groupOnly: true, adminOnly: true, run: async ({ sock, from, msg, reply }) => {
    const target = msg.message?.extendedTextMessage?.contextInfo?.participant || (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [])[0];
    if (!target) return reply('❌ Reply to or mention the user you want to promote.');
    await sock.groupParticipantsUpdate(from, [target], 'promote');
    await reply('✅ User promoted to admin.');
}});
reg('demote', { category: 'Group', desc: '.demote (reply/mention)', groupOnly: true, adminOnly: true, run: async ({ sock, from, msg, reply }) => {
    const target = msg.message?.extendedTextMessage?.contextInfo?.participant || (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [])[0];
    if (!target) return reply('❌ Reply to or mention the user you want to demote.');
    await sock.groupParticipantsUpdate(from, [target], 'demote');
    await reply('✅ User demoted.');
}});
reg('mute', { category: 'Group', desc: '.mute', groupOnly: true, adminOnly: true, run: async ({ sock, from, reply }) => {
    await sock.groupSettingUpdate(from, 'announcement'); await reply('🔇 Group muted — only admins can send messages.');
}});
reg('unmute', { category: 'Group', desc: '.unmute', groupOnly: true, adminOnly: true, run: async ({ sock, from, reply }) => {
    await sock.groupSettingUpdate(from, 'not_announcement'); await reply('🔊 Group unmuted — everyone can send messages.');
}});
reg('setname', { category: 'Group', desc: '.setname [new name]', groupOnly: true, adminOnly: true, run: async ({ sock, from, reply, q }) => {
    if (!q) return reply('❌ Provide a new group name.'); await sock.groupUpdateSubject(from, q); await reply('✅ Group name updated.');
}});
reg('setdesc', { category: 'Group', desc: '.setdesc [new description]', groupOnly: true, adminOnly: true, run: async ({ sock, from, reply, q }) => {
    if (!q) return reply('❌ Provide a new description.'); await sock.groupUpdateDescription(from, q); await reply('✅ Group description updated.');
}});
reg('grouplink', { category: 'Group', desc: '.grouplink', aliases: ['invitelink'], groupOnly: true, adminOnly: true, run: async ({ sock, from, reply }) => {
    const code = await sock.groupInviteCode(from); await reply(`🔗 https://chat.whatsapp.com/${code}`);
}});
reg('revokelink', { category: 'Group', desc: '.revokelink', groupOnly: true, adminOnly: true, run: async ({ sock, from, reply }) => {
    await sock.groupRevokeInvite(from); await reply('✅ Group invite link revoked and regenerated.');
}});
reg('setrules', { category: 'Group', desc: '.setrules [text]', groupOnly: true, adminOnly: true, run: async ({ from, reply, q }) => {
    if (!q) return reply('❌ Provide rules text.'); getGroupSettings(from).rules = q; await reply('✅ Group rules updated.');
}});
reg('rules', { category: 'Group', desc: '.rules', groupOnly: true, run: async ({ from, reply }) => {
    const r = getGroupSettings(from).rules; await reply(r ? `📜 *Group Rules:*\n${r}` : 'ℹ️ No rules have been set yet. Use `.setrules` as an admin.');
}});
reg('antilink', { category: 'Group', desc: '.antilink [on/off]', groupOnly: true, adminOnly: true, run: async ({ from, reply, q }) => {
    const setting = getGroupSettings(from);
    if (q === 'on') { setting.antilink = true; return reply('✅ Antilink enabled.'); }
    if (q === 'off') { setting.antilink = false; return reply('✅ Antilink disabled.'); }
    await reply(`ℹ️ Antilink is currently *${setting.antilink ? 'ON' : 'OFF'}*. Use \`.antilink on\` or \`.antilink off\`.`);
}});
reg('warn', { category: 'Group', desc: '.warn (reply)', groupOnly: true, adminOnly: true, run: async ({ from, reply, msg }) => {
    const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!target) return reply('❌ Reply to the user you want to warn.');
    const s = getGroupSettings(from);
    s.warns[target] = (s.warns[target] || 0) + 1;
    await reply(`⚠️ @${target.split('@')[0]} has been warned (${s.warns[target]}/3).`);
}});
reg('resetwarn', { category: 'Group', desc: '.resetwarn (reply)', groupOnly: true, adminOnly: true, run: async ({ from, reply, msg }) => {
    const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!target) return reply('❌ Reply to the user whose warnings you want to reset.');
    delete getGroupSettings(from).warns[target];
    await reply('✅ Warnings reset for that user.');
}});

// ---- OWNER-ONLY ----
function isOwner(sender) {
    if (!OWNER_NUMBER) return false;
    return sender.replace(/[^0-9]/g, '').startsWith(OWNER_NUMBER) || sender.split('@')[0] === OWNER_NUMBER;
}
reg('join', { category: 'Owner', desc: '.join [invite link]', ownerOnly: true, run: async ({ sock, reply, q }) => {
    if (!q) return reply('❌ Provide a group invite link.');
    const code = q.split('/').pop();
    try { await sock.groupAcceptInvite(code); await reply('✅ Joined the group.'); } catch (e) { await reply('❌ Failed to join group.'); }
}});
reg('leave', { category: 'Owner', desc: '.leave', groupOnly: true, ownerOnly: true, run: async ({ sock, from, reply }) => {
    await reply('👋 Leaving group...'); await sock.groupLeave(from);
}});
reg('block', { category: 'Owner', desc: '.block (reply)', ownerOnly: true, run: async ({ sock, msg, reply }) => {
    const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!target) return reply('❌ Reply to the user you want to block.');
    await sock.updateBlockStatus(target, 'block'); await reply('✅ User blocked.');
}});
reg('unblock', { category: 'Owner', desc: '.unblock (reply)', ownerOnly: true, run: async ({ sock, msg, reply }) => {
    const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!target) return reply('❌ Reply to the user you want to unblock.');
    await sock.updateBlockStatus(target, 'unblock'); await reply('✅ User unblocked.');
}});
reg('restart', { category: 'Owner', desc: '.restart', ownerOnly: true, run: async ({ reply }) => {
    await reply('♻️ Restarting...'); setTimeout(() => process.exit(0), 1000);
}});
reg('setbio', { category: 'Owner', desc: '.setbio [text]', ownerOnly: true, run: async ({ sock, reply, q }) => {
    if (!q) return reply('❌ Provide bio text.'); await sock.updateProfileStatus(q); await reply('✅ Bio updated.');
}});
reg('broadcast', { category: 'Owner', desc: '.broadcast [text] (in a group, sends as announcement)', groupOnly: true, ownerOnly: true, run: async ({ sock, from, reply, q }) => {
    if (!q) return reply('❌ Provide the announcement text.');
    await sock.sendMessage(from, { text: `📢 *ANNOUNCEMENT*\n\n${q}` });
}});
reg('setppic', { category: 'Owner', desc: '.setppic (reply to an image)', ownerOnly: true, run: async ({ reply }) => {
    await reply('ℹ️ Profile picture updates require media download support — ask the developer to enable it.');
}});

// ---- TEXT TOOLS ----
reg('reverse', { category: 'Text', desc: '.reverse [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text. Example: `.reverse hello`');
    await reply(`🔁 ${q.split('').reverse().join('')}`);
}});
reg('upper', { category: 'Text', desc: '.upper [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(q.toUpperCase());
}});
reg('lower', { category: 'Text', desc: '.lower [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(q.toLowerCase());
}});
reg('mock', { category: 'Text', desc: '.mock [text] (SpOnGeBoB CaSe)', aliases: ['spongebob'], run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(q.split('').map((c, i) => i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join(''));
}});
reg('count', { category: 'Text', desc: '.count [text]', aliases: ['wordcount'], run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    const words = q.trim().split(/\s+/).filter(Boolean).length;
    await reply(`🔢 Characters: ${q.length}\n📝 Words: ${words}`);
}});
reg('repeat', { category: 'Text', desc: '.repeat [n] [text]', aliases: ['spam'], run: async ({ reply, args }) => {
    const n = parseInt(args[0], 10);
    const text = args.slice(1).join(' ');
    if (!n || n < 1 || !text) return reply('❌ Usage: `.repeat 3 hello`');
    if (n > 10) return reply('❌ Max repeat count is 10 (to avoid spam).');
    await reply(Array(n).fill(text).join('\n'));
}});
reg('binary', { category: 'Text', desc: '.binary [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(q.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' '));
}});
reg('base64encode', { category: 'Text', desc: '.base64encode [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(Buffer.from(q).toString('base64'));
}});
reg('base64decode', { category: 'Text', desc: '.base64decode [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide base64 text.');
    try { await reply(Buffer.from(q, 'base64').toString('utf8')); } catch (e) { await reply('❌ Invalid base64.'); }
}});
reg('clap', { category: 'Text', desc: '.clap [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(q.trim().split(/\s+/).join(' 👏 '));
}});

// ---- MORE FUN ----
reg('slap', { category: 'Fun', desc: '.slap (reply)', run: async ({ reply, msg }) => {
    const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
    const who = target ? `@${target.split('@')[0]}` : 'someone';
    await reply(`👋 *SLAP!* You slapped ${who} with a large trout! 🐟`);
}});
reg('hug', { category: 'Fun', desc: '.hug (reply)', run: async ({ reply, msg }) => {
    const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
    const who = target ? `@${target.split('@')[0]}` : 'everyone';
    await reply(`🤗 Sending a warm hug to ${who}!`);
}});
reg('kiss', { category: 'Fun', desc: '.kiss (reply)', run: async ({ reply, msg }) => {
    const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
    const who = target ? `@${target.split('@')[0]}` : 'you';
    await reply(`😘 A sweet kiss for ${who}!`);
}});
reg('fight', { category: 'Fun', desc: '.fight (reply)', run: async ({ reply }) => await reply(pick(['🥊 You threw the first punch!', '🥋 Epic battle ensues!', '💥 KO! You win!'])) });
reg('dice', { category: 'Fun', desc: '.dice [sides]', run: async ({ reply, q }) => {
    const sides = parseInt(q, 10) || 6;
    if (sides < 2 || sides > 1000) return reply('❌ Choose between 2 and 1000 sides.');
    await reply(`🎲 Rolled a d${sides}: *${randInt(1, sides)}*`);
}});
reg('choose', { category: 'Fun', desc: '.choose option1, option2, ...', aliases: ['pick'], run: async ({ reply, q }) => {
    const opts = q.split(',').map(s => s.trim()).filter(Boolean);
    if (opts.length < 2) return reply('❌ Give at least 2 options separated by commas.');
    await reply(`🤔 I choose: *${pick(opts)}*`);
}});
reg('rate', { category: 'Fun', desc: '.rate [anything]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide something to rate.');
    await reply(`⭐ I rate "${q}" a *${randInt(1, 10)}/10*!`);
}});
reg('would', { category: 'Fun', desc: '.would', aliases: ['wyr'], run: async ({ reply }) => await reply(`🤔 *Would You Rather:*\n\n${pick(WOULD)}`) });
reg('trivia', { category: 'Fun', desc: '.trivia', run: async ({ reply }) => { const t = pick(TRIVIA); await reply(`🧠 *Trivia:* ${t.q}\n||Answer: ${t.a}||`); }});
reg('meme', { category: 'Fun', desc: '.meme', run: async ({ reply }) => {
    try {
        const res = await axios.get('https://meme-api.com/gimme', { timeout: 10000 });
        if (res.data?.url) await reply(`😂 ${res.data.title || 'Meme'}\n${res.data.url}`);
        else await reply('❌ Could not fetch a meme right now.');
    } catch (e) { await reply('⚠️ Meme service unavailable right now.'); }
}});

// ---- MORE TOOLS ----
reg('short', { category: 'Tools', desc: '.short [url]', aliases: ['shorten'], run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide a URL. Example: `.short https://example.com`');
    try {
        const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(q)}`, { timeout: 10000 });
        await reply(`🔗 ${res.data}`);
    } catch (e) { await reply('⚠️ Shortener service unavailable right now.'); }
}});
reg('translate', { category: 'Tools', desc: '.translate [lang] [text]', aliases: ['tr'], run: async ({ reply, args }) => {
    const lang = args[0]; const text = args.slice(1).join(' ');
    if (!lang || !text) return reply('❌ Usage: `.translate si Hello there`');
    try {
        const res = await axios.get('https://api.mymemory.translated.net/get', { params: { q: text, langpair: `en|${lang}` }, timeout: 10000 });
        const translated = res.data?.responseData?.translatedText;
        if (!translated) return reply('❌ Translation failed.');
        await reply(`🌐 *Translation (${lang}):*\n${translated}`);
    } catch (e) { await reply('⚠️ Translation service unavailable right now.'); }
}});
reg('qrcode', { category: 'Tools', desc: '.qrcode [text]', aliases: ['qr'], run: async ({ sock, from, msg, reply, q }) => {
    if (!q) return reply('❌ Provide text/URL to encode.');
    try {
        const buffer = await QRCode.toBuffer(q, { width: 400 });
        await sock.sendMessage(from, { image: buffer, caption: `📱 QR code for: ${q}` }, { quoted: msg });
    } catch (e) { await reply('❌ Failed to generate QR code.'); }
}});
reg('password', { category: 'Tools', desc: '.password [length]', aliases: ['genpass'], run: async ({ reply, q }) => {
    const len = Math.min(Math.max(parseInt(q, 10) || 12, 6), 64);
    await reply(`🔐 *Generated Password:*\n\`${genPassword(len)}\``);
}});
reg('time', { category: 'Tools', desc: '.time', run: async ({ reply }) => {
    await reply(`🕒 Server time: ${new Date().toUTCString()}`);
}});
reg('calc', { category: 'Tools', desc: '.calc [expression]', aliases: ['calculate'], run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide a math expression. Example: `.calc 5*(3+2)`');
    try { await reply(`🧮 Result: ${safeCalculate(q)}`); } catch (e) { await reply('❌ Invalid expression.'); }
}});
reg('define', { category: 'Tools', desc: '.define [word]', aliases: ['dictionary'], run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide a word to define.');
    try {
        const res = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q)}`, { timeout: 10000 });
        const entry = res.data?.[0];
        const def = entry?.meanings?.[0]?.definitions?.[0]?.definition;
        if (!def) return reply('❌ No definition found.');
        await reply(`📖 *${q}*\n${entry.meanings[0].partOfSpeech ? `(${entry.meanings[0].partOfSpeech}) ` : ''}${def}`);
    } catch (e) { await reply('❌ No definition found.'); }
}});
reg('lyrics', { category: 'Tools', desc: '.lyrics [song title]', run: async ({ reply }) => {
    await reply('ℹ️ Lyrics lookups aren\'t supported here due to copyright — try a licensed lyrics site or app.');
}});

// ---- SOCIAL MEDIA DOWNLOADER ----
// Uses the free api.siputzx.my.id scraper (same provider already used for
// .ai above). Free scraper APIs like this can change or go down without
// notice, so every call is wrapped and fails with a clear message instead
// of crashing the bot.
function extractDownloadUrl(data) {
    if (!data) return null;
    if (typeof data === 'string') return data;
    if (data.url) return data.url;
    if (data.download_url) return data.download_url;
    if (data.downloadUrl) return data.downloadUrl;
    if (Array.isArray(data) && data[0]) return extractDownloadUrl(data[0]);
    if (data.data) return extractDownloadUrl(data.data);
    if (data.result) return extractDownloadUrl(data.result);
    if (Array.isArray(data.video)) return extractDownloadUrl(data.video[0]);
    if (Array.isArray(data.urls)) return extractDownloadUrl(data.urls[0]);
    return null;
}
reg('song', { category: 'Downloader', desc: '.song [name/link] — download YouTube audio', aliases: ['play'], run: async ({ sock, from, msg, reply, q }) => {
    if (!q) return reply('❌ Give me a song name or YouTube link.\n📌 Example: `.song faded alan walker`');
    try {
        let link = q;
        if (!/^https?:\/\//i.test(q)) {
            const search = await axios.get('https://api.siputzx.my.id/api/s/youtube', { params: { query: q }, timeout: 15000 });
            const first = search.data?.data?.[0] || search.data?.result?.[0];
            if (!first?.url) return reply('❌ No results found for that search.');
            link = first.url;
        }
        const res = await axios.get('https://api.siputzx.my.id/api/d/ytmp3', { params: { url: link }, timeout: 30000 });
        const audioUrl = extractDownloadUrl(res.data);
        if (!audioUrl) return reply('❌ Could not fetch the audio. The download service may be down right now — try again later.');
        await sock.sendMessage(from, { audio: { url: audioUrl }, mimetype: 'audio/mpeg' }, { quoted: msg });
    } catch (e) { await reply('❌ Failed to download. The service may be down — try again later.'); }
}});
reg('video', { category: 'Downloader', desc: '.video [name/link] — download YouTube video', aliases: ['ytmp4'], run: async ({ sock, from, msg, reply, q }) => {
    if (!q) return reply('❌ Give me a video name or YouTube link.\n📌 Example: `.video faded alan walker`');
    try {
        let link = q;
        if (!/^https?:\/\//i.test(q)) {
            const search = await axios.get('https://api.siputzx.my.id/api/s/youtube', { params: { query: q }, timeout: 15000 });
            const first = search.data?.data?.[0] || search.data?.result?.[0];
            if (!first?.url) return reply('❌ No results found for that search.');
            link = first.url;
        }
        const res = await axios.get('https://api.siputzx.my.id/api/d/ytmp4', { params: { url: link }, timeout: 30000 });
        const videoUrl = extractDownloadUrl(res.data);
        if (!videoUrl) return reply('❌ Could not fetch the video. The download service may be down right now — try again later.');
        await sock.sendMessage(from, { video: { url: videoUrl }, caption: `🎬 *${BOT_NAME}*` }, { quoted: msg });
    } catch (e) { await reply('❌ Failed to download. The service may be down — try again later.'); }
}});
reg('fb', { category: 'Downloader', desc: '.fb [link] — download Facebook video', aliases: ['facebook'], run: async ({ sock, from, msg, reply, q }) => {
    if (!q) return reply('❌ Give me a Facebook video link.\n📌 Example: `.fb https://facebook.com/...`');
    try {
        const res = await axios.get('https://api.siputzx.my.id/api/d/facebook', { params: { url: q }, timeout: 30000 });
        const videoUrl = extractDownloadUrl(res.data);
        if (!videoUrl) return reply('❌ Could not fetch that video. Make sure the link is public and try again.');
        await sock.sendMessage(from, { video: { url: videoUrl }, caption: `🎬 *${BOT_NAME}*` }, { quoted: msg });
    } catch (e) { await reply('❌ Failed to download. The service may be down — try again later.'); }
}});
reg('tiktok', { category: 'Downloader', desc: '.tiktok [link] — download TikTok video (no watermark)', aliases: ['tt'], run: async ({ sock, from, msg, reply, q }) => {
    if (!q) return reply('❌ Give me a TikTok link.\n📌 Example: `.tiktok https://vt.tiktok.com/...`');
    try {
        const res = await axios.get('https://api.siputzx.my.id/api/d/tiktok', { params: { url: q }, timeout: 30000 });
        const videoUrl = extractDownloadUrl(res.data);
        if (!videoUrl) return reply('❌ Could not fetch that video. Make sure the link is public and try again.');
        await sock.sendMessage(from, { video: { url: videoUrl }, caption: `🎬 *${BOT_NAME}*` }, { quoted: msg });
    } catch (e) { await reply('❌ Failed to download. The service may be down — try again later.'); }
}});
reg('ig', { category: 'Downloader', desc: '.ig [link] — download Instagram photo/video', aliases: ['instagram'], run: async ({ sock, from, msg, reply, q }) => {
    if (!q) return reply('❌ Give me an Instagram post/reel link.\n📌 Example: `.ig https://instagram.com/p/...`');
    try {
        const res = await axios.get('https://api.siputzx.my.id/api/d/instagram', { params: { url: q }, timeout: 30000 });
        const mediaUrl = extractDownloadUrl(res.data);
        if (!mediaUrl) return reply('❌ Could not fetch that post. Make sure the link is public and try again.');
        if (/\.mp4($|\?)/i.test(mediaUrl)) {
            await sock.sendMessage(from, { video: { url: mediaUrl }, caption: `🎬 *${BOT_NAME}*` }, { quoted: msg });
        } else {
            await sock.sendMessage(from, { image: { url: mediaUrl }, caption: `🖼️ *${BOT_NAME}*` }, { quoted: msg });
        }
    } catch (e) { await reply('❌ Failed to download. The service may be down — try again later.'); }
}});

// ---- MORE GROUP MANAGEMENT ----
reg('groupname', { category: 'Group', desc: '.groupname', groupOnly: true, run: async ({ reply, groupMetadata }) => {
    await reply(`📛 Group name: ${groupMetadata.subject}`);
}});
reg('memberlist', { category: 'Group', desc: '.memberlist', groupOnly: true, adminOnly: true, run: async ({ reply, groupMetadata }) => {
    const list = groupMetadata.participants.map((p, i) => `${i + 1}. @${p.id.split('@')[0]}${p.admin ? ' (admin)' : ''}`).join('\n');
    await reply(`👥 *Members (${groupMetadata.participants.length}):*\n${list}`);
}});
reg('adminlist', { category: 'Group', desc: '.adminlist', groupOnly: true, run: async ({ reply, groupMetadata }) => {
    const admins = groupMetadata.participants.filter(p => p.admin);
    if (!admins.length) return reply('ℹ️ No admins found.');
    await reply(`👑 *Admins:*\n${admins.map(a => `@${a.id.split('@')[0]}`).join('\n')}`);
}});
reg('closegroup', { category: 'Group', desc: '.closegroup', groupOnly: true, adminOnly: true, run: async ({ sock, from, reply }) => {
    await sock.groupSettingUpdate(from, 'announcement'); await reply('🔒 Group closed — only admins can send messages.');
}});
reg('opengroup', { category: 'Group', desc: '.opengroup', groupOnly: true, adminOnly: true, run: async ({ sock, from, reply }) => {
    await sock.groupSettingUpdate(from, 'not_announcement'); await reply('🔓 Group opened — everyone can send messages.');
}});
reg('lockinfo', { category: 'Group', desc: '.lockinfo', groupOnly: true, adminOnly: true, run: async ({ sock, from, reply }) => {
    await sock.groupSettingUpdate(from, 'locked'); await reply('🔒 Only admins can edit group info now.');
}});
reg('unlockinfo', { category: 'Group', desc: '.unlockinfo', groupOnly: true, adminOnly: true, run: async ({ sock, from, reply }) => {
    await sock.groupSettingUpdate(from, 'unlocked'); await reply('🔓 All members can edit group info now.');
}});
reg('welcome', { category: 'Group', desc: '.welcome [on/off]', groupOnly: true, adminOnly: true, run: async ({ from, reply, q }) => {
    const s = getGroupSettings(from);
    if (q === 'on') { s.welcome = true; return reply('✅ Welcome messages enabled.'); }
    if (q === 'off') { s.welcome = false; return reply('✅ Welcome messages disabled.'); }
    await reply(`ℹ️ Welcome messages are currently *${s.welcome ? 'ON' : 'OFF'}*.`);
}});

// =====================================================================
// +100 MORE COMMANDS — all self-contained (no third-party APIs), so
// they work reliably with zero extra setup or external dependencies.
// =====================================================================

// ---- TEXT TOOLS (25) ----
reg('rot13', { category: 'Text', desc: '.rot13 [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(q.replace(/[a-zA-Z]/g, c => String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c.charCodeAt(0) + 13) ? c.charCodeAt(0) + 13 : c.charCodeAt(0) - 13)));
}});
reg('rot47', { category: 'Text', desc: '.rot47 [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(q.replace(/[!-~]/g, c => String.fromCharCode(33 + ((c.charCodeAt(0) - 33 + 47) % 94))));
}});
reg('atbash', { category: 'Text', desc: '.atbash [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(q.replace(/[a-zA-Z]/g, c => {
        const isUpper = c === c.toUpperCase();
        const base = isUpper ? 65 : 97;
        return String.fromCharCode(base + (25 - (c.charCodeAt(0) - base)));
    }));
}});
reg('caesar', { category: 'Text', desc: '.caesar [shift] [text]', run: async ({ reply, args }) => {
    const shift = parseInt(args[0]);
    const text = args.slice(1).join(' ');
    if (isNaN(shift) || !text) return reply('❌ Usage: .caesar [shift] [text]');
    await reply(text.replace(/[a-zA-Z]/g, c => {
        const base = c === c.toUpperCase() ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + shift) % 26 + 26) % 26 + base);
    }));
}});
reg('decaesar', { category: 'Text', desc: '.decaesar [shift] [text]', run: async ({ reply, args }) => {
    const shift = parseInt(args[0]);
    const text = args.slice(1).join(' ');
    if (isNaN(shift) || !text) return reply('❌ Usage: .decaesar [shift] [text]');
    await reply(text.replace(/[a-zA-Z]/g, c => {
        const base = c === c.toUpperCase() ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base - shift) % 26 + 26) % 26 + base);
    }));
}});
const MORSE_MAP = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.' };
const MORSE_REV = Object.fromEntries(Object.entries(MORSE_MAP).map(([k, v]) => [v, k]));
reg('morse', { category: 'Text', desc: '.morse [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(q.toUpperCase().split('').map(c => c === ' ' ? '/' : (MORSE_MAP[c] || c)).join(' '));
}});
reg('demorse', { category: 'Text', desc: '.demorse [morse code]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide morse code, e.g. .demorse .... ..');
    await reply(q.split(' ').map(c => c === '/' ? ' ' : (MORSE_REV[c] || c)).join(''));
}});
const LEET_MAP = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7', A: '4', E: '3', I: '1', O: '0', S: '5', T: '7' };
reg('leet', { category: 'Text', desc: '.leet [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(q.split('').map(c => LEET_MAP[c] || c).join(''));
}});
reg('vowelcount', { category: 'Text', desc: '.vowelcount [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(`🔤 Vowels: ${(q.match(/[aeiouAEIOU]/g) || []).length}`);
}});
reg('consonantcount', { category: 'Text', desc: '.consonantcount [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(`🔠 Consonants: ${(q.match(/[b-df-hj-np-tv-zB-DF-HJ-NP-TV-Z]/g) || []).length}`);
}});
reg('removevowels', { category: 'Text', desc: '.removevowels [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(q.replace(/[aeiouAEIOU]/g, ''));
}});
reg('removespaces', { category: 'Text', desc: '.removespaces [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(q.replace(/\s+/g, ''));
}});
reg('shuffletext', { category: 'Text', desc: '.shuffletext [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    const arr = q.split('');
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[arr[i], arr[j]] = [arr[j], arr[i]]; }
    await reply(arr.join(''));
}});
reg('titlecase', { category: 'Text', desc: '.titlecase [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(q.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()));
}});
reg('snakecase', { category: 'Text', desc: '.snakecase [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(q.trim().toLowerCase().replace(/\s+/g, '_'));
}});
reg('camelcase', { category: 'Text', desc: '.camelcase [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    const words = q.trim().split(/\s+/);
    await reply(words.map((w, i) => i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()).join(''));
}});
reg('kebabcase', { category: 'Text', desc: '.kebabcase [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(q.trim().toLowerCase().replace(/\s+/g, '-'));
}});
reg('mirror', { category: 'Text', desc: '.mirror [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.'); await reply(`${q} | ${q.split('').reverse().join('')}`);
}});
reg('acronym', { category: 'Text', desc: '.acronym [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(q.trim().split(/\s+/).map(w => w[0].toUpperCase()).join(''));
}});
reg('charfreq', { category: 'Text', desc: '.charfreq [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    const freq = {};
    for (const c of q.replace(/\s/g, '')) freq[c] = (freq[c] || 0) + 1;
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);
    await reply('📊 *Character Frequency:*\n' + top.map(([c, n]) => `${c}: ${n}`).join('\n'));
}});
reg('isanagram', { category: 'Text', desc: '.isanagram [word1] , [word2]', run: async ({ reply, q }) => {
    if (!q || !q.includes(',')) return reply('❌ Usage: .isanagram listen , silent');
    const [a, b] = q.split(',').map(s => s.trim().toLowerCase().replace(/\s/g, '').split('').sort().join(''));
    await reply(a === b ? '✅ Yes, these are anagrams!' : '❌ No, these are not anagrams.');
}});
reg('wordfreq', { category: 'Text', desc: '.wordfreq [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    const freq = {};
    for (const w of q.toLowerCase().trim().split(/\s+/)) freq[w] = (freq[w] || 0) + 1;
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10);
    await reply('📊 *Word Frequency:*\n' + top.map(([w, n]) => `${w}: ${n}`).join('\n'));
}});
reg('sentencecount', { category: 'Text', desc: '.sentencecount [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(`📝 Sentences: ${(q.match(/[.!?]+/g) || []).length || 1}`);
}});
reg('randomcase', { category: 'Text', desc: '.randomcase [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    await reply(q.split('').map(c => Math.random() > 0.5 ? c.toUpperCase() : c.toLowerCase()).join(''));
}});
reg('textstats', { category: 'Text', desc: '.textstats [text]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide text.');
    const words = q.trim().split(/\s+/).length;
    const chars = q.length;
    const sentences = (q.match(/[.!?]+/g) || []).length || 1;
    await reply(`📊 *Text Stats*\n┃ 🔡 Characters: ${chars}\n┃ 📝 Words: ${words}\n┃ 📄 Sentences: ${sentences}`);
}});

// ---- UNIT CONVERTERS (15) ----
reg('cm2ft', { category: 'Tools', desc: '.cm2ft [cm]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n)) return reply('❌ Provide a number.'); await reply(`📏 ${n} cm = ${(n / 30.48).toFixed(2)} ft`);
}});
reg('ft2cm', { category: 'Tools', desc: '.ft2cm [ft]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n)) return reply('❌ Provide a number.'); await reply(`📏 ${n} ft = ${(n * 30.48).toFixed(2)} cm`);
}});
reg('kg2lb', { category: 'Tools', desc: '.kg2lb [kg]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n)) return reply('❌ Provide a number.'); await reply(`⚖️ ${n} kg = ${(n * 2.20462).toFixed(2)} lb`);
}});
reg('lb2kg', { category: 'Tools', desc: '.lb2kg [lb]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n)) return reply('❌ Provide a number.'); await reply(`⚖️ ${n} lb = ${(n / 2.20462).toFixed(2)} kg`);
}});
reg('km2mi', { category: 'Tools', desc: '.km2mi [km]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n)) return reply('❌ Provide a number.'); await reply(`🛣️ ${n} km = ${(n * 0.621371).toFixed(2)} mi`);
}});
reg('mi2km', { category: 'Tools', desc: '.mi2km [mi]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n)) return reply('❌ Provide a number.'); await reply(`🛣️ ${n} mi = ${(n / 0.621371).toFixed(2)} km`);
}});
reg('c2f', { category: 'Tools', desc: '.c2f [celsius]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n)) return reply('❌ Provide a number.'); await reply(`🌡️ ${n}°C = ${(n * 9 / 5 + 32).toFixed(1)}°F`);
}});
reg('f2c', { category: 'Tools', desc: '.f2c [fahrenheit]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n)) return reply('❌ Provide a number.'); await reply(`🌡️ ${n}°F = ${((n - 32) * 5 / 9).toFixed(1)}°C`);
}});
reg('dec2hex', { category: 'Tools', desc: '.dec2hex [number]', run: async ({ reply, q }) => {
    const n = parseInt(q); if (isNaN(n)) return reply('❌ Provide a decimal number.'); await reply(`🔢 Hex: ${n.toString(16).toUpperCase()}`);
}});
reg('hex2dec', { category: 'Tools', desc: '.hex2dec [hex]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide a hex value.'); const n = parseInt(q, 16); if (isNaN(n)) return reply('❌ Invalid hex.'); await reply(`🔢 Decimal: ${n}`);
}});
reg('dec2oct', { category: 'Tools', desc: '.dec2oct [number]', run: async ({ reply, q }) => {
    const n = parseInt(q); if (isNaN(n)) return reply('❌ Provide a decimal number.'); await reply(`🔢 Octal: ${n.toString(8)}`);
}});
reg('oct2dec', { category: 'Tools', desc: '.oct2dec [octal]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide an octal value.'); const n = parseInt(q, 8); if (isNaN(n)) return reply('❌ Invalid octal.'); await reply(`🔢 Decimal: ${n}`);
}});
reg('dec2bin', { category: 'Tools', desc: '.dec2bin [number]', run: async ({ reply, q }) => {
    const n = parseInt(q); if (isNaN(n)) return reply('❌ Provide a decimal number.'); await reply(`🔢 Binary: ${n.toString(2)}`);
}});
reg('bin2dec', { category: 'Tools', desc: '.bin2dec [binary]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide a binary value.'); const n = parseInt(q, 2); if (isNaN(n)) return reply('❌ Invalid binary.'); await reply(`🔢 Decimal: ${n}`);
}});
reg('inch2cm', { category: 'Tools', desc: '.inch2cm [inches]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n)) return reply('❌ Provide a number.'); await reply(`📏 ${n} in = ${(n * 2.54).toFixed(2)} cm`);
}});

// ---- MATH (15) ----
reg('average', { category: 'Tools', desc: '.average [numbers separated by space]', run: async ({ reply, args }) => {
    const nums = args.map(Number).filter(n => !isNaN(n));
    if (!nums.length) return reply('❌ Provide numbers, e.g. .average 4 8 15 16');
    await reply(`📊 Average: ${(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)}`);
}});
reg('sumnum', { category: 'Tools', desc: '.sumnum [numbers separated by space]', run: async ({ reply, args }) => {
    const nums = args.map(Number).filter(n => !isNaN(n));
    if (!nums.length) return reply('❌ Provide numbers.'); await reply(`➕ Sum: ${nums.reduce((a, b) => a + b, 0)}`);
}});
reg('maxnum', { category: 'Tools', desc: '.maxnum [numbers separated by space]', run: async ({ reply, args }) => {
    const nums = args.map(Number).filter(n => !isNaN(n));
    if (!nums.length) return reply('❌ Provide numbers.'); await reply(`⬆️ Max: ${Math.max(...nums)}`);
}});
reg('minnum', { category: 'Tools', desc: '.minnum [numbers separated by space]', run: async ({ reply, args }) => {
    const nums = args.map(Number).filter(n => !isNaN(n));
    if (!nums.length) return reply('❌ Provide numbers.'); await reply(`⬇️ Min: ${Math.min(...nums)}`);
}});
reg('factorial', { category: 'Tools', desc: '.factorial [n]', run: async ({ reply, q }) => {
    const n = parseInt(q);
    if (isNaN(n) || n < 0 || n > 170) return reply('❌ Provide a whole number between 0 and 170.');
    let result = 1n; for (let i = 2; i <= n; i++) result *= BigInt(i);
    await reply(`🧮 ${n}! = ${result.toString()}`);
}});
reg('isprime', { category: 'Tools', desc: '.isprime [n]', run: async ({ reply, q }) => {
    const n = parseInt(q);
    if (isNaN(n)) return reply('❌ Provide a number.');
    if (n < 2) return reply(`❌ ${n} is not prime.`);
    let prime = true;
    for (let i = 2; i * i <= n; i++) if (n % i === 0) { prime = false; break; }
    await reply(prime ? `✅ ${n} is a prime number.` : `❌ ${n} is not a prime number.`);
}});
reg('gcd', { category: 'Tools', desc: '.gcd [a] [b]', run: async ({ reply, args }) => {
    let a = parseInt(args[0]), b = parseInt(args[1]);
    if (isNaN(a) || isNaN(b)) return reply('❌ Usage: .gcd 12 18');
    while (b) { [a, b] = [b, a % b]; } await reply(`🔢 GCD: ${Math.abs(a)}`);
}});
reg('lcm', { category: 'Tools', desc: '.lcm [a] [b]', run: async ({ reply, args }) => {
    const a = parseInt(args[0]), b = parseInt(args[1]);
    if (isNaN(a) || isNaN(b)) return reply('❌ Usage: .lcm 4 6');
    const gcd = (x, y) => y ? gcd(y, x % y) : x;
    await reply(`🔢 LCM: ${Math.abs(a * b) / gcd(a, b)}`);
}});
reg('fibonacci', { category: 'Tools', desc: '.fibonacci [n]', run: async ({ reply, q }) => {
    const n = parseInt(q);
    if (isNaN(n) || n < 0 || n > 1000) return reply('❌ Provide a whole number between 0 and 1000.');
    let a = 0n, b = 1n; for (let i = 0; i < n; i++) [a, b] = [b, a + b];
    await reply(`🔢 Fibonacci(${n}) = ${a.toString()}`);
}});
reg('sqrtnum', { category: 'Tools', desc: '.sqrtnum [n]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n) || n < 0) return reply('❌ Provide a non-negative number.'); await reply(`√${n} = ${Math.sqrt(n).toFixed(4)}`);
}});
reg('powernum', { category: 'Tools', desc: '.powernum [base] [exponent]', run: async ({ reply, args }) => {
    const base = parseFloat(args[0]), exp = parseFloat(args[1]);
    if (isNaN(base) || isNaN(exp)) return reply('❌ Usage: .powernum 2 10');
    await reply(`🧮 ${base}^${exp} = ${Math.pow(base, exp)}`);
}});
reg('modnum', { category: 'Tools', desc: '.modnum [a] [b]', run: async ({ reply, args }) => {
    const a = parseFloat(args[0]), b = parseFloat(args[1]);
    if (isNaN(a) || isNaN(b)) return reply('❌ Usage: .modnum 10 3');
    await reply(`🧮 ${a} mod ${b} = ${a % b}`);
}});
reg('roundnum', { category: 'Tools', desc: '.roundnum [number] [decimals]', run: async ({ reply, args }) => {
    const n = parseFloat(args[0]), d = parseInt(args[1]) || 0;
    if (isNaN(n)) return reply('❌ Usage: .roundnum 3.14159 2');
    await reply(`🧮 Rounded: ${n.toFixed(d)}`);
}});
reg('square', { category: 'Tools', desc: '.square [n]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n)) return reply('❌ Provide a number.'); await reply(`🧮 ${n}² = ${n * n}`);
}});
reg('cube', { category: 'Tools', desc: '.cube [n]', run: async ({ reply, q }) => {
    const n = parseFloat(q); if (isNaN(n)) return reply('❌ Provide a number.'); await reply(`🧮 ${n}³ = ${n * n * n}`);
}});

// ---- GENERATORS (10) ----
reg('uuidgen', { category: 'Tools', desc: '.uuidgen', run: async ({ reply }) => { await reply(`🆔 ${nodeCrypto.randomUUID()}`); }});
reg('pin', { category: 'Tools', desc: '.pin [length]', run: async ({ reply, q }) => {
    const len = Math.min(Math.max(parseInt(q) || 4, 4), 10);
    await reply(`🔢 PIN: ${Array.from({ length: len }, () => randInt(0, 9)).join('')}`);
}});
const RANDOM_NAMES = ['Alex', 'Nadia', 'Kavi', 'Sam', 'Priya', 'Liam', 'Zara', 'Malik', 'Ishara', 'Noah'];
reg('randomname', { category: 'Fun', desc: '.randomname', run: async ({ reply }) => { await reply(`👤 ${pick(RANDOM_NAMES)}`); }});
const RANDOM_EMOJIS = ['😂', '🔥', '💎', '🎉', '🚀', '🌸', '⚡', '🎯', '🦋', '🌟'];
reg('randomemoji', { category: 'Fun', desc: '.randomemoji', run: async ({ reply }) => { await reply(pick(RANDOM_EMOJIS)); }});
reg('yesno', { category: 'Fun', desc: '.yesno', run: async ({ reply }) => { await reply(pick(['✅ Yes', '❌ No'])); }});
const RANDOM_WORDS = ['Serendipity', 'Wanderlust', 'Ephemeral', 'Luminous', 'Mosaic', 'Nostalgia', 'Solitude', 'Euphoria', 'Whimsical', 'Velvet'];
reg('randomword', { category: 'Fun', desc: '.randomword', run: async ({ reply }) => { await reply(`📖 ${pick(RANDOM_WORDS)}`); }});
reg('randomletter', { category: 'Fun', desc: '.randomletter', run: async ({ reply }) => { await reply(String.fromCharCode(65 + randInt(0, 25))); }});
const RANDOM_COUNTRIES = ['Sri Lanka', 'Japan', 'Brazil', 'Canada', 'Kenya', 'Norway', 'India', 'Italy', 'Egypt', 'Australia'];
reg('randomcountry', { category: 'Fun', desc: '.randomcountry', run: async ({ reply }) => { await reply(`🌍 ${pick(RANDOM_COUNTRIES)}`); }});
const RANDOM_ANIMALS = ['Lion', 'Dolphin', 'Eagle', 'Panda', 'Wolf', 'Elephant', 'Tiger', 'Owl', 'Fox', 'Otter'];
reg('randomanimal', { category: 'Fun', desc: '.randomanimal', run: async ({ reply }) => { await reply(`🐾 ${pick(RANDOM_ANIMALS)}`); }});
const RANDOM_SPORTS = ['Cricket', 'Football', 'Badminton', 'Volleyball', 'Chess', 'Tennis', 'Swimming', 'Rugby', 'Basketball', 'Athletics'];
reg('randomsport', { category: 'Fun', desc: '.randomsport', run: async ({ reply }) => { await reply(`🏆 ${pick(RANDOM_SPORTS)}`); }});

// ---- MORE FUN (25) ----
const PICKUP_LINES = ["Are you Wi-Fi? Because I'm really feeling a connection.", "Do you have a map? I keep getting lost in your eyes.", "Is your name Google? Because you have everything I've been searching for.", "Are you a parking ticket? Because you've got fine written all over you.", "If you were a vegetable, you'd be a cute-cumber."];
reg('pickup', { category: 'Fun', desc: '.pickup', run: async ({ reply }) => { await reply(`💘 ${pick(PICKUP_LINES)}`); }});
const DAD_JOKES = ["Why don't skeletons fight each other? They don't have the guts.", "I'm reading a book on anti-gravity. It's impossible to put down!", "Why did the scarecrow win an award? He was outstanding in his field.", "I used to be a banker, but I lost interest.", "What do you call fake spaghetti? An impasta."];
reg('dadjoke', { category: 'Fun', desc: '.dadjoke', run: async ({ reply }) => { await reply(`👨 ${pick(DAD_JOKES)}`); }});
const KNOCK_KNOCK = ["Knock knock! Who's there? Lettuce. Lettuce who? Lettuce in, it's cold out here!", "Knock knock! Who's there? Boo. Boo who? Aww, don't cry, it's just a joke!", "Knock knock! Who's there? Cargo. Cargo who? Car go 'vroom vroom'!"];
reg('knockknock', { category: 'Fun', desc: '.knockknock', run: async ({ reply }) => { await reply(pick(KNOCK_KNOCK)); }});
reg('luckynumber', { category: 'Fun', desc: '.luckynumber', run: async ({ reply }) => { await reply(`🍀 Your lucky number today is *${randInt(1, 99)}*`); }});
reg('zodiaccompat', { category: 'Fun', desc: '.zodiaccompat [sign1] [sign2]', run: async ({ reply, args }) => {
    if (args.length < 2) return reply('❌ Usage: .zodiaccompat leo aries');
    await reply(`💫 ${args[0]} + ${args[1]} compatibility: *${randInt(30, 100)}%*`);
}});
const SUPERHERO_ADJ = ['Shadow', 'Crimson', 'Iron', 'Silent', 'Blazing', 'Mystic', 'Storm', 'Phantom'];
const SUPERHERO_NOUN = ['Falcon', 'Wolf', 'Blade', 'Guardian', 'Viper', 'Hawk', 'Titan', 'Ghost'];
reg('superhero', { category: 'Fun', desc: '.superhero', run: async ({ reply }) => { await reply(`🦸 ${pick(SUPERHERO_ADJ)} ${pick(SUPERHERO_NOUN)}`); }});
const VILLAIN_ADJ = ['Dark', 'Vile', 'Wicked', 'Grim', 'Toxic', 'Savage', 'Cruel', 'Rogue'];
reg('villainname', { category: 'Fun', desc: '.villainname', run: async ({ reply }) => { await reply(`🦹 ${pick(VILLAIN_ADJ)} ${pick(SUPERHERO_NOUN)}`); }});
const ANIME_FACTS = ["Studio Ghibli was co-founded by Hayao Miyazaki in 1985.", "One Piece has been running since 1997 and is still ongoing.", "Astro Boy is considered one of the earliest anime series, from 1963.", "Naruto's iconic running pose was inspired by real ninja stealth stances."];
reg('animefact', { category: 'Fun', desc: '.animefact', run: async ({ reply }) => { await reply(`🎌 ${pick(ANIME_FACTS)}`); }});
const MOVIE_FACTS = ["The Lumière brothers screened the first public film in 1895.", "Titanic (1997) held the highest-grossing film record for 12 years.", "The Wilhelm Scream sound effect has been used in over 400 films.", "Avatar (2009) took over a decade to develop the technology used to film it."];
reg('moviefact', { category: 'Fun', desc: '.moviefact', run: async ({ reply }) => { await reply(`🎬 ${pick(MOVIE_FACTS)}`); }});
const SPACE_FACTS = ["A day on Venus is longer than its year.", "Neutron stars can spin at over 600 rotations per second.", "There are more stars in the universe than grains of sand on Earth.", "The footprints on the Moon will likely stay there for millions of years."];
reg('spacefact', { category: 'Fun', desc: '.spacefact', run: async ({ reply }) => { await reply(`🚀 ${pick(SPACE_FACTS)}`); }});
const TECH_FACTS = ["The first computer mouse was made of wood.", "More than 90% of the world's currency exists only digitally.", "The first 1GB hard drive (1980) weighed over 500 pounds.", "Email existed before the World Wide Web."];
reg('techfact', { category: 'Fun', desc: '.techfact', run: async ({ reply }) => { await reply(`💻 ${pick(TECH_FACTS)}`); }});
const MYTH_FACTS = ["In Norse mythology, Thor's hammer Mjolnir could only be lifted by the worthy.", "The Greek Titan Atlas was condemned to hold up the sky, not the Earth.", "Anubis, the Egyptian god of the dead, has the head of a jackal.", "In Sri Lankan folklore, the Mahasona is a fearsome graveyard demon."];
reg('mythfact', { category: 'Fun', desc: '.mythfact', run: async ({ reply }) => { await reply(`📜 ${pick(MYTH_FACTS)}`); }});
const BRAIN_TEASERS = [{ q: 'What has to be broken before you can use it?', a: 'An egg' }, { q: 'What gets wetter the more it dries?', a: 'A towel' }, { q: 'What has keys but no locks, space but no room?', a: 'A keyboard' }];
reg('brainteaser', { category: 'Fun', desc: '.brainteaser', run: async ({ reply }) => { const b = pick(BRAIN_TEASERS); await reply(`🧠 ${b.q}\n||Answer: ${b.a}||`); }});
const SCENARIOS = ['You wake up with the ability to talk to animals, but only chickens.', 'You can teleport, but only to places you have already sneezed.', 'You gain super strength, but only on Tuesdays.'];
reg('scenario', { category: 'Fun', desc: '.scenario', run: async ({ reply }) => { await reply(`🎭 ${pick(SCENARIOS)}`); }});
const NICKNAME_ADJ = ['Sunny', 'Sparky', 'Breezy', 'Cosmic', 'Jolly', 'Turbo', 'Lucky', 'Zesty'];
reg('nickname', { category: 'Fun', desc: '.nickname [name]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide a name.'); await reply(`✨ ${pick(NICKNAME_ADJ)} ${q}`);
}});
reg('shipname', { category: 'Fun', desc: '.shipname [name1] [name2]', run: async ({ reply, args }) => {
    if (args.length < 2) return reply('❌ Usage: .shipname Alex Sam');
    const a = args[0], b = args[1];
    await reply(`💞 Ship Name: *${a.slice(0, Math.ceil(a.length / 2))}${b.slice(Math.floor(b.length / 2))}*`);
}});
reg('crushrate', { category: 'Fun', desc: '.crushrate [name]', run: async ({ reply, q }) => {
    if (!q) return reply('❌ Provide a name.'); await reply(`💓 Your crush meter for *${q}*: ${randInt(0, 100)}%`);
}});
reg('iqtest', { category: 'Fun', desc: '.iqtest', run: async ({ reply }) => { await reply(`🧠 Your (very unofficial and just-for-fun) IQ today: *${randInt(85, 145)}*`); }});
reg('luckday', { category: 'Fun', desc: '.luckday', run: async ({ reply }) => {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    await reply(`🍀 Your lucky day this week is *${pick(days)}*`);
}});
reg('powerlevel', { category: 'Fun', desc: '.powerlevel', run: async ({ reply }) => { await reply(`⚡ Power Level: *${randInt(1000, 9999)}* — it's over 9000... almost!`); }});
const ANIMAL_PERSONALITIES = ['a wise old owl', 'a playful otter', 'a loyal wolf', 'a curious fox', 'a gentle deer', 'a bold lion'];
reg('animalpersonality', { category: 'Fun', desc: '.animalpersonality', run: async ({ reply }) => { await reply(`🐾 Your spirit animal personality: *${pick(ANIMAL_PERSONALITIES)}*`); }});
reg('secretadmirer', { category: 'Fun', desc: '.secretadmirer', run: async ({ reply }) => { await reply(pick(['👀 Someone in this chat might have a crush on you...', '💌 Your secret admirer is closer than you think!', '😏 Someone thinks you are pretty amazing.'])); }});
const FUTURE_JOBS = ['Astronaut', 'Chef', 'Game Developer', 'Detective', 'Musician', 'Marine Biologist', 'Pilot', 'Architect'];
reg('futurejob', { category: 'Fun', desc: '.futurejob', run: async ({ reply }) => { await reply(`💼 Your future job: *${pick(FUTURE_JOBS)}*`); }});
const PAST_LIVES = ['a pirate captain', 'a royal scribe', 'a wandering monk', 'a Viking explorer', 'a court jester', 'a silk road merchant'];
reg('pastlife', { category: 'Fun', desc: '.pastlife', run: async ({ reply }) => { await reply(`🕰️ In a past life, you were *${pick(PAST_LIVES)}*`); }});
const SUPERPOWERS = ['Invisibility', 'Time Travel', 'Mind Reading', 'Super Speed', 'Flight', 'Shape-shifting', 'Teleportation'];
reg('superpower', { category: 'Fun', desc: '.superpower', run: async ({ reply }) => { await reply(`🦸 Your superpower would be: *${pick(SUPERPOWERS)}*`); }});

// ---- GROUP & OWNER UTILITIES (10) ----
reg('groupid', { category: 'Group', desc: '.groupid', groupOnly: true, run: async ({ reply, from }) => { await reply(`🆔 Group ID: ${from}`); }});
reg('grouppic', { category: 'Group', desc: '.grouppic', groupOnly: true, run: async ({ sock, from, reply }) => {
    try {
        const url = await sock.profilePictureUrl(from, 'image');
        await sock.sendMessage(from, { image: { url }, caption: '🖼️ Group Picture' });
    } catch (e) { await reply('❌ This group has no profile picture.'); }
}});
reg('membercount', { category: 'Group', desc: '.membercount', groupOnly: true, run: async ({ reply, groupMetadata }) => {
    await reply(`👥 Members: ${groupMetadata?.participants?.length || 0}`);
}});
reg('groupowner', { category: 'Group', desc: '.groupowner', groupOnly: true, run: async ({ reply, groupMetadata }) => {
    await reply(groupMetadata?.owner ? `👑 Group Owner: @${groupMetadata.owner.split('@')[0]}` : 'ℹ️ Owner info not available for this group.');
}});
reg('tagadmins', { category: 'Group', desc: '.tagadmins [message]', groupOnly: true, run: async ({ sock, from, groupMetadata, q }) => {
    const admins = groupMetadata.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
    if (!admins.length) return sock.sendMessage(from, { text: 'ℹ️ No admins found.' });
    await sock.sendMessage(from, { text: `📢 ${q || 'Attention admins!'}\n\n${admins.map(a => `@${a.id.split('@')[0]}`).join(' ')}`, mentions: admins.map(a => a.id) });
}});
reg('getpp', { category: 'Owner', desc: '.getpp (reply to a message)', run: async ({ sock, from, msg, reply }) => {
    const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!target) return reply('❌ Reply to a message from the person whose profile picture you want.');
    try {
        const url = await sock.profilePictureUrl(target, 'image');
        await sock.sendMessage(from, { image: { url }, caption: '🖼️ Profile Picture' });
    } catch (e) { await reply('❌ Could not fetch profile picture (may be private).'); }
}});
reg('blocklist', { category: 'Owner', desc: '.blocklist', ownerOnly: true, run: async ({ sock, reply }) => {
    try {
        const list = await sock.fetchBlocklist();
        await reply(list.length ? `🚫 *Blocked Contacts:*\n${list.map(j => j.split('@')[0]).join('\n')}` : 'ℹ️ No blocked contacts.');
    } catch (e) { await reply('❌ Could not fetch blocklist.'); }
}});
reg('groupdesc', { category: 'Group', desc: '.groupdesc', groupOnly: true, run: async ({ reply, groupMetadata }) => {
    await reply(groupMetadata?.desc ? `📄 *Group Description:*\n${groupMetadata.desc}` : 'ℹ️ No description set for this group.');
}});
reg('jid', { category: 'System', desc: '.jid', run: async ({ reply, sender }) => { await reply(`🆔 Your JID: ${sender}`); }});
reg('stats', { category: 'System', desc: '.stats', run: async ({ reply }) => {
    const uptimeSec = Math.floor(process.uptime());
    const h = Math.floor(uptimeSec / 3600), m = Math.floor((uptimeSec % 3600) / 60);
    await reply(`📊 *${BOT_NAME} Stats*\n┃ ⚡ Commands: ${new Set(Object.values(commands)).size}+\n┃ 🤖 Active Bots: ${activeBotCount()}\n┃ ⏱️ Uptime: ${h}h ${m}m\n┃ 💾 Sessions: ${sessions.size}`);
}});

// Emoji shown per category header in the menu — keep this consistent with
// the emoji the bot uses elsewhere (alive/owner cards) for a unified feel.
const CATEGORY_EMOJI = {
    System: '🚀',
    Owner: '👑',
    Group: '🛡️',
    Fun: '🎉',
    Tools: '🧰',
    Downloader: '📥',
    Sticker: '🖼️',
    Search: '🔎',
};
// A small rotating icon set per category so each command line gets its own
// bullet instead of one flat "➤" everywhere — gives the menu a premium feel.
const CATEGORY_BULLETS = {
    System: ['⚡', '🔋', '📶', '🛰️'],
    Owner: ['👑', '💎', '🗝️'],
    Group: ['🛡️', '🔨', '📢', '🔗'],
    Fun: ['🎲', '🎭', '🔥', '💫', '🃏'],
    Tools: ['🧩', '🔧', '📐', '🔢', '📎'],
    Downloader: ['📥', '🎬', '🎵'],
    Sticker: ['🖼️', '✂️'],
    Search: ['🔎', '🌐'],
};

// Converts plain text into Unicode "Mathematical Sans-Bold" characters —
// these are real, distinct Unicode codepoints (not a custom font), so they
// render as a bold, premium-looking typeface on every device/WhatsApp
// client without needing any special font support. Only letters/digits are
// converted; spaces, emoji, and punctuation pass through unchanged so
// syntax like ".ping [text]" stays fully readable.
// A little "fancy font" engine — converts normal text into several different
// real Unicode typefaces (not images, not a custom font — genuine distinct
// codepoints), so different parts of the menu/replies can each use a
// different eye-catching style, exactly like the popular "fancy font"
// generator apps. Renders correctly on every device/WhatsApp client with no
// special font installed.
const FONT_OFFSETS = {
    boldSans: { upper: 0x1D5D4, lower: 0x1D5EE, digit: 0x1D7EC },       // 𝗕𝗼𝗹𝗱 𝗦𝗮𝗻𝘀
    italicSans: { upper: 0x1D608, lower: 0x1D622, digit: null },        // 𝘐𝘵𝘢𝘭𝘪𝘤
    boldItalicSans: { upper: 0x1D63C, lower: 0x1D656, digit: null },    // 𝙄𝙩𝙖𝙡𝙞𝙘 𝘽𝙤𝙡𝙙
    script: { upper: 0x1D49C, lower: 0x1D4B6, digit: null },            // 𝒮𝒸𝓇𝒾𝓅𝓉 (with known gaps, patched below)
    boldScript: { upper: 0x1D4D0, lower: 0x1D4EA, digit: null },        // 𝓑𝓸𝓵𝓭 𝓢𝓬𝓻𝓲𝓹𝓽
    doubleStruck: { upper: 0x1D538, lower: 0x1D552, digit: 0x1D7D8 },   // 𝔻𝕠𝕦𝕓𝕝𝕖 (with known gaps, patched below)
    fraktur: { upper: 0x1D504, lower: 0x1D51E, digit: null },           // 𝔉𝔯𝔞𝔨𝔱𝔲𝔯 (with known gaps, patched below)
    monospace: { upper: 0x1D670, lower: 0x1D68A, digit: 0x1D7F6 },      // 𝚖𝚘𝚗𝚘
};
// A handful of math-alphanumeric letters were left as their original
// Unicode "compatibility" codepoints instead of getting a spot in the
// dedicated block, so the formula above misses them — patch those in.
const FONT_EXCEPTIONS = {
    script: { C: '𝒞', H: 'ℋ', I: 'ℐ', L: 'ℒ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' },
    doubleStruck: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' },
    fraktur: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' },
};
function toFont(text, style) {
    const cfg = FONT_OFFSETS[style];
    if (!cfg) return String(text);
    const exceptions = FONT_EXCEPTIONS[style] || {};
    return String(text).replace(/[A-Za-z0-9]/g, (ch) => {
        if (exceptions[ch]) return exceptions[ch];
        const code = ch.charCodeAt(0);
        if (code >= 65 && code <= 90 && cfg.upper) return String.fromCodePoint(cfg.upper + (code - 65));
        if (code >= 97 && code <= 122 && cfg.lower) return String.fromCodePoint(cfg.lower + (code - 97));
        if (code >= 48 && code <= 57 && cfg.digit) return String.fromCodePoint(cfg.digit + (code - 48));
        return ch;
    });
}
// Shorthand helpers used throughout the bot's replies.
const toProFont = (t) => toFont(t, 'boldSans');
const toItalic = (t) => toFont(t, 'italicSans');
const toBoldItalic = (t) => toFont(t, 'boldItalicSans');
const toScript = (t) => toFont(t, 'script');
const toBoldScript = (t) => toFont(t, 'boldScript');
const toDoubleStruck = (t) => toFont(t, 'doubleStruck');
const toFraktur = (t) => toFont(t, 'fraktur');
const toMonospaceFont = (t) => toFont(t, 'monospace');

// Big block-letter "ASCII art" banner for headers — a 5-row dot-matrix font
// rendered with █ blocks. Must be wrapped in a ``` monospace code block when
// sent, or the columns won't line up on WhatsApp.
const ART_FONT = {
    M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
    A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
    D: ['████ ', '█   █', '█   █', '█   █', '████ '],
    U: ['█   █', '█   █', '█   █', '█   █', ' ███ '],
    S: [' ████', '█    ', ' ███ ', '    █', '████ '],
    H: ['█   █', '█   █', '█████', '█   █', '█   █'],
    N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
    K: ['█  █ ', '█ █  ', '██   ', '█ █  ', '█  █ '],
    O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
    W: ['█   █', '█   █', '█ █ █', '██ ██', '█   █'],
    R: ['████ ', '█   █', '████ ', '█ █  ', '█  █ '],
    P: ['████ ', '█   █', '████ ', '█    ', '█    '],
    ' ': ['  ', '  ', '  ', '  ', '  '],
};
function generateArt(word) {
    const chars = word.toUpperCase().split('').map(c => ART_FONT[c] || ART_FONT[' ']);
    return [0, 1, 2, 3, 4].map(row => chars.map(c => c[row]).join(' ')).join('\n');
}

function getHour() {
    return new Date().getUTCHours();
}
function greeting() {
    const h = getHour();
    if (h < 12) return 'Good Morning 🌅';
    if (h < 17) return 'Good Afternoon ☀️';
    if (h < 20) return 'Good Evening 🌇';
    return 'Good Night 🌙';
}

function buildMenu(filterCat) {
    const grouped = {};
    const printed = new Set();
    for (const [name, def] of Object.entries(commands)) {
        if (printed.has(def)) continue;
        printed.add(def);
        if (!grouped[def.category]) grouped[def.category] = [];
        grouped[def.category].push(def.desc);
    }
    // Fixed, sensible category order (falls back to alphabetical for any
    // category not listed here) so the menu reads the same every time.
    const CATEGORY_ORDER = ['System', 'Owner', 'Group', 'Downloader', 'Fun', 'Tools', 'Text', 'Sticker', 'Search'];
    let cats = Object.keys(grouped).sort((a, b) => {
        const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
    });

    // .menu [category] — show just that category's full command list
    if (filterCat) {
        const match = cats.find(c => c.toLowerCase() === filterCat.toLowerCase());
        if (!match) return `❌ Unknown category *${filterCat}*.\n📌 Available: ${cats.join(', ')}\n\nType *.menu* to see the full index.`;
        const emoji = CATEGORY_EMOJI[match] || '✨';
        const bullets = CATEGORY_BULLETS[match] || ['✨'];
        let out = `┏━❮ ${emoji} ❯━ ${toBoldScript(match)} (${grouped[match].length}) ━┓\n`;
        grouped[match].forEach((d, i) => { out += `┃ ${bullets[i % bullets.length]} ${d}\n`; });
        out += `┗━━━━━━━━━━━━━━━━━┛\n\n📖 Type *.menu* to go back to the full index.`;
        return out;
    }

    // Default view: a compact category index (keeps the message short and
    // readable even with 200+ commands) — open a category with .menu [name].
    // Deliberately mixes a few different fancy Unicode typefaces (bold,
    // script, double-struck, fraktur) instead of one uniform style, for a
    // varied "premium" look throughout the card. A short block-letter ASCII
    // art banner ("MD") leads it off — kept short so it doesn't wrap on a
    // narrow phone screen inside its monospace code block.
    let out = '```\n' + generateArt('MD') + '\n```\n';
    out += `╔═❖ ${toBoldScript(BOT_NAME)} 👑 ❖═╗\n`;
    out += `║ ${toItalic(greeting())}\n`;
    out += `║ 💎 ${toProFont('Edition')}: ${toDoubleStruck('PRO')}\n`;
    out += `║ 👤 ${toProFont('Owner')}: ${toFraktur(OWNER_NAME)}\n`;
    out += `║ ⚡ ${toProFont('Commands')}: ${printed.size}+ across ${cats.length} categories\n`;
    out += `║ 📢 ${toProFont('Channel')}: ${CHANNEL_LINK}\n`;
    out += `╚══════════════════╝\n\n`;

    cats.forEach((cat, idx) => {
        const emoji = CATEGORY_EMOJI[cat] || '✨';
        const num = String(idx + 1).padStart(2, '0');
        const tag = cat === 'Downloader' ? '  🆕' : '';
        out += `┃ ❮${num}❯ ${emoji} ${toProFont(cat)} — ${grouped[cat].length} cmds${tag}\n`;
    });

    out += `\n📖 Type *.menu [category]* to open one\n💡 Example: *.menu Downloader*\n`;
    out += `\n> 💎 ${toBoldScript(BOT_NAME + ' PRO')} — ${toItalic('Powered By Nimah Dev')} 🔥`;
    return out;
}

// =========================================================================
// Main Bot Logic
// =========================================================================
async function startBotSession(sessionId) {
    let s = sessions.get(sessionId);
    if (!s) {
        s = {
            sock: null, isConnected: false, currentQR: null,
            reconnectAttempts: 0, reconnectTimer: null, pairingInProgress: false,
            sessionDir: path.join(SESSION_ROOT, 'sessions', sessionId),
            autoStatus: { ...AUTO_STATUS_DEFAULT },
            createdAt: Date.now()
        };
        sessions.set(sessionId, s);
    }
    s.currentQR = null;
    const { state, saveCreds } = await useMultiFileAuthState(s.sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        // A custom platform string in the browser tuple (e.g. our bot name
        // as the "platform") gets rejected more often by WhatsApp Business
        // accounts — their linking flow validates against known device
        // fingerprints more strictly than the regular app does. Browsers.ubuntu()
        // sends a real, recognized fingerprint (with our bot name only as the
        // "browser" field) so QR linking works reliably on both WhatsApp and
        // WhatsApp Business.
        browser: Browsers.ubuntu(BOT_NAME),
        // Common fixes for pairing failures on resource-constrained hosts
        // (like Railway's free tier): skip syncing full chat history and
        // don't force an "online" presence right after pairing — both can
        // slow down or overload the socket during the critical pairing
        // handshake window, which can make WhatsApp reject the code even
        // though it looked "connected" on our side.
        syncFullHistory: false,
        markOnlineOnConnect: false,
        // Send keep-alive frames more frequently than the 30s default so we
        // detect a dead socket fast (and so Railway's network layer doesn't
        // treat the connection as idle and silently drop it while we wait
        // for the phone to submit the pairing code).
        keepAliveIntervalMs: 15000
    });
    s.sock = sock;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;

        // Full diagnostic dump of every connection.update event. This is the
        // piece that was missing before — we only logged on 'close'/'open',
        // so failures that happened silently (e.g. WhatsApp rejecting a
        // pairing attempt without ever emitting our tracked statusCode)
        // left no trace in the logs. Keep this on for now while debugging;
        // it's cheap and text-only.
        console.log(`📶 [${sessionId}] connection.update:`, JSON.stringify({
            connection,
            qr: qr ? '[qr present]' : undefined,
            isNewLogin,
            receivedPendingNotifications,
            errorMessage: lastDisconnect?.error?.message,
            statusCode: lastDisconnect?.error?.output?.statusCode
        }));

        if (qr) s.currentQR = qr;
        if (connection === 'open') s.currentQR = null;

        if (connection === 'close') {
            s.isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            // Clean up this socket instance's listeners so we don't stack
            // duplicate handlers on every reconnect (memory leak + duplicate replies).
            try {
                sock.ev.removeAllListeners();
            } catch (e) { /* ignore */ }

            if (statusCode === DisconnectReason.loggedOut) {
                const wasRegistered = !!state?.creds?.registered;
                if (!wasRegistered) {
                    // Either the code expired before it was entered, or
                    // WhatsApp rejected the pairing attempt for another
                    // reason. Check the connection.update log lines above
                    // (right before this one) for the real error message.
                    console.log(`⏰ [${sessionId}] Pairing did not complete (code expired or was rejected). Generate a new one from the pairing page.`);
                } else {
                    console.log(`🔌 [${sessionId}] Logged out from a previously linked session. Clearing session and restarting pairing.`);
                }
                s.reconnectAttempts = 0;
                fs.rm(s.sessionDir, { recursive: true, force: true }, () => startBotSession(sessionId));
                return;
            }

            if (statusCode === DisconnectReason.badSession) {
                console.log(`⚠️ [${sessionId}] Bad session file. Clearing session and restarting.`);
                s.reconnectAttempts = 0;
                fs.rm(s.sessionDir, { recursive: true, force: true }, () => startBotSession(sessionId));
                return;
            }

            if (statusCode === DisconnectReason.connectionReplaced) {
                // Another session (e.g. WhatsApp opened elsewhere with same
                // creds) took over. Don't hammer reconnects in this case.
                console.log(`⚠️ [${sessionId}] Connection replaced by another session. Not auto-reconnecting.`);
                return;
            }

            // For everything else (restartRequired, timedOut, connectionLost,
            // connectionClosed, unknown network blips, etc.) reconnect with
            // exponential backoff instead of a fixed 3s retry loop.
            s.reconnectAttempts++;
            const delay = Math.min(3000 * (2 ** (s.reconnectAttempts - 1)), MAX_RECONNECT_DELAY_MS);
            console.log(`🔌 [${sessionId}] Connection closed. Status: ${statusCode || 'unknown'}. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${s.reconnectAttempts})...`);

            clearTimeout(s.reconnectTimer);
            s.reconnectTimer = setTimeout(() => startBotSession(sessionId), delay);
        } else if (connection === 'open') {
            s.isConnected = true;
            s.reconnectAttempts = 0; // reset backoff once we're stably connected
            clearTimeout(s.reconnectTimer);
            console.log(`🤖 🚀 [${sessionId}] ${BOT_NAME} Power Bot Successfully Connected to WhatsApp! 🔥`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;

            // ---- Auto Status View/React ----
            if (msg.key.remoteJid === 'status@broadcast') {
                if (msg.key.fromMe) return;
                try {
                    if (s.autoStatus.view) await sock.readMessages([msg.key]);
                    if (s.autoStatus.react) {
                        await sock.sendMessage('status@broadcast', {
                            react: { text: s.autoStatus.emoji, key: msg.key }
                        }, { statusJidList: [msg.key.participant, sock.user.id] });
                    }
                } catch (e) { /* ignore status view/react errors */ }
                return;
            }
            if (msg.key.fromMe) return;

            const messageType = Object.keys(msg.message)[0];
            const body = messageType === 'conversation' ? msg.message.conversation :
                         messageType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text : '';
            if (!body) return;

            const from = msg.key.remoteJid;
            const sender = msg.key.participant || msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const args = body.trim().split(/ +/);
            const rawCommand = args.shift().toLowerCase();
            if (!rawCommand.startsWith('.') && !rawCommand.startsWith('/')) return;
            const command = rawCommand.slice(1);
            const q = args.join(' ');
            const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg });

            const def = commands[command];
            if (!def) return;

            let groupMetadata = null;
            let isSenderAdmin = false;
            if (isGroup) {
                try {
                    groupMetadata = await sock.groupMetadata(from);
                    const participant = groupMetadata.participants.find(p => p.id === sender);
                    isSenderAdmin = !!(participant && (participant.admin === 'admin' || participant.admin === 'superadmin'));
                } catch (e) { /* ignore */ }
            }

            if (def.groupOnly && !isGroup) return reply('❌ This command only works in groups.');
            if (def.adminOnly && !isSenderAdmin && !isOwner(sender)) return reply('❌ Only group admins can use this command.');
            if (def.ownerOnly && !isOwner(sender)) return reply('❌ Only the bot owner can use this command.');

            // Simple antilink enforcement for groups that enabled it
            if (isGroup) {
                const settings = getGroupSettings(from);
                if (settings.antilink && !isSenderAdmin && /chat\.whatsapp\.com\//i.test(body)) {
                    try {
                        await sock.sendMessage(from, { delete: msg.key });
                        await reply('🚫 Links are not allowed in this group.');
                    } catch (e) { /* ignore */ }
                }
            }

            await def.run({ sock, msg, from, sender, args, q, isGroup, groupMetadata, isSenderAdmin, reply, session: s });
        } catch (err) {
            console.log('Error handling command:', err);
        }
    });

    return sock;
}

// Resume any sessions that already have saved credentials on disk (e.g. a
// bot that was paired before a Railway redeploy, on a mounted volume).
function resumeSavedSessions() {
    const sessionsRoot = path.join(SESSION_ROOT, 'sessions');
    try {
        if (!fs.existsSync(sessionsRoot)) return;
        for (const id of fs.readdirSync(sessionsRoot)) {
            startBotSession(id).catch((err) => console.log(`Failed to resume session ${id}:`, err));
        }
    } catch (e) { /* ignore */ }
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web Server running on port ${PORT}`);
    console.log(`⚡ Loaded ${new Set(Object.values(commands)).size} commands.`);
    resumeSavedSessions();
});

process.on('unhandledRejection', (err) => console.log('Unhandled Rejection:', err));
// Never let one bad error take the whole server (and every paired bot) down.
process.on('uncaughtException', (err) => console.log('Uncaught Exception:', err));

// ---- Connection Watchdog ----
// Belt-and-braces on top of the reconnect logic in connection.update: if a
// session is somehow left disconnected with no reconnect scheduled (e.g. an
// edge case that slipped past the handlers above), force a fresh start
// instead of leaving that bot offline indefinitely.
setInterval(() => {
    for (const [id, s] of sessions.entries()) {
        if (!s.isConnected && !s.reconnectTimer && s.sock) {
            console.log(`🩺 [${id}] Watchdog: session looked stuck offline, restarting it.`);
            startBotSession(id).catch((err) => console.log(`Watchdog restart failed for ${id}:`, err));
        }
    }
}, 90000);
