// Self-check for the Semantic level (ADR-0037): metric references, the file format, the semantic view, impact analysis and
// metric warnings, on Northwind. Run: node tests/semantic.check.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SM = require('../media/model.js');
const G = require('../media/gov.js');
const A = require('../media/align.js');
const IM = require('../media/impact.js');
const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
const text = (m) => SM.stringify(SM.toFile(m)) + '\n';

const F = read('sample_data_models/northwind.model.json');
delete F.semantic;
F.semantic = { metrics: [
  { name: 'Revenue', description: 'Sales after discount', calculation: 'order_details.unit_price * sales.order_details.quantity * (1 - northwind.sales.order_details.discount)', aggregation: 'sum', grain: ['Order Line'], governance: { certification: 'Certified', usageScope: ['Board pack'] } },
  { name: 'Order Count', calculation: 'COUNT(orders.order_id) -- orders.nope in a comment', aggregation: 'count_distinct', grain: ['Order'] },
  { name: 'Average Order Value', calculation: '{Revenue} / { order count }', aggregation: 'none', grain: ['Order'], governance: { certification: 'Certified' } },
  { name: 'Odd', calculation: "UPPER(orders.ship_name) || 'x.y' || \"orders\".\"freight\" + quantity + orders.missing + nope.col + {Odd} + {Ghost} + fn.call(1)", grain: ['Nowhere', 'orders'] },
] };
F.layout = { semantic: { Revenue: [100, 200], 'northwind.sales.order_details': [400, 200] } }; // positions come from the layout file
const m = SM.fromFile(F, 'semantic'), R = SM.refs(m), M = (n) => m.metrics.find((x) => x.name === n);
const col = (t, c) => m.tables.find((x) => x.name === t).columns.find((x) => x.name === c).id;

// 1. what a calculation reads
let r = SM.metricRefs(m, M('Revenue'));
assert.deepEqual([...r.columns].sort(), [col('order_details', 'unit_price'), col('order_details', 'quantity'), col('order_details', 'discount')].sort(), 'table.column, schema.table.column and full refs');
assert.equal(r.missing.length, 0);
r = SM.metricRefs(m, M('Order Count'));
assert.deepEqual([...r.columns], [col('orders', 'order_id')], 'comments ignored');
r = SM.metricRefs(m, M('Average Order Value'));
assert.deepEqual([...r.metrics].sort(), [M('Revenue').id, M('Order Count').id].sort(), '{Metric} refs, case and spaces tolerated');
r = SM.metricRefs(m, M('Odd'));
assert.deepEqual([...r.columns].sort(), [col('orders', 'ship_name'), col('orders', 'freight')].sort(), 'quoted identifiers resolve; strings and bare names do not');
assert.deepEqual(r.missing.map((q) => q.kind + ' ' + q.ref).sort(), ['column orders.missing', 'metric Ghost', 'metric Odd', 'table nope.col'], 'itself and unknowns are missing; function calls are not references');
r = SM.metricRefs(m, { id: 'x', calculation: "CASE WHEN orders.freight > 0 THEN orders.order_id ELSE orders.ship_name END" });
assert.deepEqual([...r.columns].sort(), [col('orders', 'freight'), col('orders', 'order_id'), col('orders', 'ship_name')].sort(), 'a column followed by a keyword (THEN, ELSE, END) is read');

// 2. file format: round trip, layout by metric name and table ref, flatten streams
const t0 = text(m);
assert.equal(text(SM.fromFile(JSON.parse(t0), 'semantic')), t0, 'fromFile(toFile(m)) is identity with metrics');
const o0 = JSON.parse(t0);
assert.deepEqual(Object.keys(o0).slice(-2), ['semantic', 'alignment'], 'semantic sits after relationships, before alignment; no layout, no version');
const pos0 = SM.layoutOf(m, 'semantic');
assert.deepEqual(pos0.semantic.Revenue, [100, 200]);
assert.deepEqual(pos0.semantic['northwind.sales.order_details'], [400, 200]);
const fl = SM.flatten(o0);
assert.equal(fl.semantic['metric:Revenue'].calculation, M('Revenue').calculation, 'metric structure is in the semantic stream (ADR-0039)');
assert.ok(!fl.modelling['metric:Revenue'] && !('governance' in fl.semantic['metric:Revenue']));
assert.equal(fl.governance['assign:metric:Revenue'].governance.certification, 'Certified', 'metric governance is governance');
assert.equal(SM.canon(SM.flatten(SM.unflatten(fl.modelling, fl.governance, fl.semantic))), SM.canon(fl));
assert.equal(SM.idIndex(m).get('metric:Revenue'), M('Revenue').id);

