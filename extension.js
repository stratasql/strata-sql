const vscode = require('vscode');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VIEW_TYPE = 'strata.modelEditor';
// The thin project-index file split() leaves at the pre-split model's old path has an ordinary "<name>.model.json" name, so only its content
// marker tells it apart (re-checked on every read, not cached: Split and Join turn a file into one and back while its tab stays open).
// The archived pre-split file is told apart by its name instead (lib/project.js#isArchived).
const indexObjOf = (doc) => { try { const o = JSON.parse(doc.getText()); return (o && o.strata === projectLib().INDEX_STRATA) ? o : null; } catch { return null; } };
const panels = new Map(); // doc uri -> { panel, doc, lastText }
let activeKey = null;
let navView = null;

const brand = require('./media/brand.js');
const io = require('./lib/hostio.js');
const dbtLib = () => require('./lib/dbt.js'); // lazy, like projectLib: only when a dbt import runs
const sqlLib = () => require('./lib/sqlimport.js'); // lazy too: only when a DDL / SQL import runs
const projectLib = () => require('./lib/project.js'); // lazy (it loads media/model.js): needed only when a model is saved, a sample opened or a project created
const { readText, writeAtomic, embedProviderInfo, envKey } = io;

// Workspace-level settings live in <workspace>/.strata/settings.json
const wsOf = (doc) => vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
const rootOf = (doc) => wsOf(doc) || projectLib().resolve(doc.uri.fsPath).root; // no workspace folder: the project's own folder
// where every file of the model is (lib/project.js `resolve`: manifest in the model's folders up to the workspace folder, else an implicit one-part project)
const projectOf = (doc) => projectLib().resolve(doc.uri.fsPath, { stop: wsOf(doc) });
// every notification carries the product name
const say = (kind) => (text, ...buttons) => vscode.window[`show${kind}Message`](`${brand.name}: ${text}`, ...buttons);
const info = say('Information'), warn = say('Warning'), fail = say('Error');
const userOf = io.userOf;
const dirUriOf = (doc) => doc.uri.with({ path: doc.uri.path.replace(/\/[^/]*$/, '') }); // the folder a document sits in
// a path named by the webview (a part, the index file) must stay inside the project; never an absolute path or a ../ escape
const inside = (root, rel) => { const p = path.resolve(root, String(rel)), r = path.relative(root, p); return r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r) ? null : p; };
const getSettings = (doc) => io.getSettings(rootOf(doc));
const saveSettings = (doc, v) => io.saveSettings(rootOf(doc), v);
const embedPathOf = (doc) => io.embedPathOf(doc.uri.fsPath);
const readEmbedStatus = (doc) => io.readEmbedStatus(doc.uri.fsPath);

