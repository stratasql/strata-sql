// Strata live view: serves the whole tool (canvas, navigator, help, settings, sample data, embeddings, history) to the default
// browser from a small local HTTP server. Node built-ins only. The file side (model, version log, .strata settings, CSV)
// is handled here the same way the VS Code extension does it. Security: loopback by default (another address only on request), random or given token, Host / Origin checks.
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const io = require('./hostio.js');
const embed = require('../media/embed.js');
const { mainPage, navPage, MEDIA } = require('./shell.js');
const { exportHtml } = require('./export.js');
const helpMd = require('./helpmd.js');
const project = require('./project.js');
const SM = require('../media/model.js');

let helpPage = null; // help.md does not change while the server runs: rendered once
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

// the project's folder when the model belongs to one (its manifest), else the nearest folder above the model that holds .strata or .git, else the model's own folder
function findRoot(file) {
  const r = project.resolve(file);
  if (r.manifest) return r.root;
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.strata')) || fs.existsSync(path.join(d, '.git'))) return d;
    if (d === path.dirname(d)) return path.dirname(file);
  }
}

// Where the server listens and how it is reached. Loopback (the default) accepts only its own Host names; any other address (Docker: 0.0.0.0) accepts any Host,
// because the access token is then the gate, and an Origin must equal the Host it was sent to. STRATA_TOKEN / `token` keeps the link stable between runs.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
function listenOptions({ host = '127.0.0.1', token }) {
  if (token !== undefined && !/^[\w-]{16,}$/.test(token)) throw new Error('the access token needs 16 or more letters, digits, - or _');
  return { host, open: !LOOPBACK.has(host), token: token || crypto.randomBytes(18).toString('base64url') };
}
const linkHost = (host) => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host);

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try { cp.execFile(cmd, args, () => {}); } catch { /* the URL is printed anyway */ }
}

