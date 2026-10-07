// Drives the real openSample() through a stubbed vscode module, then verify()s the copied pairs.
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');
const assert = require('assert');
const REPO = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-sample-'));
const Uri = { file: (p) => ({ fsPath: p, path: p }), joinPath: (u, ...s) => Uri.file(path.join(u.fsPath, ...s)) };
const log = { exec: [], info: [], pick: 0 };
const cmds = {};
let folders = [{ uri: Uri.file(work) }];
const vscode = {
  Uri, ViewColumn: {}, ColorThemeKind: {},
  workspace: { get workspaceFolders() { return folders; }, fs: {},
    onDidChangeTextDocument: () => ({}), onDidChangeConfiguration: () => ({}), getConfiguration: () => ({ get: () => '' }) },
  window: { activeTextEditor: null, onDidChangeActiveColorTheme: () => ({}), onDidChangeActiveTextEditor: () => ({}),
    registerCustomEditorProvider: () => ({}), registerWebviewViewProvider: () => ({}), registerUriHandler: (h) => { cmds.uri = h; return {}; },
    showQuickPick: async (items) => { log.pick++; assert.equal(items.length, 2); return items[1]; },
    showOpenDialog: async () => [Uri.file(path.join(work, 'picked'))],
    showInformationMessage: (m) => { log.info.push(m); return Promise.resolve(); }, showErrorMessage: (m) => { throw new Error(m); } },
  commands: { registerCommand: (id, fn) => { cmds[id] = fn; return {}; }, executeCommand: async (...a) => { log.exec.push(a); } },
};
const orig = Module._load;
Module._load = function (req, ...r) { return req === 'vscode' ? vscode : orig.call(this, req, ...r); };
const ext = require(REPO + '/extension.js');
ext.activate({ subscriptions: { push() {} }, extensionUri: Uri.file(REPO) });
const SM = require(REPO + '/media/model.js');
// the level shortcuts: one command each, bound to Ctrl/Cmd+Alt+<letter> in package.json
const pkg = require(REPO + '/package.json');
for (const [lv, k] of [['governance', 'g'], ['conceptual', 'c'], ['logical', 'l'], ['physical', 'p'], ['semantic', 's']]) {
  assert.ok(cmds['strata.level.' + lv], 'command strata.level.' + lv);
  assert.ok(pkg.contributes.keybindings.some((b) => b.command === 'strata.level.' + lv && b.key === 'ctrl+alt+' + k && b.mac === 'cmd+alt+' + k), 'key for ' + lv);
}
// the shipped sources are flat pairs in sample_data_models/; a sample opened in a workspace is a foldered project (data_models/<id>/, history/<id>.history.jsonl)
const SRC = path.join(REPO, 'sample_data_models');
const files = (dir, id) => dir === SRC ? { model: id + '.model.json', log: id + '.model.history.jsonl', pos: id + '.model.layout.json', data: id + '_model_data' }
  : { model: `data_models/${id}/${id}.model.json`, log: `history/${id}.history.jsonl`, pos: `data_models/${id}/${id}.model.layout.json`, data: `data_models/${id}/data` };
const verifyPair = (dir, id) => {
  const f = files(dir, id), o = JSON.parse(fs.readFileSync(path.join(dir, f.model), 'utf8'));
  const h = SM.parseLog(fs.readFileSync(path.join(dir, f.log), 'utf8')).history;
  assert.ok(fs.existsSync(path.join(dir, f.pos)), id + ': positions come with the model');
  return SM.verify(h, SM.flatten(SM.toFile(SM.fromFile(o, 'physical'))));
};
(async () => {
  for (const id of ['northwind', 'fpml']) {
    assert.deepEqual(verifyPair(SRC, id), [], id + ' shipped pair drifts');
    await cmds['strata.openSample'](id);
    assert.deepEqual(verifyPair(work, id), [], id + ' copied pair drifts');
    const a = files(SRC, id), b = files(work, id);
    for (const k of ['model', 'log', 'pos']) assert.equal(fs.readFileSync(path.join(work, b[k]), 'utf8'), fs.readFileSync(path.join(SRC, a[k]), 'utf8'), id + ' ' + k + ' is copied as it is (the sample keeps its own name: no rename, no extra version)');
    assert.equal(fs.readdirSync(path.join(work, b.data)).length, fs.readdirSync(path.join(SRC, a.data)).length);
    assert.ok(!fs.existsSync(path.join(work, id + '.model.json')) && !fs.existsSync(path.join(work, id + '_model_data')), 'nothing flat beside the project');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work, 'strata.project.json'), 'utf8')).parts.map((x) => x.name).includes(id), true, 'a manifest lists it');
    assert.ok(!fs.existsSync(path.join(work, '.gitignore')), 'a sample brings no Git files');
    const last = log.exec.at(-1);
    assert.equal(last[0], 'vscode.openWith'); assert.equal(last[1].fsPath, path.join(work, b.model)); assert.equal(last[2], 'strata.modelEditor');
  }
  // northwind and fpml ship starter domains (release 2 part 3, ADR-0045 amended): opening either alone, through the real openSample command,
  // seeds them into the manifest it creates — the exact reproduction of the reported failure ("split Northwind" did nothing because nothing
  // populated `domains`) is now: open the sample, the Domains dialog already lists them, no hand-editing of strata.project.json needed.
  const P = require(REPO + '/lib/project.js');
  for (const id of ['northwind', 'fpml']) {
    const fresh = path.join(work, 'fresh-' + id); fs.mkdirSync(fresh); folders = [{ uri: Uri.file(fresh) }];
    await cmds['strata.openSample'](id);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, 'strata.project.json'), 'utf8')).domains, P.TEMPLATES[id].domains, id + ': opened alone, its starter domains are in the manifest, ready to split');
  }
  folders = [{ uri: Uri.file(work) }];
  assert.equal(log.pick, 0);
  // never overwrite: a user edit survives, the existing model is opened
  fs.writeFileSync(path.join(work, files(work, 'northwind').model), '{"mine":1}');
  await cmds['strata.openSample']('northwind');
  assert.equal(fs.readFileSync(path.join(work, files(work, 'northwind').model), 'utf8'), '{"mine":1}');
  assert.match(log.info.at(-1), /already exist.*nothing was copied.*Opened the existing model/);
  // only the data folder taken: nothing copied, nothing opened
  for (const k of ['model', 'log', 'pos']) fs.rmSync(path.join(work, files(work, 'fpml')[k]));
  const n = log.exec.length;
  await cmds['strata.openSample']('fpml');
  assert.ok(!fs.existsSync(path.join(work, files(work, 'fpml').model))); assert.equal(log.exec.length, n);
  assert.match(log.info.at(-1), /data_models\/fpml\/data already exists/);
  // no id -> quick pick (2 entries, picks FpML); no folder -> open dialog
  folders = undefined; fs.mkdirSync(path.join(work, 'picked'));
  await cmds['strata.openSample']();
  assert.equal(log.pick, 1); assert.deepEqual(verifyPair(path.join(work, 'picked'), 'fpml'), []);
  // URI handler (help links)
  folders = [{ uri: Uri.file(path.join(work, 'picked')) }];
  await cmds.uri.handleUri({ path: '/openSample', query: 'northwind' });
  assert.deepEqual(verifyPair(path.join(work, 'picked'), 'northwind'), []);
  assert.equal(cmds.uri.handleUri({ path: '/other', query: '' }), false);
  fs.rmSync(work, { recursive: true });
  console.log('sample check: ok');
})().catch((e) => { console.error(e); process.exit(1); });