// 3. what the Semantic level draws: metrics (one row per input) and only the tables they read
assert.deepEqual(SM.nodesOf(m, 'semantic').map((n) => n.name).sort(), ['Average Order Value', 'Odd', 'Order Count', 'Revenue', 'order_details', 'orders']);
const V = A.view(m, 'semantic');
assert.equal(V.layer, 'metric');
assert.deepEqual(V.schemas.map((s) => s.name), ['Semantic layer', 'sales']);
assert.deepEqual(M('Revenue').columns.map((c) => c.name), ['unit_price', 'quantity', 'discount']);
assert.deepEqual(M('Average Order Value').columns.map((c) => c.name).sort(), ['{Order Count}', '{Revenue}']);
const noMetrics = read('sample_data_models/example.model.json'); delete noMetrics.semantic;
assert.equal(A.view(SM.fromFile(noMetrics, 'semantic'), 'semantic').tables.length, 0, 'no metrics: nothing drawn');
// saved canvas state: a selected metric is stored by name
const st = SM.canvasOut(m, { level: 'semantic', mode: 'schema', levels: { semantic: { autoFit: false, view: { x: 1, y: 2, k: 1 }, scope: { c: new Set(), s: new Set(), k: new Set() }, panels: {}, selected: M('Revenue').id } } });
assert.equal(st.levels.semantic.selected, 'Revenue');
assert.equal(SM.canvasIn(m, st).levels.semantic.selected, M('Revenue').id);

// 4. impact: a column change breaks the metrics that read it, and the metrics built on those
let a = IM.analyse(m, [IM.key('column', col('order_details', 'discount'))], 'change');
assert.deepEqual([...a.impMetrics].sort(), [M('Revenue').id, M('Average Order Value').id].sort(), 'column -> metric -> derived metric');
assert.equal(a.state, 'impacted');
a = IM.analyse(m, [IM.key('table', m.tables.find((t) => t.name === 'orders').id)], 'delete');
assert.ok(a.impMetrics.has(M('Order Count').id) && a.impMetrics.has(M('Odd').id), 'deleting a table breaks the metrics on its columns');
a = IM.analyse(m, [IM.key('metric', M('Revenue').id)], 'delete');
assert.deepEqual([...a.impMetrics], [M('Average Order Value').id], 'a metric breaks the metrics built on it');
assert.ok(a.upTables.has(m.tables.find((t) => t.name === 'order_details').id), 'upstream: the tables it reads');
a = IM.analyse(m, [IM.key('metric', M('Average Order Value').id)], 'delete');
assert.equal(a.state, 'linked', 'nothing uses it, but it builds on other metrics');
assert.deepEqual([...a.upMetrics].sort(), [M('Revenue').id, M('Order Count').id].sort());
const unused = new Set(IM.unusedColumns(m, true).map((u) => u.columnId));
assert.ok(!unused.has(col('orders', 'freight')) && !unused.has(col('orders', 'ship_name')), 'columns read by a metric are used');

// 5. warnings: missing references and grain, retired but used
const keys = () => G.check(m).map((w) => w.key);
let k = keys();
for (const x of ['metric-ref:Odd:orders.missing', 'metric-ref:Odd:nope.col', 'metric-ref:Odd:Ghost', 'metric-ref:Odd:Odd', 'metric-ref:Odd:grain:Nowhere']) assert.ok(k.includes(x), x);
assert.ok(!k.includes('metric-ref:Odd:grain:orders'), 'a unique table name is a valid grain');
assert.ok(!k.some((x) => x.startsWith('metric-certified')), 'certification is a tag (ADR-0038), not a check');
M('Order Count').gov = { lifecycle: 'Retired' };
assert.ok(keys().includes('gov-retired:metric:Order Count'), 'retired metric still used by another metric');
m.tables.find((t) => t.name === 'orders').gov = { lifecycle: 'Retired' };
assert.ok(/still used by .* and \d+ more/.test(G.check(m).find((w) => w.key === 'gov-retired:northwind.sales.orders').text), 'a retired table still read by views and metrics');
// classification rolls up (ADR-0041): a metric takes the highest classification of the columns and metrics it reads; its own value is a floor
for (const x of G.objects(m)) if (x.o.gov) delete x.o.gov.classification; // (whatever the sample carries, the project defaults too)
for (const lv of G.LEVELS) if ((m.project.gov || {})[lv]) delete m.project.gov[lv].classification;
const od = m.tables.find((t) => t.name === 'order_details'), qty = od.columns.find((c) => c.name === 'quantity');
od.gov = { ...od.gov, classification: 'Confidential' };
assert.equal(G.effective(m, qty).classification, undefined, 'a table\'s value is a floor: its columns do not inherit it');
assert.equal(G.effective(m, M('Revenue')).classification, undefined, 'and a metric reading them sees nothing');
qty.gov = { classification: 'Restricted' };
assert.deepEqual(G.effective(m, M('Revenue')).classification, { v: 'Restricted', from: { kind: 'column', name: 'northwind.sales.order_details.quantity' } }, 'a metric rolls up the columns it reads');
assert.equal(G.effective(m, M('Average Order Value')).classification.v, 'Restricted', 'through the metrics it reads');
assert.equal(G.effective(m, M('Order Count')).classification, undefined, 'an unrelated metric is untouched');
M('Revenue').gov = { classification: 'Internal' };
assert.deepEqual(G.classify(m, M('Revenue')).own, { v: 'Internal', from: null }, 'the own value stays available');
assert.equal(G.effective(m, M('Revenue')).classification.v, 'Restricted', 'a higher input beats the metric\'s own value');
M('Revenue').gov = { classification: 'Restricted' }; qty.gov = {};
assert.equal(G.effective(m, od.columns.find((c) => c.name === 'unit_price')).classification, undefined, 'a metric\'s value never goes down to its columns');
assert.ok(G.effective(m, M('Odd')), 'a metric that reads itself terminates');
delete od.gov.classification; M('Revenue').gov = {};
assert.deepEqual(G.usedBy(m, 'metric', M('Revenue').id).map((x) => x.name), ['Average Order Value']);
assert.deepEqual(G.usedBy(m, 'column', col('order_details', 'quantity')).map((x) => x.name), ['Revenue']);

