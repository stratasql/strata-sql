// Self-check for media/align.js and the layer part of the file format (media/model.js). Run: node tests/align.check.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SM = require('../media/model.js');
const A0 = require('../media/align.js');
// this suite checks the alignment warnings; governance warnings (the samples have some, accepted or not) are covered by governance.check
const onlyAlign = (l) => l.filter((w) => w.kind in A0.KINDS);
const A = { ...A0, check: (m) => { const r = A0.check(m); return { all: onlyAlign(r.all), open: onlyAlign(r.open), acked: onlyAlign(r.acked) }; } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sample_data_models', f), 'utf8'));
const text = (m) => SM.stringify(SM.toFile(m)) + '\n';
const roundTrip = (m, lv) => { const t = text(m); assert.equal(text(SM.fromFile(JSON.parse(t), lv)), t, 'fromFile(toFile(m)) must be identity'); return t; };
let ids = 0;
const uid = () => 'x' + ++ids;

// 1. names and suggestions
assert.equal(A.entityName('dim_customer'), 'Customer');
assert.equal(A.entityName('customers'), 'Customer');
assert.equal(A.entityName('order_details'), 'Order Detail');
assert.equal(A.entityName('categories'), 'Category');
assert.equal(A.entityName('addresses'), 'Address');
assert.equal(A.entityName('CustomerAddress'), 'Customer Address');
assert.equal(A.entityName('sat_customer_hist'), 'Customer');
const E = (name) => ({ name });
assert.equal(A.bestMatch('customer_address', [E('Customer'), E('Order')]).name, 'Customer');
assert.equal(A.bestMatch('customer_address', [E('Customer'), E('Customer Address')]).name, 'Customer Address');
assert.equal(A.bestMatch('dim_customer', [E('Customer')]).name, 'Customer');
assert.equal(A.bestMatch('product', [E('Customer')]), null);

// 2. legacy files: no layers, no warnings, same text (migration is a no-op)
for (const f of ['example', 'northwind', 'fpml']) {
  const o = read(f + '.model.json');
  if (o.conceptual || o.logical) continue; // the showcase already has layers
  const m = SM.fromFile(o, 'physical');
  assert.equal(A.check(m).all.length, 0, f + ': a model without layers never warns');
  assert.equal(A.view(m, 'logical'), null);
  assert.equal(text(m), fs.readFileSync(path.join(__dirname, '..', 'sample_data_models', f + '.model.json'), 'utf8'));
}

// 3. generate from physical (Northwind, physical part only)
const nwFile = read('northwind.model.json');
delete nwFile.conceptual; delete nwFile.logical; delete nwFile.alignment; delete nwFile.semantic; // metric grains name the showcase entities
for (const lv of ['conceptual', 'logical']) if (nwFile.layout) delete nwFile.layout[lv];
nwFile.tables.forEach((t) => delete t.entity);
const nw = SM.fromFile(nwFile, 'physical');
const n = A.generate(nw, uid);
const bridges = ['employee_territories', 'customer_customer_demo']; // order_details has attributes: an associative entity
const plain = nw.tables.filter((t) => t.kind !== 'view' && !bridges.includes(t.name));
assert.equal(n.mapped, plain.length, 'every plain table is mapped, bridge tables and views are not');
assert.equal(n.entities, plain.length, 'one entity per table on Northwind (no name collisions)');
assert.equal(n.concepts, n.entities);
assert.ok(n.lrels >= 10 && n.crels >= 8, `relationships generated (${n.lrels} logical, ${n.crels} conceptual)`);
const by = (list, name) => list.find((x) => x.name === name);
assert.ok(by(nw.entities, 'Customer') && by(nw.entities, 'Order Detail') && by(nw.entities, 'Country'));
assert.ok(nw.lrels.some((r) => r.parentId === by(nw.entities, 'Employee').id && r.childId === r.parentId), 'self reference (reports to) becomes a logical self relationship');
assert.ok(nw.lrels.some((r) => r.cardinality === 'M..M' && r.parentId === by(nw.entities, 'Order').id && r.childId === by(nw.entities, 'Product').id), 'an M..M realised by a bridge table becomes a logical M..M');
assert.deepEqual(A.check(nw).all.filter((w) => w.kind in A.KINDS).map((w) => w.key), [], 'freshly generated layers are aligned (governance warnings are checked in governance.check)');
assert.deepEqual(A.generate(nw, uid), { entities: 0, concepts: 0, mapped: 0, lrels: 0, crels: 0 }, 'generate is idempotent');

// 4. round trip, flatten / unflatten, history with layers
const t1 = roundTrip(nw, 'physical');
roundTrip(nw, 'logical');
const F1 = JSON.parse(t1);
assert.deepEqual(Object.keys(F1).slice(0, 5), ['strata', 'project', 'governance', 'conceptual', 'logical'], 'layers come right after governance, top-down');
assert.equal(by(F1.tables, 'customers').entity, 'Customer');
assert.equal(by(F1.logical.entities, 'Customer').concept, 'Customer');
const fl = SM.flatten(F1);
assert.ok(fl.modelling['concept:Customer'] && fl.modelling['entity:Customer'] && Object.keys(fl.modelling).some((k) => k.startsWith('lrel:')) && Object.keys(fl.modelling).some((k) => k.startsWith('crel:')));
const back = SM.unflatten(fl.modelling, fl.governance);
assert.equal(SM.hash(SM.canon(SM.flatten(back).modelling)), SM.hash(SM.canon(fl.modelling)), 'unflatten keeps the layers');
const hist = SM.newHistory();
for (const s of SM.STREAMS) SM.commit(hist, s, null, fl[s], { message: 'Baseline' });
assert.deepEqual(SM.verify(hist, fl), []);

// 5. merge: customer_demographics' entity into Customer (1 concept -> 1 entity -> 2 tables)
const seg = by(nw.entities, 'Customer Demographics'), cust = by(nw.entities, 'Customer');
A.mergeInto(nw, 'entity', seg.id, cust.id);
assert.ok(!by(nw.entities, 'Customer Demographics'));
assert.deepEqual(A.tablesOf(nw, cust).map((t) => t.name).sort(), ['customer_demographics', 'customers']);
assert.ok(!nw.lrels.some((r) => r.parentId === cust.id && r.childId === cust.id), 'the M..M between the two became internal and is gone');
const leftover = A.check(nw).all.filter((w) => w.kind in A.KINDS).map((w) => w.kind);
assert.deepEqual(leftover, ['no-entity'], 'after the merge only the orphaned concept is reported: ' + leftover);
A.remove(nw, 'concept', by(nw.concepts, 'Customer Demographics').id);
assert.deepEqual(A.check(nw).all.filter((w) => w.kind in A.KINDS), []);
roundTrip(nw, 'logical');

// 6. warnings and their fixes
const m = SM.fromFile(JSON.parse(t1), 'physical');
const orders = by(m.tables, 'orders'), shippers = by(m.tables, 'shippers');
orders.entityIds = [];
let w = A.check(m).open;
assert.ok(w.some((x) => x.key === 'unmapped:northwind.sales.orders' && x.fix && x.fix.entity === by(m.entities, 'Order').id), 'unmapped table with a suggestion');
A.applyFix(m, w.find((x) => x.kind === 'unmapped'), uid);
assert.equal(A.check(m).all.length, 0);
// physical FK with no logical counterpart, then the fix adds it
m.lrels = m.lrels.filter((r) => !(r.parentId === by(m.entities, 'Shipper').id));
w = A.check(m).open.filter((x) => x.kind === 'no-logical-rel');
assert.equal(w.length, 1);
assert.ok(A.check(m).open.some((x) => x.kind === 'conceptual-rel-unrealised'), 'the conceptual Shipper -> Order is now unrealised too');
A.applyFix(m, w[0], uid);
assert.equal(A.check(m).all.length, 0);
// cardinality conflict physical vs logical
const lr = m.lrels.find((r) => r.parentId === by(m.entities, 'Shipper').id);
lr.cardinality = '1..1';
w = A.check(m).open.filter((x) => x.kind === 'cardinality');
assert.deepEqual(w.map((x) => x.key.split(':')[1]), ['physical', 'logical'], 'conflicts with the physical FK and with the conceptual relationship');
A.applyFix(m, w[0], uid);
assert.equal(lr.cardinality, '1..M');
assert.equal(A.check(m).all.length, 0);
// an M..M above is how 1..M foreign keys through a bridge / associative table look from higher up: no conflict
lr.cardinality = 'M..M';
assert.equal(A.check(m).open.filter((x) => x.kind === 'cardinality' && x.key.startsWith('cardinality:physical')).length, 0, '1..M below an M..M is compatible');
lr.cardinality = '1..M';
// entity without a concept (suggested), concept without an entity, entity without a table
by(m.entities, 'Shipper').conceptId = null;
w = A.check(m).open;
assert.ok(w.some((x) => x.kind === 'no-concept' && x.fix));
assert.ok(w.some((x) => x.kind === 'no-entity'));
A.applyFix(m, w.find((x) => x.kind === 'no-concept'), uid);
m.entities.push(SM.norm({ id: uid(), name: 'Invoice', conceptId: by(m.concepts, 'Order').id, pos: {} }));
assert.deepEqual(A.check(m).open.map((x) => x.key), ['no-table:Invoice']);
// acknowledge: stored, versioned, round-trips
m.ack.push('no-table:Invoice');
assert.equal(A.check(m).open.length, 0);
assert.equal(A.check(m).acked.length, 1);
const t2 = roundTrip(m, 'physical');
assert.deepEqual(JSON.parse(t2).alignment, { acknowledged: ['no-table:Invoice'] });
assert.ok(SM.flatten(JSON.parse(t2)).modelling.alignment);
// logical relationship with no conceptual counterpart
const inv = by(m.entities, 'Invoice');
m.lrels.push({ id: uid(), parentId: by(m.entities, 'Customer').id, childId: inv.id, cardinality: '1..M', name: 'is billed', description: '' });
assert.ok(A.check(m).open.every((x) => x.kind !== 'no-conceptual-rel'), 'Customer -> Order concept pair exists already');
inv.conceptId = by(m.concepts, 'Supplier').id;
w = A.check(m).open.filter((x) => x.kind === 'no-conceptual-rel');
assert.equal(w.length, 1);
A.applyFix(m, w[0], uid);
assert.equal(A.check(m).open.filter((x) => x.kind === 'no-conceptual-rel').length, 0);

// 7. inheritance: concept > entity > table; nearest wins, tags are a union, "-tag" drops one
const c = by(m.concepts, 'Customer'), ce = by(m.entities, 'Customer'), ct = by(m.tables, 'customers');
c.tags = ['pii']; c.properties = { business_owner: 'Sales', data_steward: 'MDM' }; c.description = 'Anyone who buys from us.';
ce.description = ''; ce.properties = { data_steward: 'Customer data team' };
ct.description = ''; ct.displayName = ''; ct.tags = ['master_data']; ct.properties = {};
let ef = A.effective(m, ct);
assert.equal(ef.description.v, 'Anyone who buys from us.');
assert.deepEqual(ef.description.from, { kind: 'concept', name: 'Customer' });
assert.deepEqual(ef.displayName, { v: 'Customer', from: { kind: 'entity', name: 'Customer' } });
assert.deepEqual(ef.tags.map((x) => [x.name, A.fromText(x.from)]), [['master_data', ''], ['pii', 'concept Customer']]);
assert.deepEqual(ef.properties.data_steward, { v: 'Customer data team', from: { kind: 'entity', name: 'Customer' } });
assert.deepEqual(ef.properties.business_owner, { v: 'Sales', from: { kind: 'concept', name: 'Customer' } });
ct.tags = ['master_data', '-pii'];
ef = A.effective(m, ct);
assert.deepEqual(ef.dropped.map((x) => x.name), ['pii']);
w = A.check(m).open.filter((x) => x.kind === 'tag-dropped');
assert.deepEqual(w.map((x) => x.key), ['tag-dropped:table:northwind.sales.customers:pii']);
roundTrip(m, 'physical');
A.applyFix(m, w[0], uid);
assert.deepEqual(ct.tags, ['master_data']);
// a drop on the entity also reaches its tables
ce.tags = ['-pii'];
assert.ok(!A.effective(m, ct).tags.some((x) => x.name === 'pii'));
ce.tags = [];

// 8. One Big Table: a table realising several entities is written as a list and inherits from all of them
by(m.tables, 'orders').entityIds.push(ce.id);
const F3 = JSON.parse(roundTrip(m, 'physical'));
assert.deepEqual(by(F3.tables, 'orders').entity, ['Order', 'Customer']);
assert.ok(A.effective(m, by(m.tables, 'orders')).tags.some((x) => x.name === 'pii' && x.from.kind === 'concept'));

// 9. view for the canvas: logical frames by concept, attributes from the realising tables
const v = A.view(m, 'logical');
assert.equal(v.layer, 'entity');
assert.ok(v.schemas.some((s) => s.name === 'Customer'));
assert.deepEqual(ce.columns.map((x) => x.name).slice(0, 7), by(m.tables, 'customers').columns.map((x) => x.name), 'attributes: the realising tables\' columns, deduplicated by name');
assert.ok(ce.columns.some((x) => x.name === 'order_date') && ce.columns.filter((x) => x.name === 'customer_id').length === 1, 'orders realises Customer too (OBT), customer_id once');
assert.equal(A.view(m, 'conceptual').tables.length, m.concepts.length);
assert.equal(A.view(m, 'physical'), null);

// 10. unknown pointers are kept as written and reported (ADR-0042), never dropped, never crash
const bad = JSON.parse(t1);
bad.tables[0].entity = 'Nope'; bad.logical.entities[0].concept = 'Nope'; bad.logical.relationships.push({ parent: 'Nope', child: 'Customer' });
const mb = SM.fromFile(bad, 'physical');
assert.equal(mb.warnings.length, 0, 'nothing is dropped, so nothing is announced as dropped');
const broken = A.check(mb).all.filter((w) => w.kind === 'broken-ref');
assert.equal(broken.length, 3, 'a table link, an entity link and a relationship');
assert.ok(broken.every((w) => w.fix && w.fix.label && w.level), 'each has a fix');
const kept = SM.toFile(mb);
assert.ok(kept.tables.some((t) => t.entity === 'Nope') && kept.logical.entities.some((e) => e.concept === 'Nope') && kept.logical.relationships.some((r) => r.parent === 'Nope' && r.child === 'Customer'), 'and the file comes back with all three');
const fixed = SM.fromFile(bad, 'physical'); for (const w of A.check(fixed).all.filter((x) => x.kind === 'broken-ref')) A.applyFix(fixed, w);
assert.equal(A.check(fixed).all.filter((w) => w.kind === 'broken-ref').length, 0, 'deleting the references clears the warnings');
assert.ok(!JSON.stringify(SM.toFile(fixed)).includes('Nope'), 'and they are gone from the file');

// 11. layout per level: layer levels are keyed by concept / entity name
const pos = SM.fromFile(JSON.parse(t1), 'conceptual');
pos.concepts[0].x = 10; pos.concepts[0].y = 20;
const F4 = { layout: SM.layoutOf(pos, 'conceptual') };
assert.deepEqual(F4.layout.conceptual[pos.concepts[0].name], [10, 20]);
assert.ok(!Object.keys(F4.layout.conceptual).some((k) => k.includes('.')), 'no table refs on a level that draws concepts');

// 12. load order on the higher levels (ADR-0033): derived from the tables, ready when all tables are
const OR = require('../media/order.js');
const nw2 = SM.fromFile(read('northwind.model.json'), 'physical');
const nmOf = (m2, id) => [...m2.entities, ...m2.concepts].find((x) => x.id === id).name;
const idOf = (list, name) => list.find((x) => x.name === name).id;
const oT = OR.analyse(nw2), oL = A.order(nw2, 'logical', oT), oC = A.order(nw2, 'conceptual', oT);
assert.equal(A.order(nw2, 'physical'), null, 'no rollup on the physical level');
const stageOf = (o, list, name) => o.stage.get(idOf(list, name));
assert.ok(stageOf(oL, nw2.entities, 'Order Line') > stageOf(oL, nw2.entities, 'Order') && stageOf(oL, nw2.entities, 'Order') > stageOf(oL, nw2.entities, 'Customer'), 'entity stages follow the table dependencies');
assert.ok(stageOf(oC, nw2.concepts, 'Order') > stageOf(oC, nw2.concepts, 'Product'), 'Order needs Product (order lines need products)');
assert.ok(!oL.deps.get(idOf(nw2.entities, 'Order')).has(idOf(nw2.entities, 'Order')), 'no self dependency');
assert.ok(!oC.deps.get(idOf(nw2.concepts, 'Order')).has(idOf(nw2.concepts, 'Order')), 'order lines needing orders is internal to the concept Order');
const ordTables = A.tablesOfConcept(nw2, nw2.concepts.find((c) => c.name === 'Order'));
const latest = Math.max(...ordTables.map((t) => oT.avail.get(t.id).ready).filter((x) => x != null));
assert.equal(oC.avail.get(idOf(nw2.concepts, 'Order')).ready, latest, 'a concept is ready when all its tables are');
assert.ok(oL.readyBy != null && oC.critical.length >= 2, 'rolled-up critical path');
assert.ok(oL.explain(idOf(nw2.entities, 'Order Line')).join(' ').includes('Ready when all its'), 'explain text');
// look-through: entity X realised by a table that needs an unmapped table that needs a table of entity Y -> X needs Y
const lt = SM.fromFile(JSON.parse(t1), 'physical');
const od = by(lt.tables, 'order_details'); od.entityIds = [];
const oLt = A.order(lt, 'logical');
assert.ok(!oLt.stage.has(idOf(lt.entities, 'Order Detail')), 'an entity realised by no table is left out');
// unrealised entity out, the rest unchanged
assert.ok(oLt.stage.has(idOf(lt.entities, 'Product')));
const bridgeLook = SM.fromFile(JSON.parse(t1), 'physical');
by(bridgeLook.tables, 'orders').entityIds = []; // order_details (Order Detail) -> orders (unmapped) -> customers (Customer)
assert.ok(A.order(bridgeLook, 'logical').deps.get(idOf(bridgeLook.entities, 'Order Detail')).has(idOf(bridgeLook.entities, 'Customer')), 'dependencies look through a table that realises nothing');

// 13. impact on the higher levels: rolled up from the tables, plus the level's own relationships
const imp = (m2, lv, list, names, mode = 'delete') => A.impact(m2, lv, names.map((n) => (lv === 'conceptual' ? 'concept:' : 'entity:') + idOf(list, n)), mode);
let ri = imp(nw2, 'logical', nw2.entities, ['Customer']);
assert.equal(ri.state, 'impacted');
assert.ok(ri.impacted.has(idOf(nw2.entities, 'Order')), 'orders reference customers: Order is impacted');
assert.ok(ri.upstream.has(idOf(nw2.entities, 'Address')), 'customers reference addresses: Address is upstream');
assert.ok(!ri.impacted.has(idOf(nw2.entities, 'Customer')), 'the selection itself is a source, not impacted');
ri = imp(nw2, 'conceptual', nw2.concepts, ['Product']);
assert.ok(ri.impacted.has(idOf(nw2.concepts, 'Order')) && ri.upstream.has(idOf(nw2.concepts, 'Supplier')));
assert.ok(ri.tables.length === 2, 'a concept selects the tables of all its entities');
// relationship-only (no tables yet): the child side of the level's relationship is impacted, the parent upstream
const ro = SM.fromFile(JSON.parse(t1), 'physical');
const pA = SM.norm({ id: 'pa', name: 'Plan A', pos: {} }), pB = SM.norm({ id: 'pb', name: 'Plan B', pos: {} });
ro.entities.push(pA, pB); ro.lrels.push({ id: 'r1', parentId: 'pa', childId: 'pb', cardinality: '1..M', name: '', description: '' });
assert.equal(A.impact(ro, 'logical', ['entity:pa'], 'delete').state, 'impacted');
assert.ok(A.impact(ro, 'logical', ['entity:pa'], 'delete').impacted.has('pb'));
assert.equal(A.impact(ro, 'logical', ['entity:pb'], 'delete').state, 'linked', 'only a parent above it: review');
const lone = SM.norm({ id: 'lone', name: 'Lonely', pos: {} }); ro.entities.push(lone);
assert.equal(A.impact(ro, 'logical', ['entity:lone'], 'delete').state, 'safe');
// One Big Table: another entity realised by a selected table is impacted
const obt = SM.fromFile(JSON.parse(t1), 'physical');
by(obt.tables, 'orders').entityIds.push(idOf(obt.entities, 'Shipper'));
assert.ok(imp(obt, 'logical', obt.entities, ['Order']).impacted.has(idOf(obt.entities, 'Shipper')), 'shares a table with the selection');

// 14. view scope: catalogs / schemas / concepts, resolved per level (union)
const sch = (ref) => nw2.schemas.find((x) => SM.refs(nw2).sch.get(x.id) === ref).id;
let S = A.inScope(nw2, { c: new Set(), s: new Set([sch('northwind.hr')]), k: new Set() });
assert.deepEqual([...S.entities].map((id) => nmOf(nw2, id)).sort(), ['Employee', 'Region', 'Territory']);
assert.deepEqual([...S.concepts].map((id) => nmOf(nw2, id)).sort(), ['Employee', 'Sales Territory']);
S = A.inScope(nw2, { c: new Set(), s: new Set(), k: new Set([idOf(nw2.concepts, 'Product')]) });
assert.deepEqual([...S.tables].map((id) => nw2.tables.find((t) => t.id === id).name).sort(), ['categories', 'products'], 'a concept pick shows its tables on the physical level');
S = A.inScope(nw2, { c: new Set(), s: new Set([sch('northwind.hr')]), k: new Set([idOf(nw2.concepts, 'Product')]) });
assert.ok(S.concepts.has(idOf(nw2.concepts, 'Product')) && S.concepts.has(idOf(nw2.concepts, 'Employee')), 'picks add up');
assert.equal(A.inScope(nw2, { c: new Set(['gone']), s: new Set(), k: new Set() }), null, 'nothing that still exists = whole project');

// 15. canvas state per level in .strata/layout.json (names, never ids), and the old single-state shape
const st = { level: 'logical', mode: 'schema', history: false, levels: {
  physical: { autoFit: false, view: { x: 10.4, y: -20, k: 0.75 }, scope: { c: new Set(), s: new Set([sch('northwind.sales')]), k: new Set() }, panels: { impact: true, order: false, orderView: 'stages', align: false }, selected: by(nw2.tables, 'orders').id },
  logical: { autoFit: true, view: { x: 40, y: 60, k: 1 }, scope: { c: new Set(), s: new Set(), k: new Set([idOf(nw2.concepts, 'Order')]) }, panels: { impact: false, order: true, orderView: 'tree', align: false }, selected: idOf(nw2.entities, 'Order Line') },
  conceptual: { autoFit: false, view: { x: 5, y: 6, k: 1.2 }, scope: { c: new Set(), s: new Set(), k: new Set() }, panels: { impact: false, order: false, orderView: 'stages', align: true }, selected: idOf(nw2.concepts, 'Customer') } } };
const saved = JSON.parse(JSON.stringify(SM.canvasOut(nw2, st)));
assert.deepEqual(saved.levels.physical.scope, { c: [], s: ['northwind.sales'], k: [] });
assert.equal(saved.levels.physical.selected, 'northwind.sales.orders');
assert.deepEqual(saved.levels.logical.scope.k, ['Order']);
assert.equal(saved.levels.logical.selected, 'Order Line');
assert.equal(saved.levels.conceptual.selected, 'Customer');
const nw3 = SM.fromFile(read('northwind.model.json'), 'physical'); // another session: other ids
const back2 = SM.canvasIn(nw3, saved);
assert.equal(back2.level, 'logical');
assert.equal(by(nw3.tables, 'orders').id, back2.levels.physical.selected);
assert.equal(nw3.entities.find((e) => e.id === back2.levels.logical.selected).name, 'Order Line');
assert.deepEqual(back2.levels.physical.view, { x: 10, y: -20, k: 0.75 });
assert.equal(back2.levels.logical.autoFit, true);
assert.equal(back2.levels.logical.panels.orderView, 'tree');
assert.ok(back2.levels.conceptual.panels.align && !back2.levels.conceptual.panels.impact);
assert.deepEqual(JSON.parse(JSON.stringify(SM.canvasOut(nw3, back2))), saved, 'round trip');
// old layout.json: one state -> scope and panels for every level, view and selection only for its own level
const legacy = { level: 'physical', mode: 'schema', autoFit: false, view: { x: 1, y: 2, k: 0.5 }, scope: { c: [], s: ['northwind.hr'] }, panels: { history: false, impact: false, order: true, orderView: 'pipeline' }, selected: 'northwind.hr.employees' };
const lg = SM.canvasIn(nw3, legacy);
assert.equal(lg.level, 'physical');
assert.deepEqual(lg.levels.physical.view, { x: 1, y: 2, k: 0.5 });
assert.equal(lg.levels.physical.selected, by(nw3.tables, 'employees').id);
for (const lv of ['logical', 'conceptual']) {
  assert.equal(lg.levels[lv].autoFit, true, lv + ': no view from another level');
  assert.equal(lg.levels[lv].selected, null);
  assert.equal(lg.levels[lv].panels.order, true);
  assert.equal(lg.levels[lv].panels.orderView, 'pipeline');
  assert.equal(lg.levels[lv].scope.s.size, 1);
}
assert.equal(SM.canvasIn(nw3, { level: 'physical', levels: { physical: { selected: 'nope', view: { x: NaN } } } }).levels.physical.autoFit, true, 'bad values fall back');
assert.equal(SM.canvasIn(nw3, null), null);
assert.equal(SM.canvasIn(nw3, { level: 'domains' }).level, 'domains', 'the Domains tab is a saved level (change 31)');
assert.equal(SM.canvasIn(nw3, { level: 'nope' }).level, 'physical');
assert.deepEqual(SM.nodesOf(nw3, 'domains'), [], 'like Governance, the Domains tab has no canvas nodes');
// the mini-map switch is global (not per level) and defaults to on, also for files written before it existed
assert.equal(saved.minimap, true);
assert.equal(back2.minimap, true);
assert.equal(lg.minimap, true, 'old files: on');
const off = SM.canvasIn(nw3, JSON.parse(JSON.stringify(SM.canvasOut(nw2, { ...st, minimap: false }))));
assert.equal(off.minimap, false, 'off survives a save');


// 9. parallel relationships (ADR-0040): two relationships between one pair (billing / shipping address) are told apart by their label
{
  const F = {
    strata: 2, project: { name: 'P', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table' },
    conceptual: { concepts: [{ name: 'Order' }, { name: 'Address' }], relationships: [{ parent: 'Address', child: 'Order', cardinality: '1..M', name: 'billing' }, { parent: 'Address', child: 'Order', cardinality: '1..M', name: 'shipping' }] },
    logical: { entities: [{ name: 'Order', concept: 'Order' }, { name: 'Address', concept: 'Address' }, { name: 'Note', concept: 'Order' }], relationships: [{ parent: 'Address', child: 'Order', cardinality: '1..M', name: 'billing' }, { parent: 'Address', child: 'Order', cardinality: '1..M', name: 'shipping' }, { parent: 'Order', child: 'Note', cardinality: '1..M', name: 'has' }] },
    schemas: [{ name: 's' }],
    tables: [
      { name: 'address', schema: 's', entity: 'Address', columns: [{ name: 'id', type: 'INT', pk: true }] },
      { name: 'orders', schema: 's', entity: 'Order', columns: [{ name: 'id', type: 'INT', pk: true }, { name: 'billing_id', type: 'INT' }, { name: 'shipping_id', type: 'INT' }] },
      { name: 'note', schema: 's', entity: 'Note', columns: [{ name: 'order_id', type: 'INT' }] },
    ],
    relationships: [{ parent: 's.address.id', child: 's.orders.billing_id', cardinality: '1..M', name: 'billing' }, { parent: 's.address.id', child: 's.orders.shipping_id', cardinality: '1..M', name: 'shipping' }, { parent: 's.orders.id', child: 's.note.order_id', cardinality: '1..M', name: 'has' }],
  };
  const m = SM.fromFile(F, 'logical'), keys = () => A.check(m).all.map((w) => w.key);
  assert.equal(m.lrels.length, 3); assert.equal(m.crels.length, 2, 'both are kept on load');
  roundTrip(m, 'logical');
  const f = SM.flatten(JSON.parse(text(m)));
  assert.deepEqual(Object.keys(f.modelling).filter((k) => k.startsWith('lrel:')).sort(), ['lrel:Address>Order#billing', 'lrel:Address>Order#shipping', 'lrel:Order>Note'], 'a parallel pair keys by label, a single relationship keeps its plain key');
  assert.deepEqual(Object.keys(f.modelling).filter((k) => k.startsWith('crel:')).sort(), ['crel:Address>Order#billing', 'crel:Address>Order#shipping']);
  assert.equal(SM.canon(SM.flatten(SM.unflatten(f.modelling, f.governance, f.semantic))), SM.canon(f), 'unflatten(flatten) keeps both');
  const h = SM.newHistory(); SM.commit(h, 'modelling', null, f.modelling, { message: 'x' });
  assert.deepEqual(SM.verify(h, { modelling: SM.flatten(SM.toFile(SM.fromFile(JSON.parse(text(m)), 'logical'))).modelling, governance: {}, semantic: {} }), [], 'the log holds both and verifies');
  assert.deepEqual(keys(), [], 'each physical relationship finds its logical one by label, each logical one is realised');
  // the label decides: a physical relationship named after neither is not aligned
  const fk = m.tables.find((t) => t.name === 'orders').columns.find((c) => c.name === 'shipping_id').foreignKey;
  fk.name = 'delivery';
  assert.ok(keys().includes('no-logical-rel:s.address.id>s.orders.shipping_id'), 'no logical relationship called delivery');
  assert.ok(keys().includes('logical-rel-unrealised:Address>Order#shipping'), 'and the shipping one lost its physical counterpart');
  const w = A.check(m).all.find((x) => x.kind === 'no-logical-rel'); assert.equal(w.fix.name, 'delivery');
  assert.ok(A.applyFix(m, w), 'the fix adds a third, labelled relationship');
  assert.equal(m.lrels.filter((r) => r.name === 'delivery').length, 1); assert.equal(m.lrels.length, 4);
  assert.ok(!keys().includes('no-logical-rel:s.address.id>s.orders.shipping_id'));
  fk.name = 'shipping';
  // unnamed physical relationships match any of the pair (no false alarms), and a single logical relationship matches whatever the label
  fk.name = '';
  assert.ok(!keys().includes('no-logical-rel:s.address.id>s.orders.shipping_id'));
  // generate: two named foreign keys between one pair make two logical relationships (and two conceptual ones)
  const g = SM.fromFile({ ...F, conceptual: undefined, logical: undefined, tables: F.tables.map(({ entity, ...t }) => t) }, 'physical');
  A.generate(g, uid);
  assert.equal(g.lrels.filter((r) => ['billing', 'shipping'].includes(r.name)).length, 2, 'generate keeps parallel foreign keys apart');
  assert.equal(g.crels.filter((r) => ['billing', 'shipping'].includes(r.name)).length, 2);
  assert.deepEqual(A.check(g).all.map((x) => x.key), [], 'and the result is aligned');
  // merging entities keeps relationships with different labels, and still folds the same one
  const mg = SM.fromFile(F, 'logical'), en = (n) => mg.entities.find((e) => e.name === n);
  const x = { id: 'x', name: 'Order2' }; mg.entities.push(SM.norm({ ...x, conceptId: en('Order').conceptId, pos: {} }));
  mg.lrels.push({ id: 'l1', parentId: en('Address').id, childId: 'x', cardinality: '1..M', name: 'shipping', description: '' }, { id: 'l2', parentId: en('Address').id, childId: 'x', cardinality: '1..M', name: 'billing', description: '' }, { id: 'l3', parentId: en('Address').id, childId: 'x', cardinality: '1..M', name: 'gift', description: '' });
  A.mergeInto(mg, 'entity', 'x', en('Order').id);
  assert.deepEqual(mg.lrels.filter((r) => r.parentId === en('Address').id).map((r) => r.name).sort(), ['billing', 'gift', 'shipping'], 'same labels fold, different ones stay');
}

// ---- cross-part reference resolution (release 2 part 2, ADR-0045 point 6): m.crossPart, the whole-project name index ----
{
  const Fx = { strata: 2, project: { name: 'X', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table' },
    schemas: [{ name: 'public' }], tables: [{ name: 'orders', schema: 'public', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: 'customer_id', type: 'INTEGER' }] }],
    conceptual: { concepts: [{ name: 'Order' }], relationships: [{ parent: 'Order', child: 'Nowhere', cardinality: '1..M' }] },
    relationships: [{ parent: 'public.customers.id', child: 'public.orders.customer_id', cardinality: '1..M' }] };
  const mx = SM.fromFile(Fx);
  assert.equal(A0.check(mx).all.filter((w) => w.kind === 'broken-ref').length, 2, 'without a project index: both the physical and the conceptual reference are broken');
  mx.crossPart = { tables: ['public.customers'], columns: ['public.customers.id'], entities: [], concepts: [], metrics: [], duplicates: [] };
  assert.equal(A0.check(mx).all.filter((w) => w.kind === 'broken-ref').length, 1, 'the physical one resolves in another part now; the conceptual one ("Nowhere" resolves nowhere) still warns');
  assert.equal(A0.check(mx).all.find((w) => w.kind === 'broken-ref').key, 'broken-ref:conceptual:Order>Nowhere');
  mx.crossPart.concepts = ['nowhere'];
  assert.equal(A0.check(mx).all.filter((w) => w.kind === 'broken-ref').length, 0, 'and once the conceptual name resolves too, nothing is broken');
  delete mx.crossPart;
  assert.equal(A0.check(mx).all.filter((w) => w.kind === 'broken-ref').length, 2, 'no index at all (a project of one part): unchanged from release 1');
}

console.log('align.check: all assertions passed');
