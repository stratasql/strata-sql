// Projects on disk (ADR-0044): the small manifest `strata.project.json`, the ONE resolver that maps a model file to its project, log, positions and data
// (`resolve`), creating a project (blank or from a template) and the Git files that make the history merge without conflicts. Node only, no vscode import:
// the wizard and the save handshake in extension.js, the live view and `strata-sql init` (cli.js) all use it.
const fs = require('fs');
const path = require('path');
const SM = require('../media/model.js');

const MANIFEST = 'strata.project.json';
// governance.json (release 2 part 2, ADR-0045 point 4): the shared tag / policy / propertyKey definitions of a project with more than one
// part, moved out of the one model file that release 1 keeps them in. Top-level, beside the manifest (not under history/): its own stream.
const GOVERNANCE = 'governance.json', GOVERNANCE_HISTORY = 'governance.history.jsonl';
// The standard folders, defined once. A project is foldered even with one part (a single project is a project of one part), so that more parts or linked
// projects later add folders and manifest entries and move nothing. The manifest stays the source of truth: `parts[].model` is a path relative to it.
const DIRS = { models: 'data_models', history: 'history', data: 'data' }; // `data_models`, not `models`: dbt owns that name
const partModel = (stem) => `${DIRS.models}/${stem}/${stem}.model.json`;
// A domain part, once a project has been split (release 2 part 6, ADR-0045 amended a sixth time): nested one level deeper, under the
// project's OWN folder, so every file about one project groups under its own name instead of sitting as a flat sibling of it.
// `projectStem` is the project's own folder name (the pre-split model's stem, e.g. "shop"); `partModel` above is unaffected and still used
// for a never-split, single-part project's own file (`data_models/<name>/<name>.model.json`) and for `join()`'s ad hoc (no index) target.
const partModelIn = (projectStem, stem) => `${DIRS.models}/${projectStem}/${stem}/${stem}.model.json`;
const partHistory = (name) => `${DIRS.history}/${name}.history.jsonl`; // one log per part, in the top-level history folder
const SAMPLES = path.join(__dirname, '..', 'sample_data_models'); // the sample models the templates are copied from
// starting points: blank, and the samples shipped with the extension (copied and renamed, never overwriting anything)
// A template can bring starter `domains` (grouping the concepts it ships with); `create()` writes them only into the manifest of a brand-new
// project, never into an existing one. Blank and star bring none.
const TEMPLATES = {
  blank: { label: 'Blank', detail: 'An empty model: a project and one schema, ready to build up' },
  northwind: { label: 'Northwind: Retail (3NF)', detail: 'Customers, orders, products, suppliers and employees; 15 tables, 10 views, sample data', platform: 'Databricks', methodology: 'ER - 3NF',
    domains: [
      { name: 'Sales', owner: 'Head of Sales', concepts: ['Customer', 'Order', 'Sales Territory'] },
      { name: 'Catalog', owner: 'Head of Merchandising', concepts: ['Product', 'Supplier', 'Shipper'] },
      { name: 'HR', owner: 'HR Director', concepts: ['Employee', 'Location'] },
    ] },
  fpml: { label: 'FpML: Banking & financial derivatives (3NF)', detail: 'OTC derivatives on ISDA FpML: parties, trades, swaps, FX, CDS, valuations; 59 tables, 8 views, sample data', platform: 'Databricks', methodology: 'ER - 3NF',
    domains: [
      { name: 'Front Office', owner: 'Front Office', concepts: ['Trade', 'Product', 'Portfolio'] },
      { name: 'Risk', owner: 'Risk', concepts: ['Valuation'] },
      { name: 'Middle Office', owner: 'Middle Office', concepts: ['Market Data'] },
      { name: 'Operations', owner: 'Operations', concepts: ['Party', 'Legal Agreement', 'Message', 'Reference Data'] },
    ] },
  star: { label: 'Dimensional star', detail: 'A small sales star: fact_sales with customer, product, date and store dimensions; no sample data', platform: 'PostgreSQL', methodology: 'Dimensional Modelling' },
};

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
let tmpN = 0;
function write(p, text) { // temp file + rename, like every write Strata SQL does
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${tmpN++}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, p); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
}
// who and why a version entry is recorded as; `user` = {name, email, system}
const infoOf = (user, message) => { const u = user || {}; return { user: u.name || 'unknown', email: u.email || '', system: u.system || '', message }; };
const posix = (p) => p.split(path.sep).join('/');
const slug = (name) => String(name).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');

// ---------- the manifest ----------
// {"strata": "project/1", "name": "...", "parts": [{"name": "orders", "model": "orders.model.json"}]}. Tiny on purpose: a small team never edits it. Room is left for
// what larger projects add later (links to other projects, domains, exposes): keys this version does not know are kept when it rewrites the file.
function readManifest(dir) {
  try { const o = JSON.parse(read(path.join(dir, MANIFEST))); return o && typeof o === 'object' ? o : null; } catch { return null; }
}
const manifestText = (o) => SM.stringify(o) + '\n';
const stemOf = (file) => path.basename(file).replace(/\.model\.json$/, '');
// The archived pre-split file (release 2 part 5, ADR-0045 point 10): detected purely by its filename suffix (no internal marker is needed —
// its content is otherwise an ordinary, valid model file, byte-for-byte what it was before the split). This is the one check every caller
// uses, so "is this file archived" is decided in exactly one place.
const ARCHIVED_RE = /\.archived\.model\.json$/;
const isArchived = (file) => ARCHIVED_RE.test(file);
// The thin project-index file that takes over an archived file's vacated path (release 2 part 5, ADR-0045 point 10): detected by content,
// not filename (it is still named "<name>.model.json", indistinguishable by name from an ordinary part) — `{"strata": "project-index/1",
// name, parts: [names]}`, regenerable, never hand-maintained. -> the parsed object, or null (not an index file, or not readable).
const INDEX_STRATA = 'project-index/1';
function readIndexFile(file) {
  let o; try { o = JSON.parse(read(file)); } catch { return null; }
  return o && typeof o === 'object' && o.strata === INDEX_STRATA ? o : null;
}
// Message types that would edit an archived (pre-split, read-only) file, its manifest, settings or sidecar files: never acted on, whichever host
// asked (extension.js and lib/live.js share this list). `saveReady` is listed because in the live view it is a real write path a raw POST could reach.
const ARCHIVED_BLOCKED = new Set(['edit', 'positions', 'settings', 'domains', 'splitIntoDomains', 'embed', 'embedKey', 'data', 'layout', 'saveReady']);
// the part name of a model that is not listed yet: its file stem, made unique among the parts already there
function partName(man, stem) {
  const names = new Set(((man && man.parts) || []).map((p) => p && p.name));
  for (let n = stem, i = 2; ; n = stem + '-' + i++) if (!names.has(n)) return n;
}
// A model file belongs to a project: the manifest in `dir` (the project root) gets created, or gets this part added. -> 'created' | 'added' | null (nothing to do)
function ensurePart(dir, modelFile, projectName) {
  if (isArchived(modelFile)) return null; // release 2 part 5: an archived (pre-split) file is never added back as a live part of its own
  const model = posix(path.relative(dir, modelFile)), stem = stemOf(modelFile);
  if (model.startsWith('..')) return null;
  const m = readManifest(dir);
  if (!m) {
    if (fs.existsSync(path.join(dir, MANIFEST))) return null; // present but unreadable: leave it alone
    write(path.join(dir, MANIFEST), manifestText({ strata: 'project/1', name: projectName || stem, parts: [{ name: stem, model }] }));
    return 'created';
  }
  if ((m.parts || []).some((p) => p && p.model === model)) return null;
  m.parts = [...(Array.isArray(m.parts) ? m.parts : []), { name: partName(m, stem), model }];
  write(path.join(dir, MANIFEST), manifestText(m));
  return 'added';
}