// ---- vector embeddings: keys live in VS Code secret storage (or env vars), never in files or the webview ----
async function embedKey(ctx, id) { return (await ctx.secrets.get('strata.embed.' + id)) || envKey(id); }
async function embedKeyStatus(ctx) {
  const embed = require('./media/embed.js'); // lazy: not needed until a model editor is opened
  const out = {};
  for (const id of embed.PROVIDER_IDS) out[id] = !embed.PROVIDERS[id].env ? 'local' : (await ctx.secrets.get('strata.embed.' + id)) ? 'secret' : envKey(id) ? 'env' : null;
  return out;
}
// The embeddings pipeline for one model FILE's text: what `generateEmbeddings` (tied to one open doc/panel) runs, so the project-index file's
// loop over every domain part (`generateEmbeddingsForIndex`) can run it once per part.
async function runEmbeddingsFor(ctx, root, modelFile, modelText, onMessage) {
  const embed = require('./media/embed.js'); // lazy: not needed until embeddings are actually generated
  const label = (id) => embed.PROVIDERS[id].label;
  return { results: await io.embedModel(modelFile, modelText, await io.getSettings(root), (id) => embedKey(ctx, id),
    { onProgress: (id, done, total) => onMessage?.(`${label(id)}: ${done}/${total}`), onStatus: (id, msg) => onMessage?.(`${label(id)}: ${msg}`) }) };
}
async function setEmbeddingKey(ctx, id) {
  const embed = require('./media/embed.js'); // lazy: not needed until the user sets an API key
  const p = embed.PROVIDERS[id];
  if (!p || !p.env) return;
  const v = await vscode.window.showInputBox({ title: `API key for ${p.label}`, prompt: 'Stored in VS Code secret storage on this machine. Leave empty to remove it.', password: true, ignoreFocusOut: true });
  if (v === undefined) return;
  if (v.trim()) await ctx.secrets.store('strata.embed.' + id, v.trim()); else await ctx.secrets.delete('strata.embed.' + id);
}
function page(webview, ctx, css, scripts, body) {
  const nonce = crypto.randomBytes(18).toString('base64url');
  const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', f));
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri(css)}"></head><body>${body}
${scripts.map((s) => `<script nonce="${nonce}" src="${uri(s)}"></script>`).join('')}</body></html>`;
}

const mediaOptions = (ctx) => ({
  enableScripts: true,
  localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
});
// the canvas's own script list: the model editor and the read-only Project View panel both load exactly this (no shim.js: both post the
// 'model' message directly, unlike the live view / HTML export which run over lib/shell.js's shim).
const EDITOR_SCRIPTS = ['brand.js', 'themes.js', 'model.js', 'legacy.js', 'align.js', 'gov.js', 'impact.js', 'order.js', 'md.js', 'codegen.js', 'layout.js', 'canvas.js'];

// The navigator shows the .model.json that was activated last: a Strata editor or the plain text editor.
let navDoc = null;
let pendingReveal = null; // reveal requested for a model that is still opening in Strata SQL
const isModelDoc = (d) => !!d && d.uri.scheme === 'file' && /\.model\.json$/.test(d.uri.fsPath);

let lastNavKey = null; // the model whose saved navigator state (.strata/layout.json) the navigator already has
// The Navigator renders from the .model.json TEXT it is given (media/nav.js). For a project-index file that text is the thin marker, which
// would render as empty, so it gets the assembled project's text instead (display only).
async function navTextOf(doc) {
  const idx = indexObjOf(doc);
  if (!idx) return doc.getText();
  try {
    const project = projectLib(), r = projectOf(doc), man = project.readManifest(r.root);
    const { F } = project.assembledProjectModel(r.root, man);
    return require('./media/model.js').stringify(F);
  } catch { return doc.getText(); } // could not assemble (a part missing/unreadable): fall back to the thin marker
}
async function pushNav() {
  if (!navView) return;
  const msg = { type: 'model', text: navDoc ? await navTextOf(navDoc) : null, file: navDoc ? path.basename(navDoc.uri.fsPath) : null };
  if (navDoc) {
    const root = rootOf(navDoc), key = io.layoutKey(root, navDoc.uri.fsPath);
    if (key !== lastNavKey) { lastNavKey = key; msg.layoutKey = key; msg.layout = (await io.readLayout(root, key)).nav || null; }
  } else lastNavKey = null;
  navView?.webview.postMessage(msg);
  if (navThemeCss) navView?.webview.postMessage({ type: 'theme', css: navThemeCss });
}
function setNavDoc(doc) {
  navDoc = doc;
  pushNav();
}

// Show or hide the navigator side view. When showing, the search box gets focus only if asked to.
async function setNavigation(show, focusSearch) {
  if (!show) {
    if (navView?.visible) await vscode.commands.executeCommand('workbench.action.closeSidebar');
    return;
  }
  if (!navView?.visible) await vscode.commands.executeCommand('strata.navigation.focus');
  if (focusSearch) navView?.webview.postMessage({ type: 'focusSearch' });
  else await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
}

// ---- browser: live view (whole tool in the default browser) and self-contained interactive HTML export ----
const liveServers = new Map(); // model file -> running live view

// The VS Code theme: its name (Auto matches Catppuccin, Tokyo Night, Rosé Pine, Nord by name) and, once a webview reported them, the real colours
// (so a browser live view or an export looks like this VS Code session).
let lastTheme = null; // { name, kind, vars }
let navThemeCss = ''; // canvas theme css for the navigator view
const themeNow = () => ({ name: vscode.workspace.getConfiguration('workbench').get('colorTheme') || '', kind: [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind) ? 'light' : 'dark' });
function themeChanged() {
  const t = themeNow();
  lastTheme = { ...(lastTheme || {}), ...t, vars: undefined }; // the old colours are stale until the webview reports the new ones
  for (const e of panels.values()) e.panel.webview.postMessage({ type: 'theme', name: t.name, kind: t.kind });
}
// save generated text next to a document (ETL code, ...); saveFileAt takes an explicit target FOLDER instead, for the Project View / index file,
// which has no backing document of its own.
async function saveFileAt(dirUri, name, text) {
  const uri = await vscode.window.showSaveDialog({ defaultUri: dirUri.with({ path: dirUri.path.replace(/\/$/, '') + '/' + path.basename(String(name)) }) });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(String(text)));
  info('saved ' + uri.path.split('/').pop(), 'Open').then((pick) => { if (pick) vscode.commands.executeCommand('vscode.open', uri); });
}
async function saveFileFor(doc, name, text) {
  await saveFileAt(dirUriOf(doc), name, text);
}
async function exportCodeFor(doc) {
  const codegen = require('./media/codegen.js'), model = require('./media/model.js');
  const pick = await vscode.window.showQuickPick(Object.entries(codegen.TARGETS).map(([id, t]) => ({ label: t.label, description: '.' + t.ext, id })), { title: 'Export ETL / ELT code' });
  if (!pick) return;
  let out;
  try { out = codegen.generate(model.fromFile(JSON.parse(doc.getText()), 'physical'), pick.id, {}); } catch (err) { return fail(err.message); }
  await saveFileFor(doc, out.name, out.text);
}
const modelStem = (doc) => path.basename(doc.uri.fsPath).replace(/\.model\.json$/, '');

// ---- sample models shipped with the extension: copied (never overwriting) into the workspace, then opened in Strata ----
const sampleModels = () => { const t = projectLib().TEMPLATES; return { northwind: t.northwind, fpml: t.fpml }; };
async function openSample(id) {
  const SAMPLES = sampleModels();
  if (!SAMPLES[id]) {
    const pick = await vscode.window.showQuickPick(Object.entries(SAMPLES).map(([k, s]) => ({ label: s.label, detail: s.detail, id: k })), { title: 'Open a sample model' });
    if (!pick) return;
    id = pick.id;
  }
  let dir = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!dir) {
    const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Copy sample here', title: 'Folder for the sample model' });
    if (!pick) return;
    dir = pick[0];
  }
  // the same code as the New Project wizard: the sample lands in the foldered layout (data_models/<id>/, history/<id>.history.jsonl, its data/), as a part of the
  // manifest in that folder (created if there is none). Never overwrites: if any of its files exists nothing is created, and an existing model is opened instead.
  const project = projectLib(), stem = id, target = vscode.Uri.file(path.join(dir.fsPath, ...project.DIRS.models.split('/'), stem, stem + '.model.json'));
  const busy = project.taken(dir.fsPath, stem);
  if (busy.length) {
    const hasModel = fs.existsSync(target.fsPath);
    info(`${busy.join(', ')} already exist${busy.length > 1 ? '' : 's'} in ${path.basename(dir.fsPath)}; nothing was copied.${hasModel ? ' Opened the existing model.' : ''}`);
    if (hasModel) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    return;
  }
  project.create({ dir: dir.fsPath, template: id, stem, git: false, user: await userOf(dir.fsPath) }); // no Git files: a sample is for looking around, not a team's project
  await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
}

// `lib/live.js#startLive` detects an archived or project-index file by content and picks the matching server itself, so this needs no
// branching; only the toast wording below differs.
async function openPart(doc, rel) {
  const p = inside(projectOf(doc).root, rel);
  if (p) await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(p), VIEW_TYPE);
}
async function openLiveFor(doc) {
  const live = require('./lib/live.js'); // lazy: only needed when the user opens the live view
  if (doc.isDirty) await doc.save(); // the live view works on the file on disk
  let srv = liveServers.get(doc.uri.fsPath);
  if (!srv) { srv = await live.startLive({ file: doc.uri.fsPath, root: rootOf(doc), theme: lastTheme }); liveServers.set(doc.uri.fsPath, srv); }
  else if (lastTheme) srv.setTheme(lastTheme);
  await vscode.env.openExternal(vscode.Uri.parse(srv.url));
  const project = projectLib();
  const what = project.isArchived(doc.uri.fsPath) ? ' (read-only: this file was archived by a split)'
    : indexObjOf(doc) ? ' (changes made there are saved to the project\'s own domain parts, not to this file)' : ' (changes made there are saved to the file)';
  vscode.window.showInformationMessage(`${brand.name} live view for ${path.basename(doc.uri.fsPath)} is running at http://127.0.0.1:${srv.port}${what}.`, 'Stop live view').then(async (pick) => {
    if (pick) { await srv.close(); liveServers.delete(doc.uri.fsPath); }
  });
}

// exportHtmlAt is the shared write (save dialog, the generated page, the "Open in browser" toast); exportHtmlFor is the one-document case.
// The project-index file calls exportHtmlAt directly with the assembled model text: its own on-disk content is only a thin marker.
async function exportHtmlAt(dirUri, name, opts) {
  const { exportHtml } = require('./lib/export.js'); // lazy: only needed when the user exports HTML
  const uri = await vscode.window.showSaveDialog({ defaultUri: dirUri.with({ path: dirUri.path.replace(/\/$/, '') + '/' + name + '.html' }), filters: { HTML: ['html'] } });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(exportHtml({ name, theme: lastTheme, ...opts })));
  info('interactive HTML saved to ' + uri.path.split('/').pop(), 'Open in browser').then((pick) => { if (pick) vscode.env.openExternal(uri); });
}
async function exportHtmlFor(doc) {
  const entry = panels.get(doc.uri.toString()), history = entry?.historyText ?? (await io.readHistory(projectOf(doc))), positions = entry?.positionsText ?? (await readText(io.layoutFilePathOf(doc.uri.fsPath)));
  const st = await io.getSettings(rootOf(doc)); // the Strata SQL theme choice travels with the export
  await exportHtmlAt(dirUriOf(doc), modelStem(doc), { modelText: doc.getText(), historyText: history, layoutText: positions, themeSetting: st.theme, themeVariant: st.themeVariant });
}

// the model the user is working with: the active Strata editor, the active text editor, or the one the navigator shows
const currentModelDoc = () => {
  const active = vscode.window.activeTextEditor?.document;
  return (activeKey && panels.get(activeKey)?.doc) || (isModelDoc(active) ? active : null) || navDoc;
};
const needModel = (fn) => () => {
  const doc = currentModelDoc();
  if (!doc) return warn('open a .model.json file first.');
  return fn(doc);
};

