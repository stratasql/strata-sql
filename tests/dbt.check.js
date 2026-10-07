// Self-check for the dbt integration (change 31, ADR-0048): lib/dbt.js (reading manifest.json + catalog.json, merging into a Strata model, the plan / apply
// re-sync), `strata-sql import-dbt` (cli.js), the manifest's `dbt` block, a Strata project in / next to a dbt project, and the extension side (the New Project
// wizard and the two commands, through a stubbed vscode). Run: node tests/dbt.check.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), Module = require('module');
const REPO = path.join(__dirname, '..'), FIX = path.join(__dirname, 'fixtures', 'dbt');
const SM = require('../media/model.js');
const P = require('../lib/project.js');
const D = require('../lib/dbt.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-dbt-'));
const user = { name: 'Ada', email: 'ada@x.io', system: 'laptop' };
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8'), J = (...p) => JSON.parse(read(...p));
const MODEL = (stem) => `data_models/${stem}/${stem}.model.json`, HISTORY = (stem) => `history/${stem}.history.jsonl`;
const tree = (dir) => { const out = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p).split(path.sep).join('/')); } })(dir); return out; };
const tab = (F, ref) => F.tables.find((t) => t.schema + '.' + t.name === ref), col = (t, n) => t.columns.find((c) => c.name === n);
const copy = (name) => { const d = path.join(scratch, name); fs.cpSync(FIX, d, { recursive: true }); return d; };
// the files of a project agree with each other: the model matches its log, the log's chain holds, one head per stream
const verify = (dir, stem) => {
  const F = J(dir, MODEL(stem)), log = SM.parseLog(read(dir, HISTORY(stem))).history;
  assert.deepStrictEqual(SM.verify(log, SM.flatten(F)), [], stem + ': the model matches its history and the chain is intact');
  for (const s of SM.STREAMS) assert.ok(SM.headsOf(log, s).length <= 1, s + ': one head');
  return { F, log };
};
// what the editor does for a user edit: canonical file, one version per changed stream, log before model
const userEdit = (modelFile, fn, message = 'User edit') => {
  const r = P.resolve(modelFile), F = JSON.parse(fs.readFileSync(modelFile, 'utf8')), log = SM.parseLog(fs.readFileSync(r.history, 'utf8')).history;
  fn(F);
  const G = SM.toFile(SM.fromFile(F)), flat = SM.flatten(G);
  for (const s of SM.STREAMS) SM.commit(log, s, null, flat[s], { user: 'Ada', email: user.email, message });
  fs.writeFileSync(r.history, SM.logText(log)); fs.writeFileSync(modelFile, SM.stringify(G) + '\n');
};

// ---- reading the artifacts ----
const imp = D.readDbt(FIX);
assert.strictEqual(imp.nodes.length, 12, '7 models + 1 seed + 1 snapshot + 2 sources + raw.jaffle.payments, which a model reads by its compiled name and no source() declares');
assert.deepStrictEqual(imp.nodes.filter((n) => n.type === 'undeclared').map((n) => n.id), ['relation:raw.jaffle.payments']);
assert.deepStrictEqual(imp.skipped, { ephemeral: 1, package: 1, disabled: 0, exposures: 1, metrics: 1, units: 0 }, 'an ephemeral model, a node of an installed package, exposures and metrics are counted, not imported');
assert.ok(imp.notes.filter((n) => !/node-sql-parser/.test(n)).length === 0 && imp.info.project === 'jaffle_shop' && imp.info.adapter === 'snowflake' && imp.info.version === '1.8.2', 'info from the manifest metadata');
assert.strictEqual(D.readDbt(path.join(FIX, 'target', 'manifest.json')).nodes.length, 12, 'the manifest.json itself works');
assert.strictEqual(D.readDbt(path.join(FIX, 'target')).nodes.length, 12, 'and the target folder');
assert.strictEqual(D.readDbt(FIX).info.dbtDir, FIX, 'the dbt project folder is found from the manifest too');
assert.throws(() => D.readDbt(path.join(scratch)), /no dbt_project.yml and no manifest.json/);
{ const bare = path.join(scratch, 'bare-dbt'); fs.mkdirSync(bare); fs.copyFileSync(path.join(FIX, 'dbt_project.yml'), path.join(bare, 'dbt_project.yml'));
  assert.throws(() => D.readDbt(bare), /dbt parse/, 'a dbt project without a compiled manifest is told how to make one (no YAML reading, ADR-0048)');
  assert.throws(() => D.readDbt(path.join(scratch, 'nope')), /does not exist/); }
{ const noCat = copy('no-catalog'); fs.rmSync(path.join(noCat, 'target', 'catalog.json'));
  const r = D.readDbt(noCat); assert.ok(/no catalog\.json/.test(r.notes[0]), 'no catalog.json: a note, the import still works');
  assert.ok(!r.nodes.find((n) => n.name === 'customers').columns.find((c) => c.name === 'customer_id').type, 'and columns have no type (defaulted to STRING later)'); }
const byName = (n) => imp.nodes.find((x) => x.name === n && x.type !== 'source') || imp.nodes.find((x) => x.name === n);
assert.deepStrictEqual(byName('order_items').columns.filter((c) => c.pk).map((c) => c.name), ['order_id', 'product_id'], 'unique_combination_of_columns = a composite primary key');
assert.deepStrictEqual(byName('orders').columns.filter((c) => c.pk).map((c) => c.name), ['order_id'], 'a contract primary_key constraint');
assert.deepStrictEqual(byName('stg_customers').columns.filter((c) => c.pk).map((c) => c.name), ['customer_id'], 'unique + not_null = primary key');
assert.ok(byName('orders').rels.length === 1 && byName('orders').rels[0].to === 'model.jaffle_shop.customers', 'a relationship test into an ephemeral model is dropped, the other kept');