// ---------- the resolver ----------
// Every place that needs a file of a model asks here: the wizard, the save handshake, the live view, the export, the tests.
// The manifest is looked for in the model's folder and its ancestors (up to `stop`, else the filesystem root); the part is the entry whose `model`
// is this file; a model the manifest does not list is another part (added at the next save). No manifest = an implicit one-part project rooted in
// the model's folder: an older log is still read, everything is written to the standard place at the next save.
function resolve(modelFile, { stop } = {}) {
  const file = path.resolve(modelFile), dir = path.dirname(file), stem = stemOf(file), top = stop && !path.relative(stop, file).startsWith('..') ? path.resolve(stop) : null;
  // An archived file (release 2 part 5): its own log kept its pre-archive name (baseStem), since it stopped being reachable through the
  // manifest at the same moment it was renamed — read from there regardless, never re-derived from the ".archived" stem.
  const archived = isArchived(file), baseStem = archived ? stem.replace(/\.archived$/, '') : stem;
  let found = null;
  for (let d = dir; !found; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, MANIFEST))) found = d;
    else if (d === top || d === path.dirname(d)) break;
  }
  const root = found || dir, man = found && readManifest(found), parts = (man && man.parts) || [];
  // an archived file is never "listed": even a manifest hand-edited to still name it is not trusted (belt and suspenders alongside
  // ensurePart's own refusal to ever add one back)
  const p = archived ? null : parts.find((x) => x && typeof x.model === 'string' && path.resolve(root, x.model) === file);
  const part = p ? p.name : partName(man, baseStem);
  const old = path.join(dir, stem + '_model_data'), has = (x) => fs.existsSync(x);
  const dataDir = !has(path.join(dir, DIRS.data)) && has(old) ? old : path.join(dir, DIRS.data); // a converted project keeps its `<name>_model_data/`
  // governance.json (release 2 part 2): only once the project has more than one part (release 1, and a domains-only project with one part,
  // never get one: tags/policies/propertyKeys stay inside that one model file, unchanged).
  const shared = parts.length > 1;
  return {
    root, manifest: !!found, listed: !!p, part, model: file, archived,
    history: path.resolve(root, (p && p.history) || partHistory(archived ? baseStem : part)),
    historyOld: [path.join(dir, stem + '.model.history.jsonl'), path.join(dir, stem + '.model.version.json')], // an unreleased flat layout (the shipped samples), then the older single-document log
    layout: path.join(dir, stem + '.model.layout.json'), embeddings: path.join(dir, stem + '.model.embeddings.json'),
    dataDir, dataOld: [...(dataDir === old ? [] : [old]), path.join(dir, 'model_data')], // the old per-model folder, then the pre-0.2 shared one
    governanceFile: shared ? path.join(root, GOVERNANCE) : null, governanceHistory: shared ? path.join(root, GOVERNANCE_HISTORY) : null,
  };
}

// ---------- git hygiene ----------
// `*.history.jsonl merge=union`: Git keeps both sides' history lines and never writes conflict markers into the log. `.strata/` is personal (settings,
// window layout, caches). Existing files are appended to, never replaced.
function ensureLines(file, lines) {
  const cur = read(file) || '', have = new Set(cur.split(/\r?\n/).map((l) => l.trim())), add = lines.filter((l) => !have.has(l));
  if (!add.length) return false;
  write(file, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
  return true;
}

// ---------- create a project ----------
// The files a new part of `stem` would occupy in the project at `dir`, relative to it (the resolver's defaults). `projectStem`, when given
// (split()'s domain parts only), nests the part one level deeper under the project's own folder (`partModelIn`) instead of the flat,
// single-part shape (`partModel`).
const partFiles = (dir, stem, projectStem) => {
  const model = projectStem ? partModelIn(projectStem, stem) : partModel(stem), folder = path.posix.dirname(model), name = partName(readManifest(dir), stem);
  return { name, model, history: partHistory(name), layout: `${folder}/${stem}.model.layout.json`, data: `${folder}/${DIRS.data}` };
};
// what is already there: the wizard checks this while the name is typed, `create` before it writes anything
const taken = (dir, stem, projectStem) => { const f = partFiles(path.resolve(dir), stem, projectStem); return [f.model, f.history, f.layout, f.data].filter((n) => fs.existsSync(path.join(dir, n))); };
// a shipped sample as text, for the live view's demo: { model, history, layout, data: { <file>.csv: text } }
function readSample(id) {
  if (!TEMPLATES[id] || id === 'blank') throw new Error(`unknown sample "${id}"`);
  const dir = path.join(SAMPLES, id + '_model_data'), data = {};
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) data[f] = read(path.join(dir, f));
  return { model: read(path.join(SAMPLES, id + '.model.json')), history: read(path.join(SAMPLES, id + '.model.history.jsonl')), layout: read(path.join(SAMPLES, id + '.model.layout.json')), data };
}
const templateName = (id) => JSON.parse(read(path.join(SAMPLES, id + '.model.json'))).project.name;

// opts: {dir, name, stem?, platform, methodology, template = 'blank', user: {name, email, system}, git = true, ignoreLayout = false, F?, message?}
// `F` (change 31, lib/dbt.js) = a ready file object to start from instead of blank / a template: its own first version, named by `message`.
// `name` is the project's name and, slugged, the part's (`stem` overrides it, as `strata.openSample` does); a template keeps its own name when none is given.
// Never overwrites: if any file of the part exists, nothing is written and an error says which. A folder that already has a manifest gets the new model
// added as one more part. Order: the first history entry, then the model, its positions and data, the manifest and the Git files.
// -> {model: path of the model file, files: [written paths]}
function create(opts) {
  const { template = 'blank', git = true, ignoreLayout = false } = opts;
  if (!TEMPLATES[template]) throw new Error(`unknown starting point "${template}" (${Object.keys(TEMPLATES).join(', ')})`);
  const name = String(opts.name || (template !== 'blank' && templateName(template)) || '').trim();
  if (!name) throw new Error('the project needs a name');
  const stem = opts.stem || slug(name);
  if (!stem) throw new Error('the project name needs at least one letter or digit');
  const dir = path.resolve(opts.dir || '.'), busy = taken(dir, stem);
  if (busy.length) throw new Error(`${busy.join(', ')} already exist${busy.length > 1 ? '' : 's'} in ${dir}; nothing was written`);
  const f = partFiles(dir, stem), at = (rel) => path.join(dir, ...rel.split('/'));
  const info = infoOf(opts.user, opts.message || (template === 'blank' ? 'Create project' : `Created from the ${TEMPLATES[template].label.split(':')[0]} template as "${name}"`));
  let F, log, positions = null, from = {};
  if (opts.F) { F = opts.F; log = SM.newHistory(); } // change 31: an imported model (lib/dbt.js) starts its own history
  else if (template === 'blank') {
    const tech = opts.platform || 'PostgreSQL', tc = SM.PLATFORMS[tech], meth = opts.methodology || 'ER - 3NF';
    if (!tc) throw new Error(`unknown platform "${tech}" (${Object.keys(SM.PLATFORMS).join(', ')})`);
    if (!SM.METHODS.includes(meth)) throw new Error(`unknown methodology "${meth}" (${SM.METHODS.join(', ')})`);
    const m = SM.blank();
    m.project = SM.norm({ name, description: '', stakeholders: [], technology: tech, methodology: meth, threePart: tc.parts === 3 });
    if (tc.parts === 3) m.catalogs.push(SM.norm({ id: SM.uid(), name: tc.catalog }));
    m.schemas.push(SM.norm({ id: SM.uid(), name: tc.schema, catalogId: tc.parts === 3 ? m.catalogs[0].id : null }));
    F = SM.toFile(m); log = SM.newHistory();
  } else {
    F = JSON.parse(read(path.join(SAMPLES, template + '.model.json')));
    log = SM.parseLog(read(path.join(SAMPLES, template + '.model.history.jsonl'))).history;
    positions = read(path.join(SAMPLES, template + '.model.layout.json'));
    if (SM.verify(log, SM.flatten(F)).length) throw new Error(`the ${template} template does not match its history; this is a bug in the extension`);
    from = SM.locate(log, SM.flatten(F)).pointers; // the template's own versions: the rename is made on top of them
    F.project.name = name; // the copy is the user's own: renamed, and the rename is one version so the history still matches the model
  }
  const flat = SM.flatten(F);
  for (const s of SM.STREAMS) SM.commit(log, s, from[s], flat[s], info);
  const written = [];
  const put = (p, text) => { write(p, text); written.push(p); };
  put(at(f.history), SM.logText(log)); // the log first: a model without its log is a drift warning, a log without its model is harmless
  put(at(f.model), SM.stringify(F) + '\n');
  if (positions) put(at(f.layout), positions);
  if (template !== 'blank' && fs.existsSync(path.join(SAMPLES, template + '_model_data'))) {
    fs.cpSync(path.join(SAMPLES, template + '_model_data'), at(f.data), { recursive: true, errorOnExist: true, force: false });
    written.push(at(f.data));
  }
  const madeManifest = ensurePart(dir, at(f.model), name);
  if (madeManifest) written.push(path.join(dir, MANIFEST));
  // a brand-new project from a template that ships starter domains gets them written into the manifest it just got (never into one that
  // already existed: a folder with a manifest of its own keeps whatever domains it already has, this model just joins it as another part)
  if (madeManifest === 'created' && TEMPLATES[template].domains) {
    const man = readManifest(dir);
    man.domains = cloneJson(TEMPLATES[template].domains);
    write(path.join(dir, MANIFEST), manifestText(man));
  }
  if (git) {
    if (ensureLines(path.join(dir, '.gitattributes'), [`${DIRS.history}/*.jsonl merge=union`])) written.push(path.join(dir, '.gitattributes'));
    if (ensureLines(path.join(dir, '.gitignore'), ['.strata/', ...(ignoreLayout ? ['*.model.layout.json'] : [])])) written.push(path.join(dir, '.gitignore'));
  }
  return { model: at(f.model), files: written };
}