const activePanel = () => (activeKey && panels.get(activeKey)?.panel) || null;

// ---- Strata SQL: New Project (ADR-0043): folder, name, starting point, (blank: platform and methodology), then create; team setup is one optional extra step ----
async function newProject() {
  const project = projectLib();
  const w = vscode.window, pick = (items, o) => w.showQuickPick(items, { ignoreFocusOut: true, ...o });
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  let dir = ws;
  const choose = async () => { const r = await w.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Create the project here', title: 'Folder for the new project' }); return r?.[0]; };
  if (ws) {
    const f = await pick([{ label: '$(folder) ' + path.basename(ws.fsPath), description: 'this workspace folder', id: 'ws' }, { label: '$(folder-opened) Choose another folder…', id: 'other' }], { title: 'New Project (1/3): folder' });
    if (!f) return;
    if (f.id === 'other') dir = await choose();
  } else dir = await choose();
  if (!dir) return;
  const taken = (n) => project.taken(dir.fsPath, project.slug(n));
  const name = await w.showInputBox({ title: 'New Project (2/3): name', prompt: 'The project name. It also names the files: data_models/<name>/<name>.model.json and history/<name>.history.jsonl.', value: 'My Data Model', ignoreFocusOut: true,
    validateInput: (v) => (!project.slug(v) ? 'Use at least one letter or digit.' : taken(v).length ? `${taken(v).join(', ')} already exist in this folder; nothing is overwritten. Pick another name or folder.` : null) });
  if (!name) return;
  let tpl;
  const items = [...Object.entries(project.TEMPLATES).map(([id, t]) => ({ label: t.label, description: t.platform ? `${t.platform} · ${t.methodology}` : '', detail: t.detail, id })), { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(package) From a dbt project…', description: 'target/manifest.json and catalog.json', detail: 'Imports models, sources, seeds and snapshots as tables with columns (read from the SQL too), relationships, tags and metrics; re-sync later to stay up to date.', id: 'dbt' },
    { label: '$(database) From DDL / SQL scripts…', description: '.sql files or folders', detail: 'Imports tables, columns, keys, foreign keys, comments and views from CREATE TABLE scripts (pg_dump, mysqldump, SSMS ...), and metrics, joins and lineage from queries; re-sync later.', id: 'sql' }];
  tpl = await pick(items, { title: 'New Project (3/3): starting point', placeHolder: 'Blank, a template copied and renamed as your own, a dbt project or SQL scripts' });
  if (!tpl) return;
  const opts = { dir: dir.fsPath, name: name.trim(), template: tpl.id, git: true, ignoreLayout: false };
  if (tpl.id === 'dbt') { // the dbt project folder (or its manifest.json); the platform comes from the dbt adapter
    const d = await w.showOpenDialog({ canSelectFolders: true, canSelectFiles: true, defaultUri: dir, openLabel: 'Import this dbt project', title: 'dbt project folder (run "dbt parse" first) or its manifest.json' });
    if (!d?.[0]) return;
    opts.from = d[0].fsPath;
  }
  if (tpl.id === 'sql') { // DDL files, optional query files, the dialect (detected, confirmed)
    const q = await pickSql(dir);
    if (!q) return;
    Object.assign(opts, q);
  }
  if (tpl.id === 'blank') {
    const model = require('./media/model.js');
    const p = await pick(Object.keys(model.PLATFORMS).map((k) => ({ label: k, description: model.PLATFORMS[k].parts === 3 ? 'catalog.schema.table' : 'schema.table' })), { title: 'Database platform', placeHolder: 'PostgreSQL' });
    if (!p) return;
    const m = await pick(model.METHODS.map((k) => ({ label: k })), { title: 'Modelling methodology', placeHolder: 'ER - 3NF' });
    if (!m) return;
    opts.platform = p.label; opts.methodology = m.label;
  }
  const go = await pick([{ label: '$(check) Create project', id: 'go' }, { label: '$(organization) Team setup…', description: 'optional', detail: 'Git files and whether the layout file is committed', id: 'team' }], { title: `Create "${opts.name}"` });
  if (!go) return;
  if (go.id === 'team') {
    const t = await w.showQuickPick([{ label: 'Git files', description: '.gitattributes and .gitignore', detail: 'History lines merge without conflicts (history/*.jsonl merge=union); .strata/ stays personal', picked: true, id: 'git' },
      { label: 'Commit the layout file', description: '<name>.model.layout.json', detail: 'Everyone sees the same diagram positions. Untick to keep them personal.', picked: true, id: 'layout' }], { canPickMany: true, title: 'Team setup', ignoreFocusOut: true });
    if (!t) return;
    opts.git = t.some((x) => x.id === 'git'); opts.ignoreLayout = !t.some((x) => x.id === 'layout');
  }
  try {
    const user = await userOf(ws?.fsPath || dir.fsPath);
    const r = opts.from ? dbtLib().importNew({ ...opts, user }) : opts.ddl || opts.dml ? sqlLib().importNew({ ...opts, user, template: undefined }) : project.create({ ...opts, user });
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(r.model), VIEW_TYPE);
    info(`created ${path.basename(r.model)} (${r.files.length} files) in ${path.basename(dir.fsPath)}` + (opts.from ? ` from dbt: ${r.headline}.` : opts.ddl || opts.dml ? ` from SQL scripts (${sqlLib().LABEL[r.dialect]}): ${r.headline}.` : '.') + (r.notes?.length ? ' ' + r.notes.join(' ') : ''));
  } catch (err) { fail(err.message); }
}

// ---- Strata SQL: Import from dbt / Re-sync from dbt (ADR-0048) ----
// Into the open model: a modal previews what would change, then lib/dbt.js writes the log first and the model after (VS Code reloads the document and
// the editor finds the new version by content hash). `ask` = pick the dbt folder / manifest.json again, else the paths in the manifest's `dbt` block are used.
async function dbtFor(doc, ask) {
  const project = projectLib(), dbt = dbtLib(), r = projectOf(doc), man = r.manifest ? project.readManifest(r.root) : null, stored = man?.dbt;
  if (doc.isDirty) return warn('save the model first, then import from dbt.');
  let from = null;
  if (ask || !stored) {
    const at = stored?.project || stored?.manifest;
    const d = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: true, defaultUri: at ? vscode.Uri.file(path.resolve(r.root, at)) : vscode.Uri.file(r.root), openLabel: 'Import this dbt project', title: 'dbt project folder (run "dbt parse" first) or its manifest.json' });
    if (!d?.[0]) return;
    from = d[0].fsPath;
  }
  try {
    const p = dbt.plan(doc.uri.fsPath, { from, stop: wsOf(doc) });
    if (!p.changes.length) return info('the model is already up to date with dbt.' + (p.notes.length ? ' ' + p.notes.join(' ') : ''));
    const shown = p.lines.slice(0, 30), more = p.lines.length - shown.length;
    const detail = [...shown, ...(more > 0 ? [`… and ${more} more`] : []), ...(p.notes.length ? ['', ...p.notes] : []), '', 'Nothing is deleted or overwritten apart from the fields dbt owns; the change is recorded as one version and can be undone.'].join('\n');
    const go = await vscode.window.showInformationMessage(`Sync from dbt: ${p.headline}`, { modal: true, detail }, 'Apply');
    if (go !== 'Apply') return;
    dbt.apply(p, { user: await userOf(rootOf(doc)) });
    info(`synced from dbt (${p.headline}).`);
  } catch (err) { fail('dbt import failed (' + err.message + ')'); }
}