// ---- versions of dbt's artifacts (ADR-0050). The fixtures in tests/fixtures/dbt-versions are HAND-BUILT from knowledge of each era's manifest shape, not real dbt output ----
{
  const VFIX = path.join(__dirname, 'fixtures', 'dbt-versions'), vdir = (era) => path.join(VFIX, era, 'target');
  const ver = (era) => { const i = D.readDbt(vdir(era)); return { i, r: D.merge(D.fresh(i, 'V'), i) }; };
  const tn = (i, n) => i.nodes.find((x) => x.name === n && x.type !== 'source') || i.nodes.find((x) => x.name === n);
  const ok = (msg, c) => assert.ok(c, msg);
  const eras = { v2: [2, '0.20.2'], v4: [4, '1.0.9'], v7: [7, '1.3.5'], v9: [9, '1.5.9'], v11: [11, '1.7.14'], v12: [12, '1.9.2'], v13: [13, '1.12.0'], fusion: [12, '2.0.0-preview.45'] };
  for (const [era, [v, dv]] of Object.entries(eras)) { // what every era must give: the tables, the keys from tests, the relationship, the SQL-derived report columns, the read note
    const { i, r } = ver(era);
    assert.strictEqual(i.info.schema.manifest, v, era + ': schema version detected');
    ok(era + ': the read note names the schema and the dbt version', r.notes[0].startsWith(`read: manifest v${v} (dbt ${dv}`));
    ok(era + ': the models and sources are all there', ['stg_orders', 'customers', 'orders_report', 'orders'].every((n) => tn(i, n)));
    assert.deepStrictEqual(tn(i, 'stg_orders').columns.filter((c) => c.pk).map((c) => c.name), ['id'], era + ': unique + not_null = primary key (tests found without attached_node too)');
    ok(era + ': the relationships test', tn(i, 'stg_orders').rels.some((x) => x.col === 'customer_id' && x.to === 'model.shop.customers' && x.field === 'id'));
    assert.deepStrictEqual(tn(i, 'orders_report').columns.map((c) => c.name), ['name', 'revenue'], era + ': columns from the SQL (raw_sql / raw_code both read)');
    ok(era + ': the view definition is the SQL with ref() replaced', /from public\.stg_orders o join public\.customers c/.test(tn(i, 'orders_report').sql.replace(/\s+/g, ' ')));
  }
  // 0.20 (schema v2): raw_sql, no project_name, no adapter_type, no attached_node, a disabled model still in nodes
  { const { i, r } = ver('v2');
    assert.strictEqual(i.info.project, 'shop', 'no project_name: the package with the most models is the project');
    assert.strictEqual(D.fresh(i, 'V').project.technology, 'PostgreSQL', 'no adapter: PostgreSQL');
    assert.strictEqual(i.skipped.disabled, 1); ok('a disabled node is not imported', !i.nodes.some((n) => n.name === 'old_disabled'));
    ok('a very old schema is called out', r.notes.some((n) => /schema v2 \(dbt before 1\.0\)/.test(n))); }
  // dbt 1.0: metrics as {type: sum, sql, model}
  { const { r } = ver('v4'); assert.deepStrictEqual(r.F.semantic.metrics.filter((x) => !x.dbt.derived).map((x) => [x.name, x.aggregation, x.calculation]), [['Total amount', 'sum', 'public.stg_orders.amount']], 'dbt 1.0 metric shape'); }
  // dbt 1.3: calculation_method metrics (incl. the old derived expression), a Python model
  { const { i, r } = ver('v7'); const m = Object.fromEntries(r.F.semantic.metrics.filter((x) => !x.dbt.derived).map((x) => [x.name, x]));
    assert.deepStrictEqual([m['Orders'].aggregation, m['Total amount'].aggregation, m['Average order'].aggregation], ['count_distinct', 'sum', 'none'], 'dbt 1.3 metric shapes');
    assert.strictEqual(m['Average order'].calculation, '{Total amount} / {Orders}', 'an old derived metric names other metrics');
    assert.strictEqual(tn(i, 'py_scores').columns[0].type, 'int'); ok('a Python model has no SQL and says so', r.notes.some((n) => /1 Python model/.test(n) && /py_scores/.test(n))); }
  // dbt 1.5: a catalog, groups, model versions (ref('x') = the latest, ref('x', v=1) = that one), contract primary key
  { const { r } = ver('v9'); const T = (n) => r.F.tables.find((t) => t.name === n);
    assert.deepStrictEqual(T('stg_orders').columns.map((c) => c.type), ['INTEGER', 'INTEGER', 'NUMERIC'], 'catalog v1 types');
    assert.deepStrictEqual(T('latest_customers').dbt.depends_on, ['public.dim_customers_v2'], 'ref() of a versioned model is its latest version');
    assert.deepStrictEqual(T('pinned_customers').dbt.depends_on, ['public.dim_customers_v1'], "ref('x', v=1) is version 1");
    assert.strictEqual(T('customers').governance.owner, 'Finance Team', 'group owner'); assert.ok(T('dim_customers_v1').columns[0].pk, 'a contract primary_key'); }
  // dbt 1.7: the MetricFlow semantic layer; conversion metrics and saved queries are counted, not guessed
  { const { i, r } = ver('v11'); const m = Object.fromEntries(r.F.semantic.metrics.filter((x) => !x.dbt.derived).map((x) => [x.name, x]));
    assert.deepStrictEqual([m['Revenue'].aggregation, m['Revenue'].calculation], ['sum', 'public.stg_orders.amount']); assert.ok(/dbt filter:/.test(m['Revenue'].description));
    assert.strictEqual(m['Revenue ratio'].calculation, '{Revenue} / {Revenue}');
    assert.deepStrictEqual([i.skipped.exposures, i.skipped.metrics], [1, 2], 'a conversion metric and a saved query are counted');
    assert.strictEqual(r.F.relationships.filter((x) => x.child === 'public.stg_orders.customer_id').length, 1, 'the test and the semantic entity say the same: one relationship');
    assert.strictEqual(r.F.tables.find((t) => t.name === 'stg_orders').dbt.semantic.entities.length, 2); }
  // dbt 1.9: unit tests and disabled nodes are counted; column config tags / meta
  { const { i, r } = ver('v12'); assert.deepStrictEqual([i.skipped.units, i.skipped.disabled], [1, 1]); ok('and reported', r.notes.some((n) => /1 disabled node, 1 unit test/.test(n)));
    const c = r.F.tables.find((t) => t.name === 'customers' && t.schema === 'public').columns.find((x) => x.name === 'name'); assert.deepStrictEqual(c.tags, ['pii'], 'column config.tags'); }
  // a schema newer than the reader knows: a warning, everything it recognises is still read, unknown resource types and keys are ignored
  { const { i, r } = ver('v13'); ok('a newer schema is a warning', r.notes.some((n) => /schema v13, newer than the newest this reader knows \(v12/.test(n))); assert.strictEqual(i.nodes.length, 5, 'and the rest is read'); }
  // Fusion
  { const { i, r } = ver('fusion'); assert.ok(i.info.schema.fusion && r.notes.some((n) => /dbt Fusion manifest/.test(n))); }
  // catalog: an unknown version and one older than the manifest are called out
  { const d = path.join(scratch, 'v9cat'); fs.cpSync(path.join(VFIX, 'v9'), d, { recursive: true });
    const c = J(d, 'target/catalog.json'); c.metadata.dbt_schema_version = 'https://schemas.getdbt.com/dbt/catalog/v99.json'; c.metadata.generated_at = '2024-05-01T07:00:00.000000Z'; fs.writeFileSync(path.join(d, 'target/catalog.json'), JSON.stringify(c));
    const r = D.readDbt(path.join(d, 'target')); ok('unknown catalog schema', r.notes.some((n) => /catalog\.json is schema v99/.test(n))); ok('a catalog older than the manifest', r.notes.some((n) => /catalog\.json \(.*\) is older than manifest\.json/.test(n))); }
  // tolerance: odd or missing sections never throw
  { const d = path.join(scratch, 'odd'); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ metadata: {}, nodes: { 'model.p.a': { resource_type: 'model', name: 'a', package_name: 'p', schema: 's', columns: null, config: null, depends_on: null, raw_sql: 'select 1 as x' }, x: null, y: 'text', 'model.p.b': { resource_type: 'model', name: 'b', package_name: 'p', schema: 's' } }, sources: { s: { name: 't' } }, metrics: [], semantic_models: null, groups: [], exposures: null, disabled: { 'model.p.c': null } }));
    const r = D.readDbt(d); assert.deepStrictEqual(r.nodes.filter((n) => n.type === 'model').map((n) => n.name).sort(), ['a', 'b']); assert.deepStrictEqual(tn(r, 'a').columns.map((c) => c.name), ['x'], 'raw_sql read, null sections ignored');
    ok('no schema version: said so', r.notes.some((n) => /no metadata\.dbt_schema_version/.test(n))); D.merge(D.fresh(r, 'Odd'), r); }
  // a manifest older than the files it came from
  { const d = path.join(scratch, 'stale'); fs.cpSync(path.join(FIX, 'target'), path.join(d, 'target'), { recursive: true }); fs.copyFileSync(path.join(FIX, 'dbt_project.yml'), path.join(d, 'dbt_project.yml'));
    ok('a fresh project has no such note', !D.readDbt(d).notes.some((n) => /is older than/.test(n)));
    fs.mkdirSync(path.join(d, 'models')); fs.writeFileSync(path.join(d, 'models', 'new.sql'), 'select 1'); const later = new Date(Date.now() + 60000); fs.utimesSync(path.join(d, 'models', 'new.sql'), later, later);
    ok('a newer model file: run dbt parse again', D.readDbt(d).notes.some((n) => /manifest\.json is older than models\/new\.sql/.test(n))); }
  // several packages and no project name: the biggest is taken, and it says so
  { const d = path.join(scratch, 'pkgs'); fs.cpSync(vdir('v2'), d, { recursive: true }); const m = J(d, 'manifest.json'); m.nodes['model.dbt_utils.helper'] = { ...m.nodes['model.shop.customers'], unique_id: 'model.dbt_utils.helper', name: 'helper', package_name: 'dbt_utils' };
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m)); const r = D.readDbt(d); assert.strictEqual(r.info.project, 'shop'); ok('the guess is reported', r.notes.some((n) => /does not name its project: "shop"/.test(n))); ok('the other package is skipped', !r.nodes.some((n) => n.name === 'helper')); }
}