// ---------- domains (release 2, ADR-0045): optional named groups of concepts, in the manifest ----------
// domains: [{name, owner?, steward?, criticality?, lifecycle?, policies?: [names], concepts: [concept names]}]. A concept is in at most one
// domain, domain names are unique (R16); checked here at the manifest level (no model needed) and again in media/gov.js#check once a model
// carries `m.domains` (the same shape, attached transiently by the host / CLI / skill script, never written by media/model.js).
const domainsOf = (man) => (man && Array.isArray(man.domains) ? man.domains : []);
function validateDomains(man) {
  const domains = domainsOf(man), issues = [], seen = new Map();
  for (const d of domains) { const k = String(d.name).toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); }
  for (const [k, n] of seen) if (n > 1) issues.push(`domain "${k}" is defined more than once`);
  const byConcept = new Map();
  for (const d of domains) for (const c of d.concepts || []) { if (!byConcept.has(c)) byConcept.set(c, []); byConcept.get(c).push(d.name); }
  for (const [c, ds] of byConcept) if (ds.length > 1) issues.push(`concept "${c}" is listed in domains ${ds.join(', ')}`);
  return issues;
}
// Replaces the manifest's whole `domains` array (release 2 part 3, ADR-0045 amended): the webview's Domains dialog already holds the full,
// edited list (the webview also validates R16 itself, for instant feedback), this is the last check before the file is written. No
// versioning: a domain is project metadata like a manifest part, not modelled/governed/semantic content (ADR-0045 point 1/4), so there is no
// history stream for it to join. Throws, writes nothing, if there is no manifest yet or the new list still fails R16.
function setDomains(root, domains) {
  const man = readManifest(root);
  if (!man) throw new Error('no project manifest found in ' + root);
  const next = { ...man, domains };
  const issues = validateDomains(next);
  if (issues.length) throw new Error(issues.join('; '));
  write(path.join(root, MANIFEST), manifestText(next));
  return domainsOf(next);
}

// The manifest's `dbt` block (change 31, ADR-0048) and `sql` block (change 33, ADR-0051): where the importer's sources are (paths relative to the manifest) and when they
// were last synced. Plain metadata like `domains`: unknown keys of the block are kept, the rest of the manifest is untouched, nothing is versioned.
function setBlock(root, key, block) {
  const man = readManifest(root);
  if (!man) throw new Error('no project manifest found in ' + root);
  const next = { ...(man[key] && typeof man[key] === 'object' ? man[key] : {}), ...block };
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k]; // a null / undefined value removes the key
  write(path.join(root, MANIFEST), manifestText({ ...man, [key]: next }));
}
const setDbt = (root, dbt) => setBlock(root, 'dbt', dbt);
const setSql = (root, sql) => setBlock(root, 'sql', sql);

// Run `fn` over each item in turn; the items before a failure are already written, so the error says how far it got (and `err.done` lists them). -> the names done
function eachPart(items, nameOf, fn, total = items.length) {
  const done = [];
  try { for (const x of items) { fn(x); done.push(nameOf(x)); } } catch (err) {
    err.done = done;
    err.message += ` (updated ${done.length} of ${total} part(s) before this failed: ${done.join(', ') || 'none'})`;
    throw err;
  }
  return done;
}

// ---------- governance.json (release 2 part 2, ADR-0045 point 4) ----------
// {"strata": "governance/1", tags, policies, propertyKeys}: the same shape as a `.model.json`'s own `governance` section (media/model.js
// `toFile`'s F.governance), moved to its own file once a project has more than one part. Unknown keys are kept, the same discipline as the
// manifest and the model file: nothing here strips a key it does not know.
function readGovernance(root) {
  try { const o = JSON.parse(read(path.join(root, GOVERNANCE))); return o && typeof o === 'object' ? o : null; } catch { return null; }
}
// Creating or editing a tag or policy from the project-index file writes to governance.json with its own governance-stream entry. `gov` is the
// file-shaped {tags, propertyKeys, policies}. A part's own editor still saves a new tag / policy into that part's file (ADR-0045 point 6).
function updateGovernance(root, gov, opts = {}) {
  const govPath = path.join(root, GOVERNANCE), histPath = path.join(root, GOVERNANCE_HISTORY);
  if (!fs.existsSync(govPath)) throw new Error('no governance.json found in ' + root + ' (only once a project has more than one part)');
  const info = infoOf(opts.user, 'Update shared tags/policies');
  const flat = SM.flatten({ governance: gov }).governance;
  const log = SM.parseLog(read(histPath)).history;
  SM.commit(log, 'governance', null, flat, info);
  write(histPath, SM.logText(log)); // the log before the file, as always
  write(govPath, manifestText({ strata: 'governance/1', ...gov }));
}
// Project Settings from the project-index file: the `project` block is identical in every part (assemble() checks), so the same block is written
// into each part as its own versioned edit (log before model). Not atomic: parts already written stay written and the error names them (`err.done`);
// until the rest are retried the index file shows "parts disagree about the project".
function updateProjectSettings(root, manifest, project, opts = {}) {
  const parts = manifest.parts || [];
  if (parts.length < 2) throw new Error('updateProjectSettings needs a project split into more than one part');
  const info = infoOf(opts.user, 'Update project settings');
  return { parts: eachPart(parts, (p) => p.name, (p) => {
    const modelPath = path.resolve(root, p.model), histPath = path.resolve(root, p.history || partHistory(p.name));
    const F = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    F.project = cloneJson(project);
    const flat = SM.flatten(F), log = SM.parseLog(read(histPath)).history;
    for (const s of SM.STREAMS) SM.commit(log, s, null, flat[s], info);
    write(histPath, SM.logText(log)); // the log before the model, as always
    write(modelPath, SM.stringify(F) + '\n');
  }) };
}