// ---- Strata SQL: Import from DDL / Re-sync from SQL scripts (ADR-0051) ----
// The same shape as the dbt import: pick the files, preview, Apply. DDL and query files are picked separately only to keep them apart in the manifest;
// the dialect is detected from the text and confirmed, never assumed.
async function pickSql(startAt) {
  const w = vscode.window, sql = sqlLib(), open = async (title, openLabel) => (await w.showOpenDialog({ canSelectMany: true, canSelectFolders: true, canSelectFiles: true, defaultUri: startAt, openLabel, title, filters: { 'SQL scripts': ['sql', 'ddl', 'dml', 'hql', 'psql', 'tsql'] } }))?.map((u) => u.fsPath);
  const ddl = await open('DDL scripts: CREATE TABLE, ALTER TABLE, views (.sql files or folders)', 'Use these DDL scripts');
  if (!ddl?.length) return null;
  let dml = [];
  const more = await w.showQuickPick([{ label: 'No query files', description: 'tables and relationships only', id: 'no' }, { label: 'Add query files…', description: 'SELECT, INSERT ... SELECT, MERGE, reports', detail: 'Metrics, joins and lineage are derived from them', id: 'dml' }], { title: 'Import from SQL scripts: queries (optional)', ignoreFocusOut: true });
  if (!more) return null;
  if (more.id === 'dml') { dml = await open('Query / DML scripts (.sql files or folders)', 'Use these query files'); if (!dml) return null; }
  const found = sql.detectFiles([...ddl, ...dml]), order = [found.dialect, ...sql.DIALECTS.filter((d) => d !== found.dialect)];
  const d = await w.showQuickPick(order.map((id) => ({ label: sql.LABEL[id] + (id === found.dialect ? (found.confident ? '  (detected)' : '  (best guess, please check)') : ''), id })), { title: 'Import from SQL scripts: SQL dialect', placeHolder: 'The dialect the scripts are written in', ignoreFocusOut: true });
  return d ? { ddl, dml: dml.length ? dml : undefined, dialect: d.id } : null;
}
async function sqlFor(doc, ask) {
  const project = projectLib(), sql = sqlLib(), r = projectOf(doc), man = r.manifest ? project.readManifest(r.root) : null, stored = man?.sql;
  if (doc.isDirty) return warn('save the model first, then import from SQL scripts.');
  let o = {};
  if (ask || !stored) { const q = await pickSql(vscode.Uri.file(r.root)); if (!q) return; o = q; }
  try {
    const go = async (extra) => {
      const p = sql.plan(doc.uri.fsPath, { ...o, ...extra, stop: wsOf(doc) });
      if (!p.changes.length && !(extra && p.samples.length)) { info('the model is already up to date with the SQL scripts.' + (p.notes.length ? ' ' + p.notes.join(' ') : '')); return null; }
      return p;
    };
    let p = await go();
    if (!p) return;
    const shown = p.lines.slice(0, 30), more = p.lines.length - shown.length;
    const detail = [...shown, ...(more > 0 ? [`… and ${more} more`] : []), ...(p.notes.length ? ['', ...p.notes] : []), '', 'Nothing is deleted or overwritten apart from what the scripts own (types, defaults, view definitions, sql_ properties); the change is recorded as one version and can be undone.'].join('\n');
    const buttons = p.valuesTables && !p.imp.sampleRows ? ['Apply', 'Apply with sample data'] : ['Apply'];
    const pick = await vscode.window.showInformationMessage(`Sync from SQL scripts: ${p.headline}`, { modal: true, detail }, ...buttons);
    if (!pick) return;
    if (pick === 'Apply with sample data') p = (await go({ sampleRows: 100 })) || p;
    sql.apply(p, { user: await userOf(rootOf(doc)) });
    info(`synced from SQL scripts (${p.headline}).`);
  } catch (err) { fail('SQL import failed (' + err.message + ')'); }
}

// ---- Strata SQL: Split into Domains / Join Parts (ADR-0045) ----
async function splitFor(doc) {
  const project = projectLib(), r = projectOf(doc);
  if (!r.manifest) return warn('save this model once (Strata SQL creates its project files on first save) before splitting it.');
  const man = project.readManifest(r.root);
  if (!project.domainsOf(man).length) return warn('add "domains" to strata.project.json first (see help.md "Domains") — nothing to split into yet.');
  const go = await vscode.window.showWarningMessage(`Split "${path.basename(doc.uri.fsPath)}" into one part per domain? This model is archived in place (renamed to "*.archived.model.json", read-only); its version log and sample data are left on disk, untouched.`, { modal: true }, 'Split');
  if (go !== 'Split') return;
  try {
    const res = project.split(doc.uri.fsPath, { user: await userOf(rootOf(doc)), stop: wsOf(doc) });
    info(`split into ${res.parts.length} part(s): ${res.parts.map((p) => p.name).join(', ')}. The original model was archived; a project-index file at its old path opens a read-only view of the whole project (Strata SQL: Open Project View).` + (res.warnings.length ? ` ${res.warnings.length} table/metric could not be routed to a single domain and went to _unassigned/_shared (see the next message).` : ''));
    if (res.warnings.length) warn('split: ' + res.warnings.join(' | '));
    const first = res.parts.find((p) => !p.name.startsWith('_')) || res.parts[0];
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(r.root, first.model)), VIEW_TYPE);
  } catch (err) { fail('split failed (' + err.message + ')'); }
}
async function joinParts() {
  const doc = currentModelDoc();
  if (!doc) return warn('open a .model.json file first.');
  const project = projectLib(), r = projectOf(doc);
  if (!r.manifest) return warn('no project manifest found for this model.');
  const man = project.readManifest(r.root);
  if ((man.parts || []).length < 2) return warn('this project already has one part; nothing to join.');
  const go = await vscode.window.showWarningMessage(`Join ${man.parts.length} parts back into one model? The split parts, governance.json and their own version logs are left on disk, untouched.${man.index ? ' The archived pre-split file is left as it is too, a second, now doubly-historical copy.' : ''}`, { modal: true }, 'Join');
  if (go !== 'Join') return;
  try {
    const res = project.join(r.root, { user: await userOf(r.root) });
    info('joined into ' + path.basename(res.model) + '.');
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(res.model), VIEW_TYPE);
  } catch (err) { fail('join failed (' + err.message + ')'); }
}