// ---- a new project from dbt ----
const dry = path.join(scratch, 'new'); fs.mkdirSync(dry);
let r = D.importNew({ from: FIX, dir: dry, name: 'Jaffle Shop', user, dryRun: true });
assert.deepStrictEqual(fs.readdirSync(dry), [], 'a dry run writes nothing');
assert.ok(/^12 tables added, 41 columns added, 5 relationships added, 9 tags added, 3 metrics added, 5 schemas added, 2 catalogs added$/.test(r.headline), r.headline);
const beforeF = JSON.stringify(D.fresh(imp, 'X')); D.merge(D.fresh(imp, 'X'), imp); assert.strictEqual(JSON.stringify(D.fresh(imp, 'X')), beforeF, 'merge does not touch its input');
const written = [], realRename = fs.renameSync;
fs.renameSync = (a, b) => { written.push(path.basename(b)); return realRename(a, b); };
r = D.importNew({ from: FIX, dir: dry, name: 'Jaffle Shop', user });
fs.renameSync = realRename;
assert.ok(written.indexOf('jaffle-shop.history.jsonl') >= 0 && written.indexOf('jaffle-shop.history.jsonl') < written.indexOf('jaffle-shop.model.json'), 'the first history entry is written before the model');
assert.deepStrictEqual(tree(dry), ['.gitattributes', '.gitignore', MODEL('jaffle-shop'), HISTORY('jaffle-shop'), 'strata.project.json'], 'the standard project tree, nothing else');
let { F, log } = verify(dry, 'jaffle-shop');
assert.strictEqual(r.model, path.join(dry, MODEL('jaffle-shop')));
assert.deepStrictEqual(SM.toFile(SM.fromFile(F)), F, 'round trip stable: fromFile(toFile(m)) is the same file');
assert.strictEqual(read(dry, MODEL('jaffle-shop')), SM.stringify(F) + '\n', 'the file is written the way the editor writes it');
assert.strictEqual(F.project.technology, 'Snowflake'); assert.strictEqual(F.project.naming, 'catalog.schema.table'); assert.strictEqual(F.project.name, 'Jaffle Shop');
assert.deepStrictEqual(F.catalogs.map((c) => c.name), ['ANALYTICS', 'RAW']); assert.strictEqual(F.schemas.length, 5); assert.strictEqual(F.tables.length, 12);
assert.deepStrictEqual(log.entries.map((e) => [e.id, e.stream, e.user]), [['m1', 'modelling', 'Ada'], ['g1', 'governance', 'Ada'], ['s1', 'semantic', 'Ada']], 'one entry per stream: the model, the tags, the metrics');
assert.ok(log.entries.every((e) => /^Import from dbt: 12 tables added/.test(e.message)));
assert.deepStrictEqual(SM.verifyLog(log), []);
// tables: kinds, types, keys, tags, governance, properties, unknown things kept
const customers = tab(F, 'ANALYTICS.MARTS.customers'), orders = tab(F, 'ANALYTICS.MARTS.orders'), items = tab(F, 'ANALYTICS.MARTS.order_items'), payments = tab(F, 'ANALYTICS.STAGING.stg_payments');
assert.deepStrictEqual(customers.dbt, { id: 'model.jaffle_shop.customers', type: 'model', materialized: 'table', path: 'models/marts/customers.sql', metricsDerived: true, tags: ['daily', 'marts'] }, 'the dbt unique_id (and more) is an ordinary key on the table');
assert.strictEqual(customers.description, 'One row per customer with their order history.'); assert.deepStrictEqual(customers.tags, ['daily', 'marts']);
assert.deepStrictEqual(customers.governance, { owner: 'Growth Team', steward: 'Data Office', classification: 'Internal', criticality: 'High', lifecycle: 'Active' }, 'meta -> governance (values matched to the allowed ones, owner from the dbt group)');
assert.deepStrictEqual(customers.properties, { dbt_team: '{"name":"growth","slack":"#growth"}', dbt_sensitivity: 'secret-ish' }, 'the other meta is kept as dbt_ properties (nested values as JSON), never dropped');
assert.deepStrictEqual(col(customers, 'customer_id'), { name: 'customer_id', type: 'NUMBER(38,0)', description: 'Primary key of the customer.', pk: true }, 'a column: catalog type, description, key');
assert.ok(col(customers, 'LOADED_AT') && col(customers, 'LOADED_AT').type === 'TIMESTAMP_NTZ', 'a column only the warehouse knows (catalog.json) is imported too');
assert.deepStrictEqual(col(customers, 'email'), { name: 'email', type: 'TEXT', description: 'Contact address.', notNull: true, tags: ['pii'], governance: { classification: 'Confidential' }, dbt: { tags: ['pii'] } });
assert.strictEqual(tab(F, 'ANALYTICS.STAGING.stg_customers').kind, 'view'); assert.ok(/from raw\.jaffle\.customers/.test(tab(F, 'ANALYTICS.STAGING.stg_customers').definition), 'a view keeps its compiled SQL');
const mv = tab(F, 'ANALYTICS.MARTS.mv_daily_revenue'); assert.ok(mv.kind === 'view' && mv.viewType === 'materialized', 'a materialized view');
assert.ok(!orders.kind && orders.dbt.materialized === 'incremental'); assert.deepStrictEqual(orders.governance, { owner: 'Finance Analytics' }); assert.deepStrictEqual(orders.properties, { dbt_domain: 'sales' });
assert.deepStrictEqual(items.columns.filter((c) => c.pk).map((c) => c.name), ['order_id', 'product_id']);
assert.ok(payments.columns.every((c) => c.type === 'STRING') && r.notes.some((n) => /5 columns had no type/.test(n)), 'no catalog entry: STRING, and a note says so');
assert.strictEqual(tab(F, 'ANALYTICS.RAW_SEEDS.country_codes').dbt.type, 'seed'); assert.strictEqual(tab(F, 'ANALYTICS.SNAPSHOTS.orders_snapshot').dbt.type, 'snapshot'); assert.strictEqual(tab(F, 'RAW.JAFFLE.customers').dbt.type, 'source');
assert.ok(!F.tables.some((t) => /int_orders_pivoted|fct_x/.test(t.name)), 'the ephemeral model and the package model are not imported');
assert.ok(r.notes.some((n) => /1 ephemeral model, 1 node of an installed package, 1 exposure, 1 saved query or metric/.test(n)), 'and the note says what was left out');
// relationships from tests, tags as definitions
assert.deepStrictEqual(F.relationships, [
  { parent: 'ANALYTICS.MARTS.customers.customer_id', child: 'ANALYTICS.MARTS.orders.customer_id', cardinality: '1..M' },
  { parent: 'ANALYTICS.MARTS.orders.order_id', child: 'ANALYTICS.MARTS.order_items.order_id', cardinality: '1..M' },
  { parent: 'ANALYTICS.STAGING.stg_customers.customer_id', child: 'ANALYTICS.STAGING.stg_orders.customer_id', cardinality: '1..M' },
  { parent: 'ANALYTICS.STAGING.stg_orders.order_id', child: 'ANALYTICS.STAGING.stg_payments.order_id', cardinality: '1..M' },
  { parent: 'RAW.JAFFLE.customers.id', child: 'RAW.JAFFLE.orders.user_id', cardinality: '1..M' }], 'relationships tests -> foreign keys, ref() and source() both');
assert.deepStrictEqual(F.governance.tags.map((t) => t.name), ['daily', 'dbt-derived', 'finance', 'history', 'marts', 'nightly', 'pii', 'raw', 'staging']); assert.ok(F.governance.tags.every((t) => t.enabled && (t.name === 'dbt-derived' || t.description === 'Imported from dbt')));
// the same file through the model: no warnings, the skill script agrees
{ const m = SM.fromFile(F); assert.deepStrictEqual(m.warnings, []); assert.deepStrictEqual(m.dangling, [], 'every relationship resolves'); }
{ const v = cp.spawnSync('node', [path.join(REPO, '.claude/skills/strata-model/scripts/strata.js'), 'validate', r.model], { encoding: 'utf8' }); assert.strictEqual(v.status, 0, v.stdout + v.stderr); assert.ok(/no problems/.test(v.stdout), v.stdout); }
// the manifest's dbt block
let man = J(dry, 'strata.project.json');
assert.deepStrictEqual(Object.keys(man.dbt), ['project', 'manifest', 'catalog', 'lastSync']); assert.strictEqual(path.resolve(dry, man.dbt.manifest), path.join(FIX, 'target', 'manifest.json')); assert.strictEqual(path.resolve(dry, man.dbt.catalog), path.join(FIX, 'target', 'catalog.json')); assert.strictEqual(path.resolve(dry, man.dbt.project), FIX);
assert.ok(!isNaN(Date.parse(man.dbt.lastSync)));
assert.strictEqual(man.parts.length, 1);

// ---- idempotent re-sync ----
const model = path.join(dry, MODEL('jaffle-shop')), snap = () => [model, path.join(dry, HISTORY('jaffle-shop')), path.join(dry, 'strata.project.json')].map((f) => [fs.readFileSync(f, 'utf8'), fs.statSync(f).mtimeMs]);
const s0 = snap();
let p = D.plan(model); assert.strictEqual(p.changes.length, 0, 'nothing changed in dbt: nothing to do'); assert.strictEqual(p.headline, 'no changes');
let s = D.sync(model, { user }); assert.deepStrictEqual(s.entries || [], []); assert.deepStrictEqual(snap(), s0, 'and nothing was written: not the model, not the log, not the manifest (lastSync stays)');
assert.deepStrictEqual(D.plan(model, { from: FIX }).changes, [], 'also when asked with an explicit folder');