// 6. rewrite-safe calculations (ADR-0040): renaming a column, table, schema or catalog follows into the formulas that read it
{
  const w = SM.fromFile(F, 'semantic'), W = (n) => w.metrics.find((x) => x.name === n), tab = (n) => w.tables.find((x) => x.name === n);
  const rename = (fn) => { const snap = SM.metricSnap(w); fn(); return SM.metricRewrite(w, snap); };
  const others = () => Object.fromEntries(w.metrics.filter((x) => x.name !== 'Revenue' && x.name !== 'Odd').map((x) => [x.name, x.calculation]));
  const before = others();
  let ch = rename(() => { tab('order_details').columns.find((c) => c.name === 'quantity').name = 'qty'; });
  assert.deepEqual(ch, ['Revenue']);
  assert.equal(W('Revenue').calculation, 'order_details.unit_price * sales.order_details.qty * (1 - northwind.sales.order_details.discount)', 'a column is renamed at every depth it was written');
  assert.deepEqual(others(), before, 'other metrics untouched');
  ch = rename(() => { tab('order_details').name = 'order_lines'; });
  assert.equal(W('Revenue').calculation, 'order_lines.unit_price * sales.order_lines.qty * (1 - northwind.sales.order_lines.discount)', 'a table, bare, schema.table and full');
  ch = rename(() => { w.schemas.find((x) => x.name === 'sales').name = 'trade'; });
  assert.equal(W('Revenue').calculation, 'order_lines.unit_price * trade.order_lines.qty * (1 - northwind.trade.order_lines.discount)', 'a schema: only the parts that name it');
  assert.equal(W('Order Count').calculation, 'COUNT(orders.order_id) -- orders.nope in a comment', 'comments stay');
  ch = rename(() => { w.catalogs[0].name = 'nw'; });
  assert.equal(W('Revenue').calculation, 'order_lines.unit_price * trade.order_lines.qty * (1 - nw.trade.order_lines.discount)', 'a catalog');
  // quoting is kept, a name that needs it gets it, strings and {metrics} are left alone, unknown names stay unknown
  ch = rename(() => { tab('orders').columns.find((c) => c.name === 'freight').name = 'freight cost'; tab('orders').name = 'Orders2'; });
  assert.ok(ch.includes('Odd'));
  assert.equal(W('Odd').calculation, `UPPER(Orders2.ship_name) || 'x.y' || "Orders2"."freight cost" + quantity + orders.missing + nope.col + {Odd} + {Ghost} + fn.call(1)`, 'quotes kept, unknown references untouched');
  assert.equal(W('Order Count').calculation, 'COUNT(Orders2.order_id) -- orders.nope in a comment');
  assert.equal(W('Average Order Value').calculation, '{Revenue} / { order count }');
  assert.deepEqual(SM.metricRefs(w, W('Revenue')).missing, [], 'everything still resolves');
  assert.deepEqual(SM.metricRefs(w, W('Odd')).missing.map((q) => q.ref).sort(), ['Ghost', 'Odd', 'nope.col', 'orders.missing'], 'and what did not resolve before still does not');
  // no rename, no change; a deleted column or a metric edited meanwhile is not touched
  assert.deepEqual(rename(() => {}), []);
  assert.deepEqual(rename(() => { const t = tab('order_lines'); t.columns = t.columns.filter((c) => c.name !== 'unit_price'); }), [], 'a deleted column is left for the warnings');
  const snap = SM.metricSnap(w); tab('order_lines').columns.find((c) => c.name === 'qty').name = 'units'; W('Revenue').calculation += ' '; assert.deepEqual(SM.metricRewrite(w, snap), [], 'a calculation edited in the same step is not rewritten');
  // two-part naming
  const F2 = read('sample_data_models/example.model.json'); F2.semantic = { metrics: [{ name: 'T', calculation: 'sum(sales.orders.total)' }] };
  const w2 = SM.fromFile(F2, 'semantic'), s2 = SM.metricSnap(w2);
  assert.ok(SM.metricRefs(w2, w2.metrics[0]).columns.size, 'resolves before');
  w2.tables.find((t) => t.name === 'orders').name = 'sales_orders';
  if (SM.metricRefs(w2, w2.metrics[0]).columns.size === 0) { assert.deepEqual(SM.metricRewrite(w2, s2), ['T']); assert.equal(w2.metrics[0].calculation, 'sum(sales.sales_orders.total)'); }
}

console.log('semantic.check: all assertions passed');