// ---- Strata SQL: Open Project View ----
// Every part (+ governance.json) assembled into one read-only model plus a table/concept/entity -> domain map (lib/project.js#assembledProjectModel,
// also used by the live view). Shown in the project-index file's own tab (a split project) or in the ad hoc panel (a multi-part project never split).
// ETL and HTML export work on the assembled model like on one part; HTML export needs exportAssembledHtml because a document's text is only the marker.
async function exportAssembledHtml(dirUri, root, man, F) {
  const SM = require('./media/model.js'), st = await io.getSettings(root);
  await exportHtmlAt(dirUri, man.name || path.basename(root), { modelText: SM.stringify(F), historyText: null, layoutText: null, themeSetting: st.theme, themeVariant: st.themeVariant });
}
// Tools > Generate embeddings from the project-index file: one embeddings file per domain part (there is no single file to save one next to),
// running the single-part pipeline (`runEmbeddingsFor`) once per part in manifest order, with progress and results per part.
async function generateEmbeddingsForIndex(ctx, doc, panel) {
  const project = projectLib(), r = projectOf(doc), man = project.readManifest(r.root), parts = man.parts || [];
  const perPart = {};
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${brand.name}: generating embeddings for every domain` }, async (progress) => {
      for (const p of parts) {
        const modelFile = path.resolve(r.root, p.model);
        progress.report({ message: `${p.name}: reading` });
        let text; try { text = await fs.promises.readFile(modelFile, 'utf8'); } catch (err) { perPart[p.name] = { error: err.message }; continue; }
        try { const { results } = await runEmbeddingsFor(ctx, r.root, modelFile, text, (msg) => progress.report({ message: `${p.name}: ${msg}` })); perPart[p.name] = { results }; }
        catch (err) { perPart[p.name] = { error: err.message }; }
      }
    });
  } catch (err) { return fail('embeddings failed: ' + err.message); }
  panel.webview.postMessage({ type: 'embedResult', perPart, embedParts: project.partsEmbedStatus(r.root, man) });
  const bad = Object.entries(perPart).filter(([, x]) => x.error).map(([name, x]) => `${name}: ${x.error}`);
  if (bad.length) warn('embeddings: ' + bad.join(' | '));
}
// Posts the whole project, freshly assembled, as a read-only 'model' message: for the project-index file's tab, and for an ordinary tab already
// open on a file that Split just turned into one. `indexFile: true` turns on Project settings, per-domain embeddings and tag/policy creation;
// the ad hoc panel (projectViewFor) sets only `projectView`, as it has no manifest-backed file to write those into.
async function postAssembledProject(doc, panel) {
  const project = projectLib(), r = projectOf(doc), man = project.readManifest(r.root);
  let F, domainOf;
  try { ({ F, domainOf } = project.assembledProjectModel(r.root, man)); } catch (err) { return fail('could not assemble the project (' + err.message + ')'); }
  const SM = require('./media/model.js'); // lazy: only needed once an index file is actually shown
  const settings = await io.getSettings(r.root);
  panel.webview.postMessage({ type: 'model', text: SM.stringify(F), history: null, layoutFile: null, readOnly: true, host: 'vscode', indexFile: true,
    themeName: themeNow().name, dataDir: '', settings, domains: project.domainsOf(man), domainOf, projectView: true, // an array even when empty: a split project always has a manifest, so domains can be added
    embedParts: project.partsEmbedStatus(r.root, man),
    // every part's own raw log text (+ governance.json's), for the merged History drawer
    histories: project.partHistoryTexts(r.root, man) });
}
// A webview panel not bound to one .model.json (the editor's own `page()` + canvas.js, `readOnly: true`, no TextDocument). One per project root;
// a static snapshot of the parts at open time, no watcher, nothing saved: there is nothing to reconcile if a part changes while it is open.
const projectViewPanels = new Map(); // project root -> panel
async function projectViewFor(ctx, doc) {
  const project = projectLib(), r = projectOf(doc);
  if (!r.manifest) return warn('this model has no project manifest yet.');
  const man = project.readManifest(r.root);
  if ((man.parts || []).length < 2) return warn('the Project View needs a project split into more than one part first (see Strata SQL: Split into Domains).');
  // a split project (ADR-0045 point 10) has a project-index file at the pre-split model's old path: open that instead of the bespoke
  // panel below, so it behaves like a normal, closeable/reopenable tab (a real document, not one-off VS Code API plumbing)
  if (man.index) return vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.resolve(r.root, man.index)), VIEW_TYPE);
  const existing = projectViewPanels.get(r.root);
  if (existing) { existing.reveal(); return; }
  let F, domainOf;
  try { ({ F, domainOf } = project.assembledProjectModel(r.root, man)); } catch (err) { return fail('could not build the Project View (' + err.message + ')'); }
  const panel = vscode.window.createWebviewPanel('strata.projectView', `${man.name || path.basename(r.root)} · Project View`, vscode.ViewColumn.Active, mediaOptions(ctx));
  projectViewPanels.set(r.root, panel);
  panel.onDidDispose(() => { if (projectViewPanels.get(r.root) === panel) projectViewPanels.delete(r.root); });
  panel.webview.html = page(panel.webview, ctx, 'canvas.css', EDITOR_SCRIPTS, '<div id="app"></div>');
  const SM = require('./media/model.js'); // lazy: only needed once the Project View is actually opened
  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready') {
      const settings = await io.getSettings(r.root);
      panel.webview.postMessage({ type: 'model', text: SM.stringify(F), history: null, layoutFile: null, readOnly: true, host: 'vscode',
        themeName: themeNow().name, dataDir: '', settings, domains: project.domainsOf(man).length ? project.domainsOf(man) : undefined, domainOf, projectView: true });
    } else if (m.type === 'help') await vscode.commands.executeCommand('strata.help');
    else if (m.type === 'openBrand') await vscode.env.openExternal(vscode.Uri.parse(brand.url));
    else if (m.type === 'saveFile') await saveFileAt(vscode.Uri.file(r.root), m.name, m.text); // ETL/ELT export: a pure read of the loaded model
    else if (m.type === 'exportHtml') await exportAssembledHtml(vscode.Uri.file(r.root), r.root, man, F);
    // everything else (edit, positions, settings, layout, newProject, domains, splitIntoDomains, embed, openLive...) is read-only here and
    // ignored: the Project View is never saved back anywhere (no doc to save against, no history stream of its own — ADR-0045). Embeddings
    // and the live view stay out of reach too (see media/canvas.js#renderToolsPop / help.md for the reason each one stays disabled there).
  });
}

class ModelEditor {
  constructor(ctx) {
    this.ctx = ctx;
  }

  // The project-index file is detected by content, before anything else about the document is trusted: its name is an ordinary "<name>.model.json",
  // only its `"strata": "project-index/1"` marker tells it apart. Assembled fresh on every 'ready'.
  async resolveCustomTextEditor(doc, panel) {
    if (indexObjOf(doc)) return this.resolveIndexEditor(doc, panel);

    const ctx = this.ctx;
    const key = doc.uri.toString();
    // An archived (pre-split) file is told apart by its filename suffix and is strictly read-only: `send()` tells the webview (`viewOnly`) and the
    // message handler ignores every mutating message regardless.
    const archived = projectLib().isArchived(doc.uri.fsPath);
    // historyText: latest version log known to the webview; historyDirty: not yet written to disk
    // positionsText / positionsDirty: the canvas positions file, held back only while an older layout waits to be converted at the next save
    const entry = { panel, doc, lastText: null, historyText: null, historyDirty: false, positionsText: null, positionsDirty: false, cache: null, cacheN: 0, embed: null };
    const fullRange = () => doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0));
    let saveDone = null;
    panels.set(key, entry);
    activeKey = key;
    setNavDoc(doc);

    panel.webview.options = mediaOptions(ctx);
    panel.webview.html = page(panel.webview, ctx, 'canvas.css', EDITOR_SCRIPTS, '<div id="app"></div>');

    // Domains live in the project manifest, not the model file (`m.domains`, attached in canvas.js, never round-tripped by media/model.js): an array once
    // a manifest exists (the Domains dialog offers "+ New domain" even when empty), `undefined` before the first save.
    const domainsFor = (r, man) => (r.manifest ? projectLib().domainsOf(man) : undefined);
    // For a project of more than one part: `crossPart` (whole-project name index, so a reference to another part's object is not reported broken) and
    // `sharedGovernance` (governance.json's tags / policies / propertyKeys, read-only here, merged in by media/gov.js). Both undefined for one part.
    const crossPartFor = (r, man) => ((man?.parts || []).length > 1 ? projectLib().buildIndex(r.root, man) : undefined);
    const sharedGovernanceFor = (r) => (r.governanceFile ? projectLib().readGovernance(r.root) || undefined : undefined);
    // What the archived-file banner (media/canvas.js) needs: the project's current parts (so a domain rename/removal since the split is
    // reflected on every open — nothing here is cached) and the project-index file's own path, to link to. Undefined for an ordinary doc.
    const archivedFor = (d) => { if (!archived) return undefined; const r = projectOf(d); const man = projectLib().readManifest(r.root) || {}; return { parts: (man.parts || []).map((p) => ({ name: p.name, model: p.model })), index: man.index || null }; };
    const send = async (reloadHistory) => {
      // Split or Join may have overwritten this file while its tab was open (VS Code does not re-evaluate the branch taken at open time), so
      // re-check on every send.
      if (indexObjOf(doc)) return postAssembledProject(doc, panel);
      const r = projectOf(doc), man = r.manifest ? projectLib().readManifest(r.root) : null; // resolved once per send
      if (reloadHistory || entry.historyText == null) entry.historyText = await io.readHistory(r); // the current log, else an older one (the webview reads both)
      const lkey = io.layoutKey(rootOf(doc), doc.uri.fsPath);
      if (reloadHistory || entry.cache == null) entry.cache = (await io.readCache(rootOf(doc), doc.uri.fsPath)) || false;
      panel.webview.postMessage({ type: 'model', text: doc.getText(), history: entry.historyText, layoutFile: entry.positionsDirty ? entry.positionsText : await readText(io.layoutFilePathOf(doc.uri.fsPath)), cache: entry.cache || undefined, settings: await getSettings(doc), dataDir: path.basename(r.dataDir), themeName: themeNow().name, layoutKey: lkey, layout: await io.readLayout(rootOf(doc), lkey),
        domains: domainsFor(r, man), crossPart: crossPartFor(r, man), sharedGovernance: sharedGovernanceFor(r), embed: entry.embed, embedKeys: await embedKeyStatus(ctx), embedProviders: embedProviderInfo(), embedFile: path.basename(embedPathOf(doc)),
        ...(archived ? { readOnly: true, host: 'vscode', archived: archivedFor(doc) } : {}) });
    };

    // Write the version log first, then let the model save: if the log write fails the model still saves and the mismatch is reported the next
    // time it is opened. After the log: positions (held back while an older layout awaits conversion), the manifest, the snapshot cache.
    const flushHistory = async () => {
      try {
        let wrote = false;
        if (entry.historyDirty && entry.historyText != null) { await writeAtomic(projectOf(doc).history, entry.historyText); entry.historyDirty = false; wrote = true; }
        if (entry.positionsDirty && entry.positionsText != null) { await writeAtomic(io.layoutFilePathOf(doc.uri.fsPath), entry.positionsText); entry.positionsDirty = false; }
        let name; try { name = JSON.parse(entry.lastText ?? doc.getText()).project?.name; } catch { /* not valid JSON: no manifest yet */ }
        if (name) { const r = projectOf(doc); projectLib().ensurePart(r.root, doc.uri.fsPath, name); }
        if (wrote) entry.cacheN = await io.writeCache(rootOf(doc), doc.uri.fsPath, entry.historyText, entry.cacheN);
      } catch (err) {
        warn(`the model was saved but its version history could not be written (${err.message}). It will be retried on the next save.`);
      }
    };

    const dataOps = {
      ...io.dataOps(() => projectOf(doc), (msg) => panel.webview.postMessage(msg)),
      open: async (m) => vscode.window.showTextDocument(vscode.Uri.file(io.dataFile(projectOf(doc), m.file)), { viewColumn: vscode.ViewColumn.Beside, preview: true }),
    };

    // Embeddings of the current model text (incremental: unchanged chunks keep their vectors). Only model metadata is sent, never sample data.
    const generateEmbeddings = async () => {
      const embed = require('./media/embed.js'); // lazy: not needed until the user triggers embedding generation
      try {
        const { results } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${brand.name}: generating embeddings` },
          (progress) => runEmbeddingsFor(ctx, rootOf(doc), doc.uri.fsPath, doc.getText(), (msg) => progress.report({ message: msg })));
        entry.embed = await readEmbedStatus(doc);
        panel.webview.postMessage({ type: 'embedResult', results, status: entry.embed });
        const bad = Object.entries(results).filter(([, r]) => !r.ok && !r.skipped).map(([id, r]) => `${embed.PROVIDERS[id].label}: ${r.error}`);
        if (bad.length) warn('embeddings: ' + bad.join(' | '));
      } catch (err) {
        panel.webview.postMessage({ type: 'embedResult', error: err.message });
        fail('embeddings failed: ' + err.message);
      }
    };

    panel.webview.onDidReceiveMessage(async (m) => {
      try {
        if ((archived || indexObjOf(doc)) && projectLib().ARCHIVED_BLOCKED.has(m.type)) return; // strictly read-only: an archived file, or one now showing as an assembled project (release 2 parts 5/7)
        if (m.type === 'ready') {
          entry.embed = await readEmbedStatus(doc);
          await send(true);
          if (pendingReveal && pendingReveal.key === key) { panel.webview.postMessage(pendingReveal.msg); pendingReveal = null; }
        }
        else if (m.type === 'edit') {
          entry.lastText = m.text;
          if (m.history != null) { entry.historyText = m.history; entry.historyDirty = true; }
          if (m.positions != null) { entry.positionsText = m.positions; entry.positionsDirty = true; }
          const edit = new vscode.WorkspaceEdit();
          edit.replace(doc.uri, fullRange(), m.text);
          await vscode.workspace.applyEdit(edit);
        } else if (m.type === 'positions') { // canvas positions: their own file, written at once (not part of any edit, so the model stays clean)
          entry.positionsText = m.text;
          if (!entry.positionsDirty) await writeAtomic(io.layoutFilePathOf(doc.uri.fsPath), m.text);
        } else if (m.type === 'newProject') await vscode.commands.executeCommand('strata.newProject');
        else if (m.type === 'saveReady') saveDone?.(m);
        else if (m.type === 'panels') await setNavigation(m.nav);
        else if (m.type === 'settings') await saveSettings(doc, m.settings);
        else if (m.type === 'help') await vscode.commands.executeCommand('strata.help');
        else if (m.type === 'embedKey') {
          await setEmbeddingKey(ctx, m.provider);
          panel.webview.postMessage({ type: 'embedKeys', keys: await embedKeyStatus(ctx) });
        } else if (m.type === 'embed') await generateEmbeddings();
        else if (m.type === 'data' && Object.hasOwn(dataOps, m.op)) await dataOps[m.op](m);
        else if (m.type === 'themeVars') { // the real VS Code colours: keep them for the live view and exports
          lastTheme = { name: themeNow().name, kind: m.kind, vars: m.vars };
          for (const srv of liveServers.values()) srv.setTheme(lastTheme);
        } else if (m.type === 'themeCss') { navThemeCss = m.css || ''; navView?.webview.postMessage({ type: 'theme', css: navThemeCss }); }
        else if (m.type === 'openBrand') await vscode.env.openExternal(vscode.Uri.parse(brand.url));
        else if (m.type === 'layout') await io.saveLayout(rootOf(doc), io.layoutKey(rootOf(doc), doc.uri.fsPath), 'canvas', m.state ?? null); // last canvas layout for this model
        else if (m.type === 'toggleNav') await setNavigation(!navView?.visible, true);
        else if (m.type === 'saveFile') await saveFileFor(doc, m.name, m.text);
        else if (m.type === 'exportHtml') await exportHtmlFor(doc);
        else if (m.type === 'openLive') await openLiveFor(doc);
        else if (m.type === 'exportOrder') { // load sequence as JSON, saved next to the model
          const uri = await vscode.window.showSaveDialog({ defaultUri: doc.uri.with({ path: doc.uri.path.replace(/(\.model)?\.json$/, '') + '.load-order.json' }), filters: { JSON: ['json'] } });
          if (uri) { await vscode.workspace.fs.writeFile(uri, Buffer.from(String(m.text))); info('load sequence saved to ' + uri.path.split('/').pop()); }
        // Domains dialog: the webview already applied and validated the new list; this writes the manifest (no reply, like `settings`).
        } else if (m.type === 'domains') { const r = projectOf(doc); projectLib().setDomains(r.root, m.domains); }
        else if (m.type === 'splitIntoDomains') await vscode.commands.executeCommand('strata.splitIntoDomains');
        else if (m.type === 'openProjectView') await vscode.commands.executeCommand('strata.openProjectView');
        // the archived-file banner's links (a domain part, or the project-index file): `m.file` is a path relative to the project root,
        // exactly as `strata.project.json`'s own `parts[].model` / `index` already are
        else if (m.type === 'openPart') await openPart(doc, m.file);
      } catch (err) {
        fail(err.message);
      }
    });

    const onChange = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== doc) return;
      // external change or native undo/redo: the webview finds the version the text now holds by its content hash
      if (doc.getText() !== entry.lastText) send(!doc.isDirty && !entry.historyDirty);
    });

    // "version on save" flushes pending changes in the webview first; the reply carries the final text + log.
    const onWillSave = vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.document !== doc) return;
      e.waitUntil((async () => {
        const reply = await new Promise((resolve) => {
          const timer = setTimeout(() => { saveDone = null; resolve(null); }, 2000);
          saveDone = (m) => { clearTimeout(timer); saveDone = null; resolve(m); };
          panel.webview.postMessage({ type: 'beforeSave' });
        });
        const changed = reply && reply.text != null;
        if (changed) {
          entry.lastText = reply.text;
          if (reply.history != null) { entry.historyText = reply.history; entry.historyDirty = true; }
          if (reply.positions != null) { entry.positionsText = reply.positions; entry.positionsDirty = true; }
        }
        await flushHistory();
        return changed ? [vscode.TextEdit.replace(fullRange(), reply.text)] : [];
      })());
    });

    panel.onDidChangeViewState(() => {
      if (panel.active) {
        activeKey = key;
        setNavDoc(doc);
      }
    });
    panel.onDidDispose(() => {
      onChange.dispose();
      onWillSave.dispose();
      panels.delete(key);
      if (activeKey === key) activeKey = null;
      if (navDoc === doc) {
        const next = [...panels.values()].at(-1);
        const text = vscode.window.activeTextEditor?.document;
        setNavDoc(next ? next.doc : isModelDoc(text) ? text : null);
      }
    });
  }

  // The project-index file's own tab: a real document whose content is never shown; every 'ready' assembles the parts + governance.json fresh
  // (`assembledProjectModel`) and posts that. Registered in `panels` so the Navigator's reveal and the toolbar keybindings (`activeKey`) reach it.
  async resolveIndexEditor(doc, panel) {
    const ctx = this.ctx;
    const key = doc.uri.toString();
    panel.webview.options = mediaOptions(ctx);
    panel.webview.html = page(panel.webview, ctx, 'canvas.css', EDITOR_SCRIPTS, '<div id="app"></div>');
    panels.set(key, { panel, doc });
    activeKey = key;
    setNavDoc(doc);
    panel.onDidChangeViewState(() => { if (panel.active) { activeKey = key; setNavDoc(doc); } });
    panel.onDidDispose(() => {
      panels.delete(key);
      if (activeKey === key) activeKey = null;
      if (navDoc === doc) setNavDoc(isModelDoc(vscode.window.activeTextEditor?.document) ? vscode.window.activeTextEditor.document : null);
    });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'ready') {
        await postAssembledProject(doc, panel);
      } else if (m.type === 'help') await vscode.commands.executeCommand('strata.help');
      else if (m.type === 'openBrand') await vscode.env.openExternal(vscode.Uri.parse(brand.url));
      else if (m.type === 'openPart') await openPart(doc, m.file);
      else if (m.type === 'saveFile') await saveFileAt(dirUriOf(doc), m.name, m.text); // next to the index file
      else if (m.type === 'exportHtml') {
        const project = projectLib(), r = projectOf(doc), man = project.readManifest(r.root);
        let F; try { ({ F } = project.assembledProjectModel(r.root, man)); } catch (err) { return fail('could not assemble the project (' + err.message + ')'); }
        await exportAssembledHtml(dirUriOf(doc), r.root, man, F);
      }
      // Narrow exceptions to the read-only rule, each routed to its own target rather than a part's file; everything else is ignored, as in the ad hoc
      // panel. Every write that succeeds re-posts the assembled project (postAssembledProject) so the open tab refreshes.
      else if (m.type === 'embed') await generateEmbeddingsForIndex(ctx, doc, panel); // once per domain part (media/canvas.js#generateEmbeddingsProject)
      // startLive detects the index file by content and runs the multi-part server (lib/live.js#startProjectLive) for it.
      else if (m.type === 'openLive') await openLiveFor(doc);
      else if (m.type === 'projectSettings') { // the SAME project block into every part's own model, each its own versioned edit
        try {
          const project = projectLib(), r = projectOf(doc), man = project.readManifest(r.root);
          const res = project.updateProjectSettings(r.root, man, m.project, { user: await userOf(r.root) });
          info(`updated project settings in ${res.parts.length} part(s).`);
          await postAssembledProject(doc, panel);
        } catch (err) { fail('could not update project settings (' + err.message + ')'); }
      } else if (m.type === 'governance') { // creating/editing a tag or policy here routes to governance.json, not to any part's file
        try {
          const project = projectLib(), r = projectOf(doc);
          project.updateGovernance(r.root, m.governance, { user: await userOf(r.root) });
          await postAssembledProject(doc, panel);
        } catch (err) { fail('could not update tags/policies (' + err.message + ')'); }
      // Edits to a table, column, relationship, concept, entity or metric: canvas.js edits the one assembled model as usual and posts it back;
      // lib/project.js#applyProjectEdit re-routes every object with split()'s rules and commits only the delta into the EXISTING part that owns it.
      } else if (m.type === 'editProject') {
        try {
          const project = projectLib(), r = projectOf(doc), man = project.readManifest(r.root);
          const F = JSON.parse(m.text);
          project.applyProjectEdit(r.root, man, F, { user: await userOf(r.root), message: m.message, conceptDomains: m.conceptDomains });
          await postAssembledProject(doc, panel);
        } catch (err) { fail('could not save (' + err.message + ')'); }
      // The Domains view is editable here too: concepts that change domain move between parts, and a domain's first objects create its part
      // (lib/project.js#applyDomains).
      } else if (m.type === 'domains') {
        try {
          const project = projectLib(), r = projectOf(doc), man = project.readManifest(r.root);
          project.applyDomains(r.root, man, m.domains, { user: await userOf(r.root) });
        } catch (err) { fail('could not save the domains (' + err.message + ')'); }
        await postAssembledProject(doc, panel); // also after a refusal: the dialog's optimistic copy is replaced by what is on disk
      // the merged History drawer's Undo/Redo: the most recent / earliest-undone change across every part (lib/project.js#projectGoto)
      } else if (m.type === 'projectUndo' || m.type === 'projectRedo') {
        try {
          const project = projectLib(), r = projectOf(doc), man = project.readManifest(r.root), redo = m.type === 'projectRedo';
          const res = project.projectGoto(r.root, man, redo ? 'redo' : 'undo');
          if (!res) info(`nothing to ${redo ? 'redo' : 'undo'} across the project's parts.`);
          await postAssembledProject(doc, panel);
        } catch (err) { fail(`could not ${m.type === 'projectRedo' ? 'redo' : 'undo'} (` + err.message + ')'); }
      }
      // everything else (positions, domains, splitIntoDomains...) is read-only here and ignored, same as the panel.
    });
  }
}

