const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
let ANTHROPIC_KEY_RUNTIME = '';

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
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

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

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

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html); return;
  }

  if (url.pathname.startsWith('/boond/') && req.method === 'POST') {
    const body = await readBody(req);
    const { email, password, boondPath } = body;
    if (!email || !password) { json(res, 400, { error: 'Email et mot de passe requis' }); return; }
    const credentials = Buffer.from(email + ':' + password).toString('base64');
    const apiPath = boondPath + (url.search || '');
    try {
      const r = await httpsRequest('https://ui.boondmanager.com/api' + apiPath, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + credentials }
      });
      json(res, r.status, r.body);
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (url.pathname === '/set-key' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.key || !body.key.startsWith('sk-ant-')) { json(res, 400, { error: 'Clé invalide' }); return; }
    ANTHROPIC_KEY_RUNTIME = body.key;
    json(res, 200, { ok: true }); return;
  }

  if (url.pathname === '/claude' && req.method === 'POST') {
    const key = ANTHROPIC_KEY_RUNTIME || ANTHROPIC_KEY;
    if (!key) { json(res, 500, { error: 'Clé Anthropic non configurée' }); return; }
    const body = await readBody(req);
    try {
      const r = await httpsRequest('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      }, body);
      json(res, r.status, r.body);
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  json(res, 404, { error: 'Route introuvable' });
});

server.listen(PORT, () => {
  console.log(`\n✅ BoondAI lancé sur http://localhost:${PORT}`);
  console.log(`   Ouvrez votre navigateur sur http://localhost:${PORT}\n`);
});
