// Self-check for media/gov.js and the governance part of the file format (ADR-0038): tags that bring policies, multi-parent policies,
// inheritance within one level, per-level owners, warnings. Run: node tests/governance.check.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SM = require('../media/model.js');
const A = require('../media/align.js');
const G = require('../media/gov.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'sample_data_models', f), 'utf8');
const text = (m) => SM.stringify(SM.toFile(m)) + '\n';

// 1. every sample loads and writes back byte-identical on every level (and in the governance tab), and its log verifies
for (const f of ['example', 'northwind', 'fpml']) {
  const t = read(f + '.model.json'), o = JSON.parse(t);
  for (const lv of [...SM.LEVELS, 'governance']) assert.equal(text(SM.fromFile(o, lv)), t, `${f}: byte-identical on ${lv}`);
  assert.deepEqual(SM.verify(SM.parseLog(read(f + '.model.history.jsonl')).history, SM.flatten(o)), [], f + ': log verifies');
}
assert.equal(G.check(SM.fromFile({ strata: 2, project: { name: 'P', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table' }, schemas: [{ name: 's' }], tables: [{ name: 't', schema: 's', columns: [{ name: 'id', type: 'INT', pk: true }] }] }, 'physical')).length, 0, 'a model without governance gets no governance warning');

// 2. a small model with every part
const F = {
  strata: 2,
  project: { name: 'P', technology: 'Databricks', methodology: 'ER - 3NF', naming: 'catalog.schema.table',
    governance: { policies: ['Security Baseline'], conceptual: { owner: 'Chief Data Officer' }, logical: { owner: 'Data Architecture' }, physical: { owner: 'Platform Team', steward: 'Data Engineering' } } },
  governance: {
    tags: [{ name: 'pii', displayName: 'Personal Data', policies: ['GDPR'], enabled: true }, { name: 'fin', enabled: true }],
    policies: [
      { name: 'Security Baseline', type: 'security' },
      { name: 'GDPR', parents: ['Security Baseline'], type: 'regulatory', jurisdiction: 'EU', classification: 'Restricted' },
      { name: 'Retention 7 Years', type: 'retention' },
      { name: 'Customer Data', parents: ['GDPR', 'Retention 7 Years'], type: 'business', owner: 'Head of Sales' },
      { name: 'Mask Personal Data', parents: ['GDPR'], type: 'protection' },
    ],
  },
  conceptual: { concepts: [{ name: 'Customer', tags: ['pii'], governance: { owner: 'Head of Sales', criticality: 'High', policies: ['Customer Data'] } }, { name: 'Order', governance: { criticality: 'Critical' } }] },
  logical: { entities: [{ name: 'Customer', concept: 'Customer' }, { name: 'Order', concept: 'Order' }] },
  catalogs: [{ name: 'c', governance: { classification: 'Internal' } }],
  schemas: [{ name: 's', catalog: 'c', governance: { owner: 'Sales Engineering', policies: ['Retention 7 Years'] } }],
  tables: [
    { name: 'customer', schema: 'c.s', entity: 'Customer', columns: [{ name: 'id', type: 'INT', pk: true }, { name: 'email', type: 'STRING', tags: ['pii'] }, { name: 'phone', type: 'STRING', governance: { classification: 'Restricted' } }] },
    { name: 'orders', schema: 'c.s', entity: 'Order', governance: { lifecycle: 'Retired', criticality: 'Critical' }, columns: [{ name: 'id', type: 'INT', pk: true }] },
    { name: 'lines', schema: 'c.s', tags: ['ghost'], governance: { policies: ['Nope'] }, columns: [{ name: 'order_id', type: 'INT' }] },
  ],
  relationships: [{ parent: 'c.s.orders.id', child: 'c.s.lines.order_id', cardinality: '1..M' }],
};
const m = SM.fromFile(F, 'physical'), t0 = text(m);
assert.equal(text(SM.fromFile(JSON.parse(t0), 'physical')), t0, 'fromFile(toFile(m)) is identity with governance');
assert.ok(t0.includes('"policies": ["GDPR"], "enabled": true') && t0.includes('"parents": ["GDPR", "Retention 7 Years"]'), 'tag policies and multi-parent policies in the file');
const fl = SM.flatten(JSON.parse(t0));
assert.deepEqual(fl.governance['tag:pii'].policies, ['GDPR'], 'tag links in the governance stream');
assert.deepEqual(fl.governance['policy:Customer Data'].parents, ['GDPR', 'Retention 7 Years']);
assert.equal(fl.governance['assign:project'].governance.physical.owner, 'Platform Team', 'per-level project defaults are governance values');
assert.ok(!('governance' in fl.modelling['table:c.s.orders']));
assert.equal(SM.canon(SM.flatten(SM.unflatten(fl.modelling, fl.governance))), SM.canon(fl), 'unflatten(flatten) keeps everything');

const T = (n) => m.tables.find((t) => t.name === n), C = (n) => m.concepts.find((c) => c.name === n), E = (n) => m.entities.find((e) => e.name === n);
const col = (t, c) => T(t).columns.find((x) => x.name === c);
const names = (o) => G.reach(m, o).map((r) => r.name).sort();
const how = (o, n) => G.reach(m, o).find((r) => r.name === n);

// 3. policies: attaching one applies its ancestors (several parents); tags bring policies; inheritance only within a level
assert.deepEqual(names(C('Customer')), ['Customer Data', 'GDPR', 'Retention 7 Years', 'Security Baseline'], 'Customer Data brings both parents and their ancestors');
assert.equal(how(C('Customer'), 'GDPR').how, 'direct', 'via an attached policy counts as direct');
assert.equal(how(C('Customer'), 'GDPR').via, 'Customer Data');
assert.deepEqual(G.ancestors(m, 'Mask Personal Data').map(([n]) => n), ['Mask Personal Data', 'GDPR', 'Security Baseline']);
assert.deepEqual(G.descendants(m, 'GDPR').sort(), ['Customer Data', 'Mask Personal Data']);
// the levels are linked (ADR-0040): what is attached to the concept reaches its entities and their tables, marked as inherited from it
assert.ok(names(E('Customer')).includes('Customer Data') && names(T('customer')).includes('Customer Data'), 'concept > entity > table');
assert.deepEqual(how(E('Customer'), 'Customer Data').from, { kind: 'concept', name: 'Customer' }); assert.equal(how(E('Customer'), 'Customer Data').how, 'inherited');
assert.deepEqual(how(T('customer'), 'Customer Data').from, { kind: 'concept', name: 'Customer' }, 'a table names the concept it comes from');
assert.ok(names(col('customer', 'id')).includes('Customer Data'), 'columns take it through their table');
assert.ok(!names(T('orders')).includes('Customer Data'), 'not to unrelated objects');
assert.equal(how(E('Order'), 'Security Baseline').how, 'inherited'); assert.equal(how(E('Order'), 'Security Baseline').from.kind, 'project');
// ...but a tag does: the concept's pii tag reaches the entity and the table (ADR-0032 tag inheritance) and brings GDPR
assert.equal(how(T('customer'), 'GDPR').how, 'tag'); assert.equal(how(T('customer'), 'GDPR').from.name, 'Personal Data');
// physical containment: schema > table > column
assert.equal(how(T('customer'), 'Retention 7 Years').how, 'inherited'); assert.deepEqual(how(T('customer'), 'Retention 7 Years').from, { kind: 'schema', name: 'c.s' });
assert.equal(how(col('customer', 'id'), 'Retention 7 Years').from.name, 'c.s', 'columns inherit from the schema through the table');
assert.equal(how(col('customer', 'email'), 'GDPR').how, 'tag', 'its own tag first');
assert.ok(G.coverage(m, 'GDPR').some((c) => c.x.kind === 'column' && c.x.o === col('customer', 'id')), 'coverage lists inherited objects');

// 4. common properties: nearest on the level, else what the object is realised from (table > entity > concept), else the project default for its level
let e = G.effective(m, C('Customer'));
assert.equal(e.owner.v, 'Head of Sales'); assert.equal(e.owner.from, null);
e = G.effective(m, C('Order'));
assert.equal(e.owner.v, 'Chief Data Officer'); assert.equal(G.fromText(e.owner.from), 'project (conceptual default)');
assert.equal(G.effective(m, E('Customer')).owner.v, 'Head of Sales', 'an entity without an owner takes its concept\'s, before the project default of its level');
assert.deepEqual(G.effective(m, E('Customer')).owner.from, { kind: 'concept', name: 'Customer' });
assert.equal(G.effective(m, E('Customer')).criticality.v, 'High', 'criticality too');
assert.equal(G.effective(m, E('Order')).owner.v, 'Data Architecture', 'no owner up the chain: the project default of the logical level');
assert.equal(G.effective(m, E('Order')).criticality.v, 'Critical');
e = G.effective(m, T('customer'));
assert.equal(e.owner.v, 'Sales Engineering'); assert.deepEqual(e.owner.from, { kind: 'schema', name: 'c.s' });
assert.equal(e.steward.v, 'Data Engineering', 'project physical default');
assert.ok(e.classification.v === 'Restricted' && e.classification.from.kind === 'column' && /^c\.s\.customer\.(phone|email)$/.test(e.classification.from.name), 'rolled up from its columns (ADR-0041): the highest of them, with the column named');
assert.equal(G.classify(m, T('customer')).own, undefined, 'the pii tag it inherits from the concept sets no classification on the table itself');
assert.equal(G.effective(m, col('customer', 'id')).owner.v, 'Sales Engineering', 'columns inherit from their table');
assert.equal(G.effective(m, col('customer', 'id')).classification, undefined, 'a column owns its classification: nothing comes down from the table, schema or catalog');
assert.equal(G.effective(m, m.schemas[0]).classification.v, 'Restricted', 'a schema rolls up its tables');
assert.deepEqual(G.classify(m, m.catalogs[0]).own, { v: 'Internal', from: null }, 'the catalog keeps its own value as a floor');
assert.equal(G.effective(m, m.catalogs[0]).classification.v, 'Restricted', 'and rolls up the highest below it');

// 5. warnings
let keys = G.check(m).map((w) => w.key);
assert.ok(keys.includes('gov-protection:c.s.customer.phone') && keys.includes('gov-protection:c.s.customer.email'), 'restricted columns (declared, and by their own pii tag) without a protection policy');
assert.ok(!keys.includes('gov-protection:c.s.customer') && !keys.includes('gov-protection:c.s'), 'a container that only rolls the value up is not asked again');
assert.ok(keys.includes('gov-retired:c.s.orders'), 'retired table still referenced by a foreign key');
assert.ok(!keys.includes('gov-owner:concept:Customer'), 'high with an owner');
assert.ok(!keys.includes('gov-owner:concept:Order'), 'the project default owner counts');
assert.ok(keys.includes('gov-unknown:c.s.lines:Nope') && keys.includes('gov-unknown:c.s.lines:#ghost'), 'unknown policy and tag');
m.project.gov.conceptual = {};
assert.ok(G.check(m).some((w) => w.key === 'gov-owner:concept:Order'), 'critical concept without a conceptual owner');
T('customer').gov = { policies: ['Mask Personal Data'] };
keys = G.check(m).map((w) => w.key);
assert.ok(!keys.some((k) => k.startsWith('gov-protection')), 'a protection policy on the table covers its columns');
T('customer').gov = {}; col('customer', 'phone').gov = { classification: 'Restricted', policies: ['Mask Personal Data'] };
assert.ok(G.check(m).some((w) => w.key === 'gov-protection:c.s.customer.email') && !G.check(m).some((w) => w.key === 'gov-protection:c.s.customer.phone'), 'one protected column does not cover its sibling');
// cycles through several parents, and the one-click fix
m.governance.policies.find((p) => p.name === 'Security Baseline').parents = ['Customer Data'];
const cyc = G.check(m).filter((w) => w.kind === 'policy-cycle');
assert.ok(cyc.length >= 1 && cyc[0].fix, 'cycle found with a fix');
assert.ok(G.ancestors(m, 'GDPR').length <= m.governance.policies.length, 'resolution stays finite');
while (G.cycles(m).length) assert.ok(A.applyFix(m, G.check(m).find((w) => w.kind === 'policy-cycle')), 'fix through the alignment panel');
assert.equal(G.cycles(m).length, 0);
m.ack = [G.check(m)[0].key];
assert.ok(A.check(m).acked.length === 1, 'governance warnings can be accepted');

// 6. switching a policy off lower down (ADR-0039): it goes however it arrives, with what arrives only through it; children stay; a warning
{
  const m2 = SM.fromFile(F, 'physical'), T2 = (n) => m2.tables.find((t) => t.name === n), c2 = (t, c) => T2(t).columns.find((x) => x.name === c);
  const on = (o) => G.reach(m2, o).map((r) => r.name).sort(), offs = (o) => G.switchedOff(m2, o).map((r) => r.name).sort();
  // from above: the schema's Retention switched off on one table, and so on its columns
  T2('customer').gov = { off: ['Retention 7 Years'] };
  assert.ok(!on(T2('customer')).includes('Retention 7 Years') && !on(c2('customer', 'id')).includes('Retention 7 Years'), 'off here and below');
  assert.ok(on(T2('orders')).includes('Retention 7 Years'), 'other tables keep it');
  assert.deepEqual(G.switchedOff(m2, c2('customer', 'id'))[0], { name: 'Retention 7 Years', how: 'off', cause: 'Retention 7 Years', from: { kind: 'table', name: 'c.s.customer' } });
  // from a tag: the email column's pii tag brings GDPR; switched off there, GDPR goes; Security Baseline stays (it also comes from the project)
  c2('customer', 'email').gov = { off: ['GDPR'] };
  assert.ok(!on(c2('customer', 'email')).includes('GDPR') && on(c2('customer', 'email')).includes('Security Baseline'));
  assert.deepEqual(offs(c2('customer', 'email')), ['GDPR', 'Retention 7 Years'], 'its own switch-off and the table\'s');
  assert.equal(G.switchedOff(m2, c2('customer', 'email')).find((r) => r.name === 'GDPR').from, null, 'switched off on the column itself');
  assert.notEqual(G.effective(m2, c2('customer', 'email')).classification && G.effective(m2, c2('customer', 'email')).classification.v, 'Restricted', 'a switched-off policy raises nothing');
  // a parent vs a child: Mask Personal Data (parent GDPR, grandparent Security Baseline) attached to lines
  m2.project.gov = { ...m2.project.gov, policies: [] }; m2.schemas[0].gov = {}; T2('lines').gov = { policies: ['Mask Personal Data'] };
  assert.deepEqual(on(c2('lines', 'order_id')), ['GDPR', 'Mask Personal Data', 'Security Baseline']);
  c2('lines', 'order_id').gov = { off: ['GDPR'] };
  assert.deepEqual(on(c2('lines', 'order_id')), ['Mask Personal Data'], 'switching off the parent keeps the child, drops the parent and what came only through it');
  assert.deepEqual(offs(c2('lines', 'order_id')), ['GDPR', 'Security Baseline']);
  assert.equal(G.switchedOff(m2, c2('lines', 'order_id')).find((r) => r.name === 'Security Baseline').cause, 'GDPR');
  c2('lines', 'order_id').gov = { off: ['Mask Personal Data'] };
  assert.deepEqual(on(c2('lines', 'order_id')), [], 'switching off the child drops what it brought');
  // always a warning until accepted; the accepted key is versioned in the governance stream; the fix switches it on again
  const w = A.check(m2).open.find((x) => x.key === 'gov-off:c.s.lines.order_id:Mask Personal Data');
  assert.ok(w && /switched off on c\.s\.lines\.order_id/.test(w.text));
  m2.ack = [w.key, 'unmapped:c.s.lines', 'metric-ref:X:y'];
  assert.ok(A.check(m2).acked.some((x) => x.key === w.key));
  const fl2 = SM.flatten(SM.toFile(m2));
  assert.deepEqual(fl2.governance.acknowledged, [w.key], 'governance warnings are accepted in the governance stream');
  assert.deepEqual(fl2.modelling.alignment.acknowledged, ['unmapped:c.s.lines'], 'alignment warnings in modelling');
  assert.deepEqual(fl2.semantic.acknowledged, ['metric-ref:X:y'], 'metric warnings in semantic');
  assert.deepEqual(SM.unflatten(fl2.modelling, fl2.governance, fl2.semantic).alignment.acknowledged, [...m2.ack].sort(), 'one list in the file');
  assert.ok(G.applyFix(m2, w) && !(c2('lines', 'order_id').gov.off || []).length, 'the fix switches it on again');
  T2('lines').gov.off = ['Nope'];
  assert.ok(G.check(m2).some((x) => x.key === 'gov-unknown:c.s.lines:off:Nope'), 'unknown policy switched off');
}

// 7. the Governance tab's state in .strata/layout.json: by policy name; names that no longer exist are dropped
{
  const st = SM.canvasOut(m, { level: 'governance', mode: 'schema', levels: {}, governance: { view: 'graph', sel: 'GDPR', graph: ['GDPR', 'Customer Data'] } });
  assert.deepEqual(st.governance, { view: 'graph', sel: 'GDPR', graph: ['GDPR', 'Customer Data'] });
  const back = SM.canvasIn(m, { ...st, governance: { view: 'odd', sel: 'Gone', graph: ['GDPR', 'Gone'] } });
  assert.equal(back.level, 'governance');
  assert.deepEqual(back.governance, { view: 'list', sel: null, graph: ['GDPR'] });
  assert.equal(SM.canvasIn(m, { level: 'physical' }).governance, undefined, 'older layouts: nothing to restore');
}

// 8. tidy: fixed order, empties dropped
assert.deepEqual(Object.keys(G.tidy({ off: ['y'], policies: ['x'], lifecycle: 'Active', owner: 'a', steward: '', physical: {} })), ['owner', 'lifecycle', 'policies', 'off']);


// 7. inheritance through the links (ADR-0040): concept > entity > table, in one direction, each level still able to say its own
{
  const m3 = SM.fromFile(F, 'physical'), T3 = (n) => m3.tables.find((t) => t.name === n), C3 = (n) => m3.concepts.find((c) => c.name === n), E3 = (n) => m3.entities.find((e) => e.name === n);
  const pol = (o) => G.reach(m3, o).map((r) => r.name).sort(), col3 = (t, c) => T3(t).columns.find((x) => x.name === c);
  // a table with no owner above it on its own level takes its entity's, before the project's physical default
  m3.schemas[0].gov = {};
  E3('Customer').gov = { owner: 'Customer Domain' };
  assert.deepEqual(G.effective(m3, T3('customer')).owner, { v: 'Customer Domain', from: { kind: 'entity', name: 'Customer' } }, 'table < entity');
  assert.equal(G.effective(m3, col3('customer', 'id')).owner.v, 'Customer Domain', 'and its columns');
  assert.equal(G.effective(m3, T3('orders')).owner.v, 'Platform Team', 'an unrealised-owner chain ends at the project default of the level');
  T3('customer').gov = { owner: 'Table Team' };
  assert.equal(G.effective(m3, T3('customer')).owner.v, 'Table Team', 'the lower level always has the last word');
  m3.schemas[0].gov = { owner: 'Schema Team' }; T3('customer').gov = {};
  assert.equal(G.effective(m3, T3('customer')).owner.v, 'Schema Team', 'physical containment is nearer than the entity');
  // several entities: the highest classification / criticality, the first owner
  E3('Order').gov = { classification: 'Confidential', criticality: 'Low', owner: 'Order Domain' }; E3('Customer').gov = { owner: 'Customer Domain', classification: 'Internal' };
  C3('Customer').tags = []; C3('Customer').gov = {}; // (the pii tag would raise the classification through GDPR)
  T3('lines').entityIds = [E3('Customer').id, E3('Order').id]; T3('lines').gov = {}; m3.schemas[0].gov = {}; m3.catalogs[0].gov = {};
  assert.equal(G.effective(m3, T3('lines')).classification, undefined, 'a classification is a floor: it is not pushed down to the tables that realise the entity');
  assert.equal(G.effective(m3, T3('lines')).owner.v, 'Customer Domain', 'the first entity\'s owner');
  // policies attached to an entity reach its tables; switching one off there cuts it from the tables as well
  E3('Order').gov = { policies: ['Retention 7 Years'] };
  assert.ok(pol(T3('orders')).includes('Retention 7 Years'));
  m3.schemas[0].gov = {}; C3('Customer').tags = ['pii']; C3('Customer').gov = { off: ['GDPR'], policies: ['Customer Data'] };
  assert.ok(!pol(E3('Customer')).includes('GDPR') && !pol(T3('customer')).includes('GDPR') && !pol(col3('customer', 'email')).includes('GDPR'), 'a switch-off on the concept holds below, through every link');
  assert.deepEqual(G.switchedOff(m3, T3('customer')).find((r) => r.name === 'GDPR').from, { kind: 'concept', name: 'Customer' });
  // a tag dropped lower down stays dropped: the concept's attachments come through, its tag policies are the tag bridge's business
  C3('Customer').gov = { policies: ['Mask Personal Data'] }; E3('Customer').tags = ['-pii']; T3('customer').tags = ['-pii'];
  assert.ok(!pol(T3('customer')).includes('GDPR') || pol(T3('customer')).includes('Mask Personal Data'), 'GDPR only through the attached policy now');
  C3('Customer').gov = {}; 
  assert.ok(!pol(T3('customer')).includes('GDPR'), 'the dropped tag brings nothing back');
  // warnings follow the effective values: a critical table with an inherited owner has one
  T3('orders').gov = { criticality: 'Critical' }; E3('Order').gov = { owner: 'Order Domain' }; m3.project.gov.physical = {};
  assert.ok(!G.check(m3).some((w) => w.key === 'gov-owner:c.s.orders'), 'an owner from the entity counts');
  E3('Order').gov = {};
  assert.ok(G.check(m3).some((w) => w.key === 'gov-owner:c.s.orders'), 'none anywhere: the warning');
  // nothing changes for a model without links, and the file is untouched
  const plain = SM.fromFile({ ...F, conceptual: undefined, logical: undefined, tables: F.tables.map(({ entity, ...t }) => t) }, 'physical');
  assert.equal(G.effective(plain, plain.tables[0]).owner.v, 'Sales Engineering');
}

// 9. classification is bottom-up (ADR-0041): a column owns it, everything above rolls it up, an own value on a container is a floor
{
  const F4 = JSON.parse(JSON.stringify(F));
  F4.semantic = { metrics: [{ name: 'Phones', calculation: 'customer.phone', aggregation: 'count' }, { name: 'Orders', calculation: 'orders.id', aggregation: 'count' }] };
  F4.tables[0].columns.find((c) => c.name === 'email').tags = []; // (the pii tag is covered above)
  F4.conceptual.concepts[0].tags = []; F4.conceptual.concepts[0].governance = { owner: 'Head of Sales', classification: 'Internal' };
  F4.catalogs[0].governance = {};
  const m4 = SM.fromFile(F4, 'physical'), T4 = (n) => m4.tables.find((t) => t.name === n), c4 = (t, c) => T4(t).columns.find((x) => x.name === c);
  const C4 = (n) => m4.concepts.find((c) => c.name === n), E4 = (n) => m4.entities.find((x) => x.name === n), X4 = (n) => m4.metrics.find((x) => x.name === n);
  const cls = (o) => { const r = G.effective(m4, o).classification; return r && r.v; }, src4 = (o) => { const r = G.effective(m4, o).classification; return r && r.from && r.from.name; };
  // roll-up at every level: column > table > schema > catalog, and column > table > entity > concept, and column > metric
  assert.equal(cls(c4('customer', 'phone')), 'Restricted');
  for (const o of [T4('customer'), m4.schemas[0], m4.catalogs[0], E4('Customer'), C4('Customer'), X4('Phones')]) { assert.equal(cls(o), 'Restricted', 'rolls up: ' + (o.name || o.id)); }
  assert.equal(src4(T4('customer')), 'c.s.customer.phone', 'the source column is named'); assert.equal(src4(C4('Customer')), 'c.s.customer.phone', 'all the way up to the concept');
  assert.equal(cls(T4('orders')), undefined, 'a table with nothing classified has none'); assert.equal(cls(E4('Order')), undefined); assert.equal(cls(X4('Orders')), undefined);
  // nothing comes down: the siblings of a Restricted column stay unclassified
  assert.equal(cls(c4('customer', 'id')), undefined); assert.equal(cls(c4('customer', 'email')), undefined);
  // a floor: the concept says Internal, the rolled-up value is the higher one; a floor above what it holds stays as it is and is not pushed down
  assert.deepEqual(G.classify(m4, C4('Customer')).own, { v: 'Internal', from: null });
  T4('orders').gov = { ...T4('orders').gov, classification: 'Confidential' };
  assert.equal(cls(T4('orders')), 'Confidential', 'a table\'s own value is its floor'); assert.equal(G.effective(m4, T4('orders')).classification.from, null);
  assert.equal(cls(c4('orders', 'id')), undefined, 'and is not inherited by its column'); assert.equal(cls(E4('Order')), 'Confidential', 'but it rolls up to the entity that it realises');
  assert.ok(!G.check(m4).some((w) => w.kind === 'gov-class-below-floor'), 'unclassified columns below a floor are fine');
  c4('orders', 'id').gov = { classification: 'Internal' };
  const w = G.check(m4).find((x) => x.kind === 'gov-class-below-floor');
  assert.ok(w && w.key === 'gov-class-below-floor:c.s.orders.id' && /Internal, below the Confidential minimum of c\.s\.orders/.test(w.text), 'a lower explicit value below a floor is reported: ' + (w && w.text));
  assert.equal(cls(c4('orders', 'id')), 'Internal', 'and left as it is'); assert.equal(cls(T4('orders')), 'Confidential');
  m4.ack = [w.key]; assert.ok(A.check(m4).acked.some((x) => x.key === w.key), 'it can be accepted');
  // a Restricted floor on a table needs protection there, but its columns are not marked Restricted, so they need nothing
  T4('lines').gov = { classification: 'Restricted' };
  const k4 = G.check(m4).map((x) => x.key);
  assert.ok(k4.includes('gov-protection:c.s.lines') && !k4.includes('gov-protection:c.s.lines.order_id'), 'protection is asked where the value is own');
  T4('lines').gov = {};
  // governance (management) still flows down and never touches classification
  m4.schemas[0].gov = {}; E4('Customer').gov = { owner: 'Customer Domain', steward: 'Steward X', lifecycle: 'Deprecated' };
  assert.equal(G.effective(m4, c4('customer', 'id')).owner.v, 'Customer Domain', 'the owner reaches the column through entity > table > column');
  assert.equal(G.effective(m4, c4('customer', 'id')).lifecycle.v, 'Deprecated'); assert.equal(cls(c4('customer', 'id')), undefined);
  assert.equal(cls(c4('customer', 'phone')), 'Restricted', 'and an owner at the top raises nothing');
  assert.equal(G.effective(m4, c4('customer', 'phone')).classification.from, null, 'the column\'s own value is its own');
  // policy minimums: on the object itself (attached, or by its own tag) they set its own value; from above or an inherited tag they do not
  T4('orders').gov = {}; c4('orders', 'id').gov = { policies: ['GDPR'] };
  assert.deepEqual(G.classify(m4, c4('orders', 'id')).own, { v: 'Restricted', from: { kind: 'policy', name: 'GDPR' } }, 'attached to the column');
  assert.deepEqual(G.effective(m4, T4('orders')).classification.from, { kind: 'column', name: 'c.s.orders.id' }, 'and rolls up to its table');
  // a policy attached higher up manages the data, it does not classify it: no own value on a schema, table, entity or concept, and none inherited by a column
  c4('orders', 'id').gov = {}; m4.schemas[0].gov = { ...m4.schemas[0].gov, policies: ['Customer Data'] }; C4('Order').gov = { policies: ['Customer Data'] }; T4('orders').gov = { policies: ['GDPR'] };
  for (const o of [m4.schemas[0], T4('orders'), E4('Order'), C4('Order'), c4('orders', 'id')]) assert.equal(G.classify(m4, o).own, undefined, 'a policy on a container or from above sets nothing: ' + (o.name || o.id));
  assert.ok(G.reach(m4, c4('orders', 'id')).some((r) => r.name === 'GDPR'), 'though the policy still reaches the column (management flows down)');
  m4.schemas[0].gov = {}; C4('Order').gov = {}; T4('orders').gov = {};
  // a tag on the column brings its policy's minimum; a tag on the table or an inherited one does not
  T4('orders').tags = ['pii']; c4('lines', 'order_id').tags = ['pii'];
  assert.equal(G.classify(m4, c4('lines', 'order_id')).own.v, 'Restricted', 'a tag on the column brings its policy\'s minimum');
  assert.equal(G.classify(m4, T4('orders')).own, undefined, 'a tag on a table does not classify it'); assert.equal(G.classify(m4, c4('orders', 'id')).own, undefined, 'nor its columns');
  T4('orders').tags = []; c4('lines', 'order_id').tags = [];
  // switch-off is unaffected: the policy that would raise the value is gone, and so is the value
  c4('orders', 'id').gov = { policies: ['GDPR'], off: ['GDPR'] };
  assert.equal(G.classify(m4, c4('orders', 'id')).own, undefined, 'a switched-off policy raises nothing'); c4('orders', 'id').gov = {};
  // the project's default for a level fills unclassified objects; the roll-up takes the higher
  m4.project.gov = { ...m4.project.gov, physical: { ...m4.project.gov.physical, classification: 'Internal' } };
  assert.deepEqual(G.effective(m4, c4('orders', 'id')).classification, { v: 'Internal', from: { kind: 'project', name: 'P', level: 'physical' } });
  assert.equal(cls(T4('customer')), 'Restricted'); assert.equal(cls(T4('lines')), 'Internal');
  // an old model (a table with a classification, its columns without) loads, and round trips
  const old = { ...F4, tables: F4.tables.map((t) => (t.name === 'orders' ? { ...t, governance: { ...t.governance, classification: 'Restricted' } } : t)) };
  const mo = SM.fromFile(old, 'physical'), to = text(mo);
  assert.equal(text(SM.fromFile(JSON.parse(to), 'physical')), to, 'round trip stable');
  assert.ok(to.includes('"classification": "Restricted"'), 'the value stays where it was in the file');
  assert.equal(G.effective(mo, mo.tables.find((t) => t.name === 'orders').columns[0]).classification, undefined, 'it is now a floor: the columns are no longer Restricted');
  assert.equal(G.effective(mo, mo.tables.find((t) => t.name === 'orders')).classification.v, 'Restricted');
  // the three streams: a classification is a governance value
  assert.equal(SM.flatten(SM.toFile(mo)).governance['assign:table:c.s.orders'].governance.classification, 'Restricted');
}

// 6. domains (release 2, R7/R8/R16, ADR-0045): optional groups of concepts, given as `m.domains` (the manifest's `domains`, attached by the host
// / CLI / skill script, never round-tripped by media/model.js: see tests/project.check.js for the manifest-level helpers). Owner / steward /
// criticality / lifecycle / policies sit above the concept in the top-down chain (own value > containment > domain > realised-parent links >
// project default); classification stays bottom-up (ADR-0041) and never sees a domain (below() does not use realisedFrom, by design).
{
  const F5 = {
    strata: 2,
    project: { name: 'P', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table' },
    conceptual: { concepts: [{ name: 'Customer' }, { name: 'Order' }] },
    logical: { entities: [{ name: 'Customer', concept: 'Customer' }, { name: 'Order', concept: 'Order' }] },
    schemas: [{ name: 's' }],
    tables: [{ name: 'customer', schema: 's', entity: 'Customer', columns: [{ name: 'id', type: 'INT', pk: true }, { name: 'email', type: 'STRING', governance: { classification: 'Restricted' } }] }],
  };
  const m5 = SM.fromFile(F5, 'physical'), C5 = (n) => m5.concepts.find((c) => c.name === n), E5 = (n) => m5.entities.find((e) => e.name === n), T5 = (n) => m5.tables.find((t) => t.name === n);
  m5.domains = [{ name: 'Sales', owner: 'Head of Sales', criticality: 'High', concepts: ['Customer', 'Order'] }];
  for (const o of [C5('Customer'), E5('Customer'), T5('customer')]) {
    const e = G.effective(m5, o);
    assert.equal(e.owner.v, 'Head of Sales', 'owner flows from the domain to concept, entity and table');
    assert.deepEqual(e.owner.from, { kind: 'domain', name: 'Sales' });
    assert.equal(e.criticality.v, 'High');
  }
  assert.equal(G.effective(m5, C5('Order')).owner.v, 'Head of Sales', 'a second concept of the same domain gets it too');
  // a concept's own value overrides its domain's (R8), and that override still flows down to the entity
  C5('Customer').gov = { owner: 'Direct Owner' };
  assert.deepEqual(G.effective(m5, C5('Customer')).owner, { v: 'Direct Owner', from: null });
  assert.equal(G.effective(m5, E5('Customer')).owner.v, 'Direct Owner');
  // classification stays bottom-up: a domain (with or without its own owner / criticality) is never a floor source
  assert.equal(G.classify(m5, C5('Customer')).rolled.v, 'Restricted', 'rolled up from the column, not from the domain');
  m5.domains = [{ name: 'Sales', concepts: ['Customer'] }];
  assert.equal(G.classify(m5, C5('Customer')).rolled.v, 'Restricted', 'unchanged: still only the column');
  C5('Customer').gov = {};
  // R16: a duplicate domain name and a concept in more than one domain, both reported
  m5.domains = [{ name: 'Sales', concepts: ['Customer'] }, { name: 'sales', concepts: ['Customer'] }, { name: 'Ops', concepts: ['Customer'] }];
  const dw = G.check(m5).filter((w) => w.kind.startsWith('domain'));
  assert.ok(dw.some((w) => w.kind === 'domain-dup' && /defined more than once/.test(w.text)));
  assert.ok(dw.some((w) => w.kind === 'domain-multi' && /Customer/.test(w.text) && /more than one domain/.test(w.text)));
  // no domains at all: no domain object anywhere, no warning, no behaviour change (release 1 unaffected)
  delete m5.domains;
  assert.equal(G.check(m5).filter((w) => w.kind.startsWith('domain')).length, 0);
}

// 7. cross-part resolution and project-wide uniqueness (release 2 part 2, ADR-0045 point 6): m.crossPart
{
  const F6 = { strata: 2, project: { name: 'X', technology: 'PostgreSQL', methodology: 'ER - 3NF', naming: 'schema.table' },
    schemas: [{ name: 'public' }], tables: [{ name: 'orders', schema: 'public', columns: [{ name: 'total', type: 'NUMERIC' }] }],
    semantic: { metrics: [{ name: 'Revenue', calculation: 'SUM(public.orders.total) + SUM(public.other.amount) + {Elsewhere}' }] } };
  const m6 = SM.fromFile(F6);
  let mw = G.check(m6).filter((w) => w.kind === 'metric-ref');
  assert.equal(mw.length, 2, 'without a project index: the other-part column and the other-part metric are both missing');
  m6.crossPart = { tables: [], columns: ['public.other.amount'], entities: [], concepts: [], metrics: ['elsewhere'], duplicates: [] };
  assert.deepEqual(G.check(m6).filter((w) => w.kind === 'metric-ref'), [], 'both resolve in another part now');
  // grain: an entity or table name that lives in another part
  m6.metrics[0].grain = ['Nope'];
  assert.ok(G.check(m6).some((w) => w.kind === 'metric-ref' && /grain "Nope"/.test(w.text)));
  m6.crossPart.entities = ['nope'];
  assert.deepEqual(G.check(m6).filter((w) => w.kind === 'metric-ref' && /grain/.test(w.text)), [], 'the grain resolves as an entity of another part');
  // R11: a metric or entity name defined in more than one part is reported once, on the object that is actually here
  m6.crossPart.duplicates = [{ kind: 'metric', name: 'revenue', parts: ['here', 'elsewhere'] }, { kind: 'entity', name: 'missing-here', parts: ['a', 'b'] }];
  const dw = G.check(m6).filter((w) => w.kind === 'cross-part-dup');
  assert.deepEqual(dw.map((w) => w.key), ['cross-part-dup:metric:revenue'], 'only the one this part actually holds (an entity named in the duplicate list that is not here is not reported here)');
  delete m6.crossPart;
  assert.equal(G.check(m6).filter((w) => w.kind === 'metric-ref' || w.kind === 'cross-part-dup').length > 0, true, 'no index at all (a project of one part): unchanged from release 1 (still reports what is genuinely missing)');
}

console.log('governance.check: all assertions passed');
