// Self-check for lib/project.js (the manifest, creating a project, the Git files), the `strata-sql init` command line and the New Project wizard
// (extension.js, driven through a stubbed vscode module). Run: node tests/project.check.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), Module = require('module');
const REPO = path.join(__dirname, '..'), SAMPLES = path.join(REPO, 'sample_data_models');
const SM = require('../media/model.js');
const P = require('../lib/project.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-proj-'));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const user = { name: 'Ada', email: 'ada@x.io', system: 'laptop' };
const MODEL = (stem) => `data_models/${stem}/${stem}.model.json`, HISTORY = (stem) => `history/${stem}.history.jsonl`, LAYOUT = (stem) => `data_models/${stem}/${stem}.model.layout.json`, DATA = (stem) => `data_models/${stem}/data`;
const tree = (dir) => { const out = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p).split(path.sep).join('/')); } })(dir); return out; };
const check = (dir, stem, name) => { // the files of a new project agree with each other
  const F = JSON.parse(read(dir, MODEL(stem))), log = SM.parseLog(read(dir, HISTORY(stem))).history;
  assert.strictEqual(F.project.name, name, 'the project is named as the user said');
  assert.ok(!('layout' in F) && !('version' in F), 'no layout and no version pointers in the model');
  assert.deepStrictEqual(SM.verify(log, SM.flatten(F)), [], stem + ': the model matches its history and the chain is intact');
  assert.strictEqual(SM.headsOf(log, 'modelling').length, 1);
  return { F, log };
};

