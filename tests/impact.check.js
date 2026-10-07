// Self-check for media/impact.js on the Northwind example. Run: node tests/impact.check.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../media/model.js');
const I = require('../media/impact.js');

const m = M.fromFile(JSON.parse(fs.readFileSync(path.join(__dirname, '../sample_data_models/northwind.model.json'), 'utf8')), 'physical');
const R = M.refs(m);
const T = (ref) => m.tables.find((t) => R.tab.get(t.id) === ref);
const C = (ref) => { for (const t of m.tables) for (const c of t.columns) if (R.col.get(c.id) === ref) return c; throw new Error('no column ' + ref); };
const names = (set) => [...set].map((n) => (n.startsWith('table:') ? R.tab.get(n.slice(6)) : R.col.get(n.slice(7)))).sort();
const viewNames = (r) => [...r.impViews].map((id) => R.tab.get(id)).sort();
const N = 'northwind.';

// 1) what each view reads (full names, aliases, joins, views over views)
const G = I.graph(m);
const reads = (ref) => [...G.reads.get(T(N + ref).id).tables].map((id) => R.tab.get(id).replace(N, '')).sort();
assert.deepStrictEqual(reads('reporting.invoices'), ['ref.addresses', 'ref.countries', 'reporting.order_details_extended', 'sales.customers', 'sales.orders', 'sales.shippers', 'hr.employees'].sort());
assert.deepStrictEqual(reads('reporting.order_subtotals'), ['reporting.order_details_extended'], 'a view over a view');
assert.deepStrictEqual(reads('reporting.current_product_list'), ['product.products']);

// 2) deleting a column: FK children + every view that mentions it, and the views' columns
let r = I.analyse(m, [I.key('column', C(N + 'product.categories.category_id').id)], 'delete');
assert(!r.safe && names(r.impacted).includes(N + 'product.products.category_id'), 'FK child column impacted');
assert(viewNames(r).includes(N + 'reporting.alphabetical_list_of_products') && viewNames(r).includes(N + 'reporting.mv_sales_by_category_year'), 'views mentioning the column are impacted');
assert(!viewNames(r).includes(N + 'reporting.current_product_list'), 'unrelated view is not');
assert(names(r.impacted).includes(N + 'reporting.alphabetical_list_of_products.category_name'), 'a broken view breaks all its columns');
assert(r.lineage.length > 0 && r.lineage.every((e) => e.column), 'column-level lineage into views');

// 3) deleting a table: everything inside is removed, dependants (FK children, joins, views over it) are impacted
r = I.analyse(m, [I.key('table', T(N + 'sales.shippers').id)], 'delete');
assert(r.sources.has(I.key('column', C(N + 'sales.shippers.phone').id)), 'contained columns are removed too');
assert(names(r.impacted).includes(N + 'sales.orders.shipper_id') && viewNames(r).includes(N + 'reporting.invoices'), 'orders.shipper_id and invoices impacted');
assert(viewNames(r).length === 1, 'only invoices reads shippers');
r = I.analyse(m, [I.key('table', T(N + 'sales.order_details').id)], 'delete');
assert(['order_details_extended', 'order_subtotals', 'invoices', 'mv_sales_by_category_year', 'mv_monthly_sales_summary'].every((v) => viewNames(r).includes(N + 'reporting.' + v)), 'views over impacted views follow (order_details -> order_details_extended -> order_subtotals, ...)');
assert(!viewNames(r).includes(N + 'reporting.current_product_list'), 'and unrelated views stay clean');

// 4) a column nothing depends on is safe; several columns can be selected together
const safeCols = ['sales.customers.fax', 'hr.employees.notes'].map((x) => I.key('column', C(N + x).id));
r = I.analyse(m, safeCols, 'delete');
assert(r.safe && r.sources.size === 2, 'unreferenced columns: no impact');
r = I.analyse(m, [...safeCols, I.key('column', C(N + 'product.categories.category_id').id)], 'delete');
assert(!r.safe && r.sources.has(safeCols[0]), 'mixed selection: impact comes from the referenced column only');

// 5) delete a schema / catalog: the whole subtree is a source
r = I.analyse(m, [I.key('schema', m.schemas.find((s) => s.name === 'product').id)], 'delete');
assert(r.sources.has(I.key('table', T(N + 'product.products').id)) && names(r.impacted).includes(N + 'sales.order_details.product_id'), 'schema delete impacts other schemas');
r = I.analyse(m, [I.key('catalog', m.catalogs[0].id)], 'change');
assert(r.srcTables.size === m.tables.length && [...r.impacted].every((n) => n.startsWith('metric:')) && r.impMetrics.size === m.metrics.length, 'everything is inside the catalog: only the metrics built on it (semantic level) are affected outside it');