// ---------- the cross-part project index (ADR-0045 point 6) ----------
// Built from the manifest and the plain JSON of every part (it must work before any part is open): name -> lower-case membership lists, plus the
// project-wide duplicates (metric and entity names are unique across parts). Attached to a loaded model as `m.crossPart` (transient, never
// round-tripped) so a reference to another part's object resolves instead of `broken-ref` / `metric-ref`. `owner` / `domainOfPart` say which part
// and domain hold a name (cross-part stubs, Project View badges). An archived file is never scanned: its manifest entry is removed on split.
function buildIndex(root, manifest) {
  const parts = (manifest && manifest.parts) || [];
  const idx = { tables: [], columns: [], entities: [], concepts: [], metrics: [], duplicates: [], owner: { tables: {}, entities: {}, concepts: {}, metrics: {} }, domainOfPart: {}, partModel: {} };
  for (const d of domainsOf(manifest)) idx.domainOfPart[slug(d.name)] = d.name;
  const seen = { entity: new Map(), concept: new Map(), metric: new Map() };
  const LIST = { entity: 'entities', concept: 'concepts', metric: 'metrics' };
  const note = (kind, name, part) => {
    if (!name) return;
    const k = String(name).toLowerCase(), list = idx[LIST[kind]], m = seen[kind], owner = idx.owner[LIST[kind]];
    list.push(k);
    if (!(k in owner)) owner[k] = part;
    if (m.has(k) && m.get(k) !== part) {
      const d = idx.duplicates.find((x) => x.kind === kind && x.name === k);
      if (d) { if (!d.parts.includes(part)) d.parts.push(part); } else idx.duplicates.push({ kind, name: k, parts: [m.get(k), part] });
    } else if (!m.has(k)) m.set(k, part);
  };
  for (const part of parts) {
    idx.partModel[part.name] = part.model; // manifest-relative, for `openPart` (a cross-part stub opens the other part)
    let F; try { F = JSON.parse(read(path.resolve(root, part.model))); } catch { continue; }
    if (!F || typeof F !== 'object') continue;
    for (const t of F.tables || []) {
      const ref = `${t.schema || ''}.${t.name || ''}`.toLowerCase();
      idx.tables.push(ref);
      if (!(ref in idx.owner.tables)) idx.owner.tables[ref] = part.name;
      for (const c of t.columns || []) idx.columns.push(ref + '.' + String(c.name || '').toLowerCase());
    }
    for (const c of (F.conceptual || {}).concepts || []) note('concept', c.name, part.name);
    for (const e of (F.logical || {}).entities || []) note('entity', e.name, part.name);
    for (const x of (F.semantic || {}).metrics || []) note('metric', x.name, part.name);
  }
  return idx;
}

// ---------- the split command (ADR-0045 point 5): one file per domain ----------
// A table's home part is its `homeDomain` (an ordinary unknown key kept in `ext`), else the single domain of the entities it realises, else
// `_unassigned`. A metric's is `homeDomain` (a domain name or "_shared"), else the single domain of what it reads, else `_shared`. Concepts route
// by manifest membership; entities by `homeDomain`, else their concept's part. Nothing is dropped or blocked.
function homeParts(fullM, domains) {
  const SA = require('../media/align.js');
  const domainOfConceptName = new Map();
  for (const d of domains) for (const cn of d.concepts || []) domainOfConceptName.set(String(cn).toLowerCase(), d.name);
  const conceptPart = new Map(), entityPart = new Map(), tablePart = new Map(), metricPart = new Map(), warnings = [];
  const findDomain = (name) => domains.find((d) => d.name.toLowerCase() === String(name).toLowerCase());
  // an object's own `homeDomain`: a domain's part, the sentinel itself ('_unassigned' / '_shared'), or null (none set, or it names no domain: warned about)
  const homeOf = (x, what, sentinel) => {
    const o = x.ext && x.ext.homeDomain;
    if (!o) return null;
    if (String(o).toLowerCase() === sentinel) return sentinel;
    const hit = findDomain(o);
    if (hit) return slug(hit.name);
    warnings.push(`${what} ${x.name}: homeDomain "${o}" does not name a domain; the usual rule was used instead`);
    return null;
  };
  for (const c of fullM.concepts) { const dn = domainOfConceptName.get(c.name.toLowerCase()); conceptPart.set(c.id, dn ? slug(dn) : '_unassigned'); }
  for (const e of fullM.entities) {
    const part = homeOf(e, 'entity', '_unassigned');
    entityPart.set(e.id, part || (e.conceptId && conceptPart.has(e.conceptId) ? conceptPart.get(e.conceptId) : '_unassigned'));
  }
  const memo = new Map();
  for (const t of fullM.tables) {
    let part = homeOf(t, 'table', '_unassigned');
    if (!part) {
      const ps = new Set(SA.entitiesOfTable(fullM, t, memo).map((e) => entityPart.get(e.id)).filter((x) => x && x !== '_unassigned'));
      if (ps.size === 1) part = [...ps][0];
      else { part = '_unassigned'; if (ps.size > 1) warnings.push(`table ${t.name} realises entities in more than one domain (${[...ps].join(', ')}); set "homeDomain" on it to choose one — sent to _unassigned`); }
    }
    tablePart.set(t.id, part);
  }
  const MX = SM.metricIndex(fullM), byId = new Map(fullM.metrics.map((x) => [x.id, x])), busy = new Set();
  // a metric that builds on another metric follows where that one lives, so the other is routed first (recursion, cycles ignored): the
  // outcome must not depend on the order the metrics happen to be listed in, or every edit could flip it between parts (change 30)
  const routeMetric = (x) => {
    if (!x) return undefined;
    if (metricPart.has(x.id) || busy.has(x.id)) return metricPart.get(x.id);
    busy.add(x.id);
    let part = homeOf(x, 'metric', '_shared');
    if (!part) {
      const r = SM.metricRefs(fullM, x, MX);
      const ps = new Set([...[...r.tables].map((id) => tablePart.get(id)), ...[...r.metrics].map((id) => routeMetric(byId.get(id)))].filter(Boolean));
      part = ps.size === 1 ? [...ps][0] : '_shared';
    }
    busy.delete(x.id);
    metricPart.set(x.id, part);
    return part;
  };
  for (const x of fullM.metrics) routeMetric(x);
  return { conceptPart, entityPart, tablePart, metricPart, warnings };
}

// which part hosts the object a `kind:ref[:...]` alignment key, or a dangling reference's name, is about (a table ref, or a concept / entity /
// metric name); null when none of them match (a tag / policy / project-level key, or a name that no longer exists anywhere)
function partForName(low, R, hp, fullM) {
  for (const t of fullM.tables) { const ref = R.tab.get(t.id).toLowerCase(); if (low === ref || low.startsWith(ref + ':') || low.startsWith(ref + '.')) return hp.tablePart.get(t.id); }
  for (const c of fullM.concepts) { const n = c.name.toLowerCase(); if (low === n || low.startsWith(n + ':')) return hp.conceptPart.get(c.id); }
  for (const e of fullM.entities) { const n = e.name.toLowerCase(); if (low === n || low.startsWith(n + ':')) return hp.entityPart.get(e.id); }
  for (const x of fullM.metrics) { const n = x.name.toLowerCase(); if (low === n || low.startsWith(n + ':')) return hp.metricPart.get(x.id); }
  return null;
}