class Navigator {
  constructor(ctx) {
    this.ctx = ctx;
  }

  resolveWebviewView(view) {
    navView = view;
    lastNavKey = null;
    view.webview.options = mediaOptions(this.ctx);
    view.webview.html = page(view.webview, this.ctx, 'nav.css', ['nav.js'], '<div id="app"></div>');
    view.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') pushNav();
      else if (m.type === 'layout' && navDoc && m.part === 'nav') io.saveLayout(rootOf(navDoc), io.layoutKey(rootOf(navDoc), navDoc.uri.fsPath), 'nav', m.state ?? null).catch(() => {});
      else if (m.type === 'reveal') {
        const msg = { type: 'reveal', kind: m.kind, ref: m.ref, column: m.column };
        const entry = navDoc && panels.get(navDoc.uri.toString());
        if (entry) {
          entry.panel.reveal(undefined, false);
          entry.panel.webview.postMessage(msg);
        } else if (navDoc) { // model is open as plain text: open it in Strata SQL, then reveal
          pendingReveal = { key: navDoc.uri.toString(), msg };
          vscode.commands.executeCommand('vscode.openWith', navDoc.uri, VIEW_TYPE);
        }
      }
    });
    view.onDidChangeVisibility(() => { if (view.visible) pushNav(); });
    view.onDidDispose(() => {
      navView = null;
    });
  }
}