// ---- create: blank and every template ----
const written = [], realRename = fs.renameSync;
fs.renameSync = (a, b) => { written.push(path.basename(b)); return realRename(a, b); };
for (const [tpl, opts] of [['blank', { platform: 'Snowflake', methodology: 'Data Vault' }], ['blank', {}], ['northwind', {}], ['fpml', {}], ['star', {}]]) {
  const dir = path.join(scratch, tpl + (opts.platform ? '-sf' : '')), name = 'My Sales ' + tpl;
  written.length = 0;
  const r = P.create({ dir, name, template: tpl, user, ...opts });
  const stem = P.slug(name);
  assert.strictEqual(stem, 'my-sales-' + tpl);
  assert.ok(written.indexOf(stem + '.history.jsonl') >= 0 && written.indexOf(stem + '.history.jsonl') < written.indexOf(stem + '.model.json'), tpl + ': the first history entry is written before the model');
  assert.strictEqual(r.model, path.join(dir, MODEL(stem)));
  const { F, log } = check(dir, stem, name);
  // northwind and fpml ship starter domains (release 2 part 3, ADR-0045 amended): a brand-new project from either template gets them written
  // straight into the fresh manifest; blank and star bring none, so their manifest stays exactly the tiny one release 1 always wrote.
  const tplDomains = P.TEMPLATES[tpl].domains;
  assert.deepStrictEqual(JSON.parse(read(dir, 'strata.project.json')), { strata: 'project/1', name, parts: [{ name: stem, model: MODEL(stem) }], ...(tplDomains ? { domains: tplDomains } : {}) }, tpl + ': a tiny manifest with one part of the foldered layout' + (tplDomains ? ', and the template\'s starter domains' : ''));
  if (tplDomains) {
    assert.deepStrictEqual(P.validateDomains({ domains: tplDomains }), [], tpl + ': its starter domains pass R16'); assert.ok(!fs.existsSync(path.join(dir, 'CODEOWNERS')), tpl + ': domains alone do not write CODEOWNERS, only a split does');
    const covered = new Set(tplDomains.flatMap((x) => x.concepts)), conceptNames = ((F.conceptual || {}).concepts || []).map((c) => c.name);
    assert.deepStrictEqual(conceptNames.filter((n) => !covered.has(n)), [], tpl + ': every one of its concepts is grouped into a starter domain');
    assert.deepStrictEqual([...covered].filter((n) => !conceptNames.includes(n)), [], tpl + ': no starter domain names a concept that does not exist');
  }
  assert.strictEqual(P.ensurePart(dir, r.model, name), null, 'and the model is already a part');
  assert.ok(read(dir, '.gitattributes').split('\n').includes('history/*.jsonl merge=union'), '.gitattributes: the history merges by union');
  const T = tree(dir), want = ['.gitattributes', '.gitignore', HISTORY(stem), MODEL(stem), 'strata.project.json', ...(tpl === 'blank' ? [] : [LAYOUT(stem)]), ...(fs.existsSync(path.join(SAMPLES, tpl + '_model_data')) ? fs.readdirSync(path.join(SAMPLES, tpl + '_model_data')).map((f) => DATA(stem) + '/' + f) : [])].sort();
  assert.deepStrictEqual(T, want, tpl + ': the exact tree');
  assert.deepStrictEqual(P.resolve(r.model).history, path.join(dir, HISTORY(stem)), 'and the resolver finds the log');
  assert.ok(read(dir, '.gitignore').split('\n').includes('.strata/'), '.gitignore: .strata/ stays personal');
  assert.ok(!fs.existsSync(path.join(dir, 'CODEOWNERS')), 'no CODEOWNERS yet: domains (if any) are not split');
  if (tpl === 'blank') {
    assert.strictEqual(F.project.technology, opts.platform || 'PostgreSQL'); assert.strictEqual(F.project.methodology, opts.methodology || 'ER - 3NF');
    assert.strictEqual(F.schemas.length, 1); assert.strictEqual(log.entries.length, 1, 'one entry: the project as created'); assert.strictEqual(log.entries[0].user, 'Ada');
    assert.strictEqual(F.project.naming, opts.platform ? 'catalog.schema.table' : 'schema.table'); assert.strictEqual(!!F.catalogs, !!opts.platform);
    assert.ok(!fs.existsSync(path.join(dir, LAYOUT(stem))), 'a blank model has no positions to write');
  } else {
    const src = SM.parseLog(read(SAMPLES, tpl + '.model.history.jsonl')).history;
    assert.strictEqual(log.entries.length, src.entries.length + 1, tpl + ': the template\'s versions plus one: the rename');
    assert.deepStrictEqual(log.entries.slice(0, src.entries.length).map((e) => e.chain), src.entries.map((e) => e.chain), 'the template\'s own versions are untouched');
    const last = log.entries.at(-1); assert.ok(last.stream === 'modelling' && last.user === 'Ada' && /template as "My Sales/.test(last.message), 'the rename is one version by the user: ' + last.message);
    assert.ok(fs.existsSync(path.join(dir, LAYOUT(stem))), 'positions are copied');
    const srcModel = JSON.parse(read(SAMPLES, tpl + '.model.json')); srcModel.project.name = name;
    assert.strictEqual(SM.stringify(F), SM.stringify(srcModel), 'the copy differs from the template only in the project name');
    assert.strictEqual(fs.existsSync(path.join(dir, DATA(stem))), fs.existsSync(path.join(SAMPLES, tpl + '_model_data')), 'sample data comes along (into data/) when the template has some');
    if (tpl === 'star') { assert.ok(F.tables.some((t) => t.name === 'fact_sales') && ['dim_customer', 'dim_product', 'dim_date', 'dim_store'].every((n) => F.tables.some((t) => t.name === n)), 'the star: fact_sales and four dimensions'); assert.ok(!fs.existsSync(path.join(dir, DATA(stem))), 'no sample data'); }
  }
}
fs.renameSync = realRename;
// a template can be created under its own name too: no rename, no extra version
const same = P.create({ dir: path.join(scratch, 'same'), name: 'Northwind Traders', template: 'northwind', user });
assert.ok(JSON.parse(read(SAMPLES, 'northwind.model.json')).project.name === 'Northwind Traders' ? SM.parseLog(read(scratch, 'same', HISTORY('northwind-traders'))).history.entries.length === SM.parseLog(read(SAMPLES, 'northwind.model.history.jsonl')).history.entries.length : true);
check(path.join(scratch, 'same'), 'northwind-traders', 'Northwind Traders');
// star: no open warnings, described levels
{
  const m = SM.fromFile(JSON.parse(read(SAMPLES, 'star.model.json')), 'physical'), SA = require('../media/align.js');
  assert.deepStrictEqual(SA.check(m).open.map((w) => w.key), [], 'the star has no open warnings');
  assert.ok(m.concepts.length === 5 && m.entities.length === 5 && m.tables.every((t) => t.description) && m.tables.filter((t) => t.columns.some((c) => c.foreignKey)).length === 1);
  assert.ok(m.tables.filter((t) => t.name.startsWith('dim_')).every((t) => t.columns[0].primaryKey && t.columns[0].name.endsWith('_key')), 'dimensions have surrogate keys');
  assert.strictEqual(m.tables.find((t) => t.name === 'fact_sales').columns.filter((c) => c.foreignKey).length, 4, 'the fact references all four');
  assert.ok(m.project.gov.conceptual.owner && m.project.gov.logical.owner && m.project.gov.physical.owner, 'owner defaults per level');
}

// ---- never overwrite ----
const dirN = path.join(scratch, 'northwind'), snap = () => tree(dirN).map((f) => f + ':' + read(dirN, f)).join('\n');
const before = snap();
assert.throws(() => P.create({ dir: dirN, name: 'My Sales northwind', template: 'northwind', user }), /already exist.*nothing was written/, 'same name: refused');
assert.strictEqual(snap(), before, 'nothing changed');
// a folder that already has a manifest takes the new model as one more part (nothing is replaced)
P.create({ dir: dirN, name: 'Another', template: 'blank', user });
assert.deepStrictEqual(P.readManifest(dirN).parts.map((p) => p.name), ['my-sales-northwind', 'another'], 'the manifest lists both'); check(dirN, 'another', 'Another'); check(dirN, 'my-sales-northwind', 'My Sales northwind');
assert.deepStrictEqual(P.readManifest(dirN).domains, P.TEMPLATES.northwind.domains, 'joining an existing manifest as a second part leaves its domains exactly as they were');
// starter domains only ever seed a BRAND NEW manifest: a template joining a folder that already has one (even one with no domains at all) never adds any
const joinDir = path.join(scratch, 'join-existing'); P.create({ dir: joinDir, name: 'First', template: 'blank', user });
assert.strictEqual(P.readManifest(joinDir).domains, undefined, 'a blank project starts with no domains');
P.create({ dir: joinDir, name: 'Northwind Two', template: 'northwind', user });
assert.strictEqual(P.readManifest(joinDir).domains, undefined, 'northwind joining an existing (domain-less) manifest as a second part does not retroactively add its starter domains');
const half = path.join(scratch, 'half'); fs.mkdirSync(path.join(half, 'data_models', 'x'), { recursive: true }); fs.writeFileSync(path.join(half, LAYOUT('x')), 'mine');
assert.throws(() => P.create({ dir: half, name: 'x', user }), /x\.model\.layout\.json already exists/); assert.strictEqual(read(half, LAYOUT('x')), 'mine'); assert.deepStrictEqual(tree(half), [LAYOUT('x')], 'and no partial write');
assert.deepStrictEqual(P.taken(half, 'x'), [LAYOUT('x')], 'the wizard asks the same question while the name is typed');
assert.throws(() => P.create({ dir: path.join(scratch, 'e1'), name: '   ' }), /needs a name/); assert.throws(() => P.create({ dir: path.join(scratch, 'e2'), name: '!!!' }), /letter or digit/);
assert.throws(() => P.create({ dir: path.join(scratch, 'e3'), name: 'x', template: 'nope' }), /unknown starting point/); assert.throws(() => P.create({ dir: path.join(scratch, 'e4'), name: 'x', platform: 'Access' }), /unknown platform/);
assert.throws(() => P.create({ dir: path.join(scratch, 'e5'), name: 'x', methodology: 'Guess' }), /unknown methodology/); assert.ok(!fs.existsSync(path.join(scratch, 'e5')), 'a refused project leaves no folder behind');

// ---- git files: appended to, never clobbered; the layout can stay personal ----
const gd = path.join(scratch, 'git'); fs.mkdirSync(gd);
fs.writeFileSync(path.join(gd, '.gitignore'), 'node_modules\ndist'); fs.writeFileSync(path.join(gd, '.gitattributes'), '* text=auto\nhistory/*.jsonl merge=union\n');
P.create({ dir: gd, name: 'g', user, ignoreLayout: true });
assert.strictEqual(read(gd, '.gitignore'), 'node_modules\ndist\n.strata/\n*.model.layout.json\n', 'existing lines kept, the missing ones appended');
assert.strictEqual(read(gd, '.gitattributes'), '* text=auto\nhistory/*.jsonl merge=union\n', 'a line that is already there is not repeated');
const nogit = path.join(scratch, 'nogit'); P.create({ dir: nogit, name: 'n', user, git: false }); assert.ok(!fs.existsSync(path.join(nogit, '.gitignore')) && !fs.existsSync(path.join(nogit, '.gitattributes')));
assert.strictEqual(P.ensureLines(path.join(gd, '.gitignore'), ['.strata/']), false, 'idempotent');

// ---- a bare model gets a manifest; several models share one; unknown keys of a manifest survive ----
const bare = path.join(scratch, 'bare'); fs.mkdirSync(bare); fs.writeFileSync(path.join(bare, 'a.model.json'), '{}\n'); fs.writeFileSync(path.join(bare, 'b.model.json'), '{}\n');
assert.strictEqual(P.ensurePart(bare, path.join(bare, 'a.model.json'), 'A'), 'created'); assert.deepStrictEqual(P.readManifest(bare), { strata: 'project/1', name: 'A', parts: [{ name: 'a', model: 'a.model.json' }] });
const m0 = P.readManifest(bare); m0.links = [{ name: 'core', path: '../core' }]; m0.exposes = ['dashboards']; fs.writeFileSync(path.join(bare, P.MANIFEST), JSON.stringify(m0));
assert.strictEqual(P.ensurePart(bare, path.join(bare, 'b.model.json'), 'B'), 'added'); const m1 = P.readManifest(bare);
assert.deepStrictEqual(m1.parts.map((p) => p.model), ['a.model.json', 'b.model.json']); assert.deepStrictEqual(m1.links, m0.links, 'keys it does not know (links, exposes, ...) are kept'); assert.deepStrictEqual(m1.exposes, ['dashboards']);
assert.strictEqual(P.ensurePart(bare, path.join(bare, 'b.model.json'), 'B'), null, 'idempotent');
fs.writeFileSync(path.join(bare, P.MANIFEST), '{ broken'); assert.strictEqual(P.ensurePart(bare, path.join(bare, 'a.model.json'), 'A'), null, 'a manifest that cannot be read is left alone'); assert.strictEqual(read(bare, P.MANIFEST), '{ broken');

// the .gitattributes the wizard writes really selects the log for the union merge (needs git, else skipped)
{
  const g = path.join(scratch, 'northwind'), init = cp.spawnSync('git', ['init', '-q'], { cwd: g }), ca = init.error ? init : cp.spawnSync('git', ['check-attr', 'merge', '--', HISTORY('my-sales-northwind'), MODEL('my-sales-northwind')], { cwd: g, encoding: 'utf8' });
  if (ca.error) console.log('  (git not available: check-attr skipped)');
  else { const lines = ca.stdout.trim().split('\n'); assert.ok(/merge: union$/.test(lines[0]) && /unspecified$/.test(lines[1]), 'git applies merge=union to history/*.jsonl and to nothing else: ' + ca.stdout + ca.stderr); }
}

// ---- the resolver: one place that says where the files of a model are ----
{
  const pr = path.join(scratch, 'resolve'), r0 = P.create({ dir: pr, name: 'Orders', user }), R0 = P.resolve(r0.model);
  assert.deepStrictEqual([R0.root, R0.manifest, R0.listed, R0.part], [pr, true, true, 'orders']);
  assert.deepStrictEqual([R0.history, R0.layout, R0.embeddings, R0.dataDir], [path.join(pr, HISTORY('orders')), path.join(pr, LAYOUT('orders')), path.join(pr, 'data_models/orders/orders.model.embeddings.json'), path.join(pr, DATA('orders'))]);
  // a second part is created beside it: each model resolves its own log
  const r1 = P.create({ dir: pr, name: 'Billing', user }); assert.strictEqual(P.resolve(r1.model).history, path.join(pr, HISTORY('billing'))); assert.strictEqual(P.resolve(r0.model).history, path.join(pr, HISTORY('orders')));
  // a model deep inside the project, not listed: another part of the same project, rooted at the manifest (not at its own folder)
  const deep = path.join(pr, 'data_models', 'orders', 'sub', 'deep'); fs.mkdirSync(deep, { recursive: true }); const dm = path.join(deep, 'orders.model.json'); fs.writeFileSync(dm, '{}\n');
  let R = P.resolve(dm);
  assert.deepStrictEqual([R.root, R.listed, R.part, R.history], [pr, false, 'orders-2', path.join(pr, HISTORY('orders-2'))], 'unlisted: a new part, the name made unique, the log in the project\'s history folder');
  assert.strictEqual(P.ensurePart(R.root, dm, 'Orders'), 'added'); assert.deepStrictEqual(P.readManifest(pr).parts.map((x) => [x.name, x.model]).at(-1), ['orders-2', 'data_models/orders/sub/deep/orders.model.json']);
  R = P.resolve(dm); assert.deepStrictEqual([R.listed, R.part, R.history], [true, 'orders-2', path.join(pr, HISTORY('orders-2'))], 'and once listed it resolves to the same log');
  assert.strictEqual(P.resolve(dm, { stop: deep }).root, deep, 'a workspace folder below the manifest hides it: an implicit project of its own');
  assert.strictEqual(P.resolve(dm, { stop: pr }).root, pr, 'a workspace folder at the manifest finds it');
  // the manifest can name another log for a part (unknown keys are kept)
  const man = P.readManifest(pr); man.parts[1].history = 'audit/billing.jsonl'; man.domains = ['x']; fs.writeFileSync(path.join(pr, P.MANIFEST), JSON.stringify(man));
  assert.strictEqual(P.resolve(r1.model).history, path.join(pr, 'audit', 'billing.jsonl'), 'parts[].history overrides the default');
  // an unreadable manifest still marks the project root, nothing is listed
  const bad = path.join(scratch, 'badman'); fs.mkdirSync(path.join(bad, 'm'), { recursive: true }); fs.writeFileSync(path.join(bad, P.MANIFEST), '{ nope'); fs.writeFileSync(path.join(bad, 'm', 'q.model.json'), '{}');
  R = P.resolve(path.join(bad, 'm', 'q.model.json')); assert.deepStrictEqual([R.root, R.manifest, R.listed], [bad, true, false]);
  // no manifest: an implicit one-part project rooted in the model's folder; older places are read, the standard place is written
  const ol = path.join(scratch, 'older'); fs.mkdirSync(ol); fs.writeFileSync(path.join(ol, 'legacy.model.json'), '{}');
  R = P.resolve(path.join(ol, 'legacy.model.json'));
  assert.deepStrictEqual([R.root, R.manifest, R.part, R.history], [ol, false, 'legacy', path.join(ol, 'history', 'legacy.history.jsonl')]);
  assert.deepStrictEqual(R.historyOld, [path.join(ol, 'legacy.model.history.jsonl'), path.join(ol, 'legacy.model.version.json')], 'older logs beside the model: read only');
  assert.strictEqual(R.dataDir, path.join(ol, 'data')); assert.deepStrictEqual(R.dataOld, [path.join(ol, 'legacy_model_data'), path.join(ol, 'model_data')]);
  fs.mkdirSync(path.join(ol, 'legacy_model_data')); R = P.resolve(path.join(ol, 'legacy.model.json'));
  assert.deepStrictEqual([R.dataDir, R.dataOld], [path.join(ol, 'legacy_model_data'), [path.join(ol, 'model_data')]], 'an older <name>_model_data/ is kept in use (renames and new files go there)');
  fs.mkdirSync(path.join(ol, 'data')); assert.strictEqual(P.resolve(path.join(ol, 'legacy.model.json')).dataDir, path.join(ol, 'data'), 'data/ wins once it exists');
}

// ---- splitting a project into domains (release 2 part 2, ADR-0045 points 4-6): governance.json, `strata-sql split`, the cross-part index ----
{
  const SA = require('../media/align.js'), G = require('../media/gov.js');
  const dir = path.join(scratch, 'domains'), r0 = P.create({ dir, name: 'Shop', user });
  // a small model by hand: Sales (Customer, Order), Misc (no domain: _unassigned), a metric reading both (_shared), a cross-domain M..M via a
  // bridge table that itself has no domain (a pure bridge: media/align.js#mappable), and one pre-existing broken reference (kept as ADR-0042
  // says, and expected to round-trip through the split too).
  const F = {
    strata: 2, project: { name: 'Shop', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table' },
    governance: { tags: [{ name: 'pii', enabled: true }], policies: [{ name: 'GDPR', type: 'privacy' }] },
    conceptual: { concepts: [{ name: 'Customer' }, { name: 'Order' }, { name: 'Misc' }], relationships: [{ parent: 'Customer', child: 'Order', cardinality: '1..M' }, { parent: 'Order', child: 'Misc', cardinality: '1..M' }, { parent: 'Order', child: 'Gone', cardinality: '1..M' }] },
    logical: { entities: [{ name: 'Customer', concept: 'Customer' }, { name: 'Order', concept: 'Order' }, { name: 'Misc', concept: 'Misc' }], relationships: [{ parent: 'Customer', child: 'Order', cardinality: '1..M' }, { parent: 'Order', child: 'Misc', cardinality: '1..M' }] },
    schemas: [{ name: 'public' }],
    tables: [
      { name: 'customers', schema: 'public', entity: 'Customer', governance: { owner: 'Ada' }, columns: [{ name: 'id', type: 'INTEGER', pk: true, tags: ['pii'] }, { name: 'name', type: 'TEXT' }] },
      { name: 'orders', schema: 'public', entity: 'Order', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'customer_id', type: 'INTEGER' }, { name: 'total', type: 'NUMERIC' }] },
      { name: 'order_tags', schema: 'public', columns: [{ name: 'order_id', type: 'INTEGER', pk: true }, { name: 'misc_id', type: 'INTEGER', pk: true }] }, // pure bridge: no entity of its own
      { name: 'misc_stuff', schema: 'public', entity: 'Misc', columns: [{ name: 'id', type: 'INTEGER', pk: true }] },
    ],
    relationships: [
      { parent: 'public.customers.id', child: 'public.orders.customer_id', cardinality: '1..M' },
      { parent: 'public.orders.id', child: 'public.order_tags.order_id', cardinality: '1..M' },
      { parent: 'public.misc_stuff.id', child: 'public.order_tags.misc_id', cardinality: '1..M' },
      { parent: 'public.orders', child: 'public.misc_stuff', cardinality: 'M..M', via: 'public.order_tags' },
    ],
    semantic: { metrics: [{ name: 'Revenue', calculation: 'SUM(public.orders.total)', aggregation: 'sum' }, { name: 'Spanning', calculation: 'SUM(public.orders.total) + SUM(public.misc_stuff.id)', aggregation: 'sum' }] },
    alignment: { acknowledged: ['gov-owner:concept:Misc'] },
  };
  fs.writeFileSync(r0.model, SM.stringify(F) + '\n');
  const preM = SM.fromFile(F), preLog = SM.newHistory(), preFlat = SM.flatten(SM.toFile(preM));
  for (const s of SM.STREAMS) SM.commit(preLog, s, null, preFlat[s], { user: 'Ada', message: 'setup' });
  fs.writeFileSync(P.resolve(r0.model).history, SM.logText(preLog));
  assert.deepStrictEqual(SA.check(preM).all.filter((w) => w.kind === 'broken-ref').map((w) => w.key), ['broken-ref:conceptual:Order>Gone'], 'one pre-existing broken reference, unrelated to the split');

  // no domains yet: split refuses, resolve() gives no governance.json, nothing touched
  assert.throws(() => P.split(r0.model, { user }), /no domains are defined/);
  assert.strictEqual(P.resolve(r0.model).governanceFile, null, 'one part: no governance.json path even to consider');
  assert.strictEqual(P.resolve(r0.model).governanceHistory, null);

  const man = P.readManifest(dir);
  man.domains = [{ name: 'Sales', owner: 'Head of Sales', concepts: ['Customer', 'Order'] }];
  fs.writeFileSync(path.join(dir, P.MANIFEST), JSON.stringify(man));
  fs.writeFileSync(P.resolve(r0.model).layout, '{"strata":"layout/1","positions":{}}\n'); // an existing layout file: proves it is renamed to pair with the archived model
  const before = tree(dir); // the original files, to prove they are left exactly as they were
  const beforeText = new Map(before.map((f) => [f, read(dir, f)]));
  // shop.model.json and its layout are archived (release 2 part 5): a thin project-index file takes over the model's path, so those two are
  // checked separately below, not byte-for-byte-unchanged like everything else
  const untouched = before.filter((f) => f !== 'strata.project.json' && f !== '.gitattributes' && f !== MODEL('shop') && f !== LAYOUT('shop'));

  const preSplitModelText = beforeText.get(MODEL('shop')), preSplitLayoutText = beforeText.get(LAYOUT('shop'));
  const res = P.split(r0.model, { user });
  assert.deepStrictEqual(res.parts.map((p) => p.name).sort(), ['_shared', '_unassigned', 'sales'], 'one part per domain, plus _shared (the spanning metric) and _unassigned (Misc, and the bridge table)');
  assert.deepStrictEqual(res.warnings, [], 'no ambiguous table or metric here');
  // write order: governance.history.jsonl before governance.json, and every part's history before its model (log-before-model, like the save handshake)
  const idxOf = (n) => res.files.findIndex((f) => f.endsWith(n));
  assert.ok(idxOf('governance.history.jsonl') < idxOf('governance.json'), 'governance history before governance.json');
  for (const p of res.parts) assert.ok(idxOf(`history/${p.name}.history.jsonl`) < idxOf(p.model), `${p.name}: history before its model`);
  assert.ok(idxOf('strata.project.json') > idxOf(res.parts[0].model), 'the manifest is written last, once every part exists');

  const T = tree(dir);
  // release 2 part 6 (ADR-0045 amended a sixth time): every domain part nests one level deeper, under the project's OWN folder
  // (data_models/shop/<part>/...), instead of sitting as a flat sibling of it — only history/ stays flat at the project root.
  assert.deepStrictEqual(T, [...before.filter((f) => f !== LAYOUT('shop')), 'CODEOWNERS', 'data_models/shop/_shared/_shared.model.json', 'data_models/shop/_unassigned/_unassigned.model.json', 'data_models/shop/sales/sales.model.json',
    'data_models/shop/shop.archived.model.json', 'data_models/shop/shop.archived.model.layout.json',
    'governance.history.jsonl', 'governance.json', 'history/_shared.history.jsonl', 'history/_unassigned.history.jsonl', 'history/sales.history.jsonl'].sort(),
    'the exact resulting tree: the original part archived in place (model + layout renamed away), the new parts nested under data_models/shop/, plus the new files (the vacated shop.model.json is still there too: a fresh project-index file, not deleted)');
  for (const f of untouched) assert.strictEqual(read(dir, f), beforeText.get(f), `the original ${f} is left exactly as it was`);
  assert.strictEqual(read(dir, '.gitattributes'), beforeText.get('.gitattributes') + `${P.GOVERNANCE_HISTORY} merge=union\n`, 'governance.history.jsonl gets its own merge=union line: it is not under history/');

  // release 2 part 5 (ADR-0045 point 10): the pre-split file, archived in place — byte-for-byte the same content, just renamed (and its
  // layout renamed to match, paired in the Explorer); its history log (history/shop.history.jsonl) keeps its old name, untouched, still in
  // `untouched` above since it was never reachable through the manifest either way
  assert.strictEqual(read(dir, 'data_models/shop/shop.archived.model.json'), preSplitModelText, 'archived: byte-for-byte the pre-split model');
  assert.strictEqual(read(dir, 'data_models/shop/shop.archived.model.layout.json'), preSplitLayoutText, 'archived: its layout, renamed to match');
  assert.ok(fs.existsSync(path.join(dir, HISTORY('shop'))), 'its own history log is still there, at its old, unrenamed path');

  // ... and a thin, regenerable project-index file takes its exact old place
  const idxFile = P.readIndexFile(path.join(dir, MODEL('shop')));
  assert.ok(idxFile, 'readIndexFile recognises it');
  assert.strictEqual(idxFile.strata, P.INDEX_STRATA); assert.strictEqual(idxFile.name, 'Shop');
  assert.deepStrictEqual([...idxFile.parts].sort(), ['_shared', '_unassigned', 'sales'], 'names every resulting part');
  assert.strictEqual(P.readIndexFile(path.join(dir, 'data_models/shop/sales/sales.model.json')), null, 'an ordinary part is not mistaken for one');

  // the manifest no longer double-lists the split-away part, and now names the index file
  const man2 = P.readManifest(dir);
  assert.deepStrictEqual(man2.parts.map((p) => p.name).sort(), ['_shared', '_unassigned', 'sales']);
  assert.ok(!man2.parts.some((p) => p.model === path.relative(dir, r0.model).split(path.sep).join('/')), 'the old single part is gone from parts[]');
  assert.strictEqual(man2.index, MODEL('shop'));
  assert.deepStrictEqual(man2.domains, man.domains, 'domains are unchanged');

  // never silently re-added as a live part: ensurePart refuses the archived file outright, and resolve() never lists it either
  assert.strictEqual(P.ensurePart(dir, path.join(dir, 'data_models/shop/shop.archived.model.json'), 'Shop'), null, 'ensurePart refuses an archived file');
  assert.deepStrictEqual(P.readManifest(dir).parts, man2.parts, 'nothing was added');
  const archResolved = P.resolve(path.join(dir, 'data_models/shop/shop.archived.model.json'));
  assert.strictEqual(archResolved.archived, true); assert.strictEqual(archResolved.listed, false);
  assert.strictEqual(archResolved.history, path.join(dir, HISTORY('shop')), 'resolves to its own, unrenamed history log');
  assert.strictEqual(archResolved.layout, path.join(dir, 'data_models/shop/shop.archived.model.layout.json'), 'and its renamed layout');

  // governance.json: the tag and policy moved out, with a fresh history whose first entry is the split
  const gov = JSON.parse(read(dir, 'governance.json'));
  assert.deepStrictEqual(gov, { strata: 'governance/1', tags: [{ name: 'pii', enabled: true }], policies: [{ name: 'GDPR', type: 'privacy' }] }, 'the file-level governance definitions, moved verbatim');
  const govLog = SM.parseLog(read(dir, 'governance.history.jsonl')).history;
  assert.strictEqual(govLog.entries.length, 1); assert.strictEqual(govLog.entries[0].stream, 'governance'); assert.ok(/Split from shop/.test(govLog.entries[0].message));
  const { strata: _s, ...govBody } = gov;
  assert.deepStrictEqual(SM.verify(govLog, SM.flatten({ governance: govBody })), [], 'governance.json matches its own log');

  // routing: sales has Customer/Order, _unassigned has Misc and the pure bridge table, _shared has the spanning metric; none carry `governance`
  const salesF = JSON.parse(read(dir, 'data_models/shop/sales/sales.model.json'));
  assert.deepStrictEqual(salesF.conceptual.concepts.map((c) => c.name).sort(), ['Customer', 'Order']);
  assert.strictEqual(salesF.tables.find((t) => t.name === 'customers').governance.owner, 'Ada', 'a table\'s own governance value travels with it');
  assert.ok(!('governance' in salesF), 'no governance SECTION in a split part: it moved to governance.json');
  const unF = JSON.parse(read(dir, 'data_models/shop/_unassigned/_unassigned.model.json'));
  assert.deepStrictEqual(unF.conceptual.concepts.map((c) => c.name), ['Misc']);
  assert.ok(unF.tables.some((t) => t.name === 'order_tags'), 'the pure bridge table (no entity of its own) is _unassigned, not dropped');
  assert.ok(unF.relationships.some((r) => r.parent === 'public.orders' && r.child === 'public.misc_stuff' && r.via === 'public.order_tags'), 'the M..M via the bridge table: kept, via named, even though the bridge is a different part than sales');
  assert.ok(salesF.conceptual.relationships.some((r) => r.parent === 'Order' && r.child === 'Gone'), 'the pre-existing broken reference is preserved: routed with "Order", the end that does still exist');
  const sharedF = JSON.parse(read(dir, 'data_models/shop/_shared/_shared.model.json'));
  assert.deepStrictEqual(sharedF.semantic.metrics.map((x) => x.name), ['Spanning'], 'a metric reading tables in two parts has no single home: _shared');
  assert.deepStrictEqual([...(salesF.tables || []), ...(unF.tables || []), ...(sharedF.tables || [])].length, F.tables.length, 'every table lands somewhere, once');

  // fresh per-part history: one snapshot per non-empty stream, message names the split
  const salesLog = SM.parseLog(read(dir, 'history/sales.history.jsonl')).history;
  assert.strictEqual(SM.headsOf(salesLog, 'modelling').length, 1); assert.ok(/Split from shop into 1 domain/.test(salesLog.entries[0].message));
  assert.deepStrictEqual(SM.verify(salesLog, SM.flatten(salesF)), [], 'sales matches its own fresh log');

  // CODEOWNERS: one line per domain that has an owner
  assert.strictEqual(read(dir, 'CODEOWNERS'), '/data_models/shop/sales/ @Head of Sales\n');

  // never overwrite: splitting again (parts.length > 1 now) is refused outright
  assert.throws(() => P.split(r0.model, { user }), /already has more than one part/);

  // losslessness: reassembling every part + governance.json reproduces the pre-split model exactly (layout is not versioned, so left out)
  const reassembled = P.assemble(dir, man2);
  const preFlat2 = SM.flatten(F), reFlat = SM.flatten(reassembled);
  for (const s of SM.STREAMS) assert.strictEqual(SM.stateHash(reFlat[s]), SM.stateHash(preFlat2[s]), `${s}: reassembling the parts reproduces the pre-split model`);


  // cross-part reference resolution: opening one part alone, the relationships / metric naming another part's object are not `broken-ref` /
  // `metric-ref`, and the canvas only ever draws this part's own tables (SA.view / nodesOf only ever look at m.tables / m.concepts / m.entities,
  // which are this part's own — the whole-project index adds names to check against, it never adds objects to draw)
  const idx = P.buildIndex(dir, man2);
  // excluded from the cross-part project index too: its tables/concepts (a full duplicate of "sales", by design) never appear, so opening
  // it never manufactures a spurious cross-part-dup warning against the real sales part
  assert.deepStrictEqual(idx.duplicates, [], 'no duplicates: the archived file is not scanned at all');
  assert.strictEqual(idx.owner.concepts.customer, 'sales', 'Customer is owned by sales alone, not "shop"');
  const salesM = SM.fromFile(salesF); salesM.crossPart = idx;
  assert.deepStrictEqual(SA.check(salesM).all.filter((w) => w.kind === 'broken-ref').map((w) => w.key), ['broken-ref:conceptual:Order>Gone'], 'sales: the ONE genuinely broken reference still warns ("Gone" resolves nowhere)');
  const unM = SM.fromFile(unF); unM.crossPart = idx;
  assert.deepStrictEqual(SA.check(unM).all.filter((w) => w.kind === 'broken-ref'), [], '_unassigned: the M..M to orders (in the sales part) is not broken');
  assert.strictEqual(SA.view(unM, 'physical'), null); assert.strictEqual(nodesOfCount(unM, 'physical'), 2, '_unassigned draws only its own two tables, never sales\' or _shared\'s');
  const sharedM = SM.fromFile(sharedF); sharedM.crossPart = idx;
  assert.deepStrictEqual(G.check(sharedM).filter((w) => w.kind === 'metric-ref'), [], 'Spanning reads columns in two other parts: not metric-ref');

  // cross-part stub labelling (release 2 part 4, ADR-0045 extended): the index names which part (and domain) owns a name, so the canvas can
  // label a stub instead of drawing every unresolved reference the same red "broken" way
  assert.strictEqual(idx.owner.tables['public.orders'], 'sales'); assert.strictEqual(idx.owner.tables['public.misc_stuff'], '_unassigned');
  assert.strictEqual(idx.owner.concepts['order'], 'sales'); assert.strictEqual(idx.domainOfPart.sales, 'Sales');
  assert.deepStrictEqual(SA.crossTarget(unM, 'relationships', 'public.orders'), { label: 'orders', part: 'sales', domain: 'Sales' }, 'the bridge M..M into orders (a different part) names its table, part and domain');
  assert.deepStrictEqual(SA.crossTarget(salesM, 'conceptual', 'Gone'), { label: 'Gone', part: null, domain: null }, 'a name that resolves nowhere: no part, no domain, but never null itself');

  // project-wide uniqueness (R11): a metric name duplicated across two parts is caught, an entity name duplicated across two parts is caught
  const dupIdx = { ...idx, duplicates: [{ kind: 'metric', name: 'revenue', parts: ['sales', '_shared'] }, { kind: 'entity', name: 'order', parts: ['sales', '_unassigned'] }] };
  const salesDup = SM.fromFile(salesF); salesDup.crossPart = dupIdx;
  const dw = G.check(salesDup).filter((w) => w.kind === 'cross-part-dup');
  assert.deepStrictEqual(dw.map((w) => w.key).sort(), ['cross-part-dup:entity:order', 'cross-part-dup:metric:revenue']);

  // release 2 part 9 (ADR-0045 amended): Project settings edited from the project-index file write the SAME project block into EVERY part's
  // own model, each its own real, versioned edit (log before model, like the ordinary save handshake) — not one shared edit.
  const histBeforeUp = Object.fromEntries(man2.parts.map((p) => [p.name, read(dir, `history/${p.name}.history.jsonl`)]));
  const newProj = { ...F.project, description: 'Updated via the project-index file' };
  const upRes = P.updateProjectSettings(dir, man2, newProj, { user });
  assert.deepStrictEqual(upRes.parts.sort(), man2.parts.map((p) => p.name).sort());
  for (const p of man2.parts) {
    const pf = JSON.parse(read(dir, p.model));
    assert.strictEqual(pf.project.description, 'Updated via the project-index file', p.name + ': got the new project block');
    assert.notStrictEqual(read(dir, `history/${p.name}.history.jsonl`), histBeforeUp[p.name], p.name + ': a new history entry was appended');
  }
  // every part agrees again: assemble()'s own "parts disagree about the project" check still holds after a real multi-file write
  assert.doesNotThrow(() => P.assemble(dir, man2), 'assemble() still agrees: every part has the identical project block');
  P.updateProjectSettings(dir, man2, F.project, { user }); // restore: later assertions below compare the split parts against the pre-split F

  // Creating or editing a tag or policy from the project-index file routes to governance.json (its own versioned entry) — never into any
  // part's own (still-empty) file, and it is then visible from any part's own editor too (m.sharedGovernance already merges it in).
  const govHistBeforeUp = read(dir, 'governance.history.jsonl');
  P.updateGovernance(dir, { tags: [...gov.tags, { name: 'new_tag', displayName: 'New Tag', enabled: true }], propertyKeys: [], policies: gov.policies }, { user });
  const govAfterUp = JSON.parse(read(dir, 'governance.json'));
  assert.deepStrictEqual(govAfterUp.tags.map((t) => t.name).sort(), ['new_tag', 'pii']);
  assert.notStrictEqual(read(dir, 'governance.history.jsonl'), govHistBeforeUp, 'a new governance-stream entry');
  for (const p of man2.parts) assert.ok(!('governance' in JSON.parse(read(dir, p.model))), p.name + ': still no governance section of its own');
  P.updateGovernance(dir, gov, { user }); // restore: the "losslessness" reassembly check above and the join check below compare against pre-split F

  // no domains, never split: completely untouched by any of this (byte for byte release 1)
  const plain = P.create({ dir: path.join(scratch, 'plain'), name: 'Plain', user });
  assert.strictEqual(P.resolve(plain.model).governanceFile, null);
  assert.throws(() => P.split(plain.model, { user }), /no domains are defined/);
  assert.deepStrictEqual(P.buildIndex(path.join(scratch, 'plain'), P.readManifest(path.join(scratch, 'plain'))),
    { tables: [], columns: [], entities: [], concepts: [], metrics: [], duplicates: [], owner: { tables: {}, entities: {}, concepts: {}, metrics: {} }, domainOfPart: {}, partModel: { plain: 'data_models/plain/plain.model.json' } });
  // a one-part project has nowhere else to route "every part" to, and no governance.json to route a tag/policy into
  assert.throws(() => P.updateProjectSettings(path.join(scratch, 'plain'), P.readManifest(path.join(scratch, 'plain')), newProj, { user }), /more than one part/);
  assert.throws(() => P.updateGovernance(path.join(scratch, 'plain'), { tags: [], propertyKeys: [], policies: [] }, { user }), /no governance\.json found/);

  // join: the reverse, falls out of assemble() cheaply. Release 2 part 5: this project has a project-index file (man2.index), so join
  // reoccupies its exact path with a fresh, full model, discarding its "project-index/1" marker — the archived file is left exactly as it
  // is (a second, now doubly-historical copy), and since its own pre-split history log already sits at the name the joined part would
  // otherwise want (history/shop.history.jsonl), join gives the joined part a different, free history file instead of overwriting it.
  const preJoinArchived = read(dir, 'data_models/shop/shop.archived.model.json'), preJoinArchivedHistory = read(dir, HISTORY('shop'));
  const joined = P.join(dir, { user });
  assert.strictEqual(joined.model, path.join(dir, MODEL('shop')), 'reoccupies the exact path the index file used to have');
  const joinedF = JSON.parse(read(joined.model));
  const joinedFlat = SM.flatten(joinedF);
  for (const s of SM.STREAMS) assert.strictEqual(SM.stateHash(joinedFlat[s]), SM.stateHash(preFlat2[s]), `join: ${s} matches the pre-split model too`);
  const man3 = P.readManifest(dir);
  assert.strictEqual(man3.parts.length, 1, 'join collapses the manifest back to one part');
  assert.ok(!('index' in man3), 'no longer an index file: this is a real part again');
  assert.strictEqual(man3.parts[0].history, HISTORY('shop-joined'), 'a fresh history file: history/shop.history.jsonl already belongs to the archived file');
  assert.strictEqual(read(dir, 'data_models/shop/shop.archived.model.json'), preJoinArchived, 'the archived file: still untouched by Join');
  assert.strictEqual(read(dir, HISTORY('shop')), preJoinArchivedHistory, 'and its own history log: not overwritten by the joined part\'s fresh one');
  assert.strictEqual(P.readIndexFile(joined.model), null, 'not an index file any more');
  assert.ok(fs.existsSync(path.join(dir, 'data_models/shop/sales/sales.model.json')), 'the split parts are left on disk, exactly as split leaves the original single part');

  // join, ad hoc (never split): exactly the release-1 behaviour, unaffected — no man.index to react to, `opts.stem` still chooses the
  // name. assemble() needs every part to share the exact same `project` block, so the second "part" is a hand-copied file with it, like
  // the ad hoc Project View fixture above (two independent P.create() calls would each keep their own project name and never assemble).
  const adHocJoinDir = path.join(scratch, 'adhoc-join'), b1 = P.create({ dir: adHocJoinDir, name: 'Orders', user });
  const bdir2 = path.join(adHocJoinDir, 'data_models', 'more'); fs.mkdirSync(bdir2, { recursive: true });
  const bmodel2 = path.join(bdir2, 'more.model.json'); fs.writeFileSync(bmodel2, read(b1.model));
  P.ensurePart(adHocJoinDir, bmodel2, 'Orders');
  assert.ok(!('index' in P.readManifest(adHocJoinDir)));
  const adJoined = P.join(adHocJoinDir, { user, stem: 'orders-joined' }); // "orders" is a real, current part (not archived): still taken
  assert.strictEqual(adJoined.model, path.join(adHocJoinDir, MODEL('orders-joined')));
  assert.strictEqual(P.readManifest(adHocJoinDir).parts.length, 1);
  assert.ok(fs.existsSync(path.join(adHocJoinDir, MODEL('orders'))), 'the ad hoc parts stay on disk, same as ever');
}