// A link to another part's object (an entity outside the table, a foreign key to another part's table, a conceptual / logical relationship whose
// child is elsewhere) becomes the "kept as written, reported" dangling shape of ADR-0042; the project index resolves it. Mutates the cloned subset.
function pullCrossPartRefs(fullM, subM, sets) {
  const { tables: tableIds, concepts: conceptIds, entities: entityIds } = sets;
  const R = SM.refs(fullM), cName = new Map(fullM.concepts.map((c) => [c.id, c.name])), eName = new Map(fullM.entities.map((e) => [e.id, e.name]));
  for (const t of subM.tables) {
    for (const c of t.columns) {
      const f = c.foreignKey;
      if (f && !tableIds.has(f.tableId)) {
        subM.dangling.push({ list: 'relationships', r: { parent: R.col.get(f.columnId), child: R.col.get(c.id), ...(f.cardinality ? { cardinality: f.cardinality } : {}), ...(f.name ? { name: f.name } : {}), ...(f.description ? { description: f.description } : {}), ...(f.ext || {}) } });
        c.foreignKey = null;
      }
    }
    const foreign = (t.entityIds || []).filter((id) => !entityIds.has(id));
    if (foreign.length) {
      t.entityIds = t.entityIds.filter((id) => entityIds.has(id));
      t.broken = { ...(t.broken || {}), entity: [...new Set([...((t.broken || {}).entity || []), ...foreign.map((id) => eName.get(id))])] };
    }
  }
  // A relation whose via (M..M bridge) table is in another part would be dropped silently by `toFile`: keep it, with the via NAME in `ext`.
  const relKept = [];
  for (const r of subM.relations) {
    if (tableIds.has(r.parentId) && tableIds.has(r.childId)) {
      if (r.viaId && !tableIds.has(r.viaId)) r.ext = { ...(r.ext || {}), via: R.tab.get(r.viaId) }; // via elsewhere: name it directly, toFile cannot resolve it from the subset
      relKept.push(r);
    } else subM.dangling.push({ list: 'relationships', r: { parent: R.tab.get(r.parentId), child: R.tab.get(r.childId), ...(r.cardinality ? { cardinality: r.cardinality } : {}), ...(r.name ? { name: r.name } : {}), ...(r.description ? { description: r.description } : {}), ...(r.viaId && R.tab.get(r.viaId) ? { via: R.tab.get(r.viaId) } : {}), ...(r.ext || {}) } });
  }
  subM.relations = relKept;
  const crelKept = [];
  for (const r of subM.crels) {
    if (conceptIds.has(r.childId)) crelKept.push(r);
    else subM.dangling.push({ list: 'conceptual', r: { parent: cName.get(r.parentId), child: cName.get(r.childId), ...(r.cardinality ? { cardinality: r.cardinality } : {}), ...(r.name ? { name: r.name } : {}), ...(r.description ? { description: r.description } : {}) } });
  }
  subM.crels = crelKept;
  const lrelKept = [];
  for (const r of subM.lrels) {
    if (entityIds.has(r.childId)) lrelKept.push(r);
    else subM.dangling.push({ list: 'logical', r: { parent: eName.get(r.parentId), child: eName.get(r.childId), ...(r.cardinality ? { cardinality: r.cardinality } : {}), ...(r.name ? { name: r.name } : {}), ...(r.description ? { description: r.description } : {}) } });
  }
  subM.lrels = lrelKept;
}

const cloneJson = (o) => JSON.parse(JSON.stringify(o));

// A catalog or schema used by no table anywhere (a new one from "Add Schema" / "Add Catalog" in the index file): subsetModel derives a part's
// catalogs / schemas from its tables, so an orphan would vanish on the next edit. Used only by applyProjectEdit.
function orphanContainers(fullM) {
  const usedSchemaIds = new Set(fullM.tables.map((t) => t.schemaId));
  const schemas = fullM.schemas.filter((s) => !usedSchemaIds.has(s.id));
  const usedCatalogIds = new Set(fullM.schemas.filter((s) => usedSchemaIds.has(s.id)).map((s) => s.catalogId).filter(Boolean));
  const catalogs = fullM.catalogs.filter((c) => !usedCatalogIds.has(c.id));
  return { schemas, catalogs };
}

// One part's working model: only the objects `hp` routes to `partSlug`, plus the catalogs / schemas its own tables use, `project` duplicated
// verbatim (every part is a complete, standalone `.model.json`) and no `governance` section at all (it moved to governance.json). Unknown
// top-level / section keys (ADR-0042) travel with `carryExtra` (the split gives them to one part, so nothing is dropped or duplicated).
function subsetModel(fullM, hp, partSlug, carryExtra) {
  const m = SM.blank();
  m.project = cloneJson(fullM.project);
  m.extra = carryExtra ? cloneJson(fullM.extra || {}) : {};
  const want = (map) => new Set([...map].filter(([, p]) => p === partSlug).map(([id]) => id));
  const conceptIds = want(hp.conceptPart), entityIds = want(hp.entityPart), tableIds = want(hp.tablePart), metricIds = want(hp.metricPart);
  m.concepts = fullM.concepts.filter((c) => conceptIds.has(c.id)).map(cloneJson);
  m.entities = fullM.entities.filter((e) => entityIds.has(e.id)).map(cloneJson);
  m.metrics = fullM.metrics.filter((x) => metricIds.has(x.id)).map(cloneJson);
  m.tables = fullM.tables.filter((t) => tableIds.has(t.id)).map(cloneJson);
  const schemaIds = new Set(m.tables.map((t) => t.schemaId));
  m.schemas = fullM.schemas.filter((s) => schemaIds.has(s.id)).map(cloneJson);
  const catIds = new Set(m.schemas.map((s) => s.catalogId).filter(Boolean));
  m.catalogs = fullM.catalogs.filter((c) => catIds.has(c.id)).map(cloneJson);
  m.crels = fullM.crels.filter((r) => hp.conceptPart.get(r.parentId) === partSlug).map(cloneJson);
  m.lrels = fullM.lrels.filter((r) => hp.entityPart.get(r.parentId) === partSlug).map(cloneJson);
  m.relations = fullM.relations.filter((r) => hp.tablePart.get(r.childId) === partSlug).map(cloneJson);
  pullCrossPartRefs(fullM, m, { tables: tableIds, concepts: conceptIds, entities: entityIds });
  return m;
}

