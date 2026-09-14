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
// Auto Status View/React — automatically opens (marks as read) and reacts to
// contacts' WhatsApp Status updates. In-memory only, toggle with .autostatus.
const autoStatusSettings = { view: true, react: true, emoji: '💚' };

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
    const caption = `${greeting()}\n\n┏━━⪩ *${BOT_NAME}* ⪨━━┓\n┃ ✅ *Status:* Online & Active\n┃ 🤖 *Mode:* Multi-Device Power Bot\n┃ 💎 *Version:* 6.0.0 Ultimate\n┃ ⏱️ *Uptime:* ${h}h ${m}m ${s}s\n┃ 👑 *Owner:* ${OWNER_NAME}\n┃ 📢 *Channel:* ${CHANNEL_LINK}\n┗━━━━━━━━━━━━━━━━━┛\n\n✨ Type *.menu* to see all commands!`;
    const logo = getBotLogo();
    if (logo) await sock.sendMessage(from, { image: logo, caption }, { quoted: msg });
    else await reply(caption);
}});
reg('runtime', { category: 'System', desc: '.runtime', aliases: ['uptime'], run: async ({ reply }) => {
    await reply(`⏱️ *Uptime:* ${fmtDuration(Date.now() - startTime)}`);
}});
reg('owner', { category: 'System', desc: '.owner', run: async ({ reply }) => {
    await reply(OWNER_NUMBER ? `╭━━━〔 *👑 OWNER INFO* 〕━━━┈⊷\n┃ 👤 *Name:* ${OWNER_NAME}\n┃ 📞 *Contact:* wa.me/${OWNER_NUMBER}\n┃ 📢 *Channel:* ${CHANNEL_LINK}\n╰━━━━━━━━━━━━━━━━━━━━━━━┈⊷` : '👑 Owner number not configured (set OWNER_NUMBER env var).');
}});
reg('autostatus', { category: 'Owner', desc: '.autostatus [view/react/emoji] [on/off/emoji]', ownerOnly: true, run: async ({ reply, args }) => {
    const mode = (args[0] || '').toLowerCase();
    const val = (args[1] || '').toLowerCase();
    if (!mode) {
        return reply(`👁️ *Auto Status Settings*\n┃ View: ${autoStatusSettings.view ? '✅ ON' : '❌ OFF'}\n┃ React: ${autoStatusSettings.react ? '✅ ON' : '❌ OFF'}\n┃ Emoji: ${autoStatusSettings.emoji}\n\n📌 Usage:\n.autostatus view on/off\n.autostatus react on/off\n.autostatus emoji 🔥`);
    }
    if (mode === 'view' || mode === 'react') {
        if (val !== 'on' && val !== 'off') return reply('❌ Use on or off.');
        autoStatusSettings[mode] = val === 'on';
        return reply(`✅ Auto status *${mode}* turned *${val.toUpperCase()}*.`);
    }
    if (mode === 'emoji') {
        if (!val) return reply('❌ Provide an emoji, e.g. .autostatus emoji 🔥');
        autoStatusSettings.emoji = args[1];
        return reply(`✅ Auto status react emoji set to ${autoStatusSettings.emoji}`);
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
reg('menu', { category: 'System', desc: '.menu', aliases: ['help'], run: async ({ sock, from, msg, reply }) => {
    const logo = getBotLogo();
    if (logo) await sock.sendMessage(from, { image: logo, caption: buildMenu() }, { quoted: msg });
    else await reply(buildMenu());
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

function buildMenu() {
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
    const cats = Object.keys(grouped).sort((a, b) => {
        const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
    });

    let out = `╔═❖ *👑 ${BOT_NAME} 👑* ❖═╗\n`;
    out += `║ ${greeting()}\n`;
    out += `║ 💎 *Edition:* PRO\n`;
    out += `║ 👤 *Owner:* ${OWNER_NAME}\n`;
    out += `║ ⚡ *Commands:* ${printed.size}+ across ${cats.length} categories\n`;
    out += `║ 📢 *Channel:* ${CHANNEL_LINK}\n`;
    out += `╚══════════════════╝\n`;

    cats.forEach((cat, idx) => {
        const list = grouped[cat];
        const emoji = CATEGORY_EMOJI[cat] || '✨';
        const bullets = CATEGORY_BULLETS[cat] || ['✨'];
        const num = String(idx + 1).padStart(2, '0');
        out += `\n┏━❮ ${num} ❯━ ${emoji} *${cat.toUpperCase()}* (${list.length}) ━┓\n`;
        list.forEach((d, i) => { out += `┃ ${bullets[i % bullets.length]} ${d}\n`; });
        out += `┗━━━━━━━━━━━━━━━━━┛\n`;
    });

    out += `\n┏━❮ ℹ️ ❯━ *HOW TO USE* ━┓\n┃ 📖 Type a command with *.* prefix\n┃ 💡 Example: *.ping*\n┗━━━━━━━━━━━━━━━━━┛\n`;
    out += `\n> 💎 *${BOT_NAME} PRO* — Powered By Nimah Dev 🔥`;
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
                    if (autoStatusSettings.view) await sock.readMessages([msg.key]);
                    if (autoStatusSettings.react) {
                        await sock.sendMessage('status@broadcast', {
                            react: { text: autoStatusSettings.emoji, key: msg.key }
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

            await def.run({ sock, msg, from, sender, args, q, isGroup, groupMetadata, isSenderAdmin, reply });
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
