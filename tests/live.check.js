// Self-check for the live view server (lib/live.js) and the HTML export (lib/export.js). Run: node tests/live.check.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startLive } = require('../lib/live.js');
const { exportHtml } = require('../lib/export.js');
const M = require('../media/model.js');

const req = (port, method, url, { body, headers } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
  });
  r.on('error', reject);
  if (body) r.write(body);
  r.end();
});

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-live-'));
  const file = path.join(dir, 'example.model.json');
  for (const f of ['example.model.json', 'example.model.history.jsonl', 'example.model.layout.json']) fs.copyFileSync(path.join(__dirname, '..', 'sample_data_models', f), path.join(dir, f));
  const vsTheme = { name: 'Default Dark Modern', kind: 'dark', vars: { 'editor-background': '#1f1f1f', foreground: '#cccccc' } };
  const srv = await startLive({ file, theme: vsTheme });
  const q = '?t=' + srv.token, post = (m, extra) => req(srv.port, 'POST', '/msg' + q, { body: JSON.stringify(m), ...extra });

  // access control
  assert.strictEqual((await req(srv.port, 'GET', '/')).status, 403, 'page needs the token');
  assert.strictEqual((await req(srv.port, 'GET', '/?t=wrong')).status, 403);
  assert.strictEqual((await req(srv.port, 'GET', '/' + q, { headers: { host: 'evil.example.com' } })).status, 403, 'DNS rebinding guard');
  assert.strictEqual((await post({ type: 'ready' }, { headers: { origin: 'http://evil.example.com' } })).status, 403, 'foreign origin');
  for (const p of ['/media/../package.json', '/media/%2e%2e/package.json', '/media/..%2fpackage.json', '/media/help/../../package.json']) assert([403, 404].includes((await req(srv.port, 'GET', p)).status), 'no path traversal: ' + p);
  assert.strictEqual((await req(srv.port, 'GET', '/media/..%2fpackage.json' + q)).status, 404);
  assert.strictEqual((await req(srv.port, 'GET', '/media/canvas.js')).status, 200);

  // another address (Docker): any Host is accepted because the token is the gate; the token can be fixed; an Origin must still match the Host
  await assert.rejects(startLive({ file, token: 'short' }), /16 or more/, 'a weak fixed token is refused');
  assert.strictEqual(srv.open, false);
  {
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'strata-live-open-')), 'example.model.json'); fs.copyFileSync(file, copy); // its own file: close() unwatches the path
    const fixed = 'fixed_token_for_docker_0123', so = await startLive({ file: copy, host: '0.0.0.0', token: fixed }), qo = '?t=' + fixed;
    assert(so.open && so.token === fixed && so.url === `http://127.0.0.1:${so.port}/${qo}`, 'the link names a host you can open, with the given token');
    const hdr = (h, extra = {}) => ({ headers: { host: h, ...extra } });
    assert.strictEqual((await req(so.port, 'GET', '/' + qo, hdr('docs.example.com:8787'))).status, 200, 'any Host with the token');
    assert.strictEqual((await req(so.port, 'GET', '/', hdr('docs.example.com:8787'))).status, 403, 'still needs the token');
    assert.strictEqual((await req(so.port, 'POST', '/msg' + qo, { ...hdr('docs.example.com:8787', { origin: 'http://evil.example.com' }), body: '{"type":"ready"}' })).status, 403, 'a foreign Origin');
    assert.strictEqual((await req(so.port, 'POST', '/msg' + qo, { ...hdr('docs.example.com:8787', { origin: 'http://docs.example.com:8787' }), body: '{"type":"ready"}' })).status, 200, 'the same Origin as the Host');
    await so.close();
  }

  // pages
  const page = await req(srv.port, 'GET', '/' + q);
  assert(page.status === 200 && page.body.includes('id="strata-boot"') && page.body.includes('/media/canvas.js') && page.body.includes('/media/shim.js'));
  assert(page.body.includes('<div id="navpane" hidden>'), 'the navigator pane starts closed (no flash before the saved state applies)');
  assert((await req(srv.port, 'GET', '/nav' + q)).body.includes('/media/nav.js'));
  const help = await req(srv.port, 'GET', '/help' + q);
  assert(help.status === 200 && help.body.includes('<table>') && /<img alt="[^"]*" src="\/media\/help\//.test(help.body), 'help page renders tables and images');

  // ready -> model message with settings and host
  const [model] = JSON.parse((await post({ type: 'ready' })).body);
  assert.deepStrictEqual(model.theme, vsTheme, 'the VS Code session theme reaches the page');
  assert(model.type === 'model' && model.host === 'live' && model.text.includes('Sales Warehouse') && model.history && model.dataDir === 'data');
  assert.strictEqual(model.history, fs.readFileSync(path.join(dir, 'example.model.history.jsonl'), 'utf8'), 'a flat log beside a bare model is read (the unreleased layout, and the shipped samples)');

  // edit + save: the version log is written first, then the model; nothing is written before the save
  assert.strictEqual(model.layoutFile, fs.readFileSync(path.join(dir, 'example.model.layout.json'), 'utf8'), 'the canvas positions come from their own file');
  const F = JSON.parse(model.text), m = M.fromFile(F, 'physical', null, M.layoutRead(model.layoutFile));
  m.tables[0].description = 'changed in the browser';
  const text = M.stringify(M.toFile(m)) + '\n';
  const before = fs.readFileSync(file, 'utf8');
  assert.strictEqual(fs.existsSync(path.join(dir, 'strata.project.json')), false, 'no manifest yet');
  const wide = JSON.stringify({ note: '€'.repeat(150000) }); // 450 KB of 3-byte characters: arrives in several chunks, one of them splitting a character
  await post({ type: 'edit', text: wide });
  await post({ type: 'saveReady', text: null, history: null });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), wide, 'a large non-ASCII body is decoded once, never corrupted at a chunk boundary');
  fs.writeFileSync(file, before);
  await post({ type: 'ready' });
  await post({ type: 'edit', text });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'edits are held until saved');
  await post({ type: 'saveReady', text: null, history: null });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'saved to the model file');
  const lg = M.parseLog(model.history).history; M.commit(lg, 'modelling', undefined, { ...M.stateAt(lg, M.headsOf(lg, 'modelling')[0].chain), 'x:y': {} }, { user: 'ada', message: 'in the browser' });
  const hist = M.logText(lg);
  await post({ type: 'edit', text, history: hist });
  await post({ type: 'saveReady', text: null, history: null });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'history', 'example.history.jsonl'), 'utf8'), hist, 'history written to history/<name>.history.jsonl with the model, as JSON Lines'); assert.notStrictEqual(fs.readFileSync(path.join(dir, 'example.model.history.jsonl'), 'utf8'), hist, 'the flat file is left alone');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'strata.project.json'), 'utf8')), { strata: 'project/1', name: F.project.name, parts: [{ name: 'example', model: 'example.model.json' }] }, 'a model with no manifest gets a tiny one on its first save');
  // canvas positions: their own file, written at once, not part of the edit; held back only while an older layout is converted with the next save
  const posText = M.stringify(M.layoutFile(m, 'physical')) + '\n', moved = posText.replace(/\d+/, (n) => String(+n + 7));
  await post({ type: 'positions', text: moved });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'example.model.layout.json'), 'utf8'), moved, 'positions are written as they change, with no edit and no save');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'and the model file was not touched');
  await post({ type: 'edit', text, history: hist, positions: posText });
  await post({ type: 'positions', text: moved });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'example.model.layout.json'), 'utf8'), moved, 'positions sent with an edit wait for the save (the conversion of an older layout)');
  await post({ type: 'saveReady', text: null, history: null, positions: posText });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'example.model.layout.json'), 'utf8'), posText, 'and are written with it');

  // the last window layout: canvas and navigator state per model in .strata/layout.json (relative model path as the key)
  assert.strictEqual(model.layoutKey, 'example.model.json'); assert.deepStrictEqual(model.layout, {}, 'nothing saved yet');
  const canvasState = { level: 'logical', autoFit: false, view: { x: 10, y: 20, k: 0.5 }, scope: { c: [], s: ['main.sales'] }, panels: { history: false, impact: false, order: true, orderView: 'tree' }, selected: 'main.sales.orders' };
  await post({ type: 'layout', part: 'canvas', state: canvasState });
  await post({ type: 'layout', part: 'nav', state: { open: ['P', 'S:main.sales'], shut: ['Tags'], more: ['Relationships'] } });
  await post({ type: 'layout', part: 'bogus', state: { x: 1 } }); // unknown parts are ignored
  await post({ type: 'layout', part: 'browser', state: { nav: true } }); // the live view's navigator pane open / closed
  const lay = JSON.parse(fs.readFileSync(path.join(dir, '.strata', 'layout.json'), 'utf8'));
  assert.strictEqual(lay.strata, 'layout/1'); assert.deepStrictEqual(Object.keys(lay.models), ['example.model.json']); assert.deepStrictEqual(lay.models['example.model.json'].canvas, canvasState);
  assert.deepStrictEqual(lay.models['example.model.json'].nav.more, ['Relationships']); assert(!('bogus' in lay.models['example.model.json']));
  const back = JSON.parse((await post({ type: 'ready' })).body)[0];
  assert.deepStrictEqual(back.layout.canvas, canvasState, 'the layout comes back with the model'); assert.deepStrictEqual(back.layout.nav.shut, ['Tags']);
  assert.deepStrictEqual(back.layout.browser, { nav: true }, 'the navigator pane state comes back too');
  await Promise.all([1, 2, 3, 4, 5].map((i) => post({ type: 'layout', part: 'canvas', state: { ...canvasState, view: { x: i, y: i, k: 1 } } }))); // concurrent writes keep the file valid
  assert(JSON.parse(fs.readFileSync(path.join(dir, '.strata', 'layout.json'), 'utf8')).models['example.model.json'].nav, 'the nav part survives canvas writes');
  await post({ type: 'layout', part: 'canvas', state: null });
  assert(!('canvas' in JSON.parse(fs.readFileSync(path.join(dir, '.strata', 'layout.json'), 'utf8')).models['example.model.json']), 'null forgets the part');
  fs.writeFileSync(path.join(dir, '.strata', 'layout.json'), '{ not json');
  assert.deepStrictEqual(JSON.parse((await post({ type: 'ready' })).body)[0].layout, {}, 'a corrupt layout file is ignored');
  await post({ type: 'layout', part: 'nav', state: { open: [] } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.strata', 'layout.json'), 'utf8')).models['example.model.json'].nav, { open: [] }, 'and replaced on the next save');

  // settings, sample data
  await post({ type: 'settings', settings: { name: 'Ada', email: 'a@x.io', timezone: 'UTC', system: 'box', arrows: 'curved', animate: true, versionMode: 'save', recordLayout: true, theme: 'nord', themeVariant: 'light', embed: {} } });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.strata', 'settings.json'), 'utf8')).visualization.arrows, 'curved');
  assert.strictEqual(JSON.parse((await post({ type: 'ready' })).body)[0].settings.arrows, 'curved', 'settings come back');
  assert.strictEqual(JSON.parse((await post({ type: 'ready' })).body)[0].settings.theme, 'nord', 'the theme choice is stored in settings.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.strata', 'settings.json'), 'utf8')).visualization.theme, 'nord');
  assert.strictEqual(JSON.parse((await post({ type: 'ready' })).body)[0].settings.themeVariant, 'light', 'the flavour is stored too');
  await post({ type: 'data', op: 'create', file: 'main.ref.country.csv', text: 'id,iso\n' });
  assert(fs.existsSync(path.join(dir, 'data', 'main.ref.country.csv')), 'sample data file created in data/ beside the model');

  // export of the current state
  const exp = await req(srv.port, 'GET', '/export.html' + q);
  assert(exp.status === 200 && /attachment/.test(exp.headers['content-disposition']) && exp.body.includes('changed in the browser'), 'export has the current model');

  // a theme change in VS Code is pushed to connected browsers
  const themed = new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/events' + q, headers: { host: `127.0.0.1:${srv.port}` } }, (res) => {
      res.on('data', (c) => { if (String(c).includes('"type":"theme"') && String(c).includes('Catppuccin Latte')) { resolve(true); r.destroy(); } });
    });
    r.end();
  });
  await new Promise((r) => setTimeout(r, 300));
  srv.setTheme({ name: 'Catppuccin Latte', kind: 'light', vars: {} });
  assert.strictEqual(await Promise.race([themed, new Promise((r) => setTimeout(() => r(false), 3000))]), true, 'theme change reaches the browser');

  // an outside edit is pushed to connected browsers (server-sent events)
  const got = new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, path: '/events' + q, headers: { host: `127.0.0.1:${srv.port}` } }, (res) => {
      res.on('data', (c) => { const s = String(c); if (s.includes('data: ') && s.includes('edited outside')) { resolve(true); r.destroy(); } });
    });
    r.end();
  });
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(file, text.replace('changed in the browser', 'edited outside'));
  assert.strictEqual(await Promise.race([got, new Promise((r) => setTimeout(() => r(false), 4000))]), true, 'external change reaches the browser');
  await srv.close();

  // a project in the foldered layout: the log lands in history/, the positions beside the model, drags never touch the model text
  {
    const proj = path.join(dir, 'proj'), pr = require('../lib/project.js').create({ dir: proj, name: 'Live Star', template: 'star', user: { name: 'ada' } });
    const s2 = await startLive({ file: pr.model }), q2 = '?t=' + s2.token, post2 = (m) => req(s2.port, 'POST', '/msg' + q2, { body: JSON.stringify(m) });
    const pm = path.dirname(pr.model), plog = path.join(proj, 'history', 'live-star.history.jsonl');
    const [m2] = JSON.parse((await post2({ type: 'ready' })).body);
    assert.strictEqual(m2.history, fs.readFileSync(plog, 'utf8')); assert.strictEqual(m2.dataDir, 'data'); assert.strictEqual(m2.layoutFile, fs.readFileSync(path.join(pm, 'live-star.model.layout.json'), 'utf8'));
    const text0 = fs.readFileSync(pr.model, 'utf8'), lay0 = m2.layoutFile.replace(/\d+/, (n) => String(+n + 5));
    await post2({ type: 'positions', text: lay0 });
    assert.strictEqual(fs.readFileSync(path.join(pm, 'live-star.model.layout.json'), 'utf8'), lay0, 'a drag writes the layout file in the part folder'); assert.strictEqual(fs.readFileSync(pr.model, 'utf8'), text0, 'and leaves the model text alone');
    const l2 = M.parseLog(m2.history).history; M.commit(l2, 'modelling', undefined, { ...M.stateAt(l2, M.headsOf(l2, 'modelling').at(-1).chain), 'x:y': {} }, { user: 'ada', message: 'in the live view' });
    await post2({ type: 'layout', part: 'canvas', state: { level: 'physical' } }); assert.ok(JSON.parse(fs.readFileSync(path.join(proj, '.strata', 'layout.json'), 'utf8')).models['data_models/live-star/live-star.model.json'], 'window state: .strata/ at the project root, keyed by the model path');
    await post2({ type: 'edit', text: text0 + ' ', history: M.logText(l2) }); await post2({ type: 'saveReady', text: null, history: null });
    assert.strictEqual(fs.readFileSync(plog, 'utf8'), M.logText(l2), 'the log is saved in history/'); assert.deepStrictEqual(fs.readdirSync(proj).sort(), ['.gitattributes', '.gitignore', '.strata', 'data_models', 'history', 'strata.project.json'], 'the settings folder is at the project root (not inside the part)');
    assert.deepStrictEqual(fs.readdirSync(path.join(proj, 'history')), ['live-star.history.jsonl']);
    await s2.close();
  }

  // ---- the live view for a project-index file (release 2 part 13, ADR-0045 amended): a split project's assembled view, editable over HTTP
  // through the SAME lib/project.js functions the VS Code host calls (applyProjectEdit / updateProjectSettings / updateGovernance /
  // projectGoto) - a write made here and one made in VS Code must land identically, byte for byte ----
  {
    const P = require('../lib/project.js');
    const ldir = path.join(dir, 'live-split'), lp = P.create({ dir: ldir, name: 'Live Split', template: 'star', user: { name: 'ada' } });
    const lF = JSON.parse(fs.readFileSync(lp.model, 'utf8'));
    lF.tables[0].homeDomain = 'Ops'; lF.tables[1].homeDomain = 'Fin';
    fs.writeFileSync(lp.model, M.stringify(lF) + '\n');
    const lman = P.readManifest(ldir); lman.domains = [{ name: 'Ops', concepts: [] }, { name: 'Fin', concepts: [] }];
    fs.writeFileSync(path.join(ldir, P.MANIFEST), JSON.stringify(lman));
    const lres = P.split(lp.model, { user: { name: 'ada' } });
    assert.ok(lres.parts.length >= 2, 'at least two real parts');

    // startLive(), pointed at the project-index file itself, detects it (project.readIndexFile) and routes to the multi-part server - the
    // exact same public entry point extension.js#openLiveFor and the standalone `node live.js` CLI both call, unchanged, for any *.model.json
    const s3 = await startLive({ file: lp.model }), q3 = '?t=' + s3.token, post3 = (m) => req(s3.port, 'POST', '/msg' + q3, { body: JSON.stringify(m) });

    // token / Host checks apply to this server too (its own httpShell instance, no state shared with the single-part server above)
    assert.strictEqual((await req(s3.port, 'GET', '/')).status, 403, 'the project live view needs the token too');
    assert.strictEqual((await req(s3.port, 'GET', '/' + q3, { headers: { host: 'evil.example.com' } })).status, 403, 'DNS-rebinding guard applies here too');

    const [m3] = JSON.parse((await post3({ type: 'ready' })).body);
    assert.strictEqual(m3.host, 'live'); assert.strictEqual(m3.readOnly, true); assert.strictEqual(m3.indexFile, true); assert.strictEqual(m3.projectView, true);
    const F3 = JSON.parse(m3.text);
    assert.strictEqual(F3.project.name, 'Live Split');
    assert.strictEqual((F3.tables || []).length, lF.tables.length, 'every table from every part, reassembled — the same as the VS Code host');
    assert.deepStrictEqual(m3.histories.map((x) => x.name).sort(), [...lres.parts.map((p) => p.name), 'governance.json'].sort());

    // editProject: writes for real, to the CORRECT part's file, with a real new history entry - lib/project.js#applyProjectEdit, the exact
    // function extension.js#resolveIndexEditor calls for the VS Code host
    const editedId = F3.tables[0].id;
    const ownerBefore = lres.parts.find((p) => JSON.parse(fs.readFileSync(path.resolve(ldir, p.model), 'utf8')).tables.some((t) => t.id === editedId));
    const ownerHistPath = path.resolve(ldir, ownerBefore.history || `history/${ownerBefore.name}.history.jsonl`), histBefore = fs.readFileSync(ownerHistPath, 'utf8');
    F3.tables[0].description = 'edited from the browser live view';
    const [em3] = JSON.parse((await post3({ type: 'editProject', text: JSON.stringify(F3), message: 'live edit' })).body);
    assert.strictEqual(em3.indexFile, true, 'the response is a fresh assembled model, refreshing the page the same way postAssembledProject refreshes the VS Code tab');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.resolve(ldir, ownerBefore.model), 'utf8')).tables.find((t) => t.id === editedId).description, 'edited from the browser live view', 'written to the correct part\'s own file');
    assert.notStrictEqual(fs.readFileSync(ownerHistPath, 'utf8'), histBefore, 'and a real new history entry was written to that same part\'s own log');

    // projectSettings: the SAME project block into EVERY part's own model, each its own new, real, versioned edit
    const [sm3] = JSON.parse((await post3({ type: 'projectSettings', project: { ...F3.project, description: 'Updated from the live view' } })).body);
    assert.strictEqual(sm3.indexFile, true);
    for (const p of P.readManifest(ldir).parts) assert.strictEqual(JSON.parse(fs.readFileSync(path.resolve(ldir, p.model), 'utf8')).project.description, 'Updated from the live view', p.name + ': project settings written over HTTP');

    // governance: a new tag routes to governance.json, not any part's file
    const [gm3] = JSON.parse((await post3({ type: 'governance', governance: { tags: [{ name: 'from_the_browser' }], propertyKeys: [], policies: [] } })).body);
    assert.strictEqual(gm3.indexFile, true);
    assert.ok(JSON.parse(fs.readFileSync(path.join(ldir, P.GOVERNANCE), 'utf8')).tags.some((t) => t.name === 'from_the_browser'));
    for (const p of P.readManifest(ldir).parts) assert.ok(!('governance' in JSON.parse(fs.readFileSync(path.resolve(ldir, p.model), 'utf8'))), p.name + ': no governance section of its own');

    // domains (change 30): a description written over HTTP lands in the manifest and the reply is the refreshed project
    const d3 = P.readManifest(ldir).domains || [];
    const [dm3] = JSON.parse((await post3({ type: 'domains', domains: [{ name: 'Everything', description: 'From the browser', concepts: [] }, ...d3] })).body);
    assert.strictEqual(dm3.indexFile, true);
    assert.strictEqual(P.readManifest(ldir).domains[0].description, 'From the browser');

    // projectUndo / projectRedo: the single most recent (Undo) / earliest-undone (Redo) change across every part - lib/project.js#projectGoto,
    // the same function the VS Code host's own merged-drawer Undo/Redo buttons call
    await post3({ type: 'projectUndo' });
    const stillUpdated = P.readManifest(ldir).parts.every((p) => JSON.parse(fs.readFileSync(path.resolve(ldir, p.model), 'utf8')).project.description === 'Updated from the live view');
    assert.ok(!stillUpdated, 'projectUndo (the most recent change anywhere: the projectSettings edit, which touched every part) moved a real pointer in at least one part');
    const [rm3] = JSON.parse((await post3({ type: 'projectRedo' })).body);
    assert.strictEqual(rm3.indexFile, true);
    assert.ok(P.readManifest(ldir).parts.every((p) => JSON.parse(fs.readFileSync(path.resolve(ldir, p.model), 'utf8')).project.description === 'Updated from the live view'), 'projectRedo restored it');
    const [noMore] = JSON.parse((await post3({ type: 'projectRedo' })).body);
    assert.strictEqual(noMore.indexFile, true, 'nothing left to redo: still a fresh model, not an error');

    // "Open <part> →" (the merged history drawer's per-row action): no second browser tab for this server to open it in - told plainly to
    // the user instead of silently doing nothing
    const [op3] = JSON.parse((await post3({ type: 'openPart', file: lres.parts[0].model })).body);
    assert.strictEqual(op3.type, 'toast'); assert.ok(/own \.model\.json/.test(op3.text));

    // File watching, deliberately scoped down (documented in lib/live.js and help.md): an external change to a PART's file is NOT pushed
    // live over SSE (unlike the single-part server above, which does watch its one file) - only picked up on the next 'ready' (a reload)
    let sawPush = false;
    const es3 = http.request({ host: '127.0.0.1', port: s3.port, path: '/events' + q3, headers: { host: `127.0.0.1:${s3.port}` } }, (res) => {
      res.on('data', (c) => { if (String(c).includes('"type":"model"')) sawPush = true; });
    });
    es3.end();
    await new Promise((r) => setTimeout(r, 300));
    const extPart = JSON.parse(fs.readFileSync(path.resolve(ldir, ownerBefore.model), 'utf8'));
    extPart.tables[0].description = 'edited outside, directly in the part file';
    fs.writeFileSync(path.resolve(ldir, ownerBefore.model), M.stringify(extPart) + '\n');
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(sawPush, false, 'no live push for an external change to a part file (scoped down: see lib/live.js#startProjectLive)');
    es3.destroy();
    const [m3b] = JSON.parse((await post3({ type: 'ready' })).body);
    assert.strictEqual(JSON.parse(m3b.text).tables.find((t) => t.id === editedId).description, 'edited outside, directly in the part file', 'but a fresh \'ready\' (a reload) always re-reads from disk');

    await s3.close();
  }

  // ---- the live view refuses the ARCHIVED file too, exactly as the VS Code host does (ADR-0045 point 10) ----
  {
    const P = require('../lib/project.js');
    const adir = path.join(dir, 'live-archived'), ap = P.create({ dir: adir, name: 'Live Archived', template: 'star', user: { name: 'ada' } });
    const aF = JSON.parse(fs.readFileSync(ap.model, 'utf8'));
    aF.tables[0].homeDomain = 'Ops'; aF.tables[1].homeDomain = 'Fin';
    fs.writeFileSync(ap.model, M.stringify(aF) + '\n');
    const aman = P.readManifest(adir); aman.domains = [{ name: 'Ops', concepts: [] }, { name: 'Fin', concepts: [] }];
    fs.writeFileSync(path.join(adir, P.MANIFEST), JSON.stringify(aman));
    P.split(ap.model, { user: { name: 'ada' } });
    const archivedPath = path.join(adir, 'data_models', 'live-archived', 'live-archived.archived.model.json');
    assert.ok(fs.existsSync(archivedPath));
    const s4 = await startLive({ file: archivedPath }), q4 = '?t=' + s4.token, post4 = (m) => req(s4.port, 'POST', '/msg' + q4, { body: JSON.stringify(m) });
    const [m4] = JSON.parse((await post4({ type: 'ready' })).body);
    assert.strictEqual(m4.readOnly, true, 'the archived file stays read-only in the live view too'); assert.strictEqual(m4.host, 'live');
    const before4 = fs.readFileSync(archivedPath, 'utf8');
    await post4({ type: 'edit', text: '{}' });
    await post4({ type: 'saveReady', text: '{}', history: null });
    assert.strictEqual(fs.readFileSync(archivedPath, 'utf8'), before4, 'genuinely refuses the write over HTTP, not just hides the button');
    await s4.close();
  }

  // The ad hoc, never-split bespoke Project View panel (release 2 part 4/9) has no project-index file of its own for a live server to be
  // pointed at in the first place: extension.js#projectViewFor's own message handler has no 'openLive' case, and it never sends `indexFile`
  // so the client-side Tools button stays disabled too - Live view was never wired to it, and stays that way (structural, not a runtime
  // guard to test here); tests/host.check.js's own release-2-part-9 note applies unchanged: stubbing vscode.window.createWebviewPanel just
  // to re-confirm this structural absence was judged disproportionate to what it would prove.

  // the demo (strata-sql live --demo): the shipped samples for anyone to try; the server keeps no state and writes nothing
  {
    const { startDemo } = require('../lib/live.js'), cp = require('child_process');
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-demo-')), cwd0 = process.cwd(); process.chdir(wd); // anything the demo wrote would land here
    const d = await startDemo({}), dq = '?t=' + d.token, get = (u) => req(d.port, 'GET', u);
    try {
      assert.strictEqual((await get('/')).status, 403, 'the demo needs its access token too');
      assert.strictEqual((await get('/demo/sample?id=northwind')).status, 403, 'and so does a sample');
      const boot = JSON.parse((await get('/' + dq)).body.match(/id="strata-boot">([\s\S]*?)<\/script>/)[1]);
      assert.strictEqual(boot.mode, 'demo'); assert.deepStrictEqual(boot.samples.map((x) => x.id), ['northwind', 'fpml', 'star'], 'every shipped sample, and not the blank template');
      const nw = JSON.parse((await get('/demo/sample' + dq + '&id=northwind')).body);
      assert(M.fromFile(JSON.parse(nw.model), 'physical').tables.length > 10 && nw.history.trim().split('\n').length > 3 && nw.layout && Object.keys(nw.data).length > 5, 'a sample comes with its version log, positions and sample data');
      assert.strictEqual(JSON.parse((await get('/demo/sample' + dq + '&id=star')).body).model.includes('"strata"'), true);
      for (const bad of ['blank', '../../etc/passwd', '', 'example']) assert.strictEqual(JSON.parse((await get('/demo/sample' + dq + '&id=' + encodeURIComponent(bad))).body).error, 'unknown sample', 'only shipped sample ids reach the disk: ' + JSON.stringify(bad));
      assert.strictEqual((await req(d.port, 'POST', '/msg' + dq, { body: JSON.stringify({ type: 'edit', text: '{}' }) })).body, '[]', 'a posted edit is ignored');
      assert.strictEqual((await req(d.port, 'POST', '/msg' + dq, { body: '{}', headers: { origin: 'http://evil.example.com' } })).status, 403, 'a foreign origin is refused');
      assert.deepStrictEqual(fs.readdirSync(wd), [], 'nothing is written');
      const chromeBin = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      if (fs.existsSync(chromeBin)) { // the page, rendered: the first sample is open, the demo bar offers every sample (async: this process serves the page)
        const dom = await new Promise((resolve, reject) => cp.execFile(chromeBin, ['--headless=new', '--disable-gpu', '--window-size=1280,800', '--virtual-time-budget=8000', '--dump-dom', d.url], { encoding: 'utf8', maxBuffer: 1 << 27 }, (e, out) => (e ? reject(e) : resolve(out))));
        const bar = (dom.match(/id="demobar"[\s\S]*?<\/div>/) || [''])[0];
        assert((bar.match(/<option/g) || []).length === 3 && /<title>northwind/.test(dom) && (dom.match(/class="card/g) || []).length > 10, 'the demo page opens Northwind with its sample picker');
      } else console.log('  (demo render skipped: Chrome not found, set CHROME=)');
    } finally { process.chdir(cwd0); await d.close(); fs.rmSync(wd, { recursive: true, force: true }); }
  }
  // static export: self-contained, no external requests, model embedded, script-safe
  const html = exportHtml({ name: 'x', modelText: '{"strata":2,"note":"</script><b>"}', historyText: null, theme: vsTheme, themeSetting: 'tokyonight', themeVariant: 'moon' });
  assert(!/<script[^>]+src=/.test(html) && !/<link[^>]+href="(?!data:)/.test(html), 'no external files (the favicon is a data URL)');
  assert(html.includes('id="strata-boot"') && !html.includes('</script><b>'), 'embedded data cannot close the script tag');
  const boot = JSON.parse(html.match(/<script type="application\/json" id="strata-boot">([\s\S]*?)<\/script>/)[1]);
  assert.deepStrictEqual(boot.theme, vsTheme); assert.strictEqual(boot.themeSetting, 'tokyonight'); assert.strictEqual(boot.themeVariant, 'moon');
  assert(html.includes('rel="icon"') && html.includes('brand.js') === false && boot.mode === 'static' && boot.data.model.includes('</script><b>') && boot.navHtml.includes('acquireVsCodeApi'));
  // the canvas must never append null / false as text (DOM replaceChildren stringifies them; fill() filters)
  assert(!/\.replaceChildren\((?!\))/.test(fs.readFileSync(path.join(__dirname, '../media/canvas.js'), 'utf8').replace('el.replaceChildren(...kids', '')), 'canvas.js: use fill(el, ...) instead of el.replaceChildren(...)');
  // the exported page, rendered: read-only controls = zoom, fit and mini-map, and no "null" / "undefined" text (needs Chrome, else skipped)
  const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(chrome)) {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'strata-exp-')), 'nw.html'), root = path.join(__dirname, '..', 'sample_data_models');
    fs.writeFileSync(out, exportHtml({ name: 'northwind', modelText: fs.readFileSync(path.join(root, 'northwind.model.json'), 'utf8'), historyText: fs.readFileSync(path.join(root, 'northwind.model.history.jsonl'), 'utf8'), layoutText: fs.readFileSync(path.join(root, 'northwind.model.layout.json'), 'utf8') }));
    const dom = require('child_process').execFileSync(chrome, ['--headless=new', '--disable-gpu', '--window-size=1280,800', '--virtual-time-budget=5000', '--dump-dom', 'file://' + out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const ctl = (dom.match(/<div id="ctl"[\s\S]*?<\/div>/) || [''])[0];
    assert.deepStrictEqual([...ctl.matchAll(/data-ctl="(\w+)"/g)].map((m) => m[1]), ['zoomIn', 'zoom', 'zoomOut', 'fit', 'minimap'], 'export controls: navigation only');
    assert(!/>\s*(null|undefined|false)\s*</.test(ctl.replace(/<svg[\s\S]*?<\/svg>/g, '')), 'no null / undefined text in the export controls');
  } else console.log('  (export render skipped: Chrome not found, set CHROME=)');
  console.log('live check ok');
})().catch((e) => { console.error(e); process.exit(1); });