// ---- editing directly from the project-index file (release 2 part 10, ADR-0045 amended): applyProjectEdit ----
{
  const SA = require('../media/align.js');
  const dir = path.join(scratch, 'edit-index'), r0 = P.create({ dir, name: 'Shop2', user });
  const F = {
    strata: 2, project: { name: 'Shop2', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table' },
    conceptual: { concepts: [{ name: 'Customer' }, { name: 'Order' }, { name: 'Product' }] },
    logical: { entities: [{ name: 'Customer', concept: 'Customer' }, { name: 'Order', concept: 'Order' }, { name: 'Product', concept: 'Product' }] },
    schemas: [{ name: 'public' }],
    tables: [
      { name: 'customers', schema: 'public', entity: 'Customer', columns: [{ name: 'id', type: 'INTEGER', pk: true }] },
      { name: 'orders', schema: 'public', entity: 'Order', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'customer_id', type: 'INTEGER' }, { name: 'product_id', type: 'INTEGER' }, { name: 'total', type: 'NUMERIC' }] },
      { name: 'products', schema: 'public', entity: 'Product', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'name', type: 'TEXT' }] },
    ],
    relationships: [
      { parent: 'public.customers.id', child: 'public.orders.customer_id', cardinality: '1..M' },
      { parent: 'public.products.id', child: 'public.orders.product_id', cardinality: '1..M' }, // cross-domain physical FK once split: orders (Sales) -> products (Catalog)
    ],
    semantic: { metrics: [{ name: 'Revenue', calculation: 'SUM(public.orders.total)', aggregation: 'sum' }] },
  };
  fs.writeFileSync(r0.model, SM.stringify(F) + '\n');
  const log0 = SM.newHistory(), flat0 = SM.flatten(F);
  for (const s of SM.STREAMS) SM.commit(log0, s, null, flat0[s], { user: 'Ada', message: 'setup' });
  fs.writeFileSync(P.resolve(r0.model).history, SM.logText(log0));
  const man = P.readManifest(dir);
  man.domains = [{ name: 'Sales', owner: 'Head of Sales', concepts: ['Customer', 'Order'] }, { name: 'Catalog', owner: 'Head of Merch', concepts: ['Product'] }];
  fs.writeFileSync(path.join(dir, P.MANIFEST), JSON.stringify(man));
  P.split(r0.model, { user });
  const man2 = P.readManifest(dir);
  assert.deepStrictEqual(man2.parts.map((p) => p.name).sort(), ['catalog', 'sales'], 'a clean split: nothing ambiguous, no _shared/_unassigned part exists yet');
  const salesModel = 'data_models/shop2/sales/sales.model.json', catalogModel = 'data_models/shop2/catalog/catalog.model.json';
  const assembled = () => P.assemble(dir, P.readManifest(dir));

  // the cross-domain FK survives the split as a cross-part reference (a dangling stub in orders' OWN part, sales - the child column's table),
  // resolved via crossPart, not reported broken-ref — the starting point every edit below is checked against
  const idx0 = P.buildIndex(dir, man2);
  const salesM0 = SM.fromFile(JSON.parse(read(dir, salesModel))); salesM0.crossPart = idx0;
  assert.deepStrictEqual(SA.check(salesM0).all.filter((w) => w.kind === 'broken-ref'), [], 'orders.product_id -> products.id: not broken-ref (resolves in catalog)');
  assert.ok(JSON.parse(read(dir, salesModel)).relationships.some((r) => r.parent === 'public.products.id' && r.child === 'public.orders.product_id'), 'the cross-part FK is written into sales (the child column\'s own part), as a plain dangling entry');

  // 1. edit an existing table's column in a known domain (Sales): a new column on `orders` lands in sales' own file, with a new history entry
  const F1 = assembled();
  F1.tables.find((t) => t.name === 'orders').columns.push({ name: 'note', type: 'TEXT' });
  const salesHistBefore = read(dir, 'history/sales.history.jsonl'), catalogHistBefore = read(dir, 'history/catalog.history.jsonl');
  const r1 = P.applyProjectEdit(dir, P.readManifest(dir), F1, { user, message: 'Add orders.note' });
  assert.deepStrictEqual(r1.parts.sort(), ['catalog', 'sales'], 'every EXISTING part is visited (a no-op commit for the ones that did not change)');
  assert.notStrictEqual(read(dir, 'history/sales.history.jsonl'), salesHistBefore, 'sales: a real new version');
  assert.strictEqual(read(dir, 'history/catalog.history.jsonl'), catalogHistBefore, 'catalog: untouched — a no-op commit writes nothing at all');
  assert.ok(JSON.parse(read(dir, salesModel)).tables.find((t) => t.name === 'orders').columns.some((c) => c.name === 'note'));

  // 2. add a new table WITH an explicit domain (Catalog), via t.homeDomain on the raw file object — the SAME override split() already reads,
  // exactly what media/canvas.js's domainField() writes into a new table's ext.homeDomain
  const F2 = assembled();
  F2.tables.push({ name: 'suppliers', schema: 'public', homeDomain: 'Catalog', columns: [{ name: 'id', type: 'INTEGER', pk: true }] });
  P.applyProjectEdit(dir, P.readManifest(dir), F2, { user, message: 'Add suppliers' });
  assert.ok(JSON.parse(read(dir, catalogModel)).tables.some((t) => t.name === 'suppliers'), 'routed to Catalog, exactly as picked');
  assert.ok(!JSON.parse(read(dir, salesModel)).tables.some((t) => t.name === 'suppliers'), 'not sales');

  // 3. add a new table with NO domain picked and no entity link at all: ambiguous, so it would fall back to _unassigned exactly as split()
  // does — but no _unassigned part exists yet on this project, so the WHOLE edit is refused, writing nothing, rather than inventing one
  const F3 = assembled();
  F3.tables.push({ name: 'misc', schema: 'public', columns: [{ name: 'id', type: 'INTEGER', pk: true }] });
  const salesBefore3 = read(dir, salesModel), catalogBefore3 = read(dir, catalogModel);
  assert.throws(() => P.applyProjectEdit(dir, P.readManifest(dir), F3, { user }), /no part exists yet for: _unassigned/, 'a genuinely new part is never invented by an ordinary edit (Split, or the Domains tab, does that)');
  assert.strictEqual(read(dir, salesModel), salesBefore3, 'nothing at all was written: never a silent partial drop');
  assert.strictEqual(read(dir, catalogModel), catalogBefore3);

  // 4. rename a table in Catalog (products -> items) that Sales' own orders.product_id FK points to: Sales' own file is rewritten TOO — its
  // dangling stub now names the CURRENT name — with its own new history entry, entirely for free (every part is rebuilt fresh from the
  // CURRENT assembled state on every edit, the same machinery split() itself already proves)
  const F4 = assembled();
  F4.tables.find((t) => t.name === 'products').name = 'items';
  for (const r of F4.relationships || []) if (r.parent === 'public.products.id') r.parent = 'public.items.id';
  const salesHistBefore4 = read(dir, 'history/sales.history.jsonl');
  const r4 = P.applyProjectEdit(dir, P.readManifest(dir), F4, { user, message: 'Rename products to items' });
  assert.deepStrictEqual(r4.parts.sort(), ['catalog', 'sales'], 'both parts change: catalog (the rename itself), sales (its dangling FK now names items)');
  assert.notStrictEqual(read(dir, 'history/sales.history.jsonl'), salesHistBefore4, 'sales gets its OWN new version even though none of its own tables changed');
  assert.ok(JSON.parse(read(dir, salesModel)).relationships.some((r) => r.parent === 'public.items.id' && r.child === 'public.orders.product_id'), 'sales\' own dangling FK now names items, not products');
  assert.ok(!JSON.parse(read(dir, salesModel)).relationships.some((r) => r.parent === 'public.products.id'), 'the old name is gone, not just added alongside');

  // 5. add a relationship between two tables in DIFFERENT domains (customers, Sales <-> items, Catalog): table-level, M..M — owned by the
  // CHILD's part (the same precedent split()'s own subsetModel already sets for a physical relation), written as a dangling stub there
  const F5 = assembled();
  F5.relationships.push({ parent: 'public.customers', child: 'public.items', cardinality: 'M..M' });
  P.applyProjectEdit(dir, P.readManifest(dir), F5, { user, message: 'Add customers-items relationship' });
  const catalogF5 = JSON.parse(read(dir, catalogModel));
  assert.ok(catalogF5.relationships.some((r) => r.parent === 'public.customers' && r.child === 'public.items'), 'in catalog (items\' own part, the child), as a dangling stub — customers is not local to catalog');
  const catalogM5 = SM.fromFile(catalogF5); catalogM5.crossPart = P.buildIndex(dir, man2);
  assert.deepStrictEqual(require('../media/align.js').check(catalogM5).all.filter((w) => w.kind === 'broken-ref' && /customers/.test(w.key)), [], 'resolves via crossPart: not broken-ref');

  // 6. add a relationship between two tables in the SAME domain (orders, order notes — both Sales): the ordinary case, still works exactly
  // as it always has (kept as a normal, local relation — no dangling shape needed at all)
  const F6 = assembled();
  F6.tables.push({ name: 'order_notes', schema: 'public', homeDomain: 'Sales', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'order_id', type: 'INTEGER' }] });
  F6.relationships.push({ parent: 'public.orders.id', child: 'public.order_notes.order_id', cardinality: '1..M' });
  P.applyProjectEdit(dir, P.readManifest(dir), F6, { user, message: 'Add order_notes' });
  const salesF6 = JSON.parse(read(dir, salesModel));
  assert.ok(salesF6.relationships.some((r) => r.parent === 'public.orders.id' && r.child === 'public.order_notes.order_id'));
  assert.strictEqual(salesF6.tables.filter((t) => t.name === 'order_notes').length, 1);

  // 7. add a new concept/entity/metric, each with an EXPLICIT domain assignment, and each again with NONE — matching split()'s own fallback
  // (_unassigned for a concept/entity, _shared for a metric) exactly, now that suppliers gave Catalog an entity of its own to link an entity to
  const F7 = assembled();
  F7.conceptual.concepts.push({ name: 'Warehouse' }); // Catalog, via the manifest's domains[].concepts (a concept has no ext.homeDomain)
  P.applyProjectEdit(dir, P.readManifest(dir), F7, { user, conceptDomains: { Warehouse: 'Catalog' }, message: 'Add Warehouse concept' });
  assert.ok(P.readManifest(dir).domains.find((d) => d.name === 'Catalog').concepts.includes('Warehouse'), 'queued via conceptDomains: added to Catalog in the manifest');
  assert.ok(JSON.parse(read(dir, catalogModel)).conceptual.concepts.some((c) => c.name === 'Warehouse'));

  const F8 = assembled();
  F8.tables.find((t) => t.name === 'suppliers').entity = 'Supplier';
  F8.logical.entities.push({ name: 'Supplier', concept: 'Warehouse', homeDomain: 'Sales' }); // entity override: moved OFF its concept's own domain
  P.applyProjectEdit(dir, P.readManifest(dir), F8, { user, message: 'Add Supplier entity, routed to Sales by its own homeDomain' });
  assert.ok(JSON.parse(read(dir, salesModel)).logical.entities.some((e) => e.name === 'Supplier'), 'entity.homeDomain overrides what it would otherwise take from its concept (Catalog)');
  assert.ok(!JSON.parse(read(dir, catalogModel)).logical.entities.some((e) => e.name === 'Supplier'));

  const F9 = assembled();
  F9.semantic.metrics.push({ name: 'Item Count', calculation: 'COUNT(public.items.id)' }); // single-domain (Catalog): no override needed
  F9.semantic.metrics.push({ name: 'Everything', calculation: 'SUM(public.orders.total) + COUNT(public.items.id)', homeDomain: '_shared' }); // spans both: needs _shared
  assert.throws(() => P.applyProjectEdit(dir, P.readManifest(dir), F9, { user }), /no part exists yet for: _shared/, 'a metric that genuinely needs _shared still refuses cleanly when no such part exists yet');
  F9.semantic.metrics.pop();
  P.applyProjectEdit(dir, P.readManifest(dir), F9, { user, message: 'Add Item Count metric' });
  assert.ok(JSON.parse(read(dir, catalogModel)).semantic.metrics.some((x) => x.name === 'Item Count'), 'reads only catalog\'s own table: routed there with no override needed, same as split()\'s own single-domain rule');

  // 8. delete a table (suppliers): gone from catalog's own file, its own new history entry
  const F10 = assembled();
  F10.tables = F10.tables.filter((t) => t.name !== 'suppliers');
  F10.logical.entities = F10.logical.entities.filter((e) => e.name !== 'Supplier');
  const salesHistBefore10 = read(dir, 'history/sales.history.jsonl');
  const r10 = P.applyProjectEdit(dir, P.readManifest(dir), F10, { user, message: 'Delete suppliers' });
  assert.ok(r10.parts.includes('sales'), 'sales changes too: it just lost the Supplier entity');
  assert.notStrictEqual(read(dir, 'history/sales.history.jsonl'), salesHistBefore10);
  assert.ok(!JSON.parse(read(dir, catalogModel)).tables.some((t) => t.name === 'suppliers'));

  // 8b. change 30: giving a table another Domain moves it between parts. Both logs say "moved" (not an unrelated delete + add), the
  // columns travel with it and are not listed, and changesOf marks the one item with where it came from / went to.
  const moveTo = (dom, msg) => { const F = assembled(); F.tables.find((t) => t.name === 'order_notes').homeDomain = dom; P.applyProjectEdit(dir, P.readManifest(dir), F, { user, message: msg }); };
  const lastOf = (hist, stream) => { const h = SM.parseLog(read(dir, hist)).history; return { h, e: SM.headsOf(h, stream)[0] }; };
  moveTo('Catalog', 'Move order_notes to Catalog');
  { const a = lastOf('history/sales.history.jsonl', 'modelling'), b = lastOf('history/catalog.history.jsonl', 'modelling');
    assert.deepStrictEqual(a.e.moved.map((g) => [g.to, g.from]), [['catalog', undefined]], 'sales: it moved TO catalog');
    assert.deepStrictEqual(b.e.moved.map((g) => [g.from, g.to]), [['sales', undefined]], 'catalog: it moved FROM sales');
    const ca = SM.changesOf(a.h, a.e), cb = SM.changesOf(b.h, b.e);
    assert.deepStrictEqual(ca.items.filter((i) => i.k.startsWith('table:public.order_notes')).map((i) => [i.op, i.moved && i.moved.to]), [['−', 'catalog']]);
    assert.deepStrictEqual(cb.items.filter((i) => i.k.startsWith('table:public.order_notes')).map((i) => [i.op, i.moved && i.moved.from]), [['+', 'sales']]);
    assert.ok(![...ca.items, ...cb.items].some((i) => i.k.startsWith('column:public.order_notes')), 'its columns travel with the table: not listed as separate deletes / adds');
    assert.ok(SM.verifyLog(a.h).length === 0 && SM.verifyLog(b.h).length === 0, 'the hash chain still holds with the extra field'); }
  moveTo('Sales', 'Move order_notes back to Sales');

  // 9. partial-failure reporting: a later part's write fails, the earlier ones stay written, and the error names exactly which (err.done) —
  // the same shape updateProjectSettings already uses (part 9), reused here rather than inventing a new one
  const F11 = assembled();
  F11.tables.find((t) => t.name === 'order_notes').description = 'touch every part with a real diff';
  F11.tables.find((t) => t.name === 'items').description = 'touch every part with a real diff';
  const realWrite = fs.writeFileSync;
  let calls = 0;
  fs.writeFileSync = (...a) => { calls++; if (calls === 3) throw new Error('disk full (simulated)'); return realWrite(...a); }; // 1-2: sales's history+model; 3: catalog's history
  const salesModelBefore11 = read(dir, salesModel);
  let threw = null;
  try { P.applyProjectEdit(dir, P.readManifest(dir), F11, { user, message: 'Touch both' }); } catch (err) { threw = err; } finally { fs.writeFileSync = realWrite; }
  assert.ok(threw, 'the failure propagates');
  assert.deepStrictEqual(threw.done, ['sales'], 'err.done names exactly the part(s) written before the failure');
  assert.ok(/updated 1 of 2 part/.test(threw.message));
  assert.notStrictEqual(read(dir, salesModel), salesModelBefore11, 'sales: really written before catalog\'s write failed');
  assert.ok(!JSON.parse(read(dir, catalogModel)).tables.find((t) => t.name === 'items').description, 'catalog: left exactly as it was — the failed write never landed');

  // 10. release 2 part 11 (Add Schema from the project-index file): a brand-new, still-tableless schema has no table anywhere to carry it
  // into sales or catalog — this project has never needed an _unassigned part, so the whole edit refuses, naming it, rather than dropping
  // the new schema silently (the success path, routed into a REAL _unassigned part, is proven by the Shop3 fixture right below)
  const F12 = assembled();
  F12.schemas.push({ name: 'staging' });
  const salesBefore12 = read(dir, salesModel), catalogBefore12 = read(dir, catalogModel);
  assert.throws(() => P.applyProjectEdit(dir, P.readManifest(dir), F12, { user }), /no part exists yet for: _unassigned/, 'an orphan schema with no table anywhere refuses cleanly rather than vanishing silently');
  assert.strictEqual(read(dir, salesModel), salesBefore12); assert.strictEqual(read(dir, catalogModel), catalogBefore12);

  // 11. change 30 (applyDomains): edit a domain's description, then add a domain and give it a concept - the concept's objects move to a
  // part that is created for it (folder, log, manifest entry, index file), and both logs record the concept as MOVED, not deleted + added
  const dom0 = P.readManifest(dir).domains;
  P.applyDomains(dir, P.readManifest(dir), dom0.map((d) => (d.name === 'Sales' ? { ...d, description: 'Selling to customers' } : d)), { user });
  assert.strictEqual(P.readManifest(dir).domains.find((d) => d.name === 'Sales').description, 'Selling to customers', 'a description is kept in the manifest');
  const cBefore = read(dir, catalogModel);
  const res11 = P.applyDomains(dir, P.readManifest(dir), [...P.readManifest(dir).domains.map((d) => (d.name === 'Catalog' ? { ...d, concepts: d.concepts.filter((c) => c !== 'Warehouse') } : d)), { name: 'Logistics', description: 'Stock and shipping', concepts: ['Warehouse'] }], { user });
  assert.deepStrictEqual(res11.created, ['logistics'], 'the new domain got its own part');
  const man11 = P.readManifest(dir), lm = 'data_models/shop2/logistics/logistics.model.json';
  assert.ok(man11.parts.some((p) => p.name === 'logistics' && p.model === lm), 'listed in the manifest, nested like the others');
  assert.ok(JSON.parse(read(dir, lm)).conceptual.concepts.some((c) => c.name === 'Warehouse'), 'the concept is in the new part');
  assert.ok(!JSON.parse(read(dir, catalogModel)).conceptual.concepts.some((c) => c.name === 'Warehouse') && read(dir, catalogModel) !== cBefore, 'and gone from catalog');
  assert.ok(P.readManifest(dir).domains.find((d) => d.name === 'Logistics').description === 'Stock and shipping');
  { const a = lastOf('history/catalog.history.jsonl', 'modelling'), b = lastOf('history/logistics.history.jsonl', 'modelling');
    assert.deepStrictEqual(SM.changesOf(a.h, a.e).items.filter((i) => i.k === 'concept:Warehouse').map((i) => [i.op, i.moved && i.moved.to]), [['−', 'logistics']]);
    assert.deepStrictEqual(SM.changesOf(b.h, b.e).items.filter((i) => i.k === 'concept:Warehouse').map((i) => i.moved && i.moved.from), ['catalog'], 'the new part: it came from catalog'); }
  assert.deepStrictEqual(assembled().conceptual.concepts.map((c) => c.name).sort(), ['Customer', 'Order', 'Product', 'Warehouse'], 'nothing lost or duplicated');
  // (the index file's own `parts` list is covered by host.check.js, this fixture has no index file)
  assert.throws(() => P.applyDomains(dir, P.readManifest(dir), [{ name: 'A', concepts: ['Order'] }, { name: 'a', concepts: [] }], { user }), /defined more than once/, 'R16 again on the way in');

  // no domains, never split, or a genuinely one-part project: applyProjectEdit refuses outright, same as updateProjectSettings/updateGovernance
  assert.throws(() => P.applyProjectEdit(path.join(scratch, 'plain'), P.readManifest(path.join(scratch, 'plain')), F, { user }), /more than one part/);
}