// Splits a project (still one part) into one part per domain plus `_shared` (metrics with no single domain) and `_unassigned`; nothing disappears,
// it is routed or reported. opts: {user, stop}. -> {parts, files (in write order), warnings}. Throws before writing when there is no manifest, no domains
// or the project is already split; a failed write names what was and was not written (`err.written`) and undoes nothing.
function split(modelFile, opts = {}) {
  const r = resolve(modelFile, { stop: opts.stop });
  if (!r.manifest) throw new Error('this model has no project manifest yet (save it once, or run `strata-sql init`) — domains and the split need one');
  const man = readManifest(r.root);
  if ((man.parts || []).length > 1) throw new Error('this project already has more than one part; nothing to split');
  const domains = domainsOf(man);
  if (!domains.length) throw new Error('no domains are defined in the manifest (strata.project.json "domains"); add at least one before splitting');
  const issues = validateDomains(man);
  if (issues.length) throw new Error('the manifest\'s domains need fixing before splitting: ' + issues.join('; '));
  const info = infoOf(opts.user, `Split from ${r.part} into ${domains.length} domain${domains.length === 1 ? '' : 's'}`);

  const fullF = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
  const fullM = SM.fromFile(fullF);
  const hp = homeParts(fullM, domains);
  const R = SM.refs(fullM);
  const originalF = SM.toFile(fullM);
  const slugsUsed = new Set([...hp.conceptPart.values(), ...hp.entityPart.values(), ...hp.tablePart.values(), ...hp.metricPart.values()]);
  // acknowledged warnings and pre-existing dangling references (ADR-0042): routed to whichever part their name resolves in, else `_shared`
  const ackByPart = new Map(), danglingByPart = new Map();
  const routeTo = (map, slug_, x) => { if (!map.has(slug_)) map.set(slug_, []); map.get(slug_).push(x); slugsUsed.add(slug_); };
  for (const key of fullM.ack || []) { const i = key.indexOf(':'); routeTo(ackByPart, partForName((i < 0 ? key : key.slice(i + 1)).toLowerCase(), R, hp, fullM) || '_shared', key); }
  for (const d of fullM.dangling || []) {
    const rr = d.r || {}, part = partForName(String(rr.parent || '').toLowerCase(), R, hp, fullM) || partForName(String(rr.child || '').toLowerCase(), R, hp, fullM) || '_shared';
    routeTo(danglingByPart, part, cloneJson(d));
  }
  const slugOrder = [...domains.map((d) => slug(d.name)), '_unassigned', '_shared'].filter((s) => slugsUsed.has(s));
  if (!slugOrder.length) throw new Error('nothing in this model maps to a domain; nothing to split');
  const firstSlug = slugOrder[0];
  // the pre-split file, archived in place (release 2 part 5, ADR-0045 point 10): its layout is renamed to match (paired in the Explorer);
  // its history log keeps its old name (it is not reachable through the manifest either way, archived or not) and data/ needs no change
  // (keyed by directory, not filename). A thin project-index file takes over the vacated path (extension.js detects it by content).
  const baseStem = stemOf(r.model), archivedDir = path.dirname(r.model);
  const archivedModel = path.join(archivedDir, baseStem + '.archived.model.json'), archivedLayout = path.join(archivedDir, baseStem + '.archived.model.layout.json');
  // never overwrite (the same rule create() follows): refuse before writing anything if any target file already exists
  const busy = [GOVERNANCE, GOVERNANCE_HISTORY, 'CODEOWNERS'].filter((f) => fs.existsSync(path.join(r.root, f))).map((f) => path.join(r.root, f));
  busy.push(...[archivedModel, archivedLayout].filter((f) => fs.existsSync(f)));
  for (const slug_ of slugOrder) busy.push(...taken(r.root, slug_, baseStem).map((f) => path.join(r.root, f)));
  if (busy.length) throw new Error(`${busy.map((p) => path.relative(r.root, p)).join(', ')} already exist${busy.length > 1 ? '' : 's'} in ${r.root}; nothing was written`);

  const written = [];
  const put = (p, text) => { write(p, text); written.push(p); };
  try {
    // 1. governance.json and its own fresh history stream, first (log before model, project-wide, like every other write here)
    const govContent = originalF.governance || { tags: [], propertyKeys: [], policies: [] };
    const govLog = SM.newHistory();
    SM.commit(govLog, 'governance', null, SM.flatten({ governance: govContent }).governance, info);
    put(r.governanceHistory || path.join(r.root, GOVERNANCE_HISTORY), SM.logText(govLog));
    put(r.governanceFile || path.join(r.root, GOVERNANCE), manifestText({ strata: 'governance/1', ...govContent }));
    // 2. each part: history, then model, then layout, then data (the same order create() uses)
    const partsOut = [];
    for (const slug_ of slugOrder) {
      const subM = subsetModel(fullM, hp, slug_, slug_ === firstSlug);
      subM.ack = ackByPart.get(slug_) || [];
      subM.dangling = [...subM.dangling, ...(danglingByPart.get(slug_) || [])];
      const F = SM.toFile(subM), flat = SM.flatten(F);
      const log = SM.newHistory();
      for (const s of SM.STREAMS) SM.commit(log, s, null, flat[s], info);
      const files = partFiles(r.root, slug_, baseStem);
      put(path.join(r.root, files.history), SM.logText(log));
      put(path.join(r.root, files.model), SM.stringify(F) + '\n');
      partsOut.push({ name: slug_, model: files.model });
    }
    // 3. sample data: each table's CSV follows it to its part (a project without data/ has nothing to move)
    if (fs.existsSync(r.dataDir)) {
      for (const slug_ of slugOrder) {
        const tabIds = new Set([...hp.tablePart].filter(([, p]) => p === slug_).map(([id]) => id));
        for (const t of fullM.tables) if (tabIds.has(t.id)) {
          const csv = R.tab.get(t.id) + '.csv', from = path.join(r.dataDir, csv);
          if (fs.existsSync(from)) { const to = path.join(r.root, partFiles(r.root, slug_, baseStem).data, csv); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); written.push(to); }
        }
      }
    }
    // 4. archive the pre-split file, and write the project-index file at its vacated path (release 2 part 5). Done after every part and
    // governance.json are safely on disk, so a failure here still leaves a fully split, readable project behind — only the archiving step
    // itself would need retrying (opening the original file directly still works exactly as release-2-part-2 through part-4 left it).
    fs.renameSync(r.model, archivedModel); written.push(archivedModel);
    if (fs.existsSync(r.layout)) { fs.renameSync(r.layout, archivedLayout); written.push(archivedLayout); }
    put(r.model, manifestText({ strata: INDEX_STRATA, name: man.name || baseStem, parts: partsOut.map((p) => p.name) }));
    // 5. the manifest: the old single part is replaced by the new ones, and now names the project-index file too (its own files are left
    // on disk, untouched — nothing here deletes a user's files; the index file is regenerable, never hand-maintained)
    man.parts = partsOut;
    man.index = posix(path.relative(r.root, r.model));
    write(path.join(r.root, MANIFEST), manifestText(man));
    written.push(path.join(r.root, MANIFEST));
    // governance.history.jsonl is at the top level, not under history/, so the existing `history/*.jsonl merge=union` line does not cover it
    if (fs.existsSync(path.join(r.root, '.gitattributes')) && ensureLines(path.join(r.root, '.gitattributes'), [`${GOVERNANCE_HISTORY} merge=union`])) written.push(path.join(r.root, '.gitattributes'));
    // 6. CODEOWNERS: one line per domain that has an owner (never enforced, just written; see help.md)
    const owners = domains.filter((d) => d.owner && slugsUsed.has(slug(d.name)));
    if (owners.length) put(path.join(r.root, 'CODEOWNERS'), owners.map((d) => `/${DIRS.models}/${baseStem}/${slug(d.name)}/ @${d.owner}`).join('\n') + '\n');
    return { parts: partsOut, files: written, warnings: hp.warnings };
  } catch (err) {
    err.written = written;
    err.message += ` (wrote ${written.length} file(s) before this failed: ${written.map((p) => path.relative(r.root, p)).join(', ') || 'none'})`;
    throw err;
  }
}