// The HTTP shell (token / Host / Origin checks, /media assets, /help) shared by the single-part and the multi-part project server, so this
// security-relevant code exists once. Only the `/` and `/export.html` bodies and the handling of a posted message differ.
function httpShell({ name, token, open, getExportPage, handle, boot, getJson }) {
  const clients = new Set(); // server-sent-event responses
  const broadcast = (msg) => { for (const c of clients) c.write(`data: ${JSON.stringify(msg)}\n\n`); };
  const send = (res, code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'no-referrer', ...extra }); res.end(body); };
  const tokenOk = (u) => { const t = u.searchParams.get('t') || ''; return t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token)); };
  let hostHeaders = new Set();

  const server = http.createServer(async (req, res) => {
    try {
      if (!open && !hostHeaders.has(req.headers.host)) return send(res, 403, 'text/plain', 'Bad host'); // DNS-rebinding guard
      const u = new URL(req.url, 'http://x');
      if (req.method === 'POST' && req.headers.origin && !(open ? req.headers.origin.replace(/^https?:\/\//, '') === req.headers.host : hostHeaders.has(req.headers.origin.replace(/^https?:\/\//, '')))) return send(res, 403, 'text/plain', 'Bad origin');
      if (u.pathname.startsWith('/media/')) { // static assets: scripts, styles and help images only
        const rel = decodeURIComponent(u.pathname.slice(7)), p = path.join(MEDIA, rel);
        if (!p.startsWith(MEDIA + path.sep) || !TYPES[path.extname(p)] || !fs.existsSync(p)) return send(res, 404, 'text/plain', 'Not found');
        return send(res, 200, TYPES[path.extname(p)], fs.readFileSync(p));
      }
      if (!tokenOk(u)) return send(res, 403, 'text/plain', 'Open the link printed by Strata SQL (it contains an access token).');
      if (req.method === 'GET' && u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', mainPage({ inline: false, boot: { mode: 'live', name, token, ...boot }, title: name + ' · Strata SQL' }));
      if (req.method === 'GET' && u.pathname === '/nav') return send(res, 200, 'text/html; charset=utf-8', navPage({ inline: false, token }));
      if (req.method === 'GET' && u.pathname === '/help') return send(res, 200, 'text/html; charset=utf-8', (helpPage ||= helpMd.render(fs.readFileSync(path.join(__dirname, '..', 'help.md'), 'utf8'), 'Strata SQL help')));
      if (req.method === 'GET' && u.pathname === '/export.html') {
        let page; try { page = await getExportPage(); } catch (err) { return send(res, 500, 'text/plain', String(err.message)); }
        return send(res, 200, 'text/html; charset=utf-8', page, { 'content-disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}.html"` });
      }
      if (req.method === 'GET' && getJson) { const j = getJson(u); if (j !== undefined) return send(res, 200, 'application/json', JSON.stringify(j)); }
      if (req.method === 'GET' && u.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (req.method === 'POST' && u.pathname === '/msg') {
        const chunks = []; let n = 0; // bytes, decoded once: a multi-byte character can straddle two chunks
        for await (const chunk of req) { chunks.push(chunk); n += chunk.length; if (n > 64e6) { send(res, 413, 'text/plain', 'Too large'); return req.destroy(); } }
        return send(res, 200, 'application/json', JSON.stringify(await handle(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
      }
      send(res, 404, 'text/plain', 'Not found');
    } catch (err) { send(res, 500, 'text/plain', String(err.message)); }
  });
  return { server, broadcast, clients, setHostHeaders: (actual) => { hostHeaders = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]); } };
}

async function startLive({ file, root, port = 0, theme = null, host, token }) {
  file = path.resolve(file);
  // A project-index file has no model / history / positions of its own (its "file" is every part plus governance.json), so it gets the multi-part
  // server; callers keep using startLive for any *.model.json.
  if (project.readIndexFile(file)) return startProjectLive({ file, root, port, theme, host, token });
  root = root || findRoot(file);
  const archived = project.isArchived(file); // release 2 part 13: an archived (pre-split) file stays strictly read-only in the live view too,
  // exactly as it already is in the VS Code editor (ADR-0045 point 10) - the same ARCHIVED_BLOCKED list extension.js uses, moved to
  // lib/project.js in this pass so both hosts share it instead of each keeping (or, here, never having had) their own copy.
  const name = path.basename(io.stem(file)), R = () => project.resolve(file, { stop: root }); // where the model's files are (asked each time: a save may create the manifest)
  const L = listenOptions({ host, token });
  // history / positions: the version log and the canvas positions file; theme: the VS Code session's colours { name, kind, vars }
  const state = { text: '{}', history: null, positions: null, textDirty: false, historyDirty: false, positionsDirty: false, theme, cache: null, cacheN: 0 };
  let chain = Promise.resolve(); // serialises writes

  const sig = () => JSON.stringify([state.text, state.history]);
  const reload = async () => { state.text = (await io.readText(file)) ?? '{}'; state.history = await io.readHistory(R()); state.positions = await io.readText(io.layoutFilePathOf(file)); state.cache = (await io.readCache(root, file)) || undefined; state.textDirty = state.historyDirty = state.positionsDirty = false; };
  await reload();

  const keyStatus = () => Object.fromEntries(embed.PROVIDER_IDS.map((id) => [id, !embed.PROVIDERS[id].env ? 'local' : io.envKey(id) ? 'env' : null]));
  const lkey = io.layoutKey(root, file);
  const modelMsg = async () => ({ type: 'model', host: 'live', readOnly: archived || undefined, layoutKey: lkey, layout: await io.readLayout(root, lkey), text: state.text, history: state.history, layoutFile: state.positions, cache: state.cache, settings: await io.getSettings(root), dataDir: path.basename(R().dataDir), theme: state.theme,
    embed: await io.readEmbedStatus(file), embedKeys: keyStatus(), embedProviders: io.embedProviderInfo(), embedFile: path.basename(io.embedPathOf(file)) });

  // version log first, then positions, the project manifest and the model: if the log write fails the model still saves and the mismatch is reported when it is opened again
  const flush = () => (chain = chain.then(async () => {
    let wrote = false;
    if (state.historyDirty && state.history != null) { await io.writeAtomic(R().history, state.history); state.historyDirty = false; wrote = true; }
    if (state.positionsDirty && state.positions != null) { await io.writeAtomic(io.layoutFilePathOf(file), state.positions); state.positionsDirty = false; }
    if (state.textDirty) {
      let name_; try { name_ = JSON.parse(state.text).project?.name; } catch { /* not valid JSON */ }
      if (name_) project.ensurePart(R().root, file, name_);
      await io.writeAtomic(file, state.text); state.textDirty = false;
    }
    if (wrote) state.cacheN = await io.writeCache(root, file, state.history, state.cacheN);
  }));

  async function generateEmbeddings() {
    try {
      const results = await io.embedModel(file, state.text, await io.getSettings(root), io.envKey);
      shell.broadcast({ type: 'embedResult', results, status: await io.readEmbedStatus(file) });
    } catch (err) { shell.broadcast({ type: 'embedResult', error: err.message }); }
  }

  const ops = io.dataOps(R, (m) => shell.broadcast(m));
  async function handle(m) {
    if (archived && project.ARCHIVED_BLOCKED.has(m.type)) return []; // strictly read-only, belt and suspenders alongside modelMsg's readOnly
    switch (m.type) {
      case 'ready': if (!state.textDirty && !state.historyDirty && !state.positionsDirty) await reload(); return [await modelMsg()];
      case 'edit':
        state.text = String(m.text); state.textDirty = true;
        if (m.history != null) { state.history = String(m.history); state.historyDirty = true; }
        if (m.positions != null) { state.positions = String(m.positions); state.positionsDirty = true; }
        return [];
      case 'positions': // canvas positions: their own file, written at once (unless an older layout is waiting to be converted with the next save)
        state.positions = String(m.text);
        if (!state.positionsDirty) await io.writeAtomic(io.layoutFilePathOf(file), state.positions);
        return [];
      case 'newProject': return [{ type: 'toast', text: 'Create a project with the Strata SQL: New Project command in VS Code, or run: npx @stratasql/strata-sql init' }];
      case 'saveReady':
        if (m.text != null) { state.text = String(m.text); state.textDirty = true; }
        if (m.history != null) { state.history = String(m.history); state.historyDirty = true; }
        if (m.positions != null) { state.positions = String(m.positions); state.positionsDirty = true; }
        try { await flush(); } catch (err) { return [{ type: 'toast', text: 'Could not save: ' + err.message }]; }
        return [];
      case 'settings': await io.saveSettings(root, m.settings); return [];
      case 'layout': if (m.part === 'canvas' || m.part === 'nav' || m.part === 'browser') await io.saveLayout(root, lkey, m.part, m.state ?? null); return [];
      case 'data':
        if (m.op === 'open') return [{ type: 'toast', text: 'Sample data file: ' + io.dataFile(R(), m.file) }];
        if (Object.hasOwn(ops, m.op)) await ops[m.op](m);
        return [];
      case 'embed': generateEmbeddings(); return [];
      case 'embedKey': return [{ type: 'embedKeys', keys: keyStatus() }, { type: 'toast', text: 'In the live view API keys are read from environment variables (OPENAI_API_KEY, GEMINI_API_KEY, VOYAGE_API_KEY). Set them before starting the live view; the local models need no key.' }];
      case 'themeCss': return []; // only the navigator pane in the page uses it
      case 'openLive': return [{ type: 'toast', text: 'You are already in the live view.' }];
      default: return [];
    }
  }

  const shell = httpShell({
    name, token: L.token, open: L.open,
    getExportPage: async () => exportHtml({ name, modelText: state.text, historyText: state.history, layoutText: state.positions }),
    handle,
  });

  // an edit made outside (VS Code, git, another tool): pick it up unless there are unsaved changes here
  fs.watchFile(file, { interval: 700 }, async () => {
    if (state.textDirty || state.historyDirty || state.positionsDirty) return;
    const before = sig();
    await reload();
    if (sig() !== before) shell.broadcast(await modelMsg());
  });

  await new Promise((resolve, reject) => { shell.server.once('error', reject); shell.server.listen(port, L.host, resolve); });
  const actual = shell.server.address().port;
  shell.setHostHeaders(actual);
  return {
    file, port: actual, token: L.token, open: L.open, url: `http://${linkHost(L.host)}:${actual}/?t=${L.token}`,
    async close() { fs.unwatchFile(file); for (const c of shell.clients) c.end(); await flush().catch(() => {}); await new Promise((r) => shell.server.close(r)); },
    flush,
    setTheme(t) { state.theme = t; shell.broadcast({ type: 'theme', ...t }); }, // the VS Code theme changed
  };
}

// A split project's project-index file in the browser: the equivalent of extension.js's resolveIndexEditor. Editable through the same lib/project.js
// functions the VS Code host calls (editProject, projectSettings, governance, projectUndo/Redo, embeddings), so a write here and one there are
// identical. Its own function because the flows differ (every part's file, a merged history).
// No file watcher across the parts: every write this server makes re-assembles and re-serves the result; an external change (git pull, editing
// a part directly) shows after a reload, as in VS Code.
async function startProjectLive({ file, root, port = 0, theme = null, host, token }) {
  file = path.resolve(file);
  // `root` = the WORKSPACE folder (right for settings / layout, which are per workspace) but not necessarily where this index file's manifest lives
  // (a workspace can hold several nested projects), so the project root is resolved separately, once.
  const wsRoot = root || findRoot(file);
  const projRoot = project.resolve(file, { stop: wsRoot }).root;
  const name = path.basename(io.stem(file));
  const L = listenOptions({ host, token });
  const state = { theme };
  let chain = Promise.resolve(); // serialises writes across every part's files, the same reason the single-part server above does

  const manifest = () => project.readManifest(projRoot);
  const modelMsg = async () => {
    const man = manifest();
    const { F, domainOf } = project.assembledProjectModel(projRoot, man);
    return { type: 'model', host: 'live', text: SM.stringify(F), history: null, layoutFile: null, readOnly: true, indexFile: true, projectView: true,
      dataDir: '', theme: state.theme, settings: await io.getSettings(wsRoot),
      domains: project.domainsOf(man), domainOf,
      embedParts: project.partsEmbedStatus(projRoot, man), histories: project.partHistoryTexts(projRoot, man) };
  };
  const userInfo = () => io.userOf(wsRoot);

  // Embeddings once per domain part (mirrors extension.js#generateEmbeddingsForIndex); keys come from environment variables only.
  async function generateEmbeddingsForProject() {
    const settings = await io.getSettings(wsRoot), perPart = {};
    for (const p of manifest().parts || []) {
      const modelFile = path.resolve(projRoot, p.model);
      try { perPart[p.name] = { results: await io.embedModel(modelFile, await fs.promises.readFile(modelFile, 'utf8'), settings, io.envKey) }; }
      catch (err) { perPart[p.name] = { error: err.message }; }
    }
    return perPart;
  }

  // Every write below changes several files (logs before models), serialised through `chain` so two overlapping requests cannot interleave
  // and corrupt a part's log.
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.then(() => {}, () => {}); return run; };
  async function handle(m) {
    switch (m.type) {
      case 'ready':
        try { return [await modelMsg()]; } catch (err) { return [{ type: 'toast', text: 'Could not assemble the project: ' + err.message }]; }
      case 'editProject':
        return serial(async () => {
          try {
            const F = JSON.parse(m.text);
            project.applyProjectEdit(projRoot, manifest(), F, { user: await userInfo(), message: m.message, conceptDomains: m.conceptDomains });
            return [await modelMsg()];
          } catch (err) { return [{ type: 'toast', text: 'Could not save: ' + err.message }]; }
        });
      case 'projectSettings':
        return serial(async () => {
          try {
            project.updateProjectSettings(projRoot, manifest(), m.project, { user: await userInfo() });
            return [await modelMsg()];
          } catch (err) { return [{ type: 'toast', text: 'Could not update project settings: ' + err.message }]; }
        });
      case 'governance':
        return serial(async () => {
          try {
            project.updateGovernance(projRoot, m.governance, { user: await userInfo() });
            return [await modelMsg()];
          } catch (err) { return [{ type: 'toast', text: 'Could not update tags/policies: ' + err.message }]; }
        });
      case 'domains': // change 30: same as the VS Code host (lib/project.js#applyDomains); the reply also replaces the dialog's optimistic copy after a refusal
        return serial(async () => {
          let err = null;
          try { project.applyDomains(projRoot, manifest(), m.domains, { user: await userInfo() }); } catch (e) { err = e; }
          return [await modelMsg(), ...(err ? [{ type: 'toast', text: 'Could not save the domains: ' + err.message }] : [])];
        });
      case 'projectUndo': case 'projectRedo':
        return serial(async () => {
          const redo = m.type === 'projectRedo';
          try {
            const res = project.projectGoto(projRoot, manifest(), redo ? 'redo' : 'undo');
            const msgs = [await modelMsg()];
            if (!res) msgs.push({ type: 'toast', text: `Nothing to ${redo ? 'redo' : 'undo'} across the project's parts.` });
            return msgs;
          } catch (err) { return [{ type: 'toast', text: `Could not ${redo ? 'redo' : 'undo'}: ` + err.message }]; }
        });
      case 'embed':
        serial(async () => {
          try { const perPart = await generateEmbeddingsForProject(); shell.broadcast({ type: 'embedResult', perPart, embedParts: project.partsEmbedStatus(projRoot, manifest()) }); }
          catch (err) { shell.broadcast({ type: 'embedResult', error: err.message }); }
        });
        return [];
      // "Open <part> →" in the merged History drawer (release 2 part 12): there is no second browser tab for this server to open the part
      // in, unlike VS Code's own vscode.openWith - told to the user plainly instead of silently doing nothing.
      case 'openPart': return [{ type: 'toast', text: 'Open that part\'s own .model.json directly (in VS Code, or its own live view) to see its full version history.' }];
      case 'openLive': return [{ type: 'toast', text: 'You are already in the live view.' }];
      // everything else (edit, positions, domains, splitIntoDomains, settings...) is read-only here and ignored, exactly as it is for this
      // same tab in the VS Code host (resolveIndexEditor's own message handler has no case for any of them either).
      default: return [];
    }
  }

  const shell = httpShell({
    name, token: L.token, open: L.open,
    getExportPage: async () => { const man = manifest(), { F } = project.assembledProjectModel(projRoot, man), settings = await io.getSettings(wsRoot); return exportHtml({ name, theme: state.theme, modelText: SM.stringify(F), historyText: null, layoutText: null, themeSetting: settings.theme, themeVariant: settings.themeVariant }); },
    handle,
  });
  await new Promise((resolve, reject) => { shell.server.once('error', reject); shell.server.listen(port, L.host, resolve); });
  const actual = shell.server.address().port;
  shell.setHostHeaders(actual);
  return {
    file, port: actual, token: L.token, open: L.open, url: `http://${linkHost(L.host)}:${actual}/?t=${L.token}`,
    async close() { for (const c of shell.clients) c.end(); await new Promise((r) => shell.server.close(r)); },
    flush: async () => {}, // every write above is already synchronous-on-completion; nothing is ever left pending to flush
    setTheme(t) { state.theme = t; shell.broadcast({ type: 'theme', ...t }); },
  };
}

// The demo (`strata-sql live --demo`, also the Docker image with STRATA_DEMO=1): the shipped sample models for anyone to try. The server keeps no state and writes
// nothing (a posted message is ignored); media/shim.js plays the host inside the browser tab and keeps every change in sessionStorage.
async function startDemo({ port = 0, host, token }) {
  const L = listenOptions({ host, token }), samples = Object.entries(project.TEMPLATES).filter(([id]) => id !== 'blank').map(([id, t]) => ({ id, label: t.label, detail: t.detail })), cache = new Map();
  const shell = httpShell({ name: 'demo', token: L.token, open: L.open, boot: { mode: 'demo', samples }, handle: async () => [], getExportPage: async () => { throw new Error('not available in the demo'); },
    getJson: (u) => { // only ids of the shipped samples reach the disk
      if (u.pathname !== '/demo/sample') return undefined;
      const id = u.searchParams.get('id');
      if (!samples.some((s) => s.id === id)) return { error: 'unknown sample' };
      return cache.get(id) || cache.set(id, project.readSample(id)).get(id);
    } });
  await new Promise((resolve, reject) => { shell.server.once('error', reject); shell.server.listen(port, L.host, resolve); });
  const actual = shell.server.address().port;
  shell.setHostHeaders(actual);
  return { demo: true, port: actual, token: L.token, open: L.open, url: `http://${linkHost(L.host)}:${actual}/?t=${L.token}`, async close() { for (const c of shell.clients) c.end(); await new Promise((r) => shell.server.close(r)); } };
}

module.exports = { startLive, startProjectLive, startDemo, openBrowser };
