// Drives the real ModelEditor of extension.js (the host side of the save handshake) through stubbed vscode objects: what it sends the webview, and what
// it writes, when and in which order. Run: node tests/host.check.js. The real VS Code host (a real webview, native undo, the QuickPick UI) is not exercised.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), Module = require('module');
const REPO = path.join(__dirname, '..');
const SM = require('../media/model.js'), LG = require('../media/legacy.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-host-'));
const Uri = { file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => 'file://' + p, with(o) { return Uri.file(o.path !== undefined ? o.path : p); } }), joinPath: (u, ...s) => Uri.file(path.join(u.fsPath, ...s)), parse: (s) => ({ toString: () => s }) };
let provider = null, willSave = null, docChanged = null, navProvider = null;
const savedDialogs = []; // release 2 part 8 (ADR-0045 extended): captures each showSaveDialog's proposed default location
const vscode = {
  Uri, ViewColumn: {}, ColorThemeKind: {}, Range: class { constructor(...a) { this.a = a; } }, TextEdit: { replace: (r, t) => ({ text: t }) },
  WorkspaceEdit: class { replace(uri, r, text) { this.text = text; } },
  ProgressLocation: { Notification: 1 },
  workspace: { workspaceFolders: [{ uri: Uri.file(root) }], getWorkspaceFolder: () => ({ uri: Uri.file(root) }), fs: { writeFile: async (uri, buf) => fs.writeFileSync(uri.fsPath, buf) }, applyEdit: async (e) => { doc.text = e.text; return true; },
    // captures the LATEST registration, same as `willSave` below: each resolveCustomTextEditor call re-registers its own listener, and this
    // file drives one doc/panel at a time, so "the latest" is always the one under test (release 2 part 7's regression test uses it).
    onDidChangeTextDocument: (fn) => { docChanged = fn; return { dispose() {} }; }, onWillSaveTextDocument: (fn) => { willSave = fn; return { dispose() {} }; }, onDidChangeConfiguration: () => ({}), getConfiguration: () => ({ get: () => '' }) },
  window: { activeTextEditor: null, activeColorTheme: { kind: 2 }, onDidChangeActiveColorTheme: () => ({}), onDidChangeActiveTextEditor: () => ({}), registerCustomEditorProvider: (id, p) => { provider = p; return {}; }, registerWebviewViewProvider: (id, p) => { navProvider = p; return {}; },
    registerUriHandler: () => ({}), showWarningMessage: (m) => { warned.push(m); }, showErrorMessage: (m) => { throw new Error(m); }, showInformationMessage: (m) => { infoLog.push(m); return Promise.resolve(); },
    showSaveDialog: async (o) => { savedDialogs.push(o.defaultUri.fsPath); return o.defaultUri; },
    withProgress: async (opts, fn) => fn({ report: () => {} }) },
  commands: { registerCommand: () => ({}), executeCommand: async (...a) => { execLog.push(a); } }, env: { openExternal: async (u) => { opened.push(u.toString()); } },
};
const warned = [], execLog = [], infoLog = [], opened = []; // opened: release 2 part 13 - what openLiveFor() handed vscode.env.openExternal
// release 2 part 9: the index file's "generate embeddings for every domain" (generateEmbeddingsForIndex) drives the REAL media/embed.js
// pipeline; the local providers are replaced with a fast, deterministic, offline fake (same technique tests/embed.check.js already uses),
// so this test never downloads a model or needs a network. The hosted providers (openai/gemini/claude) need no faking: no key is ever
// configured (ctx.secrets.get returns undefined, no env vars), so they are reported "skipped" exactly as a real first run would be.
const EMB = require('../media/embed.js');
const fakeEmbed = async (f, key, texts) => texts.map(() => new Array(512).fill(0.1));
EMB.PROVIDERS.gemma.embed = fakeEmbed; EMB.PROVIDERS.minilm.embed = fakeEmbed;
const orig = Module._load;
Module._load = function (req, ...r) { return req === 'vscode' ? vscode : orig.call(this, req, ...r); };
const EXT = require(REPO + '/extension.js'); // kept: deactivate() closes any real live server release 2 part 13's tests below start for real
EXT.activate({ subscriptions: { push() {} }, extensionUri: Uri.file(REPO), secrets: { get: async () => undefined } });

const file = path.join(root, 'x.model.json'), f = (ext) => (ext === '.model.history.jsonl' ? path.join(root, 'history', 'x.history.jsonl') : path.join(root, 'x' + ext)); // the log is written under history/ (ADR-0044); positions and old files stay beside the model
const doc = { uri: Uri.file(file), text: '', getText() { return this.text; }, validateRange: (r) => r, lineCount: 1, isDirty: false };
const sent = [];
let handler = null, replyOnSave = { type: 'saveReady', text: null, history: null };
const panel = { active: true, visible: true, reveal() {}, onDidChangeViewState() {}, onDidDispose() {},
  webview: { options: null, html: '', cspSource: 'x', asWebviewUri: (u) => u, onDidReceiveMessage: (fn) => { handler = fn; },
    postMessage: (m) => { sent.push(m); if (m.type === 'beforeSave') setImmediate(() => handler({ ...replyOnSave })); return Promise.resolve(true); } } };
const rd = (p) => fs.readFileSync(p, 'utf8'), ex = (p) => fs.existsSync(p);
// release 2 part 13: a plain HTTP client for the REAL live server openLiveFor() starts (lib/live.js, not stubbed) - same shape as
// tests/live.check.js's own `req` helper.
const liveReq = (port, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/msg?t=' + srvToken, headers: { host: `127.0.0.1:${port}` } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b)));
  });
  r.on('error', reject); r.write(JSON.stringify(body)); r.end();
});
let srvToken = ''; // set from the URL openLiveFor() hands to vscode.env.openExternal, just before each liveReq() call below
const save = async () => { const jobs = []; await willSave({ document: doc, waitUntil: (p) => jobs.push(p) }); return Promise.all(jobs); };
const settle = () => new Promise((r) => setTimeout(r, 30));
// simulates VS Code firing onDidChangeTextDocument for an already-open document whose file changed on disk (e.g. Split/Join writing to it
// directly, not through applyEdit) — the exact mechanism resolveCustomTextEditor's own onChange listener relies on (release 2 part 7).
const fireChange = async (d) => { docChanged && docChanged({ document: d }); await settle(); };