// ---------- editing directly from the project-index file ----------
// The webview edits one assembled model (the usual mutate() / commitChange()) and posts the WHOLE model back; this re-routes every object with
// split()'s rules (homeParts, subsetModel, pullCrossPartRefs) and commits only the delta into each EXISTING part's log, so a cross-part rename
// resolves everywhere. Never invents a part file: an object routed to a part not on disk fails the whole edit before anything is written.
// opts: {user, conceptDomains: {conceptName: domainName|'_unassigned'|''}} - a concept's domain lives in the manifest, so it is reconciled
// before routing. -> {parts: [names written]}. A failed write names the parts written (err.done).
function applyProjectEdit(root, manifest, fullFileObj, opts = {}) {
  const parts = [...(manifest.parts || [])];
  if (parts.length < 2) throw new Error('applyProjectEdit needs a project split into more than one part');
  const partNames = new Set(parts.map((p) => p.name));
  let domains = cloneJson(domainsOf(manifest)), manifestChanged = false;
  for (const [conceptName, domainName] of Object.entries(opts.conceptDomains || {})) {
    const before = domains.map((d) => (d.concepts || []).length);
    domains.forEach((d) => { d.concepts = (d.concepts || []).filter((c) => c.toLowerCase() !== conceptName.toLowerCase()); });
    if (domainName && domainName !== '_unassigned') {
      const d = domains.find((x) => x.name.toLowerCase() === String(domainName).toLowerCase());
      if (d) (d.concepts ||= []).push(conceptName);
    }
    if (domains.some((d, i) => (d.concepts || []).length !== before[i])) manifestChanged = true;
  }
  if (manifestChanged) {
    const issues = validateDomains({ ...manifest, domains });
    if (issues.length) throw new Error('could not place a concept in its domain: ' + issues.join('; '));
  }

  const fullM = SM.fromFile(fullFileObj);
  const hp = homeParts(fullM, domains);
  const needed = new Set([...hp.conceptPart.values(), ...hp.entityPart.values(), ...hp.tablePart.values(), ...hp.metricPart.values()]);
  // an orphan catalog/schema (release 2 part 11): no table anywhere carries it into any part's own subset, so it is routed to _unassigned,
  // the same homeless-object destination a table/entity with no domain and no link already falls to; refused, not silently dropped, if
  // _unassigned itself does not exist yet.
  const orphans = orphanContainers(fullM);
  if (orphans.schemas.length || orphans.catalogs.length) needed.add('_unassigned');
  const missing = [...needed].filter((s) => !partNames.has(s));
  // opts.createParts (a domain given concepts after the split, applyDomains below): the part is created here - an empty file, filled by the
  // very same commit loop as every other part - instead of refusing. Nested like split()'s own (data_models/<project>/<part>/).
  const created = [];
  if (missing.length && opts.createParts) {
    const projStem = path.basename(path.dirname(path.dirname(path.resolve(root, parts[0].model))));
    for (const slug_ of missing) {
      if (taken(root, slug_, projStem).length) throw new Error(`${slug_}'s files already exist; nothing was saved`);
      const f = partFiles(root, slug_, projStem);
      created.push({ name: f.name, model: f.model }); parts.push({ name: f.name, model: f.model });
    }
    missing.length = 0;
  }
  if (missing.length) throw new Error(`no part exists yet for: ${missing.join(', ')} (split, or the Domains tab, creates a part for a domain first; nothing was saved)`);

  const info = infoOf(opts.user, opts.message || 'Edit from the project-index file');
  const R = SM.refs(fullM);
  const ackByPart = new Map(), danglingByPart = new Map();
  const routeTo = (map, slug_, x) => { if (!map.has(slug_)) map.set(slug_, []); map.get(slug_).push(x); };
  for (const key of fullM.ack || []) { const i = key.indexOf(':'); routeTo(ackByPart, partForName((i < 0 ? key : key.slice(i + 1)).toLowerCase(), R, hp, fullM) || '_shared', key); }
  for (const d of fullM.dangling || []) {
    const rr = d.r || {}, part = partForName(String(rr.parent || '').toLowerCase(), R, hp, fullM) || partForName(String(rr.child || '').toLowerCase(), R, hp, fullM) || '_shared';
    routeTo(danglingByPart, part, cloneJson(d));
  }
  const first = parts.find((p) => !p.name.startsWith('_')) || parts[0]; // carries the "unknown top-level extra" bag, same convention as split()

  // pass 1 (writes nothing): what every part will hold, and which objects only change PART - removed from one, added to another in this very
  // edit (a table / concept / entity / metric given another Domain). The log records that as a move, not as an unrelated delete and add.
  const plan = parts.map((p) => {
    const subM = subsetModel(fullM, hp, p.name, p.name === first.name);
    if (p.name === '_unassigned') {
      const haveS = new Set(subM.schemas.map((s) => s.id)), haveC = new Set(subM.catalogs.map((c) => c.id));
      for (const s of orphans.schemas) if (!haveS.has(s.id)) subM.schemas.push(cloneJson(s));
      for (const c of orphans.catalogs) if (!haveC.has(c.id)) subM.catalogs.push(cloneJson(c));
    }
    subM.ack = ackByPart.get(p.name) || [];
    subM.dangling = [...subM.dangling, ...(danglingByPart.get(p.name) || [])];
    const F = SM.toFile(subM), flat = SM.flatten(F);
    const histPath = path.resolve(root, p.history || partHistory(p.name));
    const log = SM.parseLog(read(histPath)).history;
    const gain = {}, lose = {};
    for (const s of SM.STREAMS) {
      const head = SM.headsOf(log, s).reduce((a, b) => (!a || String(b.hlc) > String(a.hlc) ? b : a), null), cur = (head && SM.stateAt(log, head.chain)) || {};
      gain[s] = Object.keys(flat[s]).filter((k) => !(k in cur)); lose[s] = Object.keys(cur).filter((k) => !(k in flat[s]));
    }
    return { p, F, flat, histPath, log, gain, lose, moved: {} };
  });
  for (const a of plan) for (const b of plan) if (a !== b) for (const s of SM.STREAMS) {
    const keys = a.lose[s].filter((k) => b.gain[s].includes(k) && !k.startsWith('column:')); // a table's columns travel with it (SM.changesOf)
    if (keys.length) { (a.moved[s] ||= []).push({ to: b.p.name, keys }); (b.moved[s] ||= []).push({ from: a.p.name, keys }); }
  }

  const done = eachPart(plan, (x) => x.p.name, ({ p, F, flat, histPath, log, moved }) => {
    let changed = false;
    for (const s of SM.STREAMS) if (SM.commit(log, s, null, flat[s], info, moved[s] ? { moved: moved[s] } : {})) changed = true;
    if (changed) { write(histPath, SM.logText(log)); write(path.resolve(root, p.model), SM.stringify(F) + '\n'); }
  }, parts.length);
  if (manifestChanged || created.length) write(path.join(root, MANIFEST), manifestText({ ...manifest, parts, domains }));
  const idxFile = manifest.index && path.resolve(root, manifest.index), ix = created.length && idxFile && readIndexFile(idxFile);
  if (ix) write(idxFile, manifestText({ ...ix, parts: parts.map((p) => p.name) })); // the index file names every part
  return { parts: done, created: created.map((c) => c.name) };
}

// Editing the domains of a split project (release 2, change 30): a domain's concepts decide which part their objects live in, so changing
// the list re-routes exactly like any other edit (applyProjectEdit reruns split()'s own rules; what only changes part is recorded as a
// move, not a delete + add) and creates the part of a domain that just got its first objects. Not split: the manifest only (setDomains).
// A split project's domain keeps its NAME (its part and every `homeDomain` are named after it): the dialog does not offer a rename there.
function applyDomains(root, manifest, domains, opts = {}) {
  if ((manifest.parts || []).length < 2) return setDomains(root, domains);
  const next = { ...manifest, domains }, issues = validateDomains(next);
  if (issues.length) throw new Error(issues.join('; '));
  const res = applyProjectEdit(root, next, assemble(root, manifest), { user: opts.user, message: opts.message || 'Change domains', createParts: true });
  write(path.join(root, MANIFEST), manifestText({ ...readManifest(root), domains })); // after the parts: the manifest names what exists
  return res;
}

// ---------- the merged history of the project-index file's tab ----------
// Every part's log as raw JSON Lines text (the webview parses it with SM.parseLog), its model path ("open this part") and its domain; governance.json's
// log is included, tagged `gov: true`, but is not a target for `projectGoto`.
function partHistoryTexts(root, manifest) {
  const parts = manifest.parts || [], idx = buildIndex(root, manifest);
  const out = parts.map((p) => ({ name: p.name, model: p.model, domain: idx.domainOfPart[p.name] || null, text: read(path.resolve(root, p.history || partHistory(p.name))) || '' }));
  if (parts.length > 1 && fs.existsSync(path.join(root, GOVERNANCE_HISTORY))) out.push({ name: GOVERNANCE, domain: null, gov: true, text: read(path.join(root, GOVERNANCE_HISTORY)) || '' });
  return out;
}
// Undo / redo across every part: the single most recent (undo) or earliest-undone (redo) entry across the parts' logs (never governance.json),
// compared by hlc, found and applied as the single-part editor does (SM.locate, SM.undoTarget / redoTarget). No history entry is written: it only moves
// which recorded content a part's file holds, and open tabs pick it up through onDidChangeTextDocument. -> {part, stream} | null.
function projectGoto(root, manifest, dir) {
  const parts = manifest.parts || [];
  let best = null;
  for (const p of parts) {
    const modelPath = path.resolve(root, p.model), histPath = path.resolve(root, p.history || partHistory(p.name));
    let F; try { F = JSON.parse(fs.readFileSync(modelPath, 'utf8')); } catch { continue; } // unreadable: skipped, not fatal to the other parts
    const hist = SM.parseLog(read(histPath) || '').history;
    const flats = SM.flatten(F), pointers = SM.locate(hist, flats).pointers;
    const t = dir === 'redo' ? SM.redoTarget(hist, pointers) : SM.undoTarget(hist, pointers);
    if (!t) continue;
    if (!best || (dir === 'redo' ? String(t.hlc) < String(best.t.hlc) : String(t.hlc) > String(best.t.hlc))) best = { p, modelPath, hist, flats, t };
  }
  if (!best) return null;
  const { p, modelPath, hist, flats, t } = best;
  const nf = { ...flats, [t.stream]: SM.stateAt(hist, t.key) || {} };
  write(modelPath, SM.stringify(SM.unflatten(nf.modelling, nf.governance, nf.semantic)) + '\n');
  return { part: p.name, stream: t.stream };
}

