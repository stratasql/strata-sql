// Self-check for media/codegen.js: the generated Airflow / Dagster / notebook code must be valid Python and follow the load order.
// Run: node tests/codegen.check.js   (python3 is used to compile the output; skipped when it is missing)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const M = require('../media/model.js');
const O = require('../media/order.js');
const C = require('../media/codegen.js');

const load = (f) => M.fromFile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), 'physical');
const hasPy = cp.spawnSync('python3', ['--version']).status === 0;
const compile = (src) => { // returns null when fine, else the Python error
  if (!hasPy) return null;
  const r = cp.spawnSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "generated", "exec")'], { input: src, encoding: 'utf8' });
  return r.status === 0 ? null : r.stderr;
};

for (const file of ['sample_data_models/example.model.json', 'sample_data_models/northwind.model.json', 'sample_data_models/fpml.model.json']) {
  const m = load(file), o = O.analyse(m), R = M.refs(m), P = C.plan(m, {});
  // one task per table / view, dependencies and stages from the load order
  assert.strictEqual(P.tasks.length, m.tables.length, file);
  for (const t of P.tasks) {
    const id = [...R.tab].find(([, r]) => r === t.id)[0];
    assert.deepStrictEqual(t.deps, [...o.deps.get(id).keys()].map((d) => R.tab.get(d)).sort(), `${file} ${t.id} deps`);
    assert.strictEqual(t.stage, o.stage.get(id));
    assert(t.statements.length && t.statements.every((s) => typeof s === 'string' && s.trim()), 'statements');
  }
  for (const target of ['airflow', 'dagster', 'notebook']) {
    const out = C.generate(m, target, { mode: 'replace', staging: 'raw' });
    assert(out.name.endsWith(target === 'notebook' ? '.ipynb' : '.py') && out.text.length > 500, `${file} ${target}`);
    if (target === 'notebook') {
      const nb = JSON.parse(out.text);
      assert.strictEqual(nb.nbformat, 4);
      const codeCells = nb.cells.filter((c) => c.cell_type === 'code');
      assert(codeCells.length >= 1 + o.stages.length && nb.cells.some((c) => c.cell_type === 'markdown'), 'cells');
      codeCells.forEach((c, i) => { const e = compile(c.source.join('')); assert(!e, `${file} notebook cell ${i}: ${e}`); });
      // every table is loaded in its stage
      const all = codeCells.map((c) => c.source.join('')).join('\n');
      for (const t of P.tasks) assert(all.includes(JSON.stringify(t.id)), `${t.id} in the notebook`);
    } else {
      const e = compile(out.text);
      assert(!e, `${file} ${target}: ${e}`);
      for (const t of P.tasks) assert(out.text.includes(target === 'dagster' ? '[' + t.id.split('.').map((x) => JSON.stringify(x)).join(', ') + ']' : JSON.stringify(t.id)), `${t.id} in ${target}`);
    }
  }
}

// content: quoting per dialect, views, staging, modes, schedule from the SLAs
const nw = load('sample_data_models/northwind.model.json'), P = C.plan(nw, { mode: 'replace', staging: 'raw' });
assert.strictEqual(P.dialect, 'databricks');
const orders = P.tasks.find((t) => t.id === 'northwind.sales.orders');
assert(orders.statements[0] === 'DELETE FROM `northwind`.`sales`.`orders`' && /INSERT INTO `northwind`.`sales`.`orders` \(`order_id`/.test(orders.statements[1]) && /FROM `northwind`.`raw`.`orders`/.test(orders.statements[1]), 'replace mode, backticks, catalog-qualified staging: ' + orders.statements.join('|'));
assert(P.tasks.find((t) => t.id === 'northwind.reporting.invoices').statements[0].startsWith('CREATE OR REPLACE VIEW `northwind`.`reporting`.`invoices` AS\nSELECT'), 'view = its definition');
assert(/^REFRESH MATERIALIZED VIEW/.test(P.tasks.find((t) => t.id === 'northwind.reporting.mv_monthly_sales_summary').statements[0]), 'materialized view is refreshed');
assert.strictEqual(P.schedule.frequency, 'daily'); assert.strictEqual(P.schedule.cron, '0 2 * * *', 'starts when the first data is due (02:00)'); assert(P.schedule.mixed, 'weekly and monthly SLAs mixed in');
assert(P.tasks.find((t) => t.id === 'northwind.ref.countries').reference && P.tasks.find((t) => t.id === 'northwind.sales.orders').slaMinutes === 120, 'reference flag, SLA minutes after the start (04:00 - 02:00)');
assert.strictEqual(C.plan(nw, { mode: 'append' }).tasks.find((t) => t.id === 'northwind.sales.orders').statements.length, 1);
assert.strictEqual(C.cron('weekly', '03:30'), '30 3 * * 1'); assert.strictEqual(C.cron('realtime', '01:00'), null); assert.strictEqual(C.cron('quarterly', '06:05'), '5 6 1 1,4,7,10 *');

// other dialects and a circular dependency
const ex = load('sample_data_models/example.model.json');
ex.project.technology = 'SQL Server';
assert(/^\[main\]|CREATE OR ALTER VIEW|REFRESH/.test(C.plan(ex, {}).tasks.map((t) => t.statements[0]).join('\n')) && C.plan(ex, {}).tasks.some((t) => /\[main\]\.\[sales\]\.\[orders\]/.test(t.statements.join('')) ), 'SQL Server brackets');
ex.project.technology = 'SQLite';
assert(C.plan(ex, {}).tasks.find((t) => t.kind === 'materialized view').statements[0].startsWith('REFRESH'), 'sqlite keeps the generic refresh (no MVs there, a comment in the docs)');
const cyc = load('sample_data_models/example.model.json'), T = (n) => cyc.tables.find((t) => t.name === n);
T('country').columns.push({ id: 'x1', name: 'capital_customer_id', dataType: 'BIGINT', foreignKey: { tableId: T('customer').id, columnId: T('customer').columns[0].id, cardinality: '1..M' } });
const cp2 = C.plan(cyc, {});
assert.strictEqual(cp2.cycles.length, 1);
const c1 = cp2.tasks.find((t) => t.id === 'main.ref.country'), c2 = cp2.tasks.find((t) => t.id === 'main.sales.customer');
assert(c1.cycle && c2.cycle && !c1.deps.includes(c2.id) && !c2.deps.includes(c1.id), 'no edge between cycle members');
for (const target of ['airflow', 'dagster']) assert(!compile(C.generate(cyc, target, {}).text));
assert.throws(() => C.generate(ex, 'nope'), /unknown target/);
assert.throws(() => C.plan({ project: null, tables: [] }, {}), /no project/);
console.log('codegen check ok' + (hasPy ? '' : ' (python3 missing: generated code not compiled)'));