function activate(ctx) {
  const post = (msg) => () => activePanel()?.webview.postMessage(msg);
  if (isModelDoc(vscode.window.activeTextEditor?.document)) navDoc = vscode.window.activeTextEditor.document;
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((ev) => { if (ev.document === navDoc) pushNav(); }),
    vscode.window.onDidChangeActiveColorTheme(themeChanged),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('workbench.colorTheme')) themeChanged(); }),
    vscode.window.onDidChangeActiveTextEditor((ed) => { if (ed && isModelDoc(ed.document)) setNavDoc(ed.document); }),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new ModelEditor(ctx), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('strata.navigation', new Navigator(ctx), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('strata.autoLayout', post({ type: 'autoLayout' })),
    vscode.commands.registerCommand('strata.undo', post({ type: 'undo' })),
    vscode.commands.registerCommand('strata.redo', post({ type: 'redo' })),
    vscode.commands.registerCommand('strata.openSettings', post({ type: 'openSettings' })),
    vscode.commands.registerCommand('strata.toggleNavigation', async () => {
      if (navView?.visible) await setNavigation(false);
      else await setNavigation(true, true);
    }),
    vscode.commands.registerCommand('strata.toggleHistory', post({ type: 'toggleHistory' })),
    vscode.commands.registerCommand('strata.search', post({ type: 'search' })),
    ...['governance', 'conceptual', 'logical', 'physical', 'semantic'].map((lv) => vscode.commands.registerCommand('strata.level.' + lv, post({ type: 'level', level: lv }))),
    vscode.commands.registerCommand('strata.setEmbeddingKey', async () => {
      const pick = await vscode.window.showQuickPick(embedProviderInfo().filter((p) => p.needsKey).map((p) => ({ label: p.label, id: p.id })), { title: 'Set embedding API key' });
      if (pick) await setEmbeddingKey(ctx, pick.id);
    }),
    // help.md is rendered by VS Code's built-in Markdown preview (falls back to the plain file)
    vscode.commands.registerCommand('strata.help', () => {
      const uri = vscode.Uri.joinPath(ctx.extensionUri, 'help.md');
      return vscode.commands.executeCommand('markdown.showPreviewToSide', uri).then(undefined, () => vscode.commands.executeCommand('vscode.open', uri));
    }),
    // Hides every Strata panel (history drawer, search, navigator); pressing again restores what was open.
    vscode.commands.registerCommand('strata.toggleAllPanels', () => {
      const p = activePanel();
      if (p) p.webview.postMessage({ type: 'togglePanels', nav: !!navView?.visible });
      else setNavigation(!navView?.visible, true);
    }),
    vscode.commands.registerCommand('strata.openLiveView', needModel(openLiveFor)),
    vscode.commands.registerCommand('strata.exportHtml', needModel(exportHtmlFor)),
    vscode.commands.registerCommand('strata.exportCode', needModel(exportCodeFor)),
    vscode.commands.registerCommand('strata.openSample', (id) => openSample(id)),
    // help.md links: vscode://strata-sql.strata-sql/openSample?northwind (the Markdown preview drops command: links)
    vscode.window.registerUriHandler({ handleUri: (uri) => uri.path === '/openSample' && openSample(uri.query).catch((err) => fail(err.message)) }),
    vscode.commands.registerCommand('strata.newProject', newProject),
    vscode.commands.registerCommand('strata.newModel', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(folder, 'untitled.model.json'),
        filters: { [`${brand.name} model`]: ['model.json'] },
      });
      if (!uri) return;
      const target = uri.path.endsWith('.model.json') ? uri : uri.with({ path: uri.path.replace(/(\.json)?$/, '.model.json') });
      await vscode.workspace.fs.writeFile(target, Buffer.from('{}\n'));
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('strata.splitIntoDomains', needModel(splitFor)),
    vscode.commands.registerCommand('strata.joinParts', joinParts),
    vscode.commands.registerCommand('strata.importDbt', needModel((doc) => dbtFor(doc, true))),
    vscode.commands.registerCommand('strata.syncDbt', needModel((doc) => dbtFor(doc, false))),
    vscode.commands.registerCommand('strata.importSql', () => { const doc = currentModelDoc(); return doc ? sqlFor(doc, true) : newProject(); }), // no model open: the wizard, which has the same starting point
    vscode.commands.registerCommand('strata.syncSql', needModel((doc) => sqlFor(doc, false))),
    vscode.commands.registerCommand('strata.openProjectView', needModel((doc) => projectViewFor(ctx, doc)))
  );
}

module.exports = { activate, deactivate: () => Promise.all([...liveServers.values()].map((srv) => srv.close())) };