// Reassembles a split project's parts + governance.json into one file object, shaped exactly like the pre-split `SM.toFile` output (used by
// `join` and by the split's own losslessness check, tests/project.check.js). Every part must have a `project` identical to the first
// (verified, since split() always writes the same one); unknown top-level / section keys, wherever the split put them, come back too.
function assemble(root, manifest) {
  const parts = (manifest.parts || []).map((p) => JSON.parse(read(path.resolve(root, p.model))));
  if (!parts.length) throw new Error('the project has no parts to assemble');
  const gov = readGovernance(root);
  const F = { strata: 2, project: parts[0].project };
  for (const p of parts.slice(1)) if (SM.stringify(p.project) !== SM.stringify(F.project)) throw new Error('parts disagree about the project: cannot reassemble');
  const govTags = (gov && gov.tags) || [], govPolicies = (gov && gov.policies) || [], govKeys = (gov && gov.propertyKeys) || [];
  // toFile()'s own condition, key by key: empty is omitted, never written as `[]`
  if (govTags.length || govPolicies.length || govKeys.length) F.governance = { ...(govTags.length ? { tags: govTags } : {}), ...(govKeys.length ? { propertyKeys: govKeys } : {}), ...(govPolicies.length ? { policies: govPolicies } : {}) };
  const byKey = (list, key) => { const m = new Map(); for (const x of list) m.set(key(x), x); return m; };
  const cats = byKey(parts.flatMap((p) => p.catalogs || []), (c) => c.name);
  if (cats.size) F.catalogs = [...cats.values()];
  F.schemas = [...byKey(parts.flatMap((p) => p.schemas || []), (s) => (s.catalog ? s.catalog + '.' : '') + s.name).values()];
  F.tables = parts.flatMap((p) => p.tables || []);
  const rels = parts.flatMap((p) => p.relationships || []);
  if (rels.length) F.relationships = rels;
  const con = parts.flatMap((p) => (p.conceptual || {}).concepts || []), crel = parts.flatMap((p) => (p.conceptual || {}).relationships || []);
  if (con.length || crel.length) F.conceptual = { ...(con.length ? { concepts: con } : {}), ...(crel.length ? { relationships: crel } : {}) };
  const ent = parts.flatMap((p) => (p.logical || {}).entities || []), lrel = parts.flatMap((p) => (p.logical || {}).relationships || []);
  if (ent.length || lrel.length) F.logical = { ...(ent.length ? { entities: ent } : {}), ...(lrel.length ? { relationships: lrel } : {}) };
  const mets = parts.flatMap((p) => (p.semantic || {}).metrics || []);
  if (mets.length) F.semantic = { metrics: mets };
  const acks = [...new Set(parts.flatMap((p) => (p.alignment || {}).acknowledged || []))].sort();
  if (acks.length) F.alignment = { acknowledged: acks };
  for (const p of parts) for (const k of Object.keys(p)) if (!TOP_KEYS.includes(k) && !(k in F)) F[k] = p[k]; // unknown keys: wherever the split put them
  return F;
}
const TOP_KEYS = ['strata', 'project', 'governance', 'catalogs', 'schemas', 'tables', 'relationships', 'conceptual', 'logical', 'semantic', 'alignment'];

// The whole project assembled into one read-only model + a table/concept/entity -> domain map (release 2 part 4, ADR-0045 extended). Moved
// here from extension.js in release 2 part 13 (Live view support for the project-index file) so lib/live.js can build the exact same thing
// for the browser, without an extension.js/vscode dependency: shared by the project-index file's own custom-editor tab, the older ad hoc
// bespoke WebviewPanel (an ad hoc multi-part project that was never split), and now the live view.
function assembledProjectModel(root, man) {
  const F = assemble(root, man), idx = buildIndex(root, man);
  const domainOf = { tables: {}, concepts: {}, entities: {} };
  for (const [ref, part] of Object.entries(idx.owner.tables)) if (idx.domainOfPart[part]) domainOf.tables[ref] = idx.domainOfPart[part];
  for (const [n, part] of Object.entries(idx.owner.concepts)) if (idx.domainOfPart[part]) domainOf.concepts[n] = idx.domainOfPart[part];
  for (const [n, part] of Object.entries(idx.owner.entities)) if (idx.domainOfPart[part]) domainOf.entities[n] = idx.domainOfPart[part];
  return { F, domainOf };
}
// Whether each domain part's own embeddings file is up to date (release 2 part 9; moved here in release 2 part 13 so extension.js's webview
// host and lib/live.js's browser host compute this identically instead of twice): the same content-hash comparison a single part's own
// embedState() already does, run once per part. -> [{name, hasEmbeddings, upToDate, generatedAt}].
function partsEmbedStatus(root, manifest) {
  return ((manifest && manifest.parts) || []).map((p) => {
    const modelPath = path.resolve(root, p.model), embedPath = modelPath.replace(/\.model\.json$/, '.model.embeddings.json');
    let F = null; try { F = JSON.parse(fs.readFileSync(modelPath, 'utf8')); } catch { /* unreadable: reported as "not generated" below */ }
    let status = null; try { status = JSON.parse(fs.readFileSync(embedPath, 'utf8')); } catch { /* not generated yet */ }
    let upToDate = false;
    if (F && status) { const { layout, version, ...content } = F; upToDate = status.contentHash === SM.hash(SM.canon(content)); }
    return { name: p.name, hasEmbeddings: !!status, upToDate, generatedAt: status && status.generatedAt };
  });
}

// Joins a split project back into one part: reassemble, write it as a fresh part with its own history. The split parts, governance.json and their
// logs stay on disk. With a project-index file (`man.index`) the joined model reoccupies its exact path and `man.index` is cleared; the archived file
// is untouched, so the joined history gets a different name when its natural one is taken.
function join(dir, opts = {}) {
  const root = path.resolve(dir), man = readManifest(root);
  if (!man) throw new Error('no project manifest found in ' + root);
  if ((man.parts || []).length < 2) throw new Error('this project already has one part; nothing to join');
  const F = assemble(root, man);
  const info = infoOf(opts.user, `Joined ${man.parts.length} parts into one`);
  const flat = SM.flatten(F), log = SM.newHistory();
  for (const s of SM.STREAMS) SM.commit(log, s, null, flat[s], info);
  const written = [];
  const put = (p, text) => { write(p, text); written.push(p); };
  if (man.index) {
    const modelPath = path.resolve(root, man.index);
    const idx = readIndexFile(modelPath);
    if (!idx) throw new Error(`strata.project.json names "${man.index}" as the project index, but it is not one (or is missing); refusing to overwrite it`);
    const baseStem = stemOf(modelPath);
    let historyRel = partHistory(baseStem);
    if (fs.existsSync(path.join(root, historyRel))) historyRel = partHistory(baseStem + '-joined'); // the archived file's own log already has this name
    if (fs.existsSync(path.join(root, historyRel))) throw new Error(`could not find a free history file for the joined part (tried ${partHistory(baseStem)} and ${historyRel})`);
    put(path.join(root, historyRel), SM.logText(log));
    put(modelPath, SM.stringify(F) + '\n');
    man.parts = [{ name: baseStem, model: man.index, ...(historyRel !== partHistory(baseStem) ? { history: historyRel } : {}) }];
    delete man.index;
    write(path.join(root, MANIFEST), manifestText(man));
    written.push(path.join(root, MANIFEST));
    return { model: modelPath, files: written };
  }
  const stem = opts.stem || slug(F.project.name);
  const busy = taken(root, stem);
  if (busy.length) throw new Error(`${busy.join(', ')} already exist${busy.length > 1 ? '' : 's'} in ${root}; nothing was written`);
  const f = partFiles(root, stem);
  put(path.join(root, f.history), SM.logText(log));
  put(path.join(root, f.model), SM.stringify(F) + '\n');
  man.parts = [{ name: stem, model: f.model }];
  write(path.join(root, MANIFEST), manifestText(man));
  written.push(path.join(root, MANIFEST));
  return { model: path.join(root, f.model), files: written };
}

module.exports = { infoOf, readSample, MANIFEST, GOVERNANCE, GOVERNANCE_HISTORY, INDEX_STRATA, DIRS, TEMPLATES, readManifest, ensurePart, ensureLines, resolve, taken, create, slug,
  isArchived, readIndexFile, ARCHIVED_BLOCKED, domainsOf, validateDomains, setDomains, setDbt, setSql, write, readGovernance, updateGovernance, updateProjectSettings, buildIndex, split, join, assemble, applyProjectEdit, applyDomains,
  partHistoryTexts, projectGoto, assembledProjectModel, partsEmbedStatus };