(async () => {
  // an older model: version pointers and layout inside the model file, the log in .model.version.json
  const legacyFile = (n) => fs.readFileSync(path.join(__dirname, 'fixtures/legacy', n), 'utf8');
  fs.writeFileSync(file, legacyFile('example.model.json')); fs.writeFileSync(f('.model.version.json'), legacyFile('example.model.version.json'));
  fs.mkdirSync(path.join(root, 'x_model_data')); fs.writeFileSync(path.join(root, 'x_model_data', 'main.sales.orders.csv'), 'id\n1\n'); // an older per-model data folder
  doc.text = rd(file);
  await provider.resolveCustomTextEditor(doc, panel);
  assert.ok(/legacy\.js/.test(panel.webview.html) && /model\.js/.test(panel.webview.html), 'the webview loads legacy.js');
  await handler({ type: 'ready' });
  let model = sent.find((m) => m.type === 'model');
  assert.strictEqual(model.history, legacyFile('example.model.version.json'), 'no current log yet: the older one is sent (the webview reads both formats)');
  assert.strictEqual(model.layoutFile, null, 'and no layout file'); assert.ok(!model.cache); assert.strictEqual(model.dataDir, 'x_model_data', 'an older data folder stays in use');
  sent.length = 0; await handler({ type: 'data', op: 'read', file: 'x_model_data/main.sales.orders.csv' }); assert.strictEqual(sent.find((x) => x.type === 'data').text, 'id\n1\n', 'and is read');
  await handler({ type: 'data', op: 'rename', file: 'x_model_data/main.sales.orders.csv', to: 'x_model_data/main.sales.orders2.csv' }); assert.ok(ex(path.join(root, 'x_model_data', 'main.sales.orders2.csv')), 'renames happen there'); await handler({ type: 'data', op: 'rename', file: 'x_model_data/main.sales.orders2.csv', to: 'x_model_data/main.sales.orders.csv' });

  // the webview converts in memory and posts an edit carrying the new log and the positions: nothing is written before the save
  const F = JSON.parse(model.text), m = SM.fromFile(F, 'physical'), lg = LG.load(model.history, { modelling: { id: F.version.modelling, flat: SM.flatten(SM.toFile(m)).modelling } }).history;
  const newText = SM.stringify(SM.toFile(m)) + '\n', jsonl = SM.logText(lg), pos = SM.stringify(SM.layoutFile(m, 'physical')) + '\n';
  const oldLog = rd(f('.model.version.json'));
  await handler({ type: 'edit', text: newText, history: jsonl, positions: pos });
  assert.strictEqual(doc.text, newText, 'the document is edited (dirty), nothing else');
  assert.ok(!ex(f('.model.history.jsonl')) && !ex(f('.model.layout.json')) && !ex(path.join(root, 'strata.project.json')), 'nothing is written before the user saves');
  await handler({ type: 'positions', text: pos.replace(/\d+/, '999') });
  assert.ok(!ex(f('.model.layout.json')), 'positions posted meanwhile are held with the conversion');
  await save();
  assert.strictEqual(rd(f('.model.history.jsonl')), jsonl, 'saved: the log, as JSON Lines'); assert.strictEqual(rd(f('.model.layout.json')), pos.replace(/\d+/, '999'), 'and the positions (the latest)');
  assert.deepStrictEqual(JSON.parse(rd(path.join(root, 'strata.project.json'))).parts, [{ name: 'x', model: 'x.model.json' }], 'and a manifest that points at the model where it is'); assert.strictEqual(rd(f('.model.version.json')), oldLog, 'the old log is left where it was');
  assert.deepStrictEqual(fs.readdirSync(root).filter((n) => !n.startsWith('.')).sort(), ['history', 'strata.project.json', 'x.model.json', 'x.model.layout.json', 'x.model.version.json', 'x_model_data'], 'converted in place: the model, the old log and the old data folder are not moved or deleted');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'history')), ['x.history.jsonl']);
  assert.deepStrictEqual(warned, []);
  // the save handshake asks the webview first and takes its answer (text and log, for version-on-save)
  assert.ok(sent.some((x) => x.type === 'beforeSave'));

  // afterwards positions are written at once, without touching the model, the log or the document
  const t0 = rd(f('.model.history.jsonl')); doc.text = newText;
  await handler({ type: 'positions', text: '{"strata":"layout/1","positions":{"physical":{"main.sales.orders":[1,2]}}}\n' });
  assert.ok(/main\.sales\.orders/.test(rd(f('.model.layout.json'))), 'written as they change'); assert.strictEqual(rd(f('.model.history.jsonl')), t0); assert.strictEqual(doc.text, newText);
  // a reload sends the current log and the positions
  sent.length = 0; await handler({ type: 'ready' }); model = sent.find((x) => x.type === 'model');
  assert.strictEqual(model.history, jsonl, 'the current log wins over the older one'); assert.ok(/main\.sales\.orders/.test(model.layoutFile));

  // an edit with a new version: the log is written before the model (the model is the document: VS Code writes it after the handshake)
  const h2 = SM.parseLog(jsonl).history; SM.commit(h2, 'modelling', undefined, { ...SM.stateAt(h2, SM.headsOf(h2, 'modelling')[0].chain), 'x:y': {} }, { user: 'ada', message: 'again' });
  await handler({ type: 'edit', text: newText + ' ', history: SM.logText(h2) });
  assert.strictEqual(rd(f('.model.history.jsonl')), jsonl, 'held until saved'); await save(); assert.strictEqual(rd(f('.model.history.jsonl')), SM.logText(h2));
  // long history: the snapshot cache is written under .strata/cache and sent with the model; deleting it changes nothing
  const long = SM.newHistory(); let st = {}, bk = null; for (let i = 0; i < 45; i++) { st = { ...st, ['k' + i]: { n: i } }; bk = SM.commit(long, 'modelling', bk, st, { user: 'ada', message: 'x' + i, at: 1e12 + i * 1000 }).chain; }
  await handler({ type: 'edit', text: newText + '  ', history: SM.logText(long) }); await save();
  const cache = path.join(root, '.strata', 'cache', 'x.model.json.snapshots.json'); assert.ok(ex(cache), 'the cache is a file under .strata/cache');
  const snaps = JSON.parse(rd(cache)).snapshots; assert.ok(snaps[bk] && Object.keys(snaps).length >= 3);
  sent.length = 0; await handler({ type: 'ready' }); assert.ok(sent.find((x) => x.type === 'model').cache[bk], 'and sent to the webview with the model');
  fs.rmSync(path.join(root, '.strata'), { recursive: true }); assert.ok(!ex(cache)); fs.writeFileSync(f('.model.history.jsonl'), SM.logText(long));
  sent.length = 0; await handler({ type: 'ready' }); assert.ok(sent.find((x) => x.type === 'model')); assert.deepStrictEqual(SM.verify(SM.parseLog(sent.find((x) => x.type === 'model').history).history, { modelling: st, governance: {}, semantic: {} }), [], 'without the cache everything still loads and verifies');
  // a project in the foldered layout: the model in data_models/<part>/, its log in the top-level history/, its data in data/, positions beside the model
  const P = require('../lib/project.js'), proj = path.join(root, 'proj'), pm = P.create({ dir: proj, name: 'Orders', template: 'star', user: { name: 'ada' } });
  Object.assign(doc, { uri: Uri.file(pm.model), text: rd(pm.model) }); sent.length = 0; warned.length = 0;
  await provider.resolveCustomTextEditor(doc, panel); await handler({ type: 'ready' }); model = sent.find((x) => x.type === 'model');
  const plog = path.join(proj, 'history', 'orders.history.jsonl');
  assert.strictEqual(model.history, rd(plog), 'the log comes from history/'); assert.strictEqual(model.dataDir, 'data'); assert.strictEqual(model.layoutFile, rd(path.join(path.dirname(pm.model), 'orders.model.layout.json')));
  const h3 = SM.parseLog(model.history).history; SM.commit(h3, 'modelling', undefined, { ...SM.stateAt(h3, SM.headsOf(h3, 'modelling').at(-1).chain), 'x:y': {} }, { user: 'ada', message: 'in the project' });
  const pmText = doc.text + ' ';
  await handler({ type: 'edit', text: pmText, history: SM.logText(h3), positions: null }); assert.strictEqual(rd(plog), model.history, 'held until saved'); await save();
  assert.strictEqual(rd(plog), SM.logText(h3), 'saved to history/<part>.history.jsonl'); assert.deepStrictEqual(fs.readdirSync(proj).sort(), ['.gitattributes', '.gitignore', 'data_models', 'history', 'strata.project.json'], 'no log beside the model, no new files in the project');
  assert.strictEqual(P.readManifest(proj).parts.length, 1, 'the model is already a part: the manifest is not touched');
  await handler({ type: 'data', op: 'create', file: 'data/main.sales.t.csv', text: 'a\n' }); assert.strictEqual(rd(path.join(path.dirname(pm.model), 'data', 'main.sales.t.csv')), 'a\n', 'new sample data goes to data/');
  // a model deeper in the same folder tree, not listed: its own part, its own log, the manifest at the project root
  const deep = path.join(proj, 'data_models', 'orders', 'sub'); fs.mkdirSync(deep); const dm = path.join(deep, 'orders.model.json'); fs.writeFileSync(dm, rd(pm.model));
  Object.assign(doc, { uri: Uri.file(dm), text: rd(dm) }); await provider.resolveCustomTextEditor(doc, panel); sent.length = 0; await handler({ type: 'ready' });
  assert.strictEqual(sent.find((x) => x.type === 'model').history, null, 'a model without a log of its own does not borrow another part\'s');
  await handler({ type: 'edit', text: doc.text + ' ', history: jsonl }); await save();
  assert.strictEqual(rd(path.join(proj, 'history', 'orders-2.history.jsonl')), jsonl, 'its log is history/<its part>.history.jsonl at the project root');
  assert.deepStrictEqual(P.readManifest(proj).parts.map((x) => x.name), ['orders', 'orders-2']); assert.ok(!ex(path.join(deep, 'strata.project.json')), 'no manifest in the model\'s own folder');
  assert.deepStrictEqual(warned, []);

  // ---- release 2 part 5 (ADR-0045 point 10): the archived file and the project-index file, through the REAL ModelEditor ----
  {
    const sdir = path.join(root, 'split-host'), sp = P.create({ dir: sdir, name: 'Split Host', template: 'star', user: { name: 'ada' } });
    const sF = JSON.parse(rd(sp.model)); // homeDomain is an unrecognized table-level key (round-tripped through media/model.js's generic `ext`)
    sF.tables[0].homeDomain = 'Ops';
    sF.tables[1].homeDomain = 'Fin';
    fs.writeFileSync(sp.model, SM.stringify(sF) + '\n');
    const sman = P.readManifest(sdir); sman.domains = [{ name: 'Ops', concepts: [] }, { name: 'Fin', concepts: [] }];
    fs.writeFileSync(path.join(sdir, P.MANIFEST), JSON.stringify(sman));
    const preText = rd(sp.model), preOrigHistory = rd(path.join(sdir, 'history', 'split-host.history.jsonl'));
    const sres = P.split(sp.model, { user: { name: 'ada' } });
    assert.ok(sres.parts.length >= 2, 'at least two real parts (Ops, Fin), so join() below has something to join');
    const archivedPath = path.join(sdir, 'data_models/split-host/split-host.archived.model.json');
    assert.strictEqual(rd(archivedPath), preText, 'archived file: byte-for-byte the pre-split content');
    const idxObj = JSON.parse(rd(sp.model));
    assert.strictEqual(idxObj.strata, 'project-index/1'); assert.deepStrictEqual(idxObj.parts.sort(), sres.parts.map((p) => p.name).sort());
    assert.strictEqual(P.readManifest(sdir).index, path.relative(sdir, sp.model).split(path.sep).join('/'));

    // opening the ARCHIVED file: read-only, a persistent banner's worth of data, and no edit path writes anything
    Object.assign(doc, { uri: Uri.file(archivedPath), text: rd(archivedPath) }); sent.length = 0; warned.length = 0;
    await provider.resolveCustomTextEditor(doc, panel); await handler({ type: 'ready' });
    const amodel = sent.find((x) => x.type === 'model');
    assert.strictEqual(amodel.readOnly, true); assert.strictEqual(amodel.host, 'vscode');
    assert.ok(amodel.archived && amodel.archived.parts.map((p) => p.name).sort().join() === sres.parts.map((p) => p.name).sort().join(), 'names the resulting parts');
    assert.strictEqual(amodel.archived.index, P.readManifest(sdir).index);
    // release 2 part 9 (ADR-0045 amended): the archived file's Tools/settings/tags stay exactly as blocked as before — a specific
    // regression check, not an assumption. It never carries `projectView`/`indexFile` (the flags that turn any of the three on), so the
    // canvas's own `indexFile` variable stays false there regardless of anything this pass built.
    assert.ok(!amodel.projectView && !amodel.indexFile, 'archived file: neither flag this pass introduced or reuses is ever sent for it');
    const beforeArchived = rd(archivedPath), beforeIndexFile = rd(sp.model), beforeManifest = rd(path.join(sdir, P.MANIFEST)), beforeGov = rd(path.join(sdir, P.GOVERNANCE));
    sent.length = 0; execLog.length = 0;
    await handler({ type: 'edit', text: '{}', history: 'x', positions: 'y' });
    await handler({ type: 'positions', text: 'y' });
    await handler({ type: 'settings', settings: { arrows: 'curved' } });
    await handler({ type: 'domains', domains: [] });
    // the three release 2 part 9 message types too: not in ARCHIVED_BLOCKED by name, but resolveCustomTextEditor (the archived file's own
    // host, unlike the index file's resolveIndexEditor) never gained a case for any of them, so they fall through and do nothing either
    await handler({ type: 'embed' });
    await handler({ type: 'projectSettings', project: { ...JSON.parse(beforeArchived).project, description: 'should never land' } });
    await handler({ type: 'governance', governance: { tags: [{ name: 'should_never_land' }], propertyKeys: [], policies: [] } });
    assert.strictEqual(doc.text, beforeArchived, 'the document itself was never edited (applyEdit was never reached)');
    assert.strictEqual(rd(archivedPath), beforeArchived, 'archived file: unchanged');
    assert.strictEqual(rd(sp.model), beforeIndexFile, 'index file: unchanged');
    assert.strictEqual(rd(path.join(sdir, P.MANIFEST)), beforeManifest, 'manifest: not re-added as a live part, nothing else written either');
    assert.strictEqual(rd(path.join(sdir, P.GOVERNANCE)), beforeGov, 'governance.json: unaffected by a governance message sent to the archived file');
    for (const p of sres.parts) assert.ok(!JSON.parse(rd(path.resolve(sdir, p.model))).project.description?.includes('should never land'), p.name + ': a projectSettings message to the archived file changed nothing');
    assert.strictEqual(P.ensurePart(sdir, archivedPath, 'Split Host'), null, 'and ensurePart refuses it directly too');

    // release 2 part 13 (ADR-0045 amended): Open Live View in Browser, for the ARCHIVED file — a REAL server (lib/live.js#startLive, not
    // stubbed), which must detect the file is archived (project.isArchived) and serve it strictly read-only, the same as the VS Code editor.
    opened.length = 0;
    await handler({ type: 'openLive' });
    assert.strictEqual(opened.length, 1, 'a real live server was started for the archived file');
    const aUrl = new URL(opened[0]); srvToken = aUrl.searchParams.get('t');
    const [aLiveModel] = await liveReq(+aUrl.port, { type: 'ready' });
    assert.strictEqual(aLiveModel.readOnly, true, 'the live view refuses to open the archived file writable'); assert.strictEqual(aLiveModel.host, 'live');
    assert.strictEqual(JSON.parse(aLiveModel.text).project.name, 'Split Host', 'the archived content, over HTTP, matches the file on disk');
    const beforeLiveEdit = rd(archivedPath);
    await liveReq(+aUrl.port, { type: 'edit', text: '{}' });
    await liveReq(+aUrl.port, { type: 'saveReady', text: '{}', history: null });
    assert.strictEqual(rd(archivedPath), beforeLiveEdit, 'and genuinely refuses the write over HTTP too, not just hides the button');

    // the banner's links open another part, or the index file, by the same message
    execLog.length = 0;
    await handler({ type: 'openPart', file: sres.parts[0].model });
    const ex1 = execLog.at(-1);
    assert.strictEqual(ex1[0], 'vscode.openWith'); assert.strictEqual(ex1[1].fsPath, path.resolve(sdir, sres.parts[0].model)); assert.strictEqual(ex1[2], 'strata.modelEditor');
    execLog.length = 0;
    for (const bad of ['../outside.model.json', path.join(os.tmpdir(), 'x.model.json')]) await handler({ type: 'openPart', file: bad });
    assert.deepStrictEqual(execLog, [], 'a path outside the project (../ or absolute) is never opened');

    // opening the INDEX file: detected by content (not filename), assembles the whole project fresh, read-only, no reply to any message
    Object.assign(doc, { uri: Uri.file(sp.model), text: rd(sp.model) }); sent.length = 0;
    await provider.resolveCustomTextEditor(doc, panel); await handler({ type: 'ready' });
    const imodel = sent.find((x) => x.type === 'model');
    assert.strictEqual(imodel.readOnly, true); assert.strictEqual(imodel.host, 'vscode'); assert.strictEqual(imodel.projectView, true);
    assert.strictEqual(imodel.history, null); assert.strictEqual(imodel.layoutFile, null);
    const assembledF = JSON.parse(imodel.text);
    assert.strictEqual(assembledF.project.name, 'Split Host');
    assert.strictEqual((assembledF.tables || []).length, sF.tables.length, 'every table from every part, reassembled');
    // release 2 part 12: every part's own raw log text, plus governance.json's own (this project has more than one part, so it exists) —
    // real, parseable JSON Lines, not just non-empty strings
    const manNow = P.readManifest(sdir);
    assert.deepStrictEqual(imodel.histories.map((x) => x.name).sort(), [...manNow.parts.map((p) => p.name), P.GOVERNANCE].sort(), 'one entry per part, plus governance.json');
    for (const x of imodel.histories) {
      const parsed = SM.parseLog(x.text);
      assert.ok(!parsed.error && parsed.history.entries.length > 0, x.name + ': a real, parseable log with at least one entry');
      assert.strictEqual(!!x.gov, x.name === P.GOVERNANCE, x.name + ': gov flag only on governance.json');
      if (!x.gov) assert.strictEqual(x.model, manNow.parts.find((p) => p.name === x.name).model, x.name + ": the part's own model path, for \"Open <part>\"");
    }
    sent.length = 0;
    await handler({ type: 'edit', text: '{}', history: 'x' });
    assert.deepStrictEqual(sent, [], 'no reply of any kind — nothing to acknowledge, same read-only contract as the Project View panel');
    assert.strictEqual(rd(path.join(sdir, P.MANIFEST)), beforeManifest, 'still nothing written');

    // change 30: the Domains view is editable from this tab: a description is saved to the manifest and the tab is refreshed with it
    sent.length = 0;
    await handler({ type: 'domains', domains: P.readManifest(sdir).domains.map((d) => (d.name === 'Ops' ? { ...d, description: 'Operations and logistics' } : d)) });
    assert.strictEqual(P.readManifest(sdir).domains.find((d) => d.name === 'Ops').description, 'Operations and logistics');
    const dm = sent.find((x) => x.type === 'model');
    assert.ok(dm && dm.domains.find((d) => d.name === 'Ops').description === 'Operations and logistics', 'the tab is re-sent with the new description');
    await handler({ type: 'domains', domains: JSON.parse(beforeManifest).domains }); // restore
    assert.strictEqual(rd(path.join(sdir, P.MANIFEST)), beforeManifest, 'and back to exactly what it was');

    // ---- release 2 part 8 (ADR-0045 extended): ETL/ELT export and HTML export ARE available here (pure reads of the assembled model);
    // embeddings (release 2 part 9) and the live view (release 2 part 13) are available too, each its own real target - see below ----
    const idxDir = path.dirname(sp.model);
    savedDialogs.length = 0;
    await handler({ type: 'saveFile', name: 'foo.py', text: 'print(1)\n' });
    assert.strictEqual(savedDialogs.at(-1), path.join(idxDir, 'foo.py'), 'ETL/ELT export defaults to the index file\'s own folder');
    assert.strictEqual(rd(path.join(idxDir, 'foo.py')), 'print(1)\n', 'and really writes there');
    savedDialogs.length = 0;
    await handler({ type: 'exportHtml' });
    assert.strictEqual(savedDialogs.at(-1), path.join(idxDir, 'Split Host.html'));
    const exportedHtml = rd(path.join(idxDir, 'Split Host.html'));
    assert.ok(exportedHtml.includes('"Split Host"'), 'the assembled project (real project name) is embedded');
    assert.ok(!exportedHtml.includes('project-index/1'), 'never the thin index-file marker itself');
    // release 2 part 13 (ADR-0045 amended): Open Live View in Browser, for the INDEX file itself — the REAL multi-part server
    // (lib/live.js#startProjectLive, routed to by startLive's own project.readIndexFile(file) check), driven over real HTTP, not stubbed.
    // The full editProject/projectSettings/governance/projectUndo/projectRedo message matrix is exercised in depth in tests/live.check.js
    // (against a fresh fixture of its own); this confirms the ROUTING from the webview command through to that same real server.
    opened.length = 0;
    await handler({ type: 'openLive' });
    assert.strictEqual(opened.length, 1, 'a real live server was started for the project-index file');
    const iUrl = new URL(opened[0]); srvToken = iUrl.searchParams.get('t');
    const [iLiveModel] = await liveReq(+iUrl.port, { type: 'ready' });
    assert.strictEqual(iLiveModel.indexFile, true); assert.strictEqual(iLiveModel.readOnly, true); assert.strictEqual(iLiveModel.host, 'live');
    const iAssembled = JSON.parse(iLiveModel.text);
    assert.strictEqual(iAssembled.project.name, 'Split Host', 'the assembled project, over HTTP, matches the VS Code host');
    assert.strictEqual((iAssembled.tables || []).length, sF.tables.length, 'every table from every part, reassembled — the same as the VS Code editor');
    assert.deepStrictEqual(iLiveModel.histories.map((x) => x.name).sort(), imodel.histories.map((x) => x.name).sort(), 'the same merged history sources as the VS Code host');
    // editProject over HTTP writes for real, exactly as lib/project.js#applyProjectEdit does for the VS Code host
    iAssembled.tables[0].description = 'renamed from the live view';
    const editedId = iAssembled.tables[0].id;
    const [editedModel] = await liveReq(+iUrl.port, { type: 'editProject', text: JSON.stringify(iAssembled), message: 'live view edit' });
    assert.strictEqual(editedModel.indexFile, true, 'and the response refreshes the tab the same way postAssembledProject does');
    const ownerPart = P.readManifest(sdir).parts.find((p) => JSON.parse(rd(path.resolve(sdir, p.model))).tables.some((t) => t.id === editedId));
    assert.ok(ownerPart, 'the edited table belongs to a real part on disk');
    assert.strictEqual(JSON.parse(rd(path.resolve(sdir, ownerPart.model))).tables.find((t) => t.id === editedId).description, 'renamed from the live view', 'and the edit landed in that part\'s own file, over HTTP');
    assert.ok(!ex(path.join(idxDir, 'split-host.model.embeddings.json')), 'still no project-wide embeddings file at the index file\'s own path');

    // ---- release 2 part 9 (ADR-0045 amended): three narrow exceptions to the read-only rule, each routed to a real target ----
    // 1. Generate embeddings: once per domain part (media/canvas.js#generateEmbeddingsProject -> the SAME 'embed' message), not one
    // project-wide file — reusing the single-part pipeline (runEmbeddingsFor) against each part's own model text.
    const man1 = P.readManifest(sdir);
    const partModelPaths = man1.parts.map((p) => path.resolve(sdir, p.model));
    sent.length = 0;
    await handler({ type: 'embed' });
    const er = sent.find((x) => x.type === 'embedResult');
    assert.ok(er, 'a real embedResult reply this time (was silently ignored before this pass)');
    assert.deepStrictEqual(Object.keys(er.perPart).sort(), man1.parts.map((p) => p.name).sort(), 'one result per domain part');
    assert.ok(Object.values(er.perPart).every((x) => !x.error), 'every part succeeded: ' + JSON.stringify(er.perPart));
    assert.ok(er.embedParts.every((x) => x.hasEmbeddings && x.upToDate), 'fresh per-part status: every part up to date');
    for (const mp of partModelPaths) {
      const ef = mp.replace(/\.model\.json$/, '.model.embeddings.json');
      assert.ok(ex(ef), 'a real embeddings file was written next to ' + path.basename(mp));
      const parsed = JSON.parse(rd(ef));
      assert.strictEqual(parsed.strata, 'embeddings/1'); assert.ok(parsed.chunks.length > 0, 'real chunks, not an empty stub');
    }
    // opening the index file again shows the same per-part status, without regenerating (reused, not embedded again)
    sent.length = 0; await handler({ type: 'ready' });
    assert.ok(sent.find((x) => x.type === 'model').embedParts.every((x) => x.upToDate), 'still up to date on the next open');

    // 2. Project settings: the SAME project block into EVERY part's own model, each its own new, real, versioned edit — not one shared edit
    const histBefore = Object.fromEntries(man1.parts.map((p) => [p.name, rd(path.join(sdir, 'history', p.name + '.history.jsonl'))]));
    const newProj = { ...sF.project, description: 'Updated from the project-index file' };
    sent.length = 0;
    await handler({ type: 'projectSettings', project: newProj });
    // release 2 part 12: the already-open tab is refreshed here too — before this pass's fix, nothing was sent after a successful write
    assert.strictEqual(JSON.parse(sent.find((x) => x.type === 'model').text).project.description, 'Updated from the project-index file', 'the open tab is refreshed with the new project settings, unprompted');
    const man2 = P.readManifest(sdir);
    assert.deepStrictEqual(man2.parts.map((p) => p.name).sort(), man1.parts.map((p) => p.name).sort(), 'still the same parts');
    for (const p of man2.parts) {
      const F = JSON.parse(rd(path.resolve(sdir, p.model)));
      assert.strictEqual(F.project.description, 'Updated from the project-index file', p.name + ': got the new project block');
      assert.notStrictEqual(rd(path.join(sdir, 'history', p.name + '.history.jsonl')), histBefore[p.name], p.name + ': a new history entry was appended (log before model)');
    }
    // every part agrees again: assemble()'s own "parts disagree about the project" check still holds after a multi-file write
    assert.doesNotThrow(() => P.assemble(sdir, man2), 'assemble() still agrees: every part has the identical project block');

    // 3. Creating a tag here routes to governance.json (its own version, its own file) — never into any part's own (still-empty) file
    const govHistBefore = rd(path.join(sdir, P.GOVERNANCE_HISTORY));
    sent.length = 0;
    await handler({ type: 'governance', governance: { tags: [{ name: 'pii', displayName: 'Personal Data', enabled: true }], propertyKeys: [], policies: [] } });
    // release 2 part 12: refreshed here too — the assembled model's own governance already merges governance.json in (assemble()), so the
    // new tag is visible on the canvas at once, without a reopen
    assert.ok(JSON.parse(sent.find((x) => x.type === 'model').text).governance.tags.some((t) => t.name === 'pii'), 'the open tab is refreshed with the new tag');
    const govAfter = JSON.parse(rd(path.join(sdir, P.GOVERNANCE)));
    assert.deepStrictEqual(govAfter.tags.map((t) => t.name), ['pii'], 'the new tag landed in governance.json');
    assert.notStrictEqual(rd(path.join(sdir, P.GOVERNANCE_HISTORY)), govHistBefore, 'a new governance.history.jsonl entry (the governance stream)');
    for (const p of man2.parts) assert.ok(!JSON.parse(rd(path.resolve(sdir, p.model))).governance, p.name + ': still no governance section of its own');
    // and it is visible from any part's own editor too (m.sharedGovernance already merges governance.json in, release 2 part 2)
    Object.assign(doc, { uri: Uri.file(partModelPaths[0]), text: rd(partModelPaths[0]) }); sent.length = 0;
    await provider.resolveCustomTextEditor(doc, panel); await handler({ type: 'ready' });
    const partModel = sent.find((x) => x.type === 'model');
    assert.ok((partModel.sharedGovernance.tags || []).some((t) => t.name === 'pii'), 'the new tag is visible from a part\'s own editor');
    // back to the index file for the rest of this section (the Navigator check, then Join Parts, below)
    Object.assign(doc, { uri: Uri.file(sp.model), text: rd(sp.model) }); sent.length = 0;
    await provider.resolveCustomTextEditor(doc, panel); await handler({ type: 'ready' });

    // ---- release 2 part 9: the Model Navigator follows this tab too, given the ASSEMBLED project's text, not the thin index marker ----
    const navSent = [];
    let navHandler = null;
    const navView = { visible: true, webview: { cspSource: 'x', asWebviewUri: (u) => u, options: null, html: '', postMessage: (m) => { navSent.push(m); }, onDidReceiveMessage: (fn) => { navHandler = fn; } }, onDidChangeVisibility: () => {}, onDidDispose: () => {} };
    navProvider.resolveWebviewView(navView); // resolveIndexEditor's own setNavDoc(doc), above, already made this document the navigator's target
    navHandler({ type: 'ready' });
    await settle();
    const navModel = navSent.find((x) => x.type === 'model');
    assert.ok(navModel, 'the Navigator got a model message');
    const navF = JSON.parse(navModel.text);
    assert.strictEqual(navF.strata, 2, 'the ASSEMBLED project, not the thin "project-index/1" marker nav.js cannot render');
    assert.ok((navF.tables || []).length > 0 && (navF.conceptual.concepts || []).length > 0, 'real tables and concepts, not empty');
    assert.strictEqual(navF.tables.length, JSON.parse(rd(archivedPath)).tables.length, 'every table from every part, same as the canvas gets');

    // ---- release 2 part 11 (ADR-0045 amended): the Navigator's reveal now reaches the project-index file's own tab, real objects
    // spanning different domain parts (dim_customer is Ops, dim_date is Fin — see the "Shop Star" template's own tables) ----
    for (const ref of [navF.tables.find((t) => /dim_customer/.test(t.name)), navF.tables.find((t) => /dim_date/.test(t.name))]) assert.ok(ref, 'fixture sanity');
    execLog.length = 0; sent.length = 0;
    navHandler({ type: 'reveal', kind: 'table', ref: navF.tables.find((t) => /dim_customer/.test(t.name)).schema + '.' + navF.tables.find((t) => /dim_customer/.test(t.name)).name });
    await settle();
    assert.ok(sent.some((x) => x.type === 'reveal'), 'reveal (Ops table) reached the index file\'s own webview, not a stale/no panel');
    assert.deepStrictEqual(execLog, [], 'not the "model is open as plain text" fallback (vscode.openWith) — the entry was found in `panels`');
    sent.length = 0;
    navHandler({ type: 'reveal', kind: 'table', ref: navF.tables.find((t) => /dim_date/.test(t.name)).schema + '.' + navF.tables.find((t) => /dim_date/.test(t.name)).name, column: 'id' });
    await settle();
    assert.ok(sent.some((x) => x.type === 'reveal' && x.column === 'id'), 'reveal (Fin table, a column) reached it too');

    // ---- release 2 part 10 (ADR-0045 amended): adding/editing/deleting a table/column/relationship/concept/entity/metric, through the
    // REAL 'editProject' message (media/canvas.js posts the whole edited, assembled model text; resolveIndexEditor re-routes it) ----
    {
      const opsModel = man1.parts.find((p) => p.name === 'ops').model, finModel = man1.parts.find((p) => p.name === 'fin').model, unModel = man1.parts.find((p) => p.name === '_unassigned').model;
      const opsHistPath = path.join(sdir, 'history', 'ops.history.jsonl'), finHistPath = path.join(sdir, 'history', 'fin.history.jsonl');

      // 1. edit an existing table's column (dim_customer, Ops): a real new version in ops alone, and (release 2 part 12) a fresh, re-assembled
      // 'model' message so the already-open tab shows the edit without needing to be closed and reopened — the bug this pass fixes; before
      // this pass's fix `sent` stayed empty here (see the report of this change for the reverted-extension.js fail-before proof)
      let F = JSON.parse(navModel.text);
      F.tables.find((t) => t.name === 'dim_customer').columns.push({ name: 'note', type: 'STRING' });
      const opsHistBefore = rd(opsHistPath), finHistBefore = rd(finHistPath);
      sent.length = 0;
      await handler({ type: 'editProject', text: SM.stringify(F), message: 'Add dim_customer.note' });
      const refreshed = sent.find((x) => x.type === 'model');
      assert.ok(refreshed, 'release 2 part 12: a fresh model is posted back so the open tab updates on its own');
      assert.ok(JSON.parse(refreshed.text).tables.find((t) => t.name === 'dim_customer').columns.some((c) => c.name === 'note'), 'and it reflects the edit that was just saved');
      assert.notStrictEqual(rd(opsHistPath), opsHistBefore, 'ops: a real new version');
      assert.strictEqual(rd(finHistPath), finHistBefore, 'fin: untouched (a no-op commit writes nothing)');
      assert.ok(JSON.parse(rd(path.resolve(sdir, opsModel))).tables.find((t) => t.name === 'dim_customer').columns.some((c) => c.name === 'note'));

      const reopen = async () => { sent.length = 0; await handler({ type: 'ready' }); return JSON.parse(sent.find((x) => x.type === 'model').text); };

      // 2. add a new table with an explicit domain (Fin) — the SAME t.ext.homeDomain override split() already reads, exactly what
      // media/canvas.js's domainField() writes when a domain is picked in the Add-table dialog
      F = await reopen();
      F.tables.push({ name: 'budget', schema: F.tables[0].schema, homeDomain: 'Fin', columns: [{ name: 'id', type: 'INTEGER', pk: true }] });
      await handler({ type: 'editProject', text: SM.stringify(F), message: 'Add budget' });
      assert.ok(JSON.parse(rd(path.resolve(sdir, finModel))).tables.some((t) => t.name === 'budget'), 'routed to Fin, as picked');
      assert.ok(!JSON.parse(rd(path.resolve(sdir, opsModel))).tables.some((t) => t.name === 'budget'));

      // 3. add a new table with NO domain picked and no entity link: falls to _unassigned exactly as split() itself would — and that part
      // already exists here, so (unlike the dedicated missing-part case below) this one succeeds outright
      F = await reopen();
      F.tables.push({ name: 'scratch', schema: F.tables[0].schema, columns: [{ name: 'id', type: 'INTEGER', pk: true }] });
      await handler({ type: 'editProject', text: SM.stringify(F), message: 'Add scratch' });
      assert.ok(JSON.parse(rd(path.resolve(sdir, unModel))).tables.some((t) => t.name === 'scratch'), 'the usual rule (no entity, no override): _unassigned, same as split()');

      // 4. a new concept with an explicit domain (Ops), via conceptDomains — a concept's home lives in the manifest, not the object itself
      F = await reopen();
      F.conceptual.concepts.push({ name: 'Warehouse' });
      await handler({ type: 'editProject', text: SM.stringify(F), message: 'Add Warehouse concept', conceptDomains: { Warehouse: 'Ops' } });
      assert.ok(P.readManifest(sdir).domains.find((d) => d.name === 'Ops').concepts.includes('Warehouse'), 'queued alongside the edit, written into the manifest');
      assert.ok(JSON.parse(rd(path.resolve(sdir, opsModel))).conceptual.concepts.some((c) => c.name === 'Warehouse'));

      // 5. an edit that genuinely cannot be routed (a metric needing _shared, which has no part here yet) fails cleanly, writing nothing,
      // reported as a native error message (the stubbed vscode throws on showErrorMessage, so this rejects) — never a silent partial drop
      F = await reopen();
      F.semantic = { metrics: [{ name: 'Everything', calculation: `SUM(${F.tables[0].schema}.dim_customer.id) + SUM(${F.tables[0].schema}.dim_date.id)`, homeDomain: '_shared' }] };
      const opsBefore5 = rd(path.resolve(sdir, opsModel));
      await assert.rejects(handler({ type: 'editProject', text: SM.stringify(F), message: 'Add Everything metric' }), /no part exists yet for: _shared/);
      assert.strictEqual(rd(path.resolve(sdir, opsModel)), opsBefore5, 'nothing at all was written for the failed edit');

      // opening the index file again reflects every successful edit above, fresh from disk
      const finalF = await reopen();
      assert.deepStrictEqual(finalF.tables.map((t) => t.name).sort(), [...sF.tables.map((t) => t.name), 'budget', 'scratch'].sort());

      // ---- release 2 part 12: the merged History drawer's own Undo/Redo — the single most recent / earliest-undone change ACROSS EVERY
      // part (lib/project.js#projectGoto), reusing each part's own SM.undoTarget/redoTarget host-side. The most recent write anywhere among
      // the three real parts above was #4 (adding the Warehouse concept to ops, after #1 ops, #2 fin, #3 _unassigned) — undoing removes it
      // there and only there; redoing brings it back; neither writes a new history entry (they only move which recorded content the file
      // holds, exactly like the single-part editor's own undo()/redo() — media/canvas.js#gotoEntry).
      assert.ok(JSON.parse(rd(path.resolve(sdir, opsModel))).conceptual.concepts.some((c) => c.name === 'Warehouse'));
      const opsHistBeforeUndo = rd(opsHistPath);
      sent.length = 0; infoLog.length = 0;
      await handler({ type: 'projectUndo' });
      assert.deepStrictEqual(infoLog, [], 'something really was undone: no "nothing to undo" toast');
      assert.ok(!((JSON.parse(rd(path.resolve(sdir, opsModel))).conceptual || {}).concepts || []).some((c) => c.name === 'Warehouse'), 'ops: the single most recent change anywhere (adding Warehouse) was undone');
      assert.ok(JSON.parse(rd(path.resolve(sdir, finModel))).tables.some((t) => t.name === 'budget'), 'fin: unaffected — only the one most recent change anywhere is undone');
      assert.ok(JSON.parse(rd(path.resolve(sdir, unModel))).tables.some((t) => t.name === 'scratch'), '_unassigned: unaffected too');
      assert.strictEqual(rd(opsHistPath), opsHistBeforeUndo, 'no new history entry: Undo only moves which recorded content the file holds');
      const afterUndo = sent.find((x) => x.type === 'model');
      assert.ok(afterUndo && !((JSON.parse(afterUndo.text).conceptual || {}).concepts || []).some((c) => c.name === 'Warehouse'), 'the tab is refreshed after Undo too, showing the undone state at once');

      sent.length = 0; infoLog.length = 0;
      await handler({ type: 'projectRedo' });
      assert.deepStrictEqual(infoLog, []);
      assert.ok(JSON.parse(rd(path.resolve(sdir, opsModel))).conceptual.concepts.some((c) => c.name === 'Warehouse'), 'Redo brings it back');
      assert.strictEqual(rd(opsHistPath), opsHistBeforeUndo, 'redo too: no new history entry — the log is byte-for-byte unchanged by either');

      // nothing left to redo now (every part is back at its own newest recorded content): a further Redo is a real, reported no-op
      sent.length = 0; infoLog.length = 0;
      await handler({ type: 'projectRedo' });
      assert.deepStrictEqual(infoLog, ["Strata SQL: nothing to redo across the project's parts."]);
      assert.ok(sent.find((x) => x.type === 'model'), 'still refreshes (a harmless no-op reload)');
    }

    // Strata: Join Parts turns the index file back into a real model, and leaves the archived file (and its own history log) untouched
    const jres = P.join(sdir, { user: { name: 'ada' } });
    assert.strictEqual(jres.model, sp.model, 'reoccupies the exact vacated path');
    assert.strictEqual(P.readIndexFile(sp.model), null, 'no longer an index file');
    assert.strictEqual(rd(archivedPath), preText, 'archived file: still untouched by Join');
    assert.strictEqual(rd(path.join(sdir, 'history', 'split-host.history.jsonl')), preOrigHistory, 'and its own history log: not overwritten by the joined part\'s fresh one');
    assert.strictEqual(P.readManifest(sdir).parts.length, 1);
  }

  // ---- release 2 part 7: a real bug — Split runs while the file it splits FROM is already open in an ordinary (ADR-0045 pre-split) tab ----
  {
    const bdir = path.join(root, 'bug-host'), bp = P.create({ dir: bdir, name: 'Bug Host', template: 'star', user: { name: 'ada' } });
    const bF = JSON.parse(rd(bp.model)); bF.tables[0].homeDomain = 'Ops'; bF.tables[1].homeDomain = 'Fin';
    fs.writeFileSync(bp.model, SM.stringify(bF) + '\n');
    const bman = P.readManifest(bdir); bman.domains = [{ name: 'Ops', concepts: [] }, { name: 'Fin', concepts: [] }];
    fs.writeFileSync(path.join(bdir, P.MANIFEST), JSON.stringify(bman));

    // open the model the ordinary way, before it is ever split — the normal, non-index path, exactly like opening it from New Project
    Object.assign(doc, { uri: Uri.file(bp.model), text: rd(bp.model) }); sent.length = 0; warned.length = 0;
    await provider.resolveCustomTextEditor(doc, panel);
    await handler({ type: 'ready' });
    assert.ok(!sent.find((x) => x.type === 'model').projectView, 'ordinary model, no project-index marker yet');

    // Split into Domains runs against this same file while its tab is still open (it always is — it's the file you split FROM); it
    // overwrites the file in place with the thin project-index content (lib/project.js#split, not through applyEdit/the document itself)
    const bres = P.split(bp.model, { user: { name: 'ada' } });
    assert.ok(bres.parts.length >= 2, 'at least two real parts');
    doc.text = rd(bp.model); // the file changed on disk under the already-open document

    // VS Code fires onDidChangeTextDocument for the still-open tab; the fix re-checks the index marker on every send, not only at first
    // resolve, and re-routes to the assembled project instead of rendering the thin index JSON as an (empty-looking) ordinary model
    sent.length = 0;
    await fireChange(doc);
    const after = sent.find((x) => x.type === 'model');
    assert.ok(after, 'the still-open panel is sent a fresh model message once the file becomes a project-index file');
    assert.strictEqual(after.projectView, true, 'routed to the assembled whole-project view, not the ordinary (now empty-looking) model path');
    assert.strictEqual(after.readOnly, true);
    const assembled = JSON.parse(after.text);
    assert.strictEqual(assembled.project.name, 'Bug Host');
    assert.strictEqual((assembled.tables || []).length, bF.tables.length, 'every table from every part, reassembled — not the thin index JSON');

    // mutating messages are ignored now too, the same as for the project-index file's own tab
    sent.length = 0; execLog.length = 0;
    await handler({ type: 'edit', text: '{}', history: 'x' });
    assert.strictEqual(doc.text, rd(bp.model), 'never edited: the mutating message was ignored, same as the archived file / the index file\'s own tab');
  }

  await EXT.deactivate(); // closes any real live server the release 2 part 13 tests above started (they use the real lib/live.js, not a stub)
  fs.rmSync(root, { recursive: true, force: true });
  console.log('host check ok');
})().catch((e) => { console.error(e); process.exit(1); });