// ---- release 2 part 11 (ADR-0045 amended): Add Schema / Add Catalog from the project-index file — a brand-new, still-tableless one
// routes to _unassigned (subsetModel only ever derives a part's own catalogs/schemas from the tables it carries), and stops being carried
// there for free the moment a real table starts using it (every part is rebuilt fresh from the current assembled state on every edit) ----
{
  const dir = path.join(scratch, 'edit-index-orphan'), r0 = P.create({ dir, name: 'Shop3', user });
  const F = {
    strata: 2, project: { name: 'Shop3', technology: 'BigQuery', methodology: 'ER - 3NF', naming: 'catalog.schema.table' },
    conceptual: { concepts: [{ name: 'Customer' }] },
    logical: { entities: [{ name: 'Customer', concept: 'Customer' }] },
    catalogs: [{ name: 'main' }],
    schemas: [{ name: 'public', catalog: 'main' }],
    tables: [
      { name: 'customers', schema: 'main.public', entity: 'Customer', columns: [{ name: 'id', type: 'INTEGER', pk: true }] },
      { name: 'scratch', schema: 'main.public', columns: [{ name: 'id', type: 'INTEGER', pk: true }] }, // no entity, no domain: goes to _unassigned
    ],
  };
  fs.writeFileSync(r0.model, SM.stringify(F) + '\n');
  const log0 = SM.newHistory(), flat0 = SM.flatten(F);
  for (const s of SM.STREAMS) SM.commit(log0, s, null, flat0[s], { user: 'Ada', message: 'setup' });
  fs.writeFileSync(P.resolve(r0.model).history, SM.logText(log0));
  const man = P.readManifest(dir);
  man.domains = [{ name: 'Sales', owner: 'Head of Sales', concepts: ['Customer'] }];
  fs.writeFileSync(path.join(dir, P.MANIFEST), JSON.stringify(man));
  P.split(r0.model, { user });
  assert.deepStrictEqual(P.readManifest(dir).parts.map((p) => p.name).sort(), ['_unassigned', 'sales'], 'a real _unassigned part exists: scratch has no entity and no domain');
  const assembled = () => P.assemble(dir, P.readManifest(dir));
  const unModel = 'data_models/shop3/_unassigned/_unassigned.model.json', salesModel = 'data_models/shop3/sales/sales.model.json';

  // Add Catalog + Add Schema, together, as the toolbar would produce for a new "lake.staging": both route into _unassigned, not duplicated
  // anywhere else, and assemble() still succeeds afterwards (no duplicate/conflicting catalog/schema definition across parts)
  const F1 = assembled();
  F1.catalogs.push({ name: 'lake' });
  F1.schemas.push({ name: 'staging', catalog: 'lake' });
  P.applyProjectEdit(dir, P.readManifest(dir), F1, { user, message: 'Add a lake.staging schema' });
  const unF1 = JSON.parse(read(dir, unModel));
  assert.ok(unF1.catalogs.some((c) => c.name === 'lake'), 'the orphan catalog landed in _unassigned');
  assert.ok(unF1.schemas.some((s) => s.name === 'staging' && s.catalog === 'lake'), 'and its orphan schema alongside it');
  assert.ok(!JSON.parse(read(dir, salesModel)).schemas.some((s) => s.name === 'staging'), 'not duplicated into sales');
  assert.doesNotThrow(() => P.assemble(dir, P.readManifest(dir)), 'assemble() still succeeds: no duplicate/conflicting catalog/schema across parts');

  // once a real table in Sales starts using it, the schema/catalog travels with that table (the ordinary per-table rule) and stops being
  // carried in _unassigned — reconciled for free, not by any code that removes a "stale" copy
  const F2 = assembled();
  F2.tables.push({ name: 'raw_events', schema: 'lake.staging', homeDomain: 'Sales', columns: [{ name: 'id', type: 'INTEGER', pk: true }] });
  P.applyProjectEdit(dir, P.readManifest(dir), F2, { user, message: 'Add raw_events, routed to Sales' });
  const salesF2 = JSON.parse(read(dir, salesModel)), unF2 = JSON.parse(read(dir, unModel));
  assert.ok(salesF2.schemas.some((s) => s.name === 'staging' && s.catalog === 'lake'), 'sales now carries it: a real table of its own uses it');
  assert.ok(salesF2.catalogs.some((c) => c.name === 'lake'));
  assert.ok(!unF2.schemas.some((s) => s.name === 'staging'), '_unassigned no longer carries it: it is not orphan anymore, reconciled for free');
  assert.ok(!unF2.catalogs.some((c) => c.name === 'lake'));
  assert.doesNotThrow(() => P.assemble(dir, P.readManifest(dir)));
}
function nodesOfCount(m, lv) { return require('../media/model.js').nodesOf(m, lv).length; }

