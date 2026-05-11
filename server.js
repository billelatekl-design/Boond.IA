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

  // BoondManager proxy - BasicAuth
  if (url.pathname.startsWith('/boond') && req.method === 'POST') {
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

  // Debug: retourne tous les champs de tous les onglets d'une ressource
  if (url.pathname === '/debug-fields' && req.method === 'POST') {
    const body = await readBody(req);
    const { email, password, resourceId } = body;
    if (!email || !password || !resourceId) { json(res, 400, { error: 'email, password, resourceId requis' }); return; }
    const credentials = Buffer.from(email + ':' + password).toString('base64');
    const tabs = ['', '/administrative', '/technical-data', '/positionings', '/contracts'];
    const results = {};
    for (const tab of tabs) {
      try {
        const r = await httpsRequest(`https://ui.boondmanager.com/api/resources/${resourceId}${tab}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + credentials }
        });
        const attrs = r.body?.data?.attributes || r.body?.data || r.body;
        results[tab || 'main'] = { status: r.status, fields: typeof attrs === 'object' ? Object.keys(attrs) : attrs, raw: attrs };
      } catch(e) { results[tab || 'main'] = { error: e.message }; }
    }
    json(res, 200, results);
    return;
  }

  // Claude proxy
  if (url.pathname === '/claude' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) { json(res, 500, { error: 'Clé Anthropic non configurée sur le serveur' }); return; }
    const body = await readBody(req);
    try {
      const r = await httpsRequest('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
      }, body);
      json(res, r.status, r.body);
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  // Filtered count endpoint
  if (url.pathname === '/boond-count' && req.method === 'POST') {
    const body = await readBody(req);
    const { email, password, boondPath, filterField, filterValue } = body;
    if (!email || !password) { json(res, 400, { error: 'email et password requis' }); return; }
    const credentials = Buffer.from(email + ':' + password).toString('base64');
    try {
      const r = await httpsRequest('https://ui.boondmanager.com/api' + boondPath + '&number=500', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + credentials }
      });
      const data = r.body?.data || [];
      if (filterField && filterValue !== undefined) {
        const filtered = data.filter(item => String(item.attributes?.[filterField]) === String(filterValue));
        json(res, r.status, { data: filtered, meta: { totals: { rows: filtered.length } } });
      } else {
        json(res, r.status, r.body);
      }
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  // Agent endpoint - boucle agentique avec tool use
  if (url.pathname === '/agent' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) { json(res, 500, { error: 'Clé Anthropic non configurée' }); return; }
    const body = await readBody(req);
    const { email, password, question, history } = body;
    if (!email || !password || !question) { json(res, 400, { error: 'email, password, question requis' }); return; }

    const credentials = Buffer.from(email + ':' + password).toString('base64');
    const today = new Date().toISOString().split('T')[0];

    const tools = [{
      name: 'boond_api',
      description: `Interroge l'API BoondManager. Pagination automatique incluse.

ENDPOINTS LISTE (retournent plusieurs items, champs de base):
- /resources : ressources internes. Champs: state(1=actif,0=inactif), firstName, lastName, title, typeOf(0=consultant interne,1=consultant externe,2=ingénieur affaires,3=manager,7=alternant,13=RH), availability, averageDailyPriceExcludingTax(TJM), email1, phone1
- /candidates : candidats RH. Champs: firstName, lastName, title, email1, phone1
- /contacts : contacts CRM externes. Champs: firstName, lastName, email1, phone1, companyName
- /projects : projets. Champs: state(1=en cours,0=terminé), title, reference, startDate, endDate, totalExcludingTax
- /invoices : factures. Champs: state(0=impayée,1=payée), totalExcludingTax, reference, dueDate
- /absences : absences. Champs: startDate, endDate, type, resourceId
- /times : saisies de temps. Champs: date, duration, projectId, resourceId
- /companies : sociétés. Champs: name, email1, phone1
- /opportunities : opportunités. Champs: title, state, probability, amount
- /expenses : notes de frais. Champs: date, amount, type
- /orders : commandes. Champs: reference, totalExcludingTax, state
- /payments : paiements. Champs: date, amount, invoiceId

ENDPOINTS DETAIL (fiche complète via ID):
- /resources/{id} : fiche principale d'une ressource
- /resources/{id}/administrative : données administratives et financières: salaire, TJM, CJM (coût journalier)
- /resources/{id}/technical-data : compétences techniques
- /resources/{id}/positionings : positionnements/missions
- /resources/{id}/projects : projets de la ressource
- /resources/{id}/absences-reports : absences
- /projects/{id} : fiche complète d'un projet
- /contacts/{id} : fiche complète d'un contact
- /candidates/{id} : fiche complète d'un candidat

STRATÉGIE pour les données financières (CJM, salaire, etc.) d'une personne:
1. Appeler /resources?keywords=PRENOM+NOM pour trouver l'ID
2. Appeler /resources/{id}/administrative pour lire les données financières

PARAMS utiles (pour les endpoints liste):
- keywords=PRENOM+NOM : recherche par nom
- state=0 ou state=1 : filtrer par état
- typeOf=0,1,2... : filtrer par type
- startDate=YYYY-MM-DD&endDate=YYYY-MM-DD : filtrer par période`,
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Endpoint (ex: /resources, /projects)' },
          params: { type: 'string', description: 'Query string sans ? (ex: state=1&keywords=Jean+Dupont)' }
        },
        required: ['path']
      }
    }];

    const SYS = `Tu es BoondAI, assistant expert BoondManager. Tu interroges l'API en temps réel via l'outil boond_api.

Aujourd'hui : ${today}

RÈGLES:
- Appelle boond_api avec les bons paramètres pour répondre précisément
- Si nécessaire, fais plusieurs appels enchaînés (ex: chercher une personne puis ses projets)
- TJM = averageDailyPriceExcludingTax = tarif journalier facturé au client HT (disponible dans la liste /resources)
- CJM (Coût Journalier Moyen) : ce champ N'EST PAS exposé par l'API externe BoondManager. Si on te demande le CJM d'une ressource, réponds clairement : "Le CJM n'est pas accessible via l'API externe BoondManager. Vous pouvez le consulter directement dans la fiche de la ressource sur BoondManager." Ne dis jamais que le CJM "n'est pas renseigné" car il peut très bien être renseigné dans BoondManager mais simplement non exposé par l'API.
- state=1 = actif/en mission, state=0 = inactif/sorti
- CONSULTANT = typeOf=0 (interne) ou typeOf=1 (externe) uniquement
- DISPONIBLE IMMÉDIATEMENT = state=0 + availability="immediate"
- Réponds en français, court et direct
- INTERDIT : emojis, ##, ###, **, tableaux, détails techniques
- Listes avec tirets uniquement`;

    const messages = [
      ...(Array.isArray(history) ? history.filter(m => m.role && m.content).slice(-10) : []),
      { role: 'user', content: question }
    ];

    let currentMessages = messages;
    const MAX_ITER = 10;
    let iter = 0;

    try {
      while (iter < MAX_ITER) {
        iter++;
        const r = await httpsRequest('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
        }, { model: 'claude-sonnet-4-6', max_tokens: 4096, system: SYS, tools, messages: currentMessages });

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
            if (toolUse.name === 'boond_api') {
              const { path, params } = toolUse.input;
              let allData = [];
              let page = 1;
              let totalRows = null;
              const PAGE_SIZE = 100;
              while (page <= 50) {
                const qs = (params ? params + '&' : '') + `number=${PAGE_SIZE}&page=${page}`;
                const apiR = await httpsRequest(
                  `https://ui.boondmanager.com/api${path}?${qs}`,
                  { method: 'GET', headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + credentials } }
                );
                const data = apiR.body?.data || [];
                if (totalRows === null) {
                  totalRows = apiR.body?.meta?.totals?.rows ?? null;
                }
                allData = allData.concat(data);
                if (data.length === 0) break;
                if (totalRows !== null && allData.length >= totalRows) break;
                if (data.length < PAGE_SIZE) break;
                page++;
              }
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify({ data: allData, total: totalRows ?? allData.length })
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
      json(res, 200, { answer: 'Désolé, la requête a nécessité trop d\'étapes. Pouvez-vous reformuler ?' });
    } catch(e) { json(res, 500, { error: e.message }); }
    return;
  }

  json(res, 404, { error: 'Route introuvable' });
});

server.listen(PORT, () => {
  console.log(`\n✅ BoondAI sur http://localhost:${PORT}\n`);
});