// ---- the user's own work, then dbt changes: a re-sync adds and updates, deletes and overwrites nothing else ----
fs.writeFileSync(path.join(dry, 'data_models/jaffle-shop/jaffle-shop.model.layout.json'), JSON.stringify({ strata: 'layout/1', positions: { physical: { 'ANALYTICS.MARTS.customers': [10, 20] } } }));
userEdit(model, (G) => {
  const c = tab(G, 'ANALYTICS.MARTS.customers'), o = tab(G, 'ANALYTICS.MARTS.orders'), st = tab(G, 'ANALYTICS.STAGING.stg_customers');
  st.displayName = 'Customers (staging)'; st.sla = { frequency: 'daily', time: '02:00' };
  G.conceptual = { concepts: [{ name: 'Customer', description: 'A person or company that buys.' }] }; G.logical = { entities: [{ name: 'Customer', concept: 'Customer' }] };
  c.entity = 'Customer'; c.tags.push('my_tag'); G.governance.tags.push({ name: 'my_tag', description: 'Mine', enabled: true });
  c.columns.push({ name: 'ltv', type: 'DECIMAL(10,2)', description: 'User added' }); col(c, 'first_name').description = 'User note';
  G.tables.push({ name: 'scratch_notes', schema: 'ANALYTICS.MARTS', columns: [{ name: 'id', type: 'INT', pk: true }] });
  o.governance = { owner: 'Someone Else' }; o.properties.team_note = 'ours';
  G.semantic = { metrics: [{ name: 'Revenue', calculation: 'sum(ANALYTICS.MARTS.orders.amount)', aggregation: 'sum' }] };
  G.relationships.push({ parent: 'ANALYTICS.MARTS.customers.customer_id', child: 'ANALYTICS.MARTS.scratch_notes.id', cardinality: '1..1' });
}, 'Model the customer');
verify(dry, 'jaffle-shop');
const layoutBefore = read(dry, 'data_models/jaffle-shop/jaffle-shop.model.layout.json'), entriesBefore = SM.parseLog(read(dry, HISTORY('jaffle-shop'))).history.entries.length;
// dbt moves on: a new model (with tests), a changed description and type, a new column, a dropped tag, a new owner, a new tag, a removed model
const dbt2 = copy('dbt2'), mf = J(dbt2, 'target/manifest.json'), cf = J(dbt2, 'target/catalog.json');
const N = mf.nodes, cid = (n) => `model.jaffle_shop.${n}`;
N[cid('customers')].description = 'One row per customer, with lifetime value.';
cf.nodes[cid('orders')].columns.AMOUNT.type = 'NUMBER(20,2)'; cf.nodes[cid('orders')].columns.DISCOUNT = { type: 'NUMBER(18,2)', index: 6, name: 'DISCOUNT' };
N[cid('orders')].columns.discount = { name: 'discount', description: 'Discount applied.', meta: {}, tags: [], constraints: [] };
N[cid('orders')].tags = ['marts']; N[cid('orders')].meta = { owner: 'New Owner', domain: 'sales' };
N[cid('stg_orders')].tags = ['staging', 'reviewed'];
for (const k of Object.keys(N)) if (k === cid('stg_payments') || (N[k].attached_node === cid('stg_payments'))) delete N[k];
N[cid('refunds')] = { ...JSON.parse(JSON.stringify(N[cid('order_items')])), name: 'refunds', alias: 'refunds', unique_id: cid('refunds'), description: 'Refunded orders.', original_file_path: 'models/marts/refunds.sql', constraints: [],
  columns: { refund_id: { name: 'refund_id', description: 'Key.', meta: {}, tags: [], constraints: [] }, order_id: { name: 'order_id', description: '', meta: {}, tags: [], constraints: [] }, amount: { name: 'amount', description: '', meta: {}, tags: [], constraints: [] } } };
const T2 = (name, at, column, kw, deps) => ({ resource_type: 'test', package_name: 'jaffle_shop', name, column_name: column, attached_node: at, depends_on: { nodes: deps || [at] }, test_metadata: { name: kw.test, kwargs: { column_name: column, ...kw.args } } });
N['test.jaffle_shop.u_refunds'] = T2('u', cid('refunds'), 'refund_id', { test: 'unique' }); N['test.jaffle_shop.n_refunds'] = T2('n', cid('refunds'), 'refund_id', { test: 'not_null' });
N['test.jaffle_shop.r_refunds'] = T2('r', cid('refunds'), 'order_id', { test: 'relationships', args: { to: "ref('orders')", field: 'order_id' } }, [cid('orders'), cid('refunds')]);
cf.nodes[cid('refunds')] = { columns: { REFUND_ID: { type: 'NUMBER(38,0)', index: 1, name: 'REFUND_ID' }, ORDER_ID: { type: 'NUMBER(38,0)', index: 2, name: 'ORDER_ID' }, AMOUNT: { type: 'NUMBER(18,2)', index: 3, name: 'AMOUNT' } } };
fs.writeFileSync(path.join(dbt2, 'target/manifest.json'), JSON.stringify(mf)); fs.writeFileSync(path.join(dbt2, 'target/catalog.json'), JSON.stringify(cf));
p = D.plan(model, { from: dbt2 });
const lines = p.lines.join('\n');
assert.ok(/\+ table ANALYTICS\.MARTS\.refunds \(dbt model, 3 columns\)/.test(lines) && /\+ relationship ANALYTICS\.MARTS\.orders\.order_id -> ANALYTICS\.MARTS\.refunds\.order_id/.test(lines), 'the preview lists the new table and its relationship: ' + lines);
assert.ok(/~ table ANALYTICS\.MARTS\.customers: description/.test(lines) && /~ column ANALYTICS\.MARTS\.orders\.amount \(type NUMBER\(18,2\) -> NUMBER\(20,2\)\)/.test(lines) && /\+ column ANALYTICS\.MARTS\.orders\.discount/.test(lines), 'and what dbt changed: ' + lines);
assert.ok(/~ table ANALYTICS\.STAGING\.stg_orders: tags/.test(lines) && /\+ tag reviewed/.test(lines) && /~ table ANALYTICS\.MARTS\.orders: tags/.test(lines));
assert.ok(p.notes.some((n) => /no longer in dbt, kept in Strata SQL: ANALYTICS\.STAGING\.stg_payments/.test(n)), 'a table that left dbt is reported and kept');
assert.strictEqual(read(dry, MODEL('jaffle-shop')), read(model), 'planning writes nothing'); assert.strictEqual(SM.parseLog(read(dry, HISTORY('jaffle-shop'))).history.entries.length, entriesBefore);
s = D.sync(model, { user, from: dbt2 });
({ F, log } = verify(dry, 'jaffle-shop'));
assert.deepStrictEqual(SM.toFile(SM.fromFile(F)), F, 'still round trip stable');
assert.strictEqual(log.entries.length, entriesBefore + 3, 'one entry per changed stream, made from the current version');
const added = log.entries.slice(-3); assert.deepStrictEqual(added.map((e) => e.stream).sort(), ['governance', 'modelling', 'semantic']); assert.ok(added.every((e) => /^Sync from dbt: 1 table added/.test(e.message) && e.user === 'Ada'));
assert.ok(SM.changesOf(log, added.find((e) => e.stream === 'modelling')).items.some((i) => i.op === '+' && i.k === 'table:ANALYTICS.MARTS.refunds'), 'the history shows the new table as an addition');
// dbt-owned fields updated
assert.strictEqual(tab(F, 'ANALYTICS.MARTS.customers').description, 'One row per customer, with lifetime value.'); assert.strictEqual(col(tab(F, 'ANALYTICS.MARTS.orders'), 'amount').type, 'NUMBER(20,2)');
assert.deepStrictEqual(col(tab(F, 'ANALYTICS.MARTS.orders'), 'discount'), { name: 'discount', type: 'NUMBER(18,2)', description: 'Discount applied.' }, 'a new column: the spelling of the properties file, the type of the warehouse');
const o2 = tab(F, 'ANALYTICS.MARTS.orders'); assert.deepStrictEqual(o2.tags, ['marts'], 'a tag dbt dropped is removed from the object it came from'); assert.deepStrictEqual(tab(F, 'ANALYTICS.STAGING.stg_orders').tags, ['reviewed', 'staging']);
assert.ok(F.governance.tags.some((t) => t.name === 'reviewed') && F.governance.tags.some((t) => t.name === 'finance'), 'a new tag gets a definition; an old definition is never removed');
const rf = tab(F, 'ANALYTICS.MARTS.refunds'); assert.ok(rf && rf.dbt.id === 'model.jaffle_shop.refunds' && col(rf, 'refund_id').pk && col(rf, 'amount').type === 'NUMBER(18,2)');
assert.ok(F.relationships.some((x) => x.parent === 'ANALYTICS.MARTS.orders.order_id' && x.child === 'ANALYTICS.MARTS.refunds.order_id'), 'and its foreign key');
// Strata-owned work untouched
const cs = tab(F, 'ANALYTICS.MARTS.customers');
assert.strictEqual(tab(F, 'ANALYTICS.STAGING.stg_customers').displayName, 'Customers (staging)'); assert.deepStrictEqual(tab(F, 'ANALYTICS.STAGING.stg_customers').sla, { frequency: 'daily', time: '02:00' });
assert.deepStrictEqual(F.conceptual.concepts.map((c) => c.name), ['Customer']); assert.strictEqual(F.logical.entities[0].concept, 'Customer'); assert.strictEqual(cs.entity, 'Customer', 'concepts, entities and the table -> entity link');
assert.ok(cs.tags.includes('my_tag') && cs.tags.includes('daily') && F.governance.tags.some((t) => t.name === 'my_tag' && t.description === 'Mine'), 'the user\'s tag on a dbt table stays');
assert.deepStrictEqual(col(cs, 'ltv'), { name: 'ltv', type: 'DECIMAL(10,2)', description: 'User added' }, 'a column dbt does not know stays'); assert.strictEqual(col(cs, 'first_name').description, 'User note', 'dbt has no description: the user\'s stays');
assert.ok(tab(F, 'ANALYTICS.MARTS.scratch_notes') && !tab(F, 'ANALYTICS.MARTS.scratch_notes').dbt, 'a table dbt does not know stays, without a dbt id');
assert.deepStrictEqual(o2.governance, { owner: 'Someone Else' }, 'a governance value the user set is not overwritten by meta'); assert.strictEqual(o2.properties.team_note, 'ours');
assert.deepStrictEqual(F.semantic.metrics.map((m) => m.name), ['Amount (refunds)', 'Revenue'], 'the user\'s Revenue is untouched; the new table got its starter metric'); assert.ok(!F.semantic.metrics.find((m) => m.name === 'Revenue').dbt, 'and the user\'s metric was not turned into a dbt one'); assert.ok(F.relationships.some((x) => x.child === 'ANALYTICS.MARTS.scratch_notes.id' && x.cardinality === '1..1'), 'the user\'s metric and relationship');
assert.ok(tab(F, 'ANALYTICS.STAGING.stg_payments') && tab(F, 'ANALYTICS.STAGING.stg_payments').dbt.id, 'the table that left dbt is still there');
assert.strictEqual(read(dry, 'data_models/jaffle-shop/jaffle-shop.model.layout.json'), layoutBefore, 'the layout file is not touched');
assert.ok(J(dry, 'strata.project.json').dbt.manifest.endsWith('dbt2/target/manifest.json'), 'the manifest\'s dbt block follows the folder used last');
assert.deepStrictEqual(D.plan(model).changes, [], 'and a second sync is a no-op again');
// a sync from the stored paths, no --from
p = D.plan(model); assert.strictEqual(p.info.manifest, path.join(dbt2, 'target', 'manifest.json'));