// ---- the command line ----
const cli = (...a) => cp.spawnSync('node', [path.join(REPO, 'cli.js'), ...a], { encoding: 'utf8', cwd: scratch });
const cdir = path.join(scratch, 'cli');
let r = cli('init', '--dir', cdir, '--name', 'CLI Demo', '--template', 'star');
assert.strictEqual(r.status, 0, r.stderr); assert.ok(/Created "CLI Demo" \(star\)[\s\S]*cli-demo\.model\.json/.test(r.stdout) && r.stdout.split('\n').length <= 6, 'a short summary, not every file'); assert.ok(/Next: strata-sql live/.test(r.stdout)); check(cdir, 'cli-demo', 'CLI Demo'); assert.ok(fs.existsSync(path.join(cdir, 'strata.project.json')) && fs.existsSync(path.join(cdir, '.gitattributes')));
console.log('  cli init (star) wrote:\n' + tree(cdir).map((f) => '    ' + f).join('\n'));
r = cli('init', '--dir', path.join(scratch, 'cli2'), '--name', 'Warehouse', '--platform', 'Databricks', '--methodology', 'One Big Table', '--no-git');
assert.strictEqual(r.status, 0, r.stderr); { const { F } = check(path.join(scratch, 'cli2'), 'warehouse', 'Warehouse'); assert.strictEqual(F.project.technology, 'Databricks'); assert.strictEqual(F.project.methodology, 'One Big Table'); assert.strictEqual(F.catalogs[0].name, 'main'); assert.ok(!fs.existsSync(path.join(scratch, 'cli2', '.gitignore'))); }
r = cli('init', '--dir', cdir, '--name', 'CLI Demo'); assert.strictEqual(r.status, 1); assert.ok(/already exist/.test(r.stderr), 'the command line never overwrites either');
r = cli('init', '--dir', path.join(scratch, 'cli3'), '--template', 'nope'); assert.strictEqual(r.status, 1); assert.ok(/unknown starting point/.test(r.stderr));
r = cli('init', '--bogus'); assert.strictEqual(r.status, 2); assert.ok(/unknown option/.test(r.stderr) && /strata-sql init --help/.test(r.stderr) && r.stderr.split('\n').length <= 3, 'a short error, not the whole manual');
r = cli('init', '--dir'); assert.strictEqual(r.status, 2); assert.strictEqual(cli().status, 0); assert.ok(/Usage: strata-sql <command>/.test(cli().stdout) && cli().stdout.split('\n').length <= 20, 'no arguments: the short overview');
r = cli('--version'); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout.trim(), require(path.join(REPO, 'package.json')).version);
r = cli('import-sql', '--help'); assert.strictEqual(r.status, 0); assert.ok(/Usage: strata-sql import-sql/.test(r.stdout) && /--ddl <paths/.test(r.stdout) && !/strata-sql split/.test(r.stdout), 'help for one command shows only that command');
r = cli('help', 'live'); assert.ok(/--host <address>/.test(r.stdout) && /STRATA_TOKEN/.test(r.stdout) && /--demo/.test(r.stdout) && /STRATA_DEMO/.test(r.stdout), 'live --help explains the demo');
r = cli('live', '--demo', 'some.model.json'); assert.strictEqual(r.status, 1); assert.ok(/--demo opens the sample models/.test(r.stderr), 'the demo takes no model');
r = cli('live', '--demo', '--dir', '.'); assert.strictEqual(r.status, 1, 'nor a project folder');
r = cli('live', '0.0.0.0', '--port', '0', '--no-open'); assert.strictEqual(r.status, 1); assert.ok(/is an address, not a model: use --host 0\.0\.0\.0/.test(r.stderr), 'a bare address is explained, not read as a file');
r = cli('frobnicate'); assert.strictEqual(r.status, 2); assert.ok(/unknown command "frobnicate"/.test(r.stderr) && /Commands:/.test(r.stderr));
assert.ok(Object.keys(require(path.join(REPO, 'package.json')).bin).join() === 'strata-sql', 'the one command is strata-sql, in the extension manifest and in the npm package');
{ const dd = path.join(scratch, 'folder-name'); fs.mkdirSync(dd); r = cli('init', '--dir', dd); assert.strictEqual(r.status, 0, r.stderr); assert.ok(fs.existsSync(path.join(dd, MODEL('folder-name'))), 'the name defaults to the folder\'s'); }
assert.strictEqual(require(path.join(REPO, 'package.json')).bin['strata-sql'], 'cli.js'); assert.ok(fs.readFileSync(path.join(REPO, 'cli.js'), 'utf8').startsWith('#!/usr/bin/env node'));

