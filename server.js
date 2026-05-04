const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
let ANTHROPIC_KEY = ''; // Set via /set-key endpoint from the UI

// ── HMAC-SHA256 JWT builder (Node.js) ──────────────────────────────────────
function b64u(s) {
  return Buffer.from(s).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function buildJwt(ut, ct, ck) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ userToken: ut, clientToken: ct, time: Math.floor(Date.now() / 1000), mode: 'normal' }));
  const sig = crypto.createHmac('sha256', ck).update(`${h}.${p}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${h}.${p}.${sig}`;
}

// ── Generic HTTPS request helper ───────────────────────────────────────────
function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Read request body ──────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// ── CORS headers ──────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, data) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── HTTP Server ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCors(res);

  // Preflight
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Serve index.html ──
  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── Proxy: BoondManager API ──
  if (url.pathname.startsWith('/boond/')) {
    const body = req.method === 'POST' ? await readBody(req) : null;
    const payload = body || {};
    const boondPath = url.pathname.replace('/boond', '') + url.search;
    const { ut, ct, ck, boondUrl } = payload;

    if (!ut || !ct || !ck) {
      // GET request — tokens in query params
      const qut = url.searchParams.get('ut');
      const qct = url.searchParams.get('ct');
      const qck = url.searchParams.get('ck');
      const qbase = url.searchParams.get('base') || 'https://ui.boondmanager.com/api';
      const qpath = url.pathname.replace('/boond', '') + '?' + [...url.searchParams.entries()]
        .filter(([k]) => !['ut','ct','ck','base'].includes(k))
        .map(([k,v]) => `${k}=${v}`).join('&');

      if (!qut || !qct || !qck) { json(res, 400, { error: 'Tokens manquants' }); return; }
      const jwt = buildJwt(qut, qct, qck);
      try {
        const r = await httpsRequest(qbase + qpath, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'X-Jwt-Client-BoondManager': jwt }
        });
        json(res, r.status, r.body);
      } catch (e) { json(res, 500, { error: e.message }); }
      return;
    }

    const jwt = buildJwt(ut, ct, ck);
    const base = boondUrl || 'https://ui.boondmanager.com/api';
    const apiPath = boondPath;
    try {
      const r = await httpsRequest(base + apiPath, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', 'X-Jwt-Client-BoondManager': jwt }
      }, body?.requestBody || null);
      json(res, r.status, r.body);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ── Set Anthropic key from UI ──
  if (url.pathname === '/set-key' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.key || !body.key.startsWith('sk-ant-')) {
      json(res, 400, { error: 'Clé invalide — doit commencer par sk-ant-' }); return;
    }
    ANTHROPIC_KEY = body.key;
    json(res, 200, { ok: true });
    return;
  }

  // ── Check if key is set ──
  if (url.pathname === '/has-key' && req.method === 'GET') {
    json(res, 200, { hasKey: !!ANTHROPIC_KEY });
    return;
  }

  // ── Proxy: Claude API ──
  if (url.pathname === '/claude' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) { json(res, 500, { error: 'Clé Anthropic non configurée — allez dans Paramètres.' }); return; }
    const body = await readBody(req);
    try {
      const r = await httpsRequest('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        }
      }, body);
      json(res, r.status, r.body);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  json(res, 404, { error: 'Route introuvable' });
});

server.listen(PORT, () => {
  console.log(`\n✅ BoondAI lancé sur http://localhost:${PORT}`);
  console.log(`   Ouvrez votre navigateur sur http://localhost:${PORT}`);
  console.log(`   Entrez votre clé Anthropic dans l'onglet Paramètres de l'app.\n`);
});