// ---- refusals: never rewrite history silently, never guess ----
{ const d = path.join(scratch, 'drift'); const r0 = D.importNew({ from: FIX, dir: d, name: 'Drift', user });
  const orig0 = read(r0.model), F0 = JSON.parse(orig0); F0.tables[0].description = 'edited outside Strata'; fs.writeFileSync(r0.model, SM.stringify(F0) + '\n');
  assert.throws(() => D.plan(r0.model), /differs from its version log/, 'a model changed without its history: import refuses (open it in Strata and record it first)');
  fs.writeFileSync(r0.model, orig0); // back to the recorded content: fine again
  D.plan(r0.model);
  fs.writeFileSync(path.join(d, HISTORY('drift')), read(d, HISTORY('drift')) + '{not json\n'); assert.throws(() => D.plan(r0.model), /unreadable/); }
{ const d = path.join(scratch, 'multi'); const r0 = D.importNew({ from: FIX, dir: d, name: 'Multi', user }); const m = J(d, 'strata.project.json'); m.parts.push({ name: 'other', model: 'x.model.json' }); fs.writeFileSync(path.join(d, 'strata.project.json'), JSON.stringify(m));
  assert.throws(() => D.plan(r0.model), /one part/, 'a project split into domains is refused, not half-imported'); }
assert.throws(() => D.plan(path.join(dry, 'data_models/jaffle-shop/jaffle-shop.archived.model.json'), { from: FIX }), /archived/);
{ const d = path.join(scratch, 'nodbt'); const r0 = P.create({ dir: d, name: 'Plain', user }); assert.throws(() => D.plan(r0.model), /no dbt project given/, 'no dbt block and no --from: says what is missing'); }
// no history file at all: a baseline entry first, so what was there before the import is still a version
{ const d = path.join(scratch, 'nohist'); const r0 = D.importNew({ from: FIX, dir: d, name: 'No Hist', user }); const hp = path.join(d, HISTORY('no-hist'));
  const F0 = J(r0.model); F0.tables = F0.tables.filter((t) => t.name !== 'orders_snapshot'); delete F0.relationships; fs.writeFileSync(r0.model, SM.stringify(SM.toFile(SM.fromFile(F0))) + '\n'); fs.rmSync(hp);
  const ps = D.plan(r0.model); assert.ok(ps.baseline && ps.changes.length); D.apply(ps, { user });
  const lg = verify(d, 'no-hist').log; assert.ok(lg.entries.some((e) => e.message === 'Baseline before the first dbt import') && lg.entries.at(-1).message.startsWith('Sync from dbt'), 'baseline first, then the sync'); }

// ---- adopting a model that already exists (2-part platform, a hand-made table with the same name) ----
{ const d = path.join(scratch, 'adopt'); const r0 = P.create({ dir: d, name: 'Mine', platform: 'PostgreSQL', user });
  userEdit(r0.model, (G) => { G.schemas.push({ name: 'MARTS' }); G.tables.push({ name: 'customers', schema: 'marts', description: 'Hand made', columns: [{ name: 'customer_id', type: 'INT', description: 'Hand made key' }, { name: 'nickname', type: 'TEXT' }] }); G.schemas[0].name === 'public'; }, 'A first table');
  const F0 = J(r0.model); assert.ok(F0.schemas.some((x) => x.name === 'marts' || x.name === 'MARTS'));
  const res = D.sync(r0.model, { from: FIX, user }); const { F: G } = verify(d, 'mine');
  const c = G.tables.filter((t) => t.name === 'customers' && /marts/i.test(t.schema));
  assert.strictEqual(c.length, 1, 'the same schema.name is adopted, not duplicated (case-insensitive)'); assert.strictEqual(c[0].dbt.id, 'model.jaffle_shop.customers'); assert.ok(col(c[0], 'nickname'), 'its own column stays');
  assert.strictEqual(col(c[0], 'customer_id').description, 'Primary key of the customer.', 'dbt owns descriptions'); assert.strictEqual(col(c[0], 'customer_id').type, 'NUMBER(38,0)', 'and types'); assert.ok(!G.catalogs, 'a 2-part project keeps 2-part naming: no catalogs');
  assert.ok(G.tables.every((t) => !t.schema.includes('.')), 'schema only'); assert.ok(res.headline); }

// ---- a Strata project in, and next to, a dbt project ----
{ const root = copy('coexist'); const before = ['dbt_project.yml', 'target/manifest.json', 'target/catalog.json'].map((f) => read(root, f));
  const r0 = D.importNew({ from: root, dir: root, name: 'Jaffle', user });
  assert.deepStrictEqual(tree(root).filter((f) => !f.startsWith('target/') && f !== 'dbt_project.yml'), ['.gitattributes', '.gitignore', MODEL('jaffle'), HISTORY('jaffle'), 'strata.project.json'], 'Strata adds its own files beside the dbt project; data_models/ does not touch dbt\'s models/');
  assert.deepStrictEqual(['dbt_project.yml', 'target/manifest.json', 'target/catalog.json'].map((f) => read(root, f)), before, 'and never touches a dbt file');
  const rs = P.resolve(r0.model, { stop: root }); assert.strictEqual(rs.root, root); assert.strictEqual(rs.history, path.join(root, HISTORY('jaffle'))); assert.ok(rs.manifest && rs.listed);
  assert.deepStrictEqual(J(root, 'strata.project.json').dbt, { project: '.', manifest: 'target/manifest.json', catalog: 'target/catalog.json', lastSync: J(root, 'strata.project.json').dbt.lastSync }, 'paths in the dbt block are relative to the manifest');
  assert.ok(read(root, '.gitignore').split('\n').includes('.strata/'));
  const g = path.join(root, '.gitignore'); fs.writeFileSync(g, 'target/\ndbt_packages/\n' + read(root, '.gitignore')); // a dbt .gitignore is appended to, never replaced
  assert.strictEqual(D.plan(r0.model).changes.length, 0, 'the stored paths find the artifacts again'); }
{ const mono = path.join(scratch, 'mono'); fs.mkdirSync(mono); fs.cpSync(FIX, path.join(mono, 'dbt'), { recursive: true });
  const r0 = D.importNew({ from: path.join(mono, 'dbt'), dir: mono, name: 'Jaffle', user });
  assert.strictEqual(J(mono, 'strata.project.json').dbt.project, 'dbt'); assert.strictEqual(P.resolve(r0.model, { stop: mono }).root, mono, 'a project next to the dbt project resolves too');
  const nested = path.join(mono, 'dbt', 'target', 'manifest.json'); const m2 = J(nested); m2.nodes['model.jaffle_shop.customers'].description = 'Changed.'; fs.writeFileSync(nested, JSON.stringify(m2));
  const ps = D.plan(r0.model, { stop: mono }); assert.ok(ps.lines.some((l) => /customers: description/.test(l)), 'a re-sync with no arguments follows the stored dbt block');
  D.apply(ps, { user }); verify(mono, 'jaffle');
  const m = J(mono, 'strata.project.json'); m.custom = { keep: 1 }; m.dbt.note = 'mine'; fs.writeFileSync(path.join(mono, 'strata.project.json'), JSON.stringify(m));
  m2.nodes['model.jaffle_shop.customers'].description = 'Again.'; fs.writeFileSync(nested, JSON.stringify(m2)); D.sync(r0.model, { user, stop: mono });
  const m3 = J(mono, 'strata.project.json'); assert.deepStrictEqual(m3.custom, { keep: 1 }); assert.strictEqual(m3.dbt.note, 'mine', 'unknown keys of the manifest and of the dbt block are kept'); assert.ok(m3.dbt.lastSync >= m.dbt.lastSync); }