// ---- the wizard, through a stubbed vscode ----
const Uri = { file: (p) => ({ fsPath: p, path: p, scheme: 'file', with(o) { return Uri.file(o.path !== undefined ? o.path : p); } }), joinPath: (u, ...s) => Uri.file(path.join(u.fsPath, ...s)) };
const ws = path.join(scratch, 'workspace'); fs.mkdirSync(ws);
const cmds = {}, log = { exec: [], info: [], err: [], asked: [], warn: [], saved: [] };
let script = [], folders = [{ uri: Uri.file(ws) }], nameCheck = null;
const CANCEL = Symbol('cancel'); // the user pressed Escape: VS Code answers undefined
const ask = (kind, o, items) => { const a = script.shift(); log.asked.push({ kind, title: o && o.title, labels: items && items.map((i) => i.label) }); if (a === undefined) throw new Error('unexpected prompt: ' + (o && o.title)); return a === CANCEL ? undefined : typeof a === 'function' ? a(items, o) : a; };
const vscode = {
  Uri, ViewColumn: {}, ColorThemeKind: {}, QuickPickItemKind: { Separator: -1 },
  workspace: { get workspaceFolders() { return folders; }, getWorkspaceFolder: () => undefined, fs: { writeFile: async (uri, buf) => fs.writeFileSync(uri.fsPath, buf) }, onDidChangeTextDocument: () => ({}), onDidChangeConfiguration: () => ({}), getConfiguration: () => ({ get: () => '' }) },
  window: { activeTextEditor: null, activeColorTheme: { kind: 2 }, onDidChangeActiveColorTheme: () => ({}), onDidChangeActiveTextEditor: () => ({}), registerCustomEditorProvider: () => ({}), registerWebviewViewProvider: () => ({}), registerUriHandler: () => ({}),
    createWebviewPanel: (id, title) => { const p = { id, title, revealed: 0, disposed: false, reveal() { p.revealed++; }, onDidDispose(fn) { p.disposeFn = fn; }, webview: { html: '', cspSource: 'x', asWebviewUri: (u) => u, messages: [], onDidReceiveMessage(fn) { p.webview.handler = fn; }, postMessage(m) { p.webview.messages.push(m); return Promise.resolve(true); } } }; log.panels = log.panels || []; log.panels.push(p); return p; },
    showQuickPick: async (items, o) => ask('pick', o, items), showInputBox: async (o) => { nameCheck = o.validateInput; return ask('input', o); }, showOpenDialog: async (o) => ask('dialog', o),
    showSaveDialog: async (o) => { log.saved.push(o.defaultUri.fsPath); return o.defaultUri; },
    showInformationMessage: (m) => { log.info.push(m); return Promise.resolve(); }, showErrorMessage: (m) => { log.err.push(m); return Promise.resolve(); },
    showWarningMessage: async (m, o, ...items) => {
      log.warn.push(m);
      if (!items.length) return undefined; // informational only (e.g. "open a model first"): nothing to answer
      const a = script.shift();
      log.asked.push({ kind: 'warn', title: m, labels: items });
      if (a === undefined) throw new Error('unexpected warning dialog: ' + m);
      return a === CANCEL ? undefined : a;
    } },
  commands: { registerCommand: (id, fn) => { cmds[id] = fn; return {}; }, executeCommand: async (...a) => { log.exec.push(a); } },
};
const orig = Module._load;
Module._load = function (req, ...r) { return req === 'vscode' ? vscode : orig.call(this, req, ...r); };
require(REPO + '/extension.js').activate({ subscriptions: { push() {} }, extensionUri: Uri.file(REPO) });
const by = (id) => (items) => items.find((i) => i.id === id || i.label.includes(id));
(async () => {
  assert.ok(cmds['strata.newProject'], 'the command exists');
  assert.ok(require(REPO + '/package.json').contributes.commands.some((c) => c.command === 'strata.newProject'), 'and is in the Command Palette');
  // Split into Domains / Join Parts / Project View: registered, in the Command Palette, and (with no model open) they say so rather than doing nothing
  for (const id of ['strata.splitIntoDomains', 'strata.joinParts', 'strata.openProjectView']) assert.ok(cmds[id] && require(REPO + '/package.json').contributes.commands.some((c) => c.command === id), id + ' exists and is in the Command Palette');
  log.err.length = 0; log.warn.length = 0;
  await cmds['strata.joinParts']();
  assert.deepStrictEqual(log.err, [], 'no doc open: a warning, not a thrown error');
  assert.ok(/open a \.model\.json file first/.test(log.warn[0] || ''));
  log.warn.length = 0; await cmds['strata.openProjectView']();
  assert.ok(/open a \.model\.json file first/.test(log.warn[0] || ''), 'openProjectView is also needModel-gated');
  { const m = require(REPO + '/package.json').contributes.menus['explorer/context'].find((e) => e.command === 'strata.newProject');
    assert.ok(m && m.when === 'explorerResourceIsFolder', 'and on the Explorer folder context menu'); }
  // the small-team path: folder (Enter), name, starting point, platform, methodology, create
  script = [by('ws'), 'Solo Model', by('blank'), (items) => items.find((i) => i.label === 'PostgreSQL'), (items) => items.find((i) => i.label === 'ER - 3NF'), by('go')];
  await cmds['strata.newProject']();
  assert.deepStrictEqual(log.err, []); check(ws, 'solo-model', 'Solo Model');
  assert.ok(read(ws, '.gitattributes').includes('merge=union') && read(ws, '.gitignore').includes('.strata/'), 'git files by default: nothing to decide for a solo user');
  assert.strictEqual(log.asked.length, 6, 'six answers, one of them a bare Enter on the defaults');
  const last = log.exec.at(-1); assert.strictEqual(last[0], 'vscode.openWith'); assert.strictEqual(last[1].fsPath, path.join(ws, MODEL('solo-model'))); assert.strictEqual(last[2], 'strata.modelEditor');
  assert.ok(/created solo-model\.model\.json/.test(log.info.at(-1)));
  assert.ok(log.asked[2].labels.some((l) => /Blank/.test(l)) && ['Northwind', 'FpML', 'Dimensional star'].every((n) => log.asked[2].labels.some((l) => l.includes(n))), 'starting points: Blank and the three templates');
  assert.ok(log.asked[2].labels.some((l) => /From DDL \/ SQL scripts/.test(l)) && !log.asked[2].labels.some((l) => /coming soon/.test(l)), 'the DDL row is a real starting point since change 33 (tests/sqlimport.check.js drives it)');
  // the name is checked while typing: nothing existing is overwritten
  assert.ok(/letter or digit/.test(nameCheck('')) && /already exist/.test(nameCheck('Solo Model')) && nameCheck('Another') === null);
  // a template: no platform / methodology questions (it brings its own)
  log.asked.length = 0; log.info.length = 0;
  script = [by('ws'), 'Trading Book', by('fpml'), by('go')];
  await cmds['strata.newProject']();
  check(ws, 'trading-book', 'Trading Book'); assert.ok(fs.existsSync(path.join(ws, DATA('trading-book'))));
  assert.deepStrictEqual(log.asked.map((a) => a.kind), ['pick', 'input', 'pick', 'pick'], 'folder, name, starting point, create');
  // team setup is one optional extra step
  script = [by('ws'), 'Team Model', by('star'), by('team'), (items) => items.filter((i) => i.id === 'git')];
  await cmds['strata.newProject']();
  assert.ok(read(ws, '.gitignore').includes('*.model.layout.json'), 'team setup: the layout file stays personal when it is not ticked'); check(ws, 'team-model', 'Team Model');
  script = [by('ws'), 'No Git', by('star'), by('team'), (items) => []]; await cmds['strata.newProject'](); const ng = read(ws, '.gitignore'); assert.ok(!/No Git/.test(ng));
  // cancelling anywhere writes nothing
  const files0 = tree(ws).join();
  for (const cut of [[CANCEL], [by('ws'), CANCEL], [by('ws'), 'Cancelled', CANCEL], [by('ws'), 'Cancelled', by('blank'), CANCEL], [by('ws'), 'Cancelled', by('blank'), (items) => items[0], CANCEL], [by('ws'), 'Cancelled', by('star'), CANCEL], [by('ws'), 'Cancelled', by('star'), by('team'), CANCEL]]) { script = cut; await cmds['strata.newProject'](); }
  assert.strictEqual(tree(ws).join(), files0, 'nothing is written unless the last step is confirmed');
  // another folder; no workspace at all: a folder dialog
  const other = path.join(scratch, 'other'); fs.mkdirSync(other);
  script = [by('other'), () => [Uri.file(other)], 'Elsewhere', by('star'), by('go')]; await cmds['strata.newProject'](); check(other, 'elsewhere', 'Elsewhere');
  folders = undefined; const third = path.join(scratch, 'third'); fs.mkdirSync(third);
  script = [() => [Uri.file(third)], 'No Workspace', by('star'), by('go')]; await cmds['strata.newProject'](); check(third, 'no-workspace', 'No Workspace');
  // an error is shown, not thrown
  folders = [{ uri: Uri.file(ws) }]; log.err.length = 0; script = [by('ws'), 'Sneaky', by('star'), by('go')];
  fs.mkdirSync(path.join(ws, DATA('sneaky')), { recursive: true }); fs.writeFileSync(path.join(ws, DATA('sneaky'), 'x.csv'), 'a'); await cmds['strata.newProject']();
  assert.ok(log.err.length === 1 && /already exist/.test(log.err[0]), 'a clash that appears after the name was checked is reported: ' + log.err[0]);
  // ---- domains (release 2, R7/R8/R16): manifest metadata, and editing them from the webview (release 2 part 3, ADR-0045 amended) ----
  assert.deepStrictEqual(P.domainsOf({ strata: 'project/1', name: 'X', parts: [] }), [], 'no domains key: empty, not undefined');
  assert.deepStrictEqual(P.domainsOf({ domains: [{ name: 'Sales', concepts: ['Customer'] }] }), [{ name: 'Sales', concepts: ['Customer'] }]);
  assert.deepStrictEqual(P.validateDomains({ domains: [{ name: 'Sales', concepts: ['Customer'] }] }), [], 'one domain, one concept: no issues');
  assert.deepStrictEqual(
    P.validateDomains({ domains: [{ name: 'Sales', concepts: ['Customer'] }, { name: 'sales', concepts: ['Customer'] }, { name: 'Ops', concepts: ['Customer'] }] }),
    ['domain "sales" is defined more than once', 'concept "Customer" is listed in domains Sales, sales, Ops'],
    'R16: a duplicate name (case-insensitive) and a concept in more than one domain');

  // setDomains: what the Domains dialog's `{type: 'domains', domains}` message writes (lib/project.js, extension.js). No versioning: a
  // domain is project metadata, so a rejected write changes nothing on disk and there is no history stream to fail to write to.
  const sdDir = path.join(scratch, 'set-domains'); P.create({ dir: sdDir, name: 'SD', user });
  assert.throws(() => P.setDomains(path.join(scratch, 'no-such-project'), []), /no project manifest/, 'no manifest yet: refused, nothing written');
  const d1 = P.setDomains(sdDir, [{ name: 'Sales', owner: 'Ada', concepts: ['Customer'] }]);
  assert.deepStrictEqual(d1, [{ name: 'Sales', owner: 'Ada', concepts: ['Customer'] }]);
  assert.deepStrictEqual(P.readManifest(sdDir).domains, d1, 'written to the manifest');
  // domains defined, but never split (release 2 part 5): no index file, no archived file — completely unaffected by any of this pass
  assert.ok(!('index' in P.readManifest(sdDir)), 'no project-index pointer yet');
  assert.strictEqual(P.resolve(path.join(sdDir, MODEL('sd'))).archived, false);
  assert.throws(() => P.setDomains(sdDir, [{ name: 'Sales', concepts: ['A'] }, { name: 'sales', concepts: ['B'] }]), /defined more than once/, 'R16 is checked again on the way in, not just trusted from the webview');
  assert.deepStrictEqual(P.readManifest(sdDir).domains, d1, 'a rejected write changes nothing on disk');
  assert.deepStrictEqual(P.setDomains(sdDir, []), [], 'clearing every domain is allowed: an explicit empty array (not "no domains key"), so the dialog can still tell "no domains" from "no manifest yet"');
  assert.deepStrictEqual(P.readManifest(sdDir).domains, []);

  // end-to-end (the exact failure this pass fixes): open a fresh Northwind / FpML copy, its manifest already has the starter domains (no
  // hand-editing needed), and Strata: Split into Domains actually produces real per-domain files.
  for (const [id, expectParts] of [['northwind', ['_shared', '_unassigned', 'catalog', 'hr', 'sales']], ['fpml', ['_shared', '_unassigned', 'front-office', 'middle-office', 'operations', 'risk']]]) {
    const eDir = path.join(scratch, id + '-e2e'), e = P.create({ dir: eDir, name: id + ' E2E', template: id, user });
    assert.deepStrictEqual(P.readManifest(eDir).domains, P.TEMPLATES[id].domains, id + ': the copy already has the starter domains');
    const preSplitText = read(e.model);
    const res = P.split(e.model, { user });
    assert.deepStrictEqual(res.parts.map((p) => p.name).sort(), expectParts, id + ': one part per starter domain, plus _unassigned (views and bridge tables realise no entity of their own) and _shared '
      + '(a metric or acknowledged warning that split() cannot pin to one domain by name matching alone — a pre-existing quirk of split()\'s own routing, not something this pass touches, see the report)');
    // release 2 part 5: the original single-part file is archived in place (renamed), byte-for-byte, and a thin project-index file takes
    // its exact old path — so `e.model` itself no longer holds the pre-split text, the archived file does
    const archivedName = id + '-e2e.archived.model.json';
    assert.strictEqual(read(eDir, `data_models/${id}-e2e/${archivedName}`), preSplitText, id + ': the archived file is left exactly as the pre-split model was');
    const idxAtPath = JSON.parse(read(e.model));
    assert.strictEqual(idxAtPath.strata, P.INDEX_STRATA); assert.deepStrictEqual(idxAtPath.parts.sort(), res.parts.map((p) => p.name).sort());
    assert.strictEqual(P.readManifest(eDir).index, path.relative(eDir, e.model).split(path.sep).join('/'));
    assert.ok(fs.existsSync(path.join(eDir, 'CODEOWNERS')), id + ': CODEOWNERS from the starter domains\' owners');
    for (const d of P.TEMPLATES[id].domains) assert.ok(read(eDir, 'CODEOWNERS').includes(`@${d.owner}`), id + ': ' + d.owner);
    // losslessness against the REAL sample content (not a hand-built fixture): reassembling every part + governance.json reproduces the
    // pre-split copy exactly, streamed the same way the hand-built fixture test above already proves for a smaller synthetic model
    const reassembled = P.assemble(eDir, P.readManifest(eDir));
    const preFlat = SM.flatten(JSON.parse(preSplitText)), reFlat = SM.flatten(reassembled);
    for (const s of SM.STREAMS) assert.strictEqual(SM.stateHash(reFlat[s]), SM.stateHash(preFlat[s]), `${id} ${s}: reassembling the real split reproduces the pre-split copy exactly`);

    // change 30: each part opens with no "version history doesn't match" - the canvas loads the file (fromFile), re-derives its content
    // (toFile) and looks that up in the part's own fresh log; a bridge table living in another part used to drop out of `via` on that
    // round trip (northwind's M..M customers/customer_demographics via customer_customer_demo), so sales.model.json looked edited outside Strata
    for (const p of P.readManifest(eDir).parts) {
      const pr = P.resolve(path.join(eDir, p.model)), o = JSON.parse(fs.readFileSync(pr.model, 'utf8'));
      const flats = SM.flatten(SM.toFile(SM.fromFile(o, 'physical'))), loc = SM.locate(SM.parseLog(fs.readFileSync(pr.history, 'utf8')).history, flats);
      assert.deepStrictEqual(loc.problems, [], `${id}/${p.name}: the part matches its own log after the load round trip`);
    }

    // ---- Strata: Open Project View (release 2 part 4/5, ADR-0045 extended), driven against this REAL split ----
    // A split project now has a project-index file (release 2 part 5): the command opens THAT (a normal document tab, the model editor's
    // CustomTextEditorProvider, tested against the real handler in tests/host.check.js) rather than building a bespoke panel — proven here
    // by the exact command it delegates to; the deep "assembles every part, read-only, no writes" proof lives in host.check.js, where the
    // real `resolveIndexEditor` can actually be driven (this stubbed vscode discards the registered CustomEditorProvider).
    if (id === 'northwind') {
      const salesModel = path.join(eDir, `data_models/${id}-e2e/sales/sales.model.json`);
      vscode.window.activeTextEditor = { document: { uri: Uri.file(salesModel) } };
      log.panels = []; log.exec.length = 0; log.warn.length = 0;
      await cmds['strata.openProjectView']();
      assert.strictEqual(log.panels.length, 0, 'a split project has an index file: no bespoke panel is built any more');
      const ex = log.exec.at(-1);
      assert.strictEqual(ex[0], 'vscode.openWith'); assert.strictEqual(ex[1].fsPath, path.join(eDir, P.readManifest(eDir).index)); assert.strictEqual(ex[2], 'strata.modelEditor');

      // a project of one part: hidden behind a warning, not an empty/broken panel
      const onePart = path.join(scratch, 'pv-one-part'); P.create({ dir: onePart, name: 'One Part', user });
      vscode.window.activeTextEditor = { document: { uri: Uri.file(path.join(onePart, MODEL('one-part'))) } };
      log.panels = []; log.warn.length = 0;
      await cmds['strata.openProjectView']();
      assert.strictEqual(log.panels.length, 0, 'one part: no panel is created');
      assert.ok(/more than one part/.test(log.warn[0] || ''), 'warn was: ' + JSON.stringify(log.warn));

      // an AD HOC multi-part project (a second model added as a part of the same manifest by hand, never through Split): no index file
      // exists to open, so the bespoke WebviewPanel is still built — the one case it remains for (ADR-0045 point 10). assemble() needs
      // every part to share the exact same `project` block (true of a real split; not automatically true of two independent P.create()
      // calls, which each keep their own name) — so the second "part" here is a hand-copied file with the SAME project block, renamed tables.
      const adHocDir = path.join(scratch, 'pv-adhoc'), a1 = P.create({ dir: adHocDir, name: 'Ad Hoc', template: 'star', user });
      const F1 = JSON.parse(read(a1.model)), F2 = { ...F1, tables: F1.tables.map((t) => ({ ...t, name: t.name + '_2' })) };
      const dir2 = path.join(adHocDir, 'data_models', 'more'); fs.mkdirSync(dir2, { recursive: true });
      const model2 = path.join(dir2, 'more.model.json'); fs.writeFileSync(model2, SM.stringify(F2) + '\n');
      P.ensurePart(adHocDir, model2, 'Ad Hoc');
      assert.ok(!('index' in P.readManifest(adHocDir)), 'never split: no index file');
      vscode.window.activeTextEditor = { document: { uri: Uri.file(a1.model) } };
      log.panels = []; log.exec.length = 0; log.warn.length = 0;
      await cmds['strata.openProjectView']();
      assert.strictEqual(log.panels.length, 1, 'no index file: the bespoke panel is built, exactly as before this pass');
      const adPanel = log.panels[0];
      await adPanel.webview.handler({ type: 'ready' });
      const adMsg = adPanel.webview.messages.find((m) => m.type === 'model');
      assert.ok(adMsg && adMsg.readOnly && adMsg.projectView, 'assembled, read-only, same as ever');
      const adF = JSON.parse(adMsg.text);
      assert.strictEqual((adF.tables || []).length, 10, 'both ad hoc parts (two "star" template copies, 5 tables each) are in the assembled model');
      // reopening reveals the same panel rather than assembling (and creating) a second one
      await cmds['strata.openProjectView']();
      assert.strictEqual(log.panels.length, 1, 'still one panel'); assert.strictEqual(adPanel.revealed, 1);

      // ---- release 2 part 8 (ADR-0045 extended): the bespoke panel (an ad hoc, never-split project) gets the same read-only Tools access
      // as the index file's own tab (tests/host.check.js) — ETL/ELT export and HTML export, defaulting next to the project's own root ----
      log.saved.length = 0;
      await adPanel.webview.handler({ type: 'saveFile', name: 'foo.py', text: 'print(1)\n' });
      assert.strictEqual(log.saved.at(-1), path.join(adHocDir, 'foo.py'), 'defaults to the project root (no single index file of its own)');
      assert.strictEqual(fs.readFileSync(path.join(adHocDir, 'foo.py'), 'utf8'), 'print(1)\n');
      log.saved.length = 0;
      await adPanel.webview.handler({ type: 'exportHtml' });
      assert.strictEqual(log.saved.at(-1), path.join(adHocDir, 'Ad Hoc.html'));
      const adHtml = fs.readFileSync(path.join(adHocDir, 'Ad Hoc.html'), 'utf8');
      assert.ok(adHtml.includes('"Ad Hoc"'), 'the assembled project (real project name) is embedded');
      adPanel.webview.messages.length = 0;
      await adPanel.webview.handler({ type: 'embed' }); await adPanel.webview.handler({ type: 'openLive' });
      assert.deepStrictEqual(adPanel.webview.messages, [], 'embeddings and the live view stay out of reach: no reply, no write');
      assert.ok(!fs.existsSync(path.join(adHocDir, 'ad-hoc.model.embeddings.json')));
    }
  }

  // ---- change 30: a domain added to a split REAL Northwind (index file, archived file, nested parts): its concept moves over, the part is
  // created and named in the manifest AND the index file, and every part still opens without a history mismatch ----
  {
    const dir = path.join(scratch, 'nw-domains'), e = P.create({ dir, name: 'nw domains', template: 'northwind', user });
    P.split(e.model, { user });
    const before = P.assemble(dir, P.readManifest(dir)), man = P.readManifest(dir);
    // an edit that changes no routing writes no history at all, however often it is repeated: a metric built on other metrics used to be
    // routed by the order the metrics were listed in, and that order changes with the parts, so it flipped between parts on every edit
    const hist = () => man.parts.map((p) => read(dir, 'history/' + p.name + '.history.jsonl')).join('\n');
    const h0 = hist();
    for (let i = 0; i < 2; i++) { P.applyDomains(dir, P.readManifest(dir), man.domains.map((d) => (d.name === 'HR' ? { ...d, description: 'People' + i } : d)), { user }); assert.strictEqual(hist(), h0, 'pass ' + i + ': no object changes part'); }
    const nd = man.domains.map((d) => (d.name === 'Catalog' ? { ...d, concepts: d.concepts.filter((c) => c !== 'Shipper') } : d));
    const res = P.applyDomains(dir, man, [...nd, { name: 'Logistics', description: 'Moving goods', owner: 'Ops', concepts: ['Shipper'] }], { user });
    assert.deepStrictEqual(res.created, ['logistics']);
    const m2 = P.readManifest(dir);
    assert.ok(m2.parts.some((p) => p.name === 'logistics'));
    assert.ok(P.readIndexFile(path.join(dir, m2.index)).parts.includes('logistics'), 'the project-index file names the new part');
    const after = P.assemble(dir, m2), fb = SM.flatten(before), fa = SM.flatten(after);
    for (const s of SM.STREAMS) assert.strictEqual(SM.stateHash(fa[s]), SM.stateHash(fb[s]), s + ': moving a concept to another domain loses and adds nothing');
    for (const p of m2.parts) {
      const pr = P.resolve(path.join(dir, p.model)), o = JSON.parse(fs.readFileSync(pr.model, 'utf8'));
      assert.deepStrictEqual(SM.locate(SM.parseLog(fs.readFileSync(pr.history, 'utf8')).history, SM.flatten(SM.toFile(SM.fromFile(o, 'physical')))).problems, [], p.name + ': no history mismatch after the move');
    }
    assert.ok(P.buildIndex(dir, m2).partModel.logistics, 'a cross-part stub can open the part: buildIndex maps part -> model file');
  }

  // ---- a merged, read-only history view + cross-part Undo/Redo for the project-index file's own tab (release 2 part 12) ----
  {
    const dir = path.join(scratch, 'merged-history'), r0 = P.create({ dir, name: 'Shop4', user });
    const F = {
      strata: 2, project: { name: 'Shop4', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table' },
      conceptual: { concepts: [{ name: 'Customer' }, { name: 'Product' }] },
      logical: { entities: [{ name: 'Customer', concept: 'Customer' }, { name: 'Product', concept: 'Product' }] },
      schemas: [{ name: 'public' }],
      tables: [
        { name: 'customers', schema: 'public', entity: 'Customer', columns: [{ name: 'id', type: 'INTEGER', pk: true }] },
        { name: 'products', schema: 'public', entity: 'Product', columns: [{ name: 'id', type: 'INTEGER', pk: true }] },
      ],
      governance: { tags: [{ name: 'pii' }] },
    };
    fs.writeFileSync(r0.model, SM.stringify(F) + '\n');
    const log0 = SM.newHistory(), flat0 = SM.flatten(F);
    for (const s of SM.STREAMS) SM.commit(log0, s, null, flat0[s], { user: 'Ada', message: 'setup' });
    fs.writeFileSync(P.resolve(r0.model).history, SM.logText(log0));
    const man = P.readManifest(dir);
    man.domains = [{ name: 'Sales', owner: 'Head of Sales', concepts: ['Customer'] }, { name: 'Catalog', owner: 'Head of Merch', concepts: ['Product'] }];
    fs.writeFileSync(path.join(dir, P.MANIFEST), JSON.stringify(man));
    P.split(r0.model, { user });
    const man2 = P.readManifest(dir);
    assert.deepStrictEqual(man2.parts.map((p) => p.name).sort(), ['catalog', 'sales'], 'a clean split, nothing ambiguous');

    // partHistoryTexts: one entry per part, plus governance.json (this project has more than one part) — real, parseable JSON Lines
    const hs = P.partHistoryTexts(dir, man2);
    assert.deepStrictEqual(hs.map((x) => x.name).sort(), ['catalog', P.GOVERNANCE, 'sales']);
    for (const x of hs) {
      const parsed = SM.parseLog(x.text);
      assert.ok(!parsed.error && parsed.history.entries.length > 0, x.name + ': a real, parseable log with at least one entry');
      assert.strictEqual(!!x.gov, x.name === P.GOVERNANCE, x.name + ': gov flag only on governance.json');
      if (!x.gov) {
        assert.strictEqual(x.model, man2.parts.find((p) => p.name === x.name).model, x.name + ": the part's own model path");
        assert.strictEqual(x.domain, x.name === 'sales' ? 'Sales' : 'Catalog', x.name + ': its domain');
      }
    }
    // a one-part project (release 1 shape): no governance.json entry, one part
    const soloDir = path.join(scratch, 'merged-history-solo'), solo = P.create({ dir: soloDir, name: 'Solo', user });
    const hsSolo = P.partHistoryTexts(soloDir, P.readManifest(soloDir));
    assert.deepStrictEqual(hsSolo.map((x) => x.name), [path.basename(path.dirname(solo.model))], 'exactly one part, no governance.json entry');

    // projectGoto: undo/redo the single most recent change ACROSS EVERY part (never governance.json — see partHistoryTexts above)
    const salesModel = man2.parts.find((p) => p.name === 'sales').model, catalogModel = man2.parts.find((p) => p.name === 'catalog').model;
    // distinct `at` timestamps, well apart: two different parts' own logs have independent hlc counters, so comparing real wall-clock
    // milliseconds this close together (real Date.now() calls, in a fast synchronous test) is not reliably ordered otherwise
    const editPart = (modelRel, name, at) => {
      const modelPath = path.join(dir, modelRel), histPath = path.join(dir, man2.parts.find((p) => p.name === name).history || `history/${name}.history.jsonl`);
      const F1 = JSON.parse(read(modelPath));
      F1.tables[0].columns.push({ name: 'note', type: 'TEXT' });
      const flat1 = SM.flatten(F1), log1 = SM.parseLog(read(histPath)).history;
      for (const s of SM.STREAMS) SM.commit(log1, s, null, flat1[s], { user: 'Bob', message: `${name}: add note`, at });
      fs.writeFileSync(histPath, SM.logText(log1));
      fs.writeFileSync(modelPath, SM.stringify(F1) + '\n');
    };
    // real, in-the-future timestamps (commit()'s wall clamps up to at least a log's own existing top, so anything in the past could tie
    // with what split() itself just committed a moment before, in real wall-clock time — the far future avoids that ambiguity outright)
    const now = Date.now();
    editPart(salesModel, 'sales', now + 10000); // touched first
    editPart(catalogModel, 'catalog', now + 20000); // touched last: the single most recent change anywhere
    const catalogBefore = read(dir, catalogModel), salesBefore = read(dir, salesModel);
    const catalogHistBefore = read(dir, path.join('history', 'catalog.history.jsonl'));
    const g1 = P.projectGoto(dir, man2, 'undo');
    assert.strictEqual(g1.part, 'catalog', 'the single most recent change anywhere is undone (catalog was edited last)');
    assert.strictEqual(g1.stream, 'modelling');
    assert.notStrictEqual(read(dir, catalogModel), catalogBefore, 'catalog: reverted');
    assert.ok(!JSON.parse(read(dir, catalogModel)).tables[0].columns.some((c) => c.name === 'note'), 'the added column is gone again');
    assert.strictEqual(read(dir, salesModel), salesBefore, 'sales: untouched — only the one most recent change anywhere is undone');
    assert.strictEqual(read(dir, path.join('history', 'catalog.history.jsonl')), catalogHistBefore, 'no new history entry: Undo only moves which recorded content the file holds');
    const g2 = P.projectGoto(dir, man2, 'redo');
    assert.strictEqual(g2.part, 'catalog');
    assert.strictEqual(read(dir, catalogModel), catalogBefore, 'redo restores it byte-for-byte');
    assert.strictEqual(read(dir, path.join('history', 'catalog.history.jsonl')), catalogHistBefore, 'redo too: no new history entry');
    assert.strictEqual(P.projectGoto(dir, man2, 'redo'), null, 'nothing left to redo: every part is back at its own newest recorded content');
    assert.strictEqual(P.projectGoto(dir, { parts: [] }, 'undo'), null, 'no parts at all: nothing to undo');
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log('project check ok');
})().catch((e) => { console.error(e); process.exit(1); });
