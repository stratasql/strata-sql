// Self-check for media/order.js. Run: node tests/order.check.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../media/model.js');
const O = require('../media/order.js');

const load = (f) => M.fromFile(JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), 'physical');
const short = (m, r) => (id) => M.refs(m).tab.get(id).split('.').slice(-1)[0];

// 1) the example model: country/product first, then customer, then orders + bridge, then order_item, then the view
let m = load('sample_data_models/example.model.json'), o = O.analyse(m), n = short(m);
assert.deepStrictEqual(o.stages.map((s) => s.ids.map(n)), [['country', 'product'], ['customer'], ['customer_product', 'orders'], ['customer_orders_mv', 'order_item']]);
// the view only needs orders (stage 3) so it shares stage 4 with order_item
assert.strictEqual(o.longest.map(n).join('>'), 'country>customer>orders>customer_orders_mv');
assert.deepStrictEqual([...o.upstream(m.tables.find((t) => t.name === 'order_item').id)].map(n).sort(), ['country', 'customer', 'orders', 'product']);
assert.deepStrictEqual([...o.downstream(m.tables.find((t) => t.name === 'customer').id)].map(n).sort(), ['customer_orders_mv', 'customer_product', 'order_item', 'orders']);
assert.deepStrictEqual(o.roots.map(n), ['country', 'product']);
assert.strictEqual(o.widest, 2);

// 2) northwind: every table loads after everything it needs, views after the tables they read
m = load('sample_data_models/northwind.model.json'); o = O.analyse(m);
for (const [id, d] of o.deps) for (const dep of d.keys()) assert(o.stage.get(id) > o.stage.get(dep), 'stage order');
assert.strictEqual(o.stages.reduce((a, s) => a + s.ids.length, 0), m.tables.length);
assert(o.stages.length >= 3);

// 3) a cycle and a self reference load together / are reported, and do not loop
m = load('sample_data_models/example.model.json');
const T = (nm) => m.tables.find((t) => t.name === nm), col = (t, nm) => t.columns.find((c) => c.name === nm);
const cust = T('customer'), country = T('country');
country.columns.push({ id: 'x1', name: 'capital_customer_id', dataType: 'BIGINT', foreignKey: { tableId: cust.id, columnId: cust.columns[0].id, cardinality: '1..M' } });
cust.columns.push({ id: 'x2', name: 'referred_by', dataType: 'BIGINT', foreignKey: { tableId: cust.id, columnId: cust.columns[0].id, cardinality: '1..M' } });
o = O.analyse(m);
assert.strictEqual(o.cycles.length, 1);
assert.deepStrictEqual(o.cycles[0].map(short(m)), ['country', 'customer']);
assert.strictEqual(o.stage.get(country.id), o.stage.get(cust.id), 'cycle members load together');
assert(o.selfRefs.has(cust.id));
assert(o.stage.get(T('orders').id) > o.stage.get(cust.id));

