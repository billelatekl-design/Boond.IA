'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

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

// Chemin vers le MCP server installé
function getMCPServerPath() {
  const candidates = [
    path.join(__dirname, 'node_modules', 'boondmanager-mcp-server', 'dist', 'index.js'),
    path.join(__dirname, 'node_modules', '.bin', 'boondmanager-mcp-server'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('boondmanager-mcp-server non trouvé. Lancez: npm install');
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Serve HTML
  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html); return;
  }

  // Login - validation identifiants BoondManager
  if (url.pathname === '/boond' && req.method === 'POST') {
    const body = await readBody(req);
    const { email, password, boondPath } = body;
    if (!email || !password || !boondPath) {
      json(res, 400, { error: 'email, password et boondPath requis' }); return;
    }
    const credentials = Buffer.from(email + ':' + password).toString('base64');
    try {
      const r = await httpsRequest('https://ui.boondmanager.com/api' + boondPath, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + credentials }
      });
      json(res, r.status, r.body);
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  // Agent - boucle agentique avec MCP server BoondManager
  if (url.pathname === '/agent' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) { json(res, 500, { error: 'Clé Anthropic non configurée' }); return; }
    const body = await readBody(req);
    const { email, password, question, history } = body;
    if (!email || !password || !question) { json(res, 400, { error: 'email, password, question requis' }); return; }

    let mcpClient = null;

    try {
      // Import dynamique du SDK MCP (ESM)
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

      const mcpPath = getMCPServerPath();

      // Lancer le MCP server avec les credentials de l'utilisateur
      const transport = new StdioClientTransport({
        command: 'node',
        args: [mcpPath],
        env: {
          ...process.env,
          BOOND_USER: email,
          BOOND_PASSWORD: password,
          BOOND_BASE_URL: 'https://ui.boondmanager.com/api',
          LOG_LEVEL: 'error'
        }
      });

      mcpClient = new Client({ name: 'boondai', version: '2.0.0' }, { capabilities: {} });
      await mcpClient.connect(transport);

      // Récupérer tous les outils du MCP server
      const { tools: mcpTools } = await mcpClient.listTools();

      // Convertir au format Anthropic (tronquer descriptions pour limiter les tokens)
      const anthropicTools = mcpTools.map(t => {
        const desc = (t.description || t.name).slice(0, 120);
        const schema = t.inputSchema || { type: 'object', properties: {} };
        // Garder uniquement les propriétés essentielles du schema pour réduire les tokens
        const trimmedSchema = {
          type: schema.type || 'object',
          properties: Object.fromEntries(
            Object.entries(schema.properties || {}).map(([k, v]) => [k, {
              type: v.type,
              description: (v.description || '').slice(0, 80),
              ...(v.enum ? { enum: v.enum } : {})
            }])
          ),
          ...(schema.required ? { required: schema.required } : {})
        };
        return { name: t.name, description: desc, input_schema: trimmedSchema };
      });

      const today = new Date().toISOString().split('T')[0];
      const SYS = `Tu es BoondAI, assistant expert BoondManager. Tu as accès à ${anthropicTools.length} outils pour interroger l'API BoondManager en temps réel.

Aujourd'hui : ${today}

RÈGLES:
- Utilise les outils disponibles pour répondre précisément à chaque question
- Si nécessaire, enchaîne plusieurs appels (ex: chercher une ressource puis ses projets)
- TJM = tarif journalier facturé au client HT
- CJM = non accessible via l'API externe BoondManager (limitation confirmée par leur support)
- state=1 = actif/en mission, state=0 = inactif/sorti
- CONSULTANT = typeOf=0 (interne) ou typeOf=1 (externe)
- Réponds en français, court et direct
- INTERDIT : emojis, ##, ###, **, tableaux, détails techniques
- Listes avec tirets uniquement`;

      const messages = [
        ...(Array.isArray(history) ? history.filter(m => m.role && m.content).slice(-10) : []),
        { role: 'user', content: question }
      ];

      let currentMessages = [...messages];
      const MAX_ITER = 15;
      let iter = 0;

      while (iter < MAX_ITER) {
        iter++;

        const r = await httpsRequest('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01'
          }
        }, {
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          system: SYS,
          tools: anthropicTools,
          messages: currentMessages
        });

        if (r.status !== 200) { json(res, r.status, r.body); return; }
        const resp = r.body;

        if (resp.stop_reason === 'end_turn') {
          const text = resp.content.find(b => b.type === 'text')?.text || '';
          json(res, 200, { answer: text }); return;
        }

        if (resp.stop_reason === 'tool_use') {
          const toolUses = resp.content.filter(b => b.type === 'tool_use');
          const toolResults = [];

          for (const toolUse of toolUses) {
            try {
              const result = await mcpClient.callTool({
                name: toolUse.name,
                arguments: toolUse.input
              });

              const content = Array.isArray(result.content)
                ? result.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n')
                : JSON.stringify(result);

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: content
              });
            } catch (toolErr) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `Erreur outil: ${toolErr.message}`,
                is_error: true
              });
            }
          }

          currentMessages = [
            ...currentMessages,
            { role: 'assistant', content: resp.content },
            { role: 'user', content: toolResults }
          ];
        } else {
          const text = resp.content?.find?.(b => b.type === 'text')?.text || '';
          json(res, 200, { answer: text }); return;
        }
      }

      json(res, 200, { answer: 'Requête trop complexe, veuillez reformuler.' });

    } catch(e) {
      const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e));
      console.error('[AGENT ERROR]', e);
      json(res, 500, { error: msg });
    } finally {
      if (mcpClient) {
        try { await mcpClient.close(); } catch {}
      }
    }
    return;
  }

  json(res, 404, { error: 'Route introuvable' });
});

server.listen(PORT, () => {
  console.log(`\n✅ BoondAI v2 (MCP) sur http://localhost:${PORT}\n`);
  console.log(`   ${fs.existsSync(path.join(__dirname, 'node_modules', 'boondmanager-mcp-server')) ? '✅ MCP server installé' : '⚠️  Lancez: npm install'}\n`);
});