// a project that was not made from dbt gets the block at its first import
{ const d = path.join(scratch, 'late'); const r0 = P.create({ dir: d, name: 'Late', platform: 'Snowflake', user }); D.sync(r0.model, { from: FIX, user }); const m = J(d, 'strata.project.json'); assert.ok(m.dbt && m.dbt.manifest, 'the block is written by the first sync'); assert.strictEqual(m.name, 'Late');
  const F0 = verify(d, 'late').F; assert.ok(F0.catalogs.some((c) => c.name === 'MY_DB') && F0.tables.length === 12, 'an existing platform default catalog stays, the tables land under dbt\'s own databases too'); }

// ---- a cold project (ADR-0049): `dbt parse` only, no catalog.json, no compiled SQL: what the user's northwind project looked like ----
{ const COLD = path.join(__dirname, 'fixtures', 'dbt-cold'), cimp = D.readDbt(COLD), cn = (n) => cimp.nodes.find((x) => x.name === n);
  assert.ok(!fs.existsSync(path.join(COLD, 'target', 'catalog.json')), 'the fixture has no catalog');
  assert.deepStrictEqual(cimp.nodes.map((n) => n.type).reduce((a, t) => ({ ...a, [t]: (a[t] || 0) + 1 }), {}), { model: 17, seed: 1, source: 1, undeclared: 4 }, '17 models, a seed, a source, and the 4 tables the raw_ models read by plain name');
  // columns come from the SQL: `select *` through the lineage, explicit lists, aggregates and their aliases
  assert.strictEqual(cn('raw_orders').columns.length, 14, 'select * from orders: the columns come from what stg_orders selects from it');
  assert.deepStrictEqual(cn('orders').columns.map((c) => c.name).slice(0, 3), ['order_id', 'customer_id', 'employee_id'], 'the hard-coded table behind it has them too');
  assert.deepStrictEqual(cn('stg_orders').columns.slice(0, 2).map((c) => [c.name, c.pk, c.notNull]), [['order_id', true, undefined], ['customer_id', undefined, true]], 'the select list first; the tests still set the keys');
  assert.deepStrictEqual(cn('report_total_revenues_per_customer').columns.map((c) => c.name), ['company_name', 'total'], 'a report: a plain column and an alias');
  assert.deepStrictEqual(cn('report_receitas_acumuladas').columns.map((c) => c.name), ['ano', 'mes', 'receita_mensal', 'diferenca_mensal', 'receita_ytd', 'percentual_mudanca_mensal'], 'through CTEs');
  assert.strictEqual(cn('report_customers').columns.length, 11, 'select * from ref(): the parent\'s columns');
  assert.ok(cn('stg_customers').columns.length === 11 && cn('stg_customers').columns[0].description === 'ID único do cliente', 'declared and derived columns are one list, the declared descriptions kept');
  assert.strictEqual(cn('report_customers').sql, '', 'a table has no definition');
  assert.ok(/from\s+"alphageek"\."public"\."raw_orders"/.test(cn('stg_orders').sql) && !/\{\{/.test(cn('stg_orders').sql), 'a view without compiled SQL gets the model SQL with ref() replaced by the relation name');
  assert.ok(cimp.notes.some((n) => /no compiled SQL/.test(n)));
  // undeclared tables, lineage
  assert.deepStrictEqual(cimp.nodes.filter((n) => n.type === 'undeclared').map((n) => n.id), ['relation:public.customers', 'relation:public.order_details', 'relation:public.orders', 'relation:public.products']);
  assert.deepStrictEqual(cn('raw_orders').deps, ['relation:public.orders'], 'lineage: raw_orders reads the hard-coded table'); assert.deepStrictEqual(cn('report_top_10_products').deps, ['model.northwind.stg_order_details', 'model.northwind.stg_products']);
  // relationships: the tests (relationships, dbt_utils.relationships_where, a contract foreign key) then the joins and semantic entities
  const rel = (n) => cn(n).rels.map((r) => `${r.col}>${r.to.split('.').pop()}.${r.field}${r.note ? ' [' + r.note + ']' : ''}`);
  assert.deepStrictEqual(rel('stg_order_details'), ['product_id>stg_products.product_id', 'order_id>stg_orders.order_id [dbt semantic model entity "order"]'], 'relationships_where is a relationship; a foreign entity meeting a primary one is another');
  assert.deepStrictEqual(rel('stg_orders'), ['customer_id>stg_customers.customer_id', 'employee_id>employees.employee_id'], 'a relationships test, and a contract foreign_key (`to: ref()`)');
  assert.deepStrictEqual(rel('stg_customers'), ['region>regions.region_id [join in the dbt model report_customers_per_region]'], 'an ON condition: the side named after the column is the parent');
  assert.deepStrictEqual(cn('stg_order_details').sem.entities.map((e) => e.name + ':' + e.type), ['order:foreign', 'product:foreign']);
  // metrics: every shape dbt has, and the aggregates of the SQL
  const cm = Object.fromEntries(cimp.metrics.map((m) => [m.name, m]));
  assert.deepStrictEqual(Object.keys(cm).sort(), ['Avg unit price', 'Double quantity', 'Legacy orders', 'List value', 'Orders placed', 'Quantity per order', 'Running quantity', 'Total quantity'], 'simple, ratio, derived, cumulative, an old-style metric, and measures no metric uses');
  assert.strictEqual(cm['Total quantity'].agg, 'sum'); assert.strictEqual(cm['Orders placed'].agg, 'count_distinct'); assert.strictEqual(cm['Quantity per order'].agg, 'none'); assert.strictEqual(cm['Legacy orders'].agg, 'count');
  assert.ok(/dbt filter/.test(cm['Total quantity'].description) && /All units sold\./.test(cm['Total quantity'].description) && /window is not modelled/.test(cm['Running quantity'].description));
  assert.strictEqual(cimp.skipped.metrics, 1, 'a conversion metric is counted as not imported');
  assert.strictEqual(cimp.aggs.length, 7); assert.ok(cimp.aggs.every((a) => a.calc.startsWith('model.northwind.')), 'every aggregate is resolved to columns of a table');
}

// import, then the same import again and again: nothing new, nothing lost
{ const d = path.join(scratch, 'cold'), COLD = path.join(__dirname, 'fixtures', 'dbt-cold'); const r0 = D.importNew({ from: COLD, dir: d, name: 'Cold', user });
  assert.ok(/^23 tables added, 156 columns added, 5 relationships added, 2 tags added, 10 metrics added, 2 schemas added$/.test(r0.headline), r0.headline);
  let { F: C, log: L } = verify(d, 'cold'); assert.deepStrictEqual(L.entries.map((e) => e.stream), ['modelling', 'governance', 'semantic'], 'the metrics are the semantic stream');
  assert.deepStrictEqual(SM.toFile(SM.fromFile(C)), C, 'round trip stable'); assert.deepStrictEqual(SM.fromFile(C).warnings, []); assert.deepStrictEqual(SM.fromFile(C).dangling, []);
  { const v = cp.spawnSync('node', [path.join(REPO, '.claude/skills/strata-model/scripts/strata.js'), 'validate', r0.model], { encoding: 'utf8' }); assert.ok(/no problems/.test(v.stdout), 'no metric-ref warning: ' + v.stdout); }
  const T = (n) => C.tables.find((t) => t.name === n), mt = (n) => C.semantic.metrics.find((m) => m.name === n);
  assert.deepStrictEqual(T('orders').dbt, { id: 'relation:public.orders', type: 'undeclared', metricsDerived: true }, 'a hard-coded table is marked as such');
  assert.ok(/not declared in dbt/.test(T('orders').description) && T('orders').columns.length === 14 && T('raw_orders').dbt.depends_on.join() === 'public.orders', 'and the lineage is kept on the table');
  assert.strictEqual(T('report_top_10_products').dbt.depends_on.join(), 'public.stg_order_details,public.stg_products');
  assert.strictEqual(T('stg_orders').kind, 'view'); assert.ok(/from\s+"alphageek"\."public"\."raw_orders"/.test(T('stg_orders').definition));
  assert.deepStrictEqual(T('stg_order_details').dbt.semantic.entities, [{ name: 'order', type: 'foreign', expr: 'order_id' }, { name: 'product', type: 'foreign', expr: 'product_id' }].map((e) => ({ name: e.name, type: e.type, expr: e.expr })), 'semantic entities and dimensions are kept on the table');
  const rl = (c) => C.relationships.find((x) => x.child === c);
  assert.strictEqual(rl('public.stg_customers.region').description, 'Inferred from join in the dbt model report_customers_per_region.'); assert.ok(!rl('public.stg_order_details.product_id').description, 'a relationship from a test says nothing about inference');
  // metrics
  assert.strictEqual(mt('Total quantity').calculation, 'public.stg_order_details.quantity'); assert.strictEqual(mt('Total quantity').aggregation, 'sum'); assert.deepStrictEqual(mt('Total quantity').tags, ['finance']); assert.deepStrictEqual(mt('Total quantity').dbt, { id: 'metric.northwind.total_quantity' });
  assert.strictEqual(mt('Quantity per order').calculation, '{Total quantity} / {Orders placed}', 'a ratio reads the other metrics by their Strata names'); assert.strictEqual(mt('Double quantity').calculation, '{Total quantity} * 2');
  assert.strictEqual(mt('List value').calculation, 'public.stg_order_details.unit_price * public.stg_order_details.quantity', 'a measure with an expression: its columns qualified');
  const sales = mt('Sales'); assert.deepStrictEqual(sales.tags, ['dbt-derived']); assert.strictEqual(sales.dbt.derived, 'sql'); assert.strictEqual(sales.calculation, 'public.stg_order_details.unit_price * public.stg_order_details.quantity * (1.0 - public.stg_order_details.discount)');
  assert.ok(/Starter metric derived from the SQL of the dbt model report_top_10_products: sum\(order_details\.unit_price/.test(sales.description) && /Also computed as total_revenues_1997 in report_total_revenues_1997.*total in report_total_revenues_per_customer,/.test(sales.description) && /not an authored definition/.test(sales.description), 'derived metrics say where they come from; six identical calculations are one metric');
  assert.strictEqual(mt('Customers').aggregation, 'count_distinct'); assert.strictEqual(mt('Customers').calculation, 'public.stg_customers.customer_id');
  assert.ok(C.governance.tags.find((t) => t.name === 'dbt-derived') && !C.semantic.metrics.some((m) => m.name === 'Total (report_clients_to_marketing)'), 'one tag definition marks derived metrics');
  // idempotent: nothing to change
  assert.deepStrictEqual(D.plan(r0.model).changes, [], 'a second sync finds nothing (derived metrics are made once per table)');
  // the user edits and deletes; the next sync does not undo it
  userEdit(r0.model, (G) => {
    const s = G.semantic.metrics.find((m) => m.name === 'Sales'); s.name = 'Net revenue'; s.description = 'Certified by finance'; s.tags = ['finance'];
    G.semantic.metrics = G.semantic.metrics.filter((m) => m.name !== 'Customers' && m.name !== 'Double quantity');
    G.relationships = G.relationships.filter((x) => x.child !== 'public.stg_customers.region');
  }, 'Review the metrics');
  const pl = D.plan(r0.model);
  assert.ok(!pl.changes.some((c) => c.kind === 'metric' && /Customers|Sales|Net revenue/.test(c.ref)), 'a deleted or edited starter metric is not recreated: ' + pl.lines.join('|'));
  assert.deepStrictEqual(pl.changes.filter((c) => c.kind === 'metric').map((c) => c.ref), ['Double quantity'], 'a metric that dbt itself defines is added again (dbt owns it) and never changed if there');
  assert.ok(pl.changes.some((c) => c.kind === 'relationship'), 'a relationship the user deleted comes back with the next sync (documented)');
  D.apply(pl, { user }); C = verify(d, 'cold').F; assert.strictEqual(C.semantic.metrics.find((m) => m.name === 'Net revenue').description, 'Certified by finance', 'edited metric untouched');
  // dbt changes a metric: not overwritten
  const c2 = copy('dbt-cold2'); fs.rmSync(c2, { recursive: true }); fs.cpSync(COLD, c2, { recursive: true });
  const mf = J(c2, 'target/manifest.json'); mf.metrics['metric.northwind.total_quantity'].label = 'Quantity sold'; mf.metrics['metric.northwind.total_quantity'].description = 'Changed in dbt'; fs.writeFileSync(path.join(c2, 'target/manifest.json'), JSON.stringify(mf));
  assert.ok(!D.plan(r0.model, { from: c2 }).changes.some((c) => c.kind === 'metric' && /Total quantity|Quantity sold/.test(c.ref)), 'an existing dbt metric is left as it is in Strata');
}

// a model imported before these features (the user's real case): tables without columns, no lineage, no metrics. The next sync fills it in.
{ const d = path.join(scratch, 'old'), COLD = path.join(__dirname, 'fixtures', 'dbt-cold'); const r0 = D.importNew({ from: COLD, dir: d, name: 'Old', user });
  userEdit(r0.model, (G) => {
    G.tables = G.tables.filter((t) => t.dbt.type !== 'undeclared');
    for (const t of G.tables) { t.columns = t.columns.filter((c) => c.pk); delete t.definition; delete t.dbt.depends_on; delete t.dbt.metricsDerived; delete t.dbt.semantic; }
    delete G.semantic; G.relationships = [];
  }, 'As an older Strata imported it');
  const s = D.sync(r0.model, { user }); const { F: O } = verify(d, 'old');
  assert.ok(O.tables.find((t) => t.name === 'raw_orders').columns.length === 14 && O.tables.find((t) => t.name === 'orders') && O.semantic.metrics.length === 10 && O.relationships.length === 5, 'columns, hard-coded tables, relationships and metrics all come in: ' + s.headline);
  assert.ok(s.entries.some((e) => e.stream === 'semantic'), 'one version in the semantic stream'); assert.deepStrictEqual(D.plan(r0.model).changes, [], 'and then it is stable'); }
// numeric columns of a fact-like table (the catalog knows the types): one metric each, marked; keys and ids are not
{ const d = path.join(scratch, 'facts'); const r0 = D.importNew({ from: FIX, dir: d, name: 'Facts', user }); const { F: X } = verify(d, 'facts');
  assert.deepStrictEqual(X.semantic.metrics.filter((m) => m.dbt.derived === 'column').map((m) => [m.name, m.calculation, m.aggregation]), [['Amount (orders)', 'ANALYTICS.MARTS.orders.amount', 'sum'], ['Quantity (order_items)', 'ANALYTICS.MARTS.order_items.quantity', 'sum']], 'a numeric non-key column of a table with a foreign key');
  assert.ok(X.semantic.metrics.some((m) => m.name === 'Revenue' && m.calculation === 'ANALYTICS.MARTS.orders.amount' && m.dbt.derived === 'sql'), 'sum(amount) as revenue in a view, read from the compiled SQL with full relation names');
  assert.ok(r0.notes.some((n) => /jaffle\.payments/i.test(n)), 'the table compiled SQL reads that no source declares is reported'); }

// ---- the command line ----
const cli = (...a) => cp.spawnSync('node', [path.join(REPO, 'cli.js'), ...a], { encoding: 'utf8' });
{ const d = path.join(scratch, 'cli'); fs.mkdirSync(d);
  let c = cli('import-dbt', '--from', FIX, '--dir', d, '--name', 'Cli Jaffle', '--dry-run'); assert.strictEqual(c.status, 0, c.stderr); assert.ok(/dry run, nothing written/.test(c.stdout) && /\+ table ANALYTICS\.MARTS\.customers/.test(c.stdout)); assert.deepStrictEqual(fs.readdirSync(d), []);
  c = cli('import-dbt', '--from', FIX, '--dir', d, '--name', 'Cli Jaffle'); assert.strictEqual(c.status, 0, c.stderr); assert.ok(/New project from dbt/.test(c.stdout) && /12 tables added/.test(c.stdout)); verify(d, 'cli-jaffle');
  c = cli('import-dbt', '--dir', d); assert.strictEqual(c.status, 0, c.stderr); assert.ok(/Re-sync of .* from dbt: no changes/.test(c.stdout), 'the same command in a project of one part is a re-sync, paths from the manifest: ' + c.stdout);
  const nm = path.join(d, '..', 'cli-dbt2'); fs.cpSync(FIX, nm, { recursive: true }); const m2 = J(nm, 'target/manifest.json'); m2.nodes['model.jaffle_shop.orders'].description = 'CLI change'; fs.writeFileSync(path.join(nm, 'target/manifest.json'), JSON.stringify(m2));
  c = cli('import-dbt', '--dir', d, '--from', nm, '--dry-run'); assert.ok(/~ table ANALYTICS\.MARTS\.orders: description/.test(c.stdout) && /dry run/.test(c.stdout));
  assert.ok(!/CLI change/.test(read(d, MODEL('cli-jaffle'))), 'dry run: not applied');
  c = cli('import-dbt', '--dir', d, '--from', nm); assert.strictEqual(c.status, 0, c.stderr); assert.ok(/CLI change/.test(read(d, MODEL('cli-jaffle')))); verify(d, 'cli-jaffle');
  c = cli('import-dbt', '--model', path.join(d, MODEL('cli-jaffle')), '--from', nm); assert.ok(/no changes/.test(c.stdout), '--model picks the model explicitly');
  c = cli('import-dbt', '--dir', path.join(scratch, 'cli-empty')); assert.strictEqual(c.status, 1); assert.ok(/no dbt project given/.test(c.stderr), c.stderr);
  fs.mkdirSync(path.join(scratch, 'cli-empty'), { recursive: true }); c = cli('import-dbt', '--dir', path.join(scratch, 'cli-empty'), '--from', path.join(scratch, 'cli-empty')); assert.strictEqual(c.status, 1); assert.ok(/no dbt_project.yml and no manifest.json/.test(c.stderr));
  c = cli('import-dbt', '--bogus'); assert.strictEqual(c.status, 2); assert.ok(/strata-sql import-dbt --help/.test(c.stderr));
  c = cli('import-dbt', '--dir', path.join(scratch, 'cli-empty2'), '--from', FIX, '--name', 'Cli Jaffle'); assert.strictEqual(c.status, 0, c.stderr); }

// ---- the extension side: the wizard and the two commands, through a stubbed vscode ----
const Uri = { file: (q) => ({ fsPath: q, path: q, scheme: 'file', with(o) { return Uri.file(o.path !== undefined ? o.path : q); } }), joinPath: (u, ...x) => Uri.file(path.join(u.fsPath, ...x)) };
const ws = path.join(scratch, 'workspace'); fs.mkdirSync(ws);
const cmds = {}, seen = { exec: [], info: [], err: [], warn: [], modal: [], asked: [], dialogs: [] };
let script = [], answer = undefined, active = null;
const ask = (kind, o, items) => { const a = script.shift(); seen.asked.push({ kind, title: o && o.title, labels: items && items.map((i) => i.label) }); if (kind === 'dialog') seen.dialogs.push(o); if (a === undefined) throw new Error('unexpected prompt: ' + (o && o.title)); return typeof a === 'function' ? a(items, o) : a; };
const vscode = {
  Uri, ViewColumn: {}, ColorThemeKind: {}, QuickPickItemKind: { Separator: -1 },
  workspace: { get workspaceFolders() { return [{ uri: Uri.file(ws) }]; }, getWorkspaceFolder: () => undefined, fs: {}, onDidChangeTextDocument: () => ({}), onDidChangeConfiguration: () => ({}), getConfiguration: () => ({ get: () => '' }) },
  window: { get activeTextEditor() { return active; }, activeColorTheme: { kind: 2 }, onDidChangeActiveColorTheme: () => ({}), onDidChangeActiveTextEditor: () => ({}), registerCustomEditorProvider: () => ({}), registerWebviewViewProvider: () => ({}), registerUriHandler: () => ({}),
    showQuickPick: async (items, o) => ask('pick', o, items), showInputBox: async (o) => ask('input', o), showOpenDialog: async (o) => ask('dialog', o),
    showInformationMessage: async (m, o, ...items) => { if (items.length) { seen.modal.push({ m, o }); return answer; } seen.info.push(m); }, showErrorMessage: (m) => { seen.err.push(m); return Promise.resolve(); }, showWarningMessage: async (m) => { seen.warn.push(m); } },
  commands: { registerCommand: (id, fn) => { cmds[id] = fn; return {}; }, executeCommand: async (...a) => { seen.exec.push(a); } },
};
const orig = Module._load; Module._load = function (req, ...x) { return req === 'vscode' ? vscode : orig.call(this, req, ...x); };
require(REPO + '/extension.js').activate({ subscriptions: { push() {} }, extensionUri: Uri.file(REPO) });
const by = (id) => (items) => items.find((i) => i.id === id);
(async () => {
  const pkg = require(REPO + '/package.json');
  for (const id of ['strata.importDbt', 'strata.syncDbt']) assert.ok(cmds[id] && pkg.contributes.commands.some((c) => c.command === id), id + ' exists and is in the Command Palette');
  // New Project > From a dbt project…
  script = [by('ws'), 'Wizard Jaffle', by('dbt'), () => [Uri.file(FIX)], by('go')];
  await cmds['strata.newProject']();
  assert.deepStrictEqual(seen.err, []); const w = verify(ws, 'wizard-jaffle'); assert.strictEqual(w.F.tables.length, 12); assert.ok(J(ws, 'strata.project.json').dbt);
  assert.deepStrictEqual(seen.asked.map((a) => a.kind), ['pick', 'input', 'pick', 'dialog', 'pick'], 'folder, name, starting point, the dbt folder, create: no platform or methodology question (dbt brings the adapter)');
  assert.ok(seen.asked[2].labels.some((l) => /From a dbt project/.test(l)) && seen.asked[2].labels.some((l) => /From DDL \/ SQL scripts/.test(l)) && !seen.asked[2].labels.some((l) => /coming soon/.test(l)), 'dbt and SQL scripts are starting points (change 33 made the DDL row real)');
  assert.ok(/from dbt: 12 tables added/.test(seen.info.at(-1)) && /5 columns had no type/.test(seen.info.at(-1)), seen.info.at(-1));
  assert.strictEqual(seen.exec.at(-1)[0], 'vscode.openWith');
  // cancelling the dbt dialog writes nothing
  const before = tree(ws).join(); script = [by('ws'), 'Cancelled', by('dbt'), () => undefined]; await cmds['strata.newProject'](); assert.strictEqual(tree(ws).join(), before);
  // a folder without a manifest: the error is shown, nothing is written
  seen.err.length = 0; script = [by('ws'), 'Broken Dbt', by('dbt'), () => [Uri.file(scratch)], by('go')]; await cmds['strata.newProject'](); assert.ok(/no dbt_project.yml and no manifest.json/.test(seen.err[0]), seen.err[0]); assert.strictEqual(tree(ws).join(), before);

  // the commands: preview, then apply
  const mfile = w.F && path.join(ws, MODEL('wizard-jaffle')), doc = { uri: Uri.file(mfile), isDirty: false };
  active = { document: doc };
  seen.info.length = 0; await cmds['strata.syncDbt'](); assert.ok(/already up to date/.test(seen.info[0]), 'nothing to do: says so');
  const nm = path.join(scratch, 'cmd-dbt'); fs.cpSync(FIX, nm, { recursive: true }); const m2 = J(nm, 'target/manifest.json'); m2.nodes['model.jaffle_shop.customers'].description = 'From the command'; fs.writeFileSync(path.join(nm, 'target/manifest.json'), JSON.stringify(m2));
  script = [() => [Uri.file(nm)]]; answer = undefined; // Import from dbt…: asks for the folder, shows the preview, the user says no
  await cmds['strata.importDbt']();
  assert.strictEqual(seen.dialogs.at(-1).defaultUri.fsPath, FIX, 'the dialog starts where the stored dbt block points'); assert.strictEqual(seen.modal.length, 1);
  assert.ok(/Sync from dbt: 1 tables? added|Sync from dbt: 1 updated/.test(seen.modal[0].m) && seen.modal[0].o.modal && /~ table ANALYTICS\.MARTS\.customers: description/.test(seen.modal[0].o.detail) && /one version/.test(seen.modal[0].o.detail), 'a modal preview lists the changes: ' + JSON.stringify(seen.modal[0]));
  assert.ok(!/From the command/.test(read(ws, MODEL('wizard-jaffle'))), 'not applied without a yes');
  answer = 'Apply'; script = [() => [Uri.file(nm)]]; await cmds['strata.importDbt']();
  assert.ok(/From the command/.test(read(ws, MODEL('wizard-jaffle'))) && /synced from dbt/.test(seen.info.at(-1))); verify(ws, 'wizard-jaffle');
  assert.strictEqual(J(ws, 'strata.project.json').dbt.manifest, path.relative(ws, path.join(nm, 'target', 'manifest.json')).split(path.sep).join('/'));
  // Re-sync uses the stored paths and asks nothing
  m2.nodes['model.jaffle_shop.customers'].description = 'Second change'; fs.writeFileSync(path.join(nm, 'target/manifest.json'), JSON.stringify(m2)); script = [];
  await cmds['strata.syncDbt'](); assert.ok(/Second change/.test(read(ws, MODEL('wizard-jaffle')))); verify(ws, 'wizard-jaffle');
  // unsaved changes in the editor: asked to save first, nothing written
  doc.isDirty = true; seen.warn.length = 0; const b = read(ws, MODEL('wizard-jaffle')); await cmds['strata.syncDbt'](); assert.ok(/save the model first/.test(seen.warn[0])); assert.strictEqual(read(ws, MODEL('wizard-jaffle')), b);
  doc.isDirty = false; active = null; seen.warn.length = 0; await cmds['strata.syncDbt'](); assert.ok(/open a \.model\.json file first/.test(seen.warn[0]), 'no model open: a warning, not an error');
  console.log('dbt.check: ok');
})().catch((e) => { console.error(e); process.exit(1); });