// 4) empty model
assert.deepStrictEqual(O.analyse({ tables: [], schemas: [], catalogs: [], relations: [] }).stages, []);
// 5) SLA: cumulative availability
m = load('sample_data_models/example.model.json');
m.tables.forEach((t) => delete t.sla); // the shipped example carries SLAs; start clean
const S = (nm) => m.tables.find((t) => t.name === nm);
S('country').sla = { exclude: true };            // static reference data: ignored
S('product').sla = { frequency: 'monthly', time: '08:00' }; // slower than its dependants: does not hold them up
S('customer').sla = { frequency: 'daily', time: '06:00' };
S('orders').sla = { frequency: 'daily', time: '05:30' };     // promises earlier than customer is ready: at risk
S('order_item').sla = { frequency: 'daily', time: '06:30' };
S('customer_product').sla = { frequency: 'hourly' };         // continuous: no clock time
// customer_orders_mv has no SLA of its own: derived from orders
o = O.analyse(m); n = short(m);
const av = (nm) => o.avail.get(S(nm).id), at = (nm) => O.hhmm(av(nm).ready);
assert.strictEqual(av('country').excluded, true);
assert.strictEqual(at('customer'), '06:00', 'customer ignores the excluded country');
assert.strictEqual(at('orders'), '06:00'); assert(av('orders').atRisk, 'orders SLA 05:30 is earlier than customer 06:00');
assert.strictEqual(at('order_item'), '06:30', 'monthly product does not delay a daily table; orders ready 06:00');
assert(!av('order_item').atRisk);
assert.strictEqual(at('customer_orders_mv'), '06:00'); assert(av('customer_orders_mv').derived);
assert.strictEqual(av('customer_product').ready, null); assert(av('customer_product').continuous);
assert.strictEqual(O.hhmm(o.readyBy), '08:00', 'pipeline ready when the last table is (monthly product itself)');
assert.deepStrictEqual(o.atRisk.map(n), ['orders']);
assert.strictEqual(o.critical.map(n).join('>'), 'product');
const J = O.toJSON(m, o, '2026-01-01T00:00:00Z');
assert.strictEqual(J.format, 'strata-load-order/1'); assert.strictEqual(J.summary.pipelineReadyBy, '08:00');
assert.deepStrictEqual(J.summary.slaAtRisk, ['main.sales.orders']);
const jo = J.stages.flatMap((st) => st.tables).find((t) => t.ref === 'main.sales.orders');
assert.deepStrictEqual(jo.sla, { frequency: 'daily', time: '05:30' }); assert.strictEqual(jo.availableBy, '06:00'); assert.strictEqual(jo.waitsFor, 'main.sales.customer'); assert(jo.slaAtRisk);
assert.strictEqual(JSON.stringify(JSON.parse(JSON.stringify(J))), JSON.stringify(J), 'plain JSON');
assert.strictEqual(O.slaProblem({ frequency: 'daily' }) != null, true); assert.strictEqual(O.slaProblem({ frequency: 'daily', time: '24:00' }) != null, true);
assert.strictEqual(O.slaProblem({ frequency: 'daily', time: '06:00' }), null); assert.strictEqual(O.slaProblem({ frequency: 'hourly' }), null); assert.strictEqual(O.slaProblem({ exclude: true }), null);
// file format round trip keeps sla
const back = M.fromFile(M.toFile(m), 'physical');
assert.deepStrictEqual(back.tables.find((t) => t.name === 'orders').sla, { frequency: 'daily', time: '05:30' });
assert.deepStrictEqual(back.tables.find((t) => t.name === 'country').sla, { exclude: true });
assert.strictEqual(back.tables.find((t) => t.name === 'customer_orders_mv').sla, undefined);
assert.strictEqual(M.stringify(M.toFile(back)), M.stringify(M.toFile(m)), 'round trip is stable');
// 6) begin / ready / duration (first data feeding the last table -> last table) and the hover estimate
assert.strictEqual(o.duration, 0, 'the monthly product is last and has no inputs with a time');
S('product').sla = { frequency: 'daily', time: '05:00' };
o = O.analyse(m);
assert.strictEqual(O.hhmm(o.beginsAt), '05:00', 'product feeds order_item'); assert.strictEqual(O.hhmm(o.readyBy), '06:30'); assert.strictEqual(o.duration, 90); assert.strictEqual(O.dur(o.duration), '1h 30m'); assert.strictEqual(O.dur(45), '45m');
const J2 = O.toJSON(m, o); assert.strictEqual(J2.summary.pipelineBeginsAt, '05:00'); assert.strictEqual(J2.summary.pipelineDurationMinutes, 90);
assert.strictEqual(J2.stages.flatMap((st) => st.tables).find((t) => t.ref === 'main.sales.orders').startsAfter, '06:00');
const ex = O.explain(m, o, S('orders').id).join('\n');
assert(/SLA: daily, data available by 05:30/.test(ex) && /Inputs are ready at 06:00 \(last to arrive: main.sales.customer at 06:00\)/.test(ex) && /Expected data available: 06:00/.test(ex) && /earlier than its inputs allow/.test(ex), ex);
assert(/Out of SLA/.test(O.explain(m, o, S('country').id)[0]));
assert(/derived/.test(O.explain(m, o, S('customer_orders_mv').id).join(' ')));

// 7) a cross-part relationship (release 2 part 4, ADR-0045 extended): never enters m.relations / a column foreignKey (see the matching
// impact.check.js test for why), so it never adds a phantom table or a phantom dependency to the load order either
{
  const Fx = { strata: 2, project: { name: 'X', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table' },
    schemas: [{ name: 'public' }],
    tables: [{ name: 'orders', schema: 'public', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'customer_id', type: 'INTEGER' }] }],
    relationships: [{ parent: 'public.customers.id', child: 'public.orders.customer_id', cardinality: '1..M' }] };
  const mx = M.fromFile(Fx);
  mx.crossPart = { tables: ['public.customers'], columns: ['public.customers.id'], entities: [], concepts: [], metrics: [], duplicates: [], owner: { tables: { 'public.customers': 'catalog' } }, domainOfPart: { catalog: 'Catalog' } };
  const ox = O.analyse(mx);
  assert.strictEqual(ox.stages.reduce((a, s) => a + s.ids.length, 0), mx.tables.length, 'exactly this part\'s own tables load, nothing phantom');
  assert.deepStrictEqual(ox.roots.map((id) => mx.tables.find((t) => t.id === id).name), ['orders'], 'orders has no LOCAL dependency here: its cross-part one lives in another file');
}
console.log('order check ok');