// 7) upstream counts too: nothing depends on it, but it depends on something => linked, never "safe"
r = I.analyse(m, [I.key('table', T(N + 'hr.employee_territories').id)], 'delete');
assert(r.impacted.size === 0 && r.state === 'linked' && !r.safe && r.linked, 'a leaf table with foreign keys is not safe to delete');
assert(['hr.employees', 'hr.territories'].every((x) => [...r.upTables].map((id) => R.tab.get(id)).includes(N + x)), 'its FK parents are upstream: ' + [...r.upTables].map((id) => R.tab.get(id)));
r = I.analyse(m, [I.key('table', T(N + 'reporting.order_subtotals').id)], 'delete');
assert(r.state === 'linked' && [...r.upViews].map((id) => R.tab.get(id)).includes(N + 'reporting.order_details_extended'), 'a view that reads other objects is linked to them');
assert(r.lineage.some((e) => e.up && e.view === T(N + 'reporting.order_subtotals').id), 'upstream lineage edges are produced');
r = I.analyse(m, [I.key('column', C(N + 'hr.employee_territories.territory_id').id)], 'delete');
assert(r.state === 'linked' && r.upstream.has(I.key('column', C(N + 'hr.territories.territory_id').id)), 'an FK column has its referenced column upstream');
r = I.analyse(m, [I.key('table', T(N + 'ref.countries').id)], 'delete');
assert(r.state === 'impacted' && r.impacted.size > 0 && !r.safe, 'a referenced table is impacted');
r = I.analyse(m, safeCols, 'delete');
assert(r.state === 'safe' && r.safe && r.upstream.size === 0, 'plain unreferenced columns are still safe');
// an isolated table (no FK, no view, no relationship) is the only kind of table that is safe
const iso = { id: 'iso1', name: 'lonely', kind: 'table', schemaId: m.schemas[0].id, columns: [{ id: 'iso1c', name: 'x', dataType: 'INT' }], tags: [], properties: {} };
m.tables.push(iso);
r = I.analyse(m, [I.key('table', 'iso1')], 'delete');
assert(r.safe && r.state === 'safe', 'an isolated table is safe');
m.tables.pop();

// 6) unused columns: not PK/unique, not FK, not mentioned by a view
const unused = I.unusedColumns(m, false).map((u) => R.col.get(u.columnId).replace(N, ''));
assert(unused.includes('sales.customers.fax') && unused.includes('hr.employees.notes'), 'fax and notes are unused');
assert(!unused.includes('sales.orders.order_id') && !unused.includes('sales.orders.customer_id') && !unused.includes('product.products.reorder_level'), 'PK, FK and view-mentioned columns are not unused');
assert(I.unusedColumns(m, true).length >= unused.length, 'includeKeys never removes columns');

// 7) a cross-part relationship (release 2 part 4, ADR-0045 extended): media/model.js#fromFile only ever builds a real FK / relation once
// BOTH ends resolve locally, so a reference into another part of a split project never enters m.relations / a column's foreignKey — it
// stays a m.dangling entry (media/align.js#crossHas suppresses the broken-ref warning; media/canvas.js draws a labelled, non-red stub) and
// impact analysis simply never sees it, exactly as a genuinely broken reference never crashes it either.
{
  const Fx = { strata: 2, project: { name: 'X', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table' },
    schemas: [{ name: 'public' }],
    tables: [{ name: 'orders', schema: 'public', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'customer_id', type: 'INTEGER' }] }],
    relationships: [{ parent: 'public.customers.id', child: 'public.orders.customer_id', cardinality: '1..M' }] };
  const mx = M.fromFile(Fx);
  mx.crossPart = { tables: ['public.customers'], columns: ['public.customers.id'], entities: [], concepts: [], metrics: [], duplicates: [], owner: { tables: { 'public.customers': 'catalog' } }, domainOfPart: { catalog: 'Catalog' } };
  assert.deepStrictEqual(mx.relations, [], 'the cross-part relationship never became a working relation');
  const t = mx.tables.find((x) => x.name === 'orders');
  const r = I.analyse(mx, [I.key('table', t.id)], 'delete');
  assert.strictEqual(r.state, 'safe', 'a cross-part reference is outside this part: no local impact, no crash');
}
console.log('impact check ok:', unused.length, 'unused columns in', new Set(I.unusedColumns(m, false).map((u) => u.tableId)).size, 'tables');
