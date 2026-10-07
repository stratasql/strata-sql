// Rebuilds the curated levels, governance and metrics of the sample models from their state on `main` (the base), reproducibly:
//   node tests/build-samples.js [example|northwind|fpml|star|all] [--dry]      (--dry: build and check, write nothing)
// Each sample's version log is cut back to BASE (its versions on main), the model is rebuilt from them through model.js, and the mapping
// below is recorded as new versions in the stream each change belongs to (the log is written before the model). The samples ship in the current
// file layout (<name>.model.json, .model.history.jsonl, .model.layout.json). An older pair (<name>.model.version.json, layout and version pointers
// inside the model) is converted first (media/legacy.js) and its old file removed. A version keeps the time, user and message it had in the file
// being rebuilt when the mapping still records the same message, so a rerun writes byte-identical files; changing the mapping stamps new versions.
// `star` is generated from scratch: a small dimensional model with its conceptual / logical mapping and owners per level.
'use strict';
const fs = require('fs'), path = require('path'), R = path.join(__dirname, '..', 'sample_data_models') + '/';
const SM = require('../media/model.js'), LG = require('../media/legacy.js'), SA = require('../media/align.js'), G = require('../media/gov.js');
require('../media/layout.js'); const L = globalThis.Layout;
const args = process.argv.slice(2), dry = args.includes('--dry'), which = args.find((a) => !a.startsWith('--')) || 'all';

const SAMPLES = {
  example: { base: { modelling: 'm2', governance: 'g1' }, fresh: ['conceptual', 'logical', 'semantic'], info: { user: 'Ada Lovelace', email: 'ada@corp.io' }, map: example },
  northwind: { base: { modelling: 'm3', governance: 'g2' }, fresh: ['semantic'], info: { user: 'Data Architect', email: 'data.architect@northwind.example' }, map: northwind },
  fpml: { base: { modelling: 'm3', governance: 'g2' }, fresh: ['semantic'], info: { user: 'Data Architect', email: 'data.architect@bank.example' }, map: fpml },
  star: { info: { user: 'Strata templates', email: '' }, map: star },
};

// the files of a sample as they are now: model, history and positions, in the current or the older layout
function readSample(id) {
  const o0 = JSON.parse(fs.readFileSync(R + id + '.model.json', 'utf8')), jsonl = R + id + '.model.history.jsonl';
  if (fs.existsSync(jsonl)) {
    const pos = fs.existsSync(R + id + '.model.layout.json') ? SM.layoutRead(fs.readFileSync(R + id + '.model.layout.json', 'utf8')) : null;
    return { o0, hist: SM.parseLog(fs.readFileSync(jsonl, 'utf8')).history, layout: pos || {} };
  }
  const flats = SM.flatten(SM.toFile(SM.fromFile(o0, 'physical'))), truth = Object.fromEntries(SM.STREAMS.filter((st) => o0.version[st]).map((st) => [st, { id: o0.version[st], flat: flats[st] }]));
  const cv = LG.load(fs.readFileSync(R + id + '.model.version.json', 'utf8'), truth);
  if (cv.error) throw new Error(id + ': ' + cv.error);
  return { o0, hist: cv.history, layout: o0.layout || {}, legacy: true };
}

function build(id) {
  const S = SAMPLES[id], { o0, hist, layout } = S.base ? readSample(id) : { hist: SM.newHistory(), layout: {} };
  const tails = new Map(S.base || !fs.existsSync(R + id + '.model.history.jsonl') ? [] : SM.parseLog(fs.readFileSync(R + id + '.model.history.jsonl', 'utf8')).history.entries.map((e) => [e.id, e])); // versions after the base in the file being rebuilt: their time, user and message are kept when the mapping records the same message
  let m, ptr = {};
  if (S.base) {
    // cut the log back to the base: nothing after each stream's base entry; a stream without a base (semantic) is emptied
    const at = (st) => SM.entriesOf(hist, st).findIndex((e) => e.id === S.base[st]);
    for (const st of Object.keys(S.base)) if (at(st) < 0) throw new Error(`${id}: base ${S.base[st]} is not in the log`);
    hist.entries = hist.entries.filter((e) => { const keep = S.base[e.stream] && SM.entriesOf(hist, e.stream).indexOf(e) <= at(e.stream); if (!keep) tails.set(e.id, e); return keep; });
    for (const st of Object.keys(S.base)) ptr[st] = SM.entriesOf(hist, st)[at(st)].chain;
    const F0 = SM.unflatten(SM.stateAt(hist, ptr.modelling), SM.stateAt(hist, ptr.governance), {}), L0 = { ...layout }; // canvas positions are not versioned: keep the others, lay out the levels the mapping builds
    for (const lv of S.fresh) delete L0[lv];
    m = SM.fromFile(F0, 'physical', null, L0);
    if (SM.verify(hist, SM.flatten(SM.toFile(m))).length) throw new Error(id + ': the base does not verify');
  } else { m = SM.blank(); }
  const rec = (message) => {
    const flat = SM.flatten(SM.toFile(m));
    for (const s of SM.STREAMS) {
      const old = tails.get(SM.PREFIX[s] + (SM.entriesOf(hist, s).length + 1)), keep = old && old.stream === s && old.message === message ? { user: old.user, email: old.email, system: old.system, at: Date.parse(old.ts) } : {};
      const e = SM.commit(hist, s, ptr[s], flat[s], { ...S.info, system: 'build-samples', message, ...keep });
      if (e) { ptr[s] = e.chain; console.log(`  ${e.id} ${message.slice(0, 110)}`); }
    }
  };
  const find = (list, n, what) => list.find((x) => x.name === n) || (() => { throw new Error(`${id}: no ${what} ${n}`); })();
  const k = {
    m, rec,
    set: (x, v) => { x.gov = G.tidy({ ...x.gov, ...v }); },
    C: (n) => find(m.concepts, n, 'concept'), E: (n) => find(m.entities, n, 'entity'), T: (n) => find(m.tables, n, 'table'), Sc: (n) => find(m.schemas, n, 'schema'),
    col: (t, c) => find(find(m.tables, t, 'table').columns, c, t + '.'),
    tag: (n) => find(m.governance.tags, n, 'tag'),
    newTag: (name, displayName, description, owner, domain) => m.governance.tags.push({ name, displayName, description, owner, domain, policies: [], enabled: true }),
    pol: (name, parents, type, v = {}) => m.governance.policies.push({ name, parents, type, jurisdiction: '', classification: '', owner: '', description: '', ...v }),
    metric: (x) => { const mt = SM.norm({ id: SM.uid(), pos: {}, columns: [], grain: [], aggregation: '', calculation: '', ...x }); m.metrics.push(mt); return mt; },
    // properties that governance values and policies replace: gone from every object and from the suggested keys
    dropProps: (keys) => { G.objects(m).forEach((x) => { for (const p of keys) delete (x.o.properties || {})[p]; }); m.governance.propertyKeys = m.governance.propertyKeys.filter((p) => !keys.includes(p)); },
    // accept a warning on purpose (it must exist): versioned in the stream of the warning
    accept: (key) => { if (!SA.check(m).all.some((w) => w.key === key)) throw new Error(`${id}: no warning ${key}`); m.ack = [...m.ack, key]; },
    // positions for a level the mapping built (Layout.compute, as Auto layout does)
    place: (lv) => { const pos = L.compute(SA.view(m, lv) || m, lv, 1.6); for (const x of SM.nodesOf(m, lv)) if (!x.pos[lv]) x.pos[lv] = { ...pos[x.id] }; },
    noOpen: (step) => { const w = SA.check(m).open; if (w.length) throw new Error(`${id}: open warnings after ${step}:\n` + w.map((x) => `  ${x.key}  ${x.text}`).join('\n')); },
  };
  console.log(id + (dry ? ' (dry run)' : ''));
  S.map(k);
  k.noOpen('the mapping');
  const text = SM.stringify(SM.toFile(m)) + '\n', posText = SM.stringify(SM.layoutFile(m, 'physical')) + '\n', back = JSON.parse(text);
  const problems = [...SM.verify(hist, SM.flatten(SM.toFile(SM.fromFile(back, 'physical')))), ...(SM.stringify(SM.toFile(SM.fromFile(back, 'physical'))) + '\n' === text ? [] : ['the model does not round trip'])];
  if (problems.length) throw new Error(id + ': ' + problems.join('; '));
  if (!dry) {
    fs.writeFileSync(R + id + '.model.history.jsonl', SM.logText(hist)); // the log first, then the model
    fs.writeFileSync(R + id + '.model.json', text); fs.writeFileSync(R + id + '.model.layout.json', posText);
    fs.rmSync(R + id + '.model.version.json', { force: true }); // an older log is replaced by the .jsonl
  }
  console.log(`  ${dry ? 'checked' : 'written'}: ${hist.entries.length} versions, ${JSON.stringify(Object.fromEntries(SM.STREAMS.map((st) => [st, (SM.entry(hist, ptr[st]) || {}).id]).filter(([, v]) => v)))}`);
}

// ---------- star: a small dimensional model to start from (no sample data) ----------
function star({ m, rec, set, C, E, T, Sc, col, place, noOpen }) {
  const uid = SM.uid, key = (name, description) => ({ name, dataType: 'BIGINT', primaryKey: true, description }), num = (name, description, dt = 'DECIMAL(18,2)') => ({ name, dataType: dt, description });
  m.project = SM.norm({ name: 'Sales Star', description: 'A small sales data mart: one fact table at the grain of an order line, with customer, product, date and store dimensions.', technology: 'PostgreSQL', methodology: 'Dimensional Modelling', threePart: false, stakeholders: [] });
  m.schemas.push(SM.norm({ id: uid(), name: 'dw', description: 'The dimensional model: conformed dimensions and the sales fact.', catalogId: null }));
  const sid = m.schemas[0].id;
  const col_ = (c) => SM.norm({ id: uid(), notNull: !!c.primaryKey, unique: false, default: '', foreignKey: null, ...c });
  const table = (name, description, columns) => { const t = SM.norm({ id: uid(), name, kind: 'table', viewType: 'view', definition: '', schemaId: sid, description, entityIds: [], pos: {}, columns: columns.map(col_) }); m.tables.push(t); return t; };
  const text = (name, description, dt = 'VARCHAR(255)') => ({ name, dataType: dt, description });
  const dCustomer = table('dim_customer', 'A person or company that buys from us: one row per customer (type 1: changes overwrite).', [key('customer_key', 'Surrogate key: meaningless, generated by the warehouse.'), { ...text('customer_id', 'Business key from the order system.', 'VARCHAR(30)'), notNull: true }, text('customer_name', 'Full name or company name.'), text('segment', 'Consumer, Corporate or Small Business.', 'VARCHAR(30)'), text('city', 'City of the billing address.'), text('country', 'Country of the billing address.')]);
  const dProduct = table('dim_product', 'Something we sell: one row per product.', [key('product_key', 'Surrogate key.'), { ...text('product_id', 'Business key (SKU).', 'VARCHAR(30)'), notNull: true }, text('product_name', 'Name shown to customers.'), text('category', 'Product category.', 'VARCHAR(60)'), text('brand', 'Brand or manufacturer.', 'VARCHAR(60)'), num('list_price', 'Current list price.')]);
  const dDate = table('dim_date', 'The calendar: one row per day, so reports can group by week, month, quarter and year without date functions.', [{ ...key('date_key', 'Surrogate key in the form YYYYMMDD.'), dataType: 'INTEGER' }, { ...text('full_date', 'The date.', 'DATE'), notNull: true }, text('year', 'Calendar year.', 'SMALLINT'), text('quarter', 'Quarter of the year, 1 to 4.', 'SMALLINT'), text('month', 'Month number, 1 to 12.', 'SMALLINT'), text('month_name', 'January to December.', 'VARCHAR(12)'), text('day_of_week', 'Monday to Sunday.', 'VARCHAR(12)'), text('is_weekend', 'True on Saturdays and Sundays.', 'BOOLEAN')]);
  const dStore = table('dim_store', 'Where a sale happened: one row per shop or web channel.', [key('store_key', 'Surrogate key.'), { ...text('store_id', 'Business key.', 'VARCHAR(30)'), notNull: true }, text('store_name', 'Name of the shop or channel.'), text('city', 'City.'), text('region', 'Sales region.', 'VARCHAR(60)')]);
  const fact = table('fact_sales', 'Sales: one row per order line (the grain). Measures are additive.', [
    { ...text('order_number', 'Degenerate dimension: the order this line belongs to.', 'VARCHAR(30)'), primaryKey: true }, { ...text('line_number', 'Line within the order.', 'SMALLINT'), primaryKey: true },
    { ...key('customer_key', 'Who bought.'), primaryKey: false, notNull: true }, { ...key('product_key', 'What was sold.'), primaryKey: false, notNull: true }, { ...key('date_key', 'When (order date).'), dataType: 'INTEGER', primaryKey: false, notNull: true }, { ...key('store_key', 'Where.'), primaryKey: false, notNull: true },
    num('quantity', 'Units sold.', 'INTEGER'), num('unit_price', 'Price of one unit at the time of sale.'), num('discount_amount', 'Discount on the line.'), num('net_amount', 'quantity x unit_price - discount_amount: the sales value.')]);
  for (const [dim, c, card] of [[dCustomer, 'customer_key', '1..M'], [dProduct, 'product_key', '1..M'], [dDate, 'date_key', '1..M'], [dStore, 'store_key', '1..M']]) {
    fact.columns.find((x) => x.name === c).foreignKey = { tableId: dim.id, columnId: dim.columns.find((x) => x.name === c).id, cardinality: card, name: '', description: '' };
  }
  for (const t of m.tables) t.columns.forEach((c) => { if (c.primaryKey) c.notNull = true; });
  const pos = L.compute(m, 'physical', 1.6); for (const t of m.tables) { t.pos.physical = { ...pos[t.id] }; }
  rec('Create the sales star: fact_sales and the customer, product, date and store dimensions');
  // the conceptual and logical levels: one entity and one concept per table (SA.generate names them from the table names), described
  SA.generate(m);
  const rename = (from, to) => { E(from).name = to; C(from).name = to; };
  rename('Sale', 'Sales');
  C('Sales').description = 'What we sold: each line of each order.'; C('Customer').description = 'A person or company that buys from us.'; C('Product').description = 'Something we sell.'; C('Date').description = 'The day a sale happened.'; C('Store').description = 'Where a sale happened: a shop or a web channel.';
  E('Sales').description = 'One order line: quantity and value, tied to a customer, a product, a date and a store.';
  for (const r of [...m.crels, ...m.lrels]) { const p = [...m.concepts, ...m.entities].find((x) => x.id === r.parentId); r.name = { Customer: 'buys', Product: 'is sold as', Date: 'happens on', Store: 'happens at' }[p && p.name] || r.name; }
  noOpen('generating the levels');
  place('conceptual'); place('logical');
  rec('Add the conceptual and logical levels: Sales with Customer, Product, Date and Store, and their relationships');
  // owners and stewards per level, as defaults on the project: nothing is repeated on the objects
  set(m.project, { conceptual: { owner: 'Business Sponsor' }, logical: { owner: 'Data Architect', steward: 'Data Steward' }, physical: { owner: 'Data Engineering', steward: 'Data Steward', classification: 'Internal' }, semantic: { owner: 'Analytics' } });
  rec('Owners and stewards per level (project defaults)');
}

// ---------- example: a small order-to-cash warehouse that shows every feature once ----------
function example({ m, rec, set, C, E, T, Sc, col, tag, newTag, pol, metric, dropProps, accept, place, noOpen }) {
  // 1. the conceptual and logical levels: generated from the tables, then curated (order lines belong to the Order concept)
  SA.generate(m);
  E('Order Item').name = 'Order Line';
  SA.mergeInto(m, 'concept', C('Order Item').id, C('Order').id);
  C('Customer').description = 'A person or company that buys from us.';
  C('Order').description = 'A purchase placed by a customer, with its lines.';
  C('Product').description = 'Something we sell.';
  C('Country').description = 'Where a customer is based.';
  for (const r of m.crels) if (!r.name) r.name = r.parentId === C('Product').id ? 'appears on' : r.parentId === C('Country').id ? 'is home of' : r.name;
  noOpen('generating the levels');
  place('conceptual'); place('logical');
  rec('Add the conceptual and logical levels: 4 concepts, 5 entities (Order and Order Line realise the Order concept), their relationships');

  // 2. policies (one with two parents) and the tag that brings one
  pol('Data Protection', [], 'security', { owner: 'Security Office', description: 'Personal and confidential data: least-privilege access, and reads are logged.' });
  pol('GDPR', ['Data Protection'], 'privacy', { jurisdiction: 'EU', classification: 'Restricted', owner: 'Privacy Officer', description: 'EU General Data Protection Regulation: a lawful basis for processing, data-subject rights, breach notification within 72 hours.' });
  pol('Mask Personal Data', ['GDPR'], 'protection', { owner: 'Data Platform', description: 'Personal data is masked for everyone outside customer service.' });
  pol('Retention 7 Years', [], 'retention', { owner: 'Finance', description: 'Kept for 7 years after the order date, then deleted.' });
  pol('Financial Records', ['Retention 7 Years'], 'regulatory', { classification: 'Confidential', owner: 'Finance', description: 'Amounts used in financial statements: changes are controlled and reconciled monthly.' });
  pol('Customer Data', ['GDPR', 'Retention 7 Years'], 'business', { owner: 'Head of Sales', description: 'How customer records are collected, used and kept: the personal data rules plus the retention of order history.' });
  tag('pii').policies = ['GDPR'];
  newTag('certified', 'Certified', 'Checked and approved for reporting.', 'Finance', 'Reporting');
  rec('Policies (Data Protection, GDPR, Mask Personal Data, Retention 7 Years, Financial Records, Customer Data) and the tags that bring them');

  // 3. governance on each level: owners per level, classification, criticality, lifecycle, attachments; a switch-off, accepted
  dropProps(['business_owner', 'data_steward']);
  set(m.project, { policies: ['Data Protection'], conceptual: { owner: 'Chief Data Officer' }, logical: { owner: 'Data Architecture' }, physical: { owner: 'Data Platform', steward: 'Data Engineering' }, semantic: { owner: 'Finance' } });
  set(C('Customer'), { owner: 'Head of Sales', steward: 'Customer Data Steward', classification: 'Confidential', criticality: 'High', lifecycle: 'Active', policies: ['Customer Data'] });
  set(C('Order'), { owner: 'Head of Sales', criticality: 'Critical', lifecycle: 'Active' });
  set(E('Order'), { owner: 'Sales Data Architect', criticality: 'Critical' });
  set(m.catalogs[0], { classification: 'Internal' });
  set(Sc('ref'), { classification: 'Public' });
  set(Sc('sales'), { owner: 'Sales Ops', steward: 'Sales Data Steward', policies: ['Mask Personal Data'] });
  set(T('orders'), { criticality: 'Critical', policies: ['Financial Records'] });
  set(col('orders', 'total'), { classification: 'Confidential' });
  set(T('customer_product'), { lifecycle: 'Proposed' });
  // the materialized view holds per-customer totals, no personal data: masking is switched off there on purpose
  set(T('customer_orders_mv'), { off: ['Mask Personal Data'] });
  accept('gov-off:main.sales.customer_orders_mv:Mask Personal Data');
  rec('Governance per level: owners, stewards, classification, criticality and lifecycle; policies on the project, a concept, a schema and a table; masking switched off on the totals view (accepted); owner / steward properties replaced');

  // 4. the semantic level
  const amt = metric({ name: 'Sales Amount', description: 'Value of the orders placed (order totals).', calculation: 'orders.total', aggregation: 'sum', grain: ['Order'] });
  const cnt = metric({ name: 'Order Count', description: 'Number of orders placed.', calculation: 'orders.id', aggregation: 'count_distinct', grain: ['Order'] });
  const aov = metric({ name: 'Average Order Value', description: 'What a customer spends on one order on average.', calculation: '{Sales Amount} / {Order Count}', aggregation: 'none', grain: ['Order'] });
  const act = metric({ name: 'Active Customers', description: 'Customers who placed at least one order.', calculation: 'orders.customer_id', aggregation: 'count_distinct', grain: ['Customer'] });
  place('semantic');
  rec('Add the semantic level: Sales Amount, Order Count, Average Order Value and Active Customers');
  set(amt, { classification: 'Confidential' }); amt.tags = ['certified'];
  set(cnt, { owner: 'Sales Ops' }); cnt.tags = ['certified'];
  aov.tags = ['certified'];
  set(act, { owner: 'Sales Ops', lifecycle: 'Proposed' });
  rec('Metric owners and classification; Sales Amount, Order Count and Average Order Value tagged Certified');
}

// ---------- Northwind: retail; personal, financial and HR data, owners on every level, four sales metrics ----------
function northwind({ m, rec, set, C, E, T, Sc, col, tag, newTag, pol, metric, dropProps, accept, place }) {
  // Classification is about the data itself and rolls up (ADR-0041): the columns that hold personal or commercial data carry it (the pii,
  // hr_sensitive and financial tags bring it; the price columns are set below), tables, schemas, entities, concepts and metrics show the highest
  // of what they hold, and a value on a container is only a minimum. Owners, stewards, criticality and policies (management) flow down.
  // 1. policies, and the tags that bring them
  pol('Data Protection', [], 'security', { owner: 'Privacy Officer', description: 'Personal and confidential data: least-privilege access, and reads are logged.' });
  pol('GDPR', ['Data Protection'], 'regulatory', { jurisdiction: 'EU', classification: 'Restricted', owner: 'Privacy Officer', description: 'EU General Data Protection Regulation: a lawful basis for processing, data-subject rights (access, erasure), breach notification within 72 hours.' });
  pol('Mask Personal Data', ['GDPR'], 'protection', { owner: 'Data Platform Team', description: 'Personal data is masked for everyone outside HR and customer service.' });
  pol('Retention 7 Years', [], 'retention', { owner: 'Data Governance Office', description: 'Kept for 7 years after the order date, then deleted.' });
  pol('Financial Records', ['Retention 7 Years'], 'regulatory', { classification: 'Confidential', owner: 'Finance', description: 'Amounts used in financial statements: changes are controlled and reconciled monthly.' });
  pol('Customer Data', ['GDPR', 'Retention 7 Years'], 'business', { owner: 'Head of Sales', description: 'How customer records are collected, used and kept: personal data rules plus the retention of order history.' });
  pol('HR Confidential', ['Data Protection'], 'security', { classification: 'Confidential', owner: 'HR Director', description: 'Employee records: HR and line managers only.' });
  tag('pii').policies = ['GDPR']; tag('financial').policies = ['Financial Records']; tag('hr_sensitive').policies = ['HR Confidential'];
  newTag('certified', 'Certified', 'Checked and approved for reporting.', 'BI Team', 'Business Intelligence');
  rec('Policies (Data Protection, GDPR, Mask Personal Data, Retention 7 Years, Financial Records, Customer Data, HR Confidential) and the tags that bring them');

  // 2. per-level governance: owners and the rest on each level, policy attachments; the old owner / steward / criticality / retention
  // properties are replaced by governance values and policies
  dropProps(['business_owner', 'data_steward', 'criticality', 'retention_years']);
  set(m.project, { policies: ['Data Protection'], conceptual: { owner: 'Chief Data Officer', steward: 'Data Governance Office' }, logical: { owner: 'Data Architecture', steward: 'Data Governance Office' }, physical: { owner: 'Data Platform Team', steward: 'Data Engineering' }, semantic: { owner: 'BI Team', steward: 'BI Team' } });
  set(C('Customer'), { owner: 'Head of Sales', steward: 'Customer Data Steward', classification: 'Confidential', criticality: 'High', lifecycle: 'Active', policies: ['Customer Data'] });
  set(C('Order'), { owner: 'Head of Sales', classification: 'Confidential', criticality: 'Critical', lifecycle: 'Active' });
  set(C('Product'), { owner: 'Head of Merchandising', criticality: 'High', lifecycle: 'Active' });
  set(C('Employee'), { owner: 'HR Director', classification: 'Confidential', lifecycle: 'Active' });
  set(C('Supplier'), { owner: 'Head of Procurement', lifecycle: 'Active' });
  set(C('Shipper'), { owner: 'Logistics Manager', lifecycle: 'Active' });
  set(E('Customer'), { owner: 'Sales Data Architect', policies: ['Customer Data'] });
  set(E('Order'), { owner: 'Sales Data Architect', criticality: 'Critical' });
  set(E('Order Line'), { owner: 'Sales Data Architect', criticality: 'Critical' });
  set(E('Employee'), { owner: 'HR Data Architect', classification: 'Confidential' });
  set(m.project, { physical: { ...m.project.gov.physical, classification: 'Internal' } }); // whatever no column says otherwise about is Internal
  set(Sc('sales'), { owner: 'Sales Engineering', steward: 'Sales Data Steward' });
  set(Sc('hr'), { owner: 'HR Systems', steward: 'HR Data Steward', classification: 'Confidential' });
  set(Sc('product'), { owner: 'Merchandising Systems' });
  set(Sc('ref'), { owner: 'Master Data Team', steward: 'Master Data Team' });
  set(Sc('reporting'), { owner: 'BI Team', steward: 'BI Team' });
  set(T('orders'), { criticality: 'Critical', policies: ['Financial Records'] });
  set(T('order_details'), { criticality: 'Critical', policies: ['Financial Records'] });
  set(T('customer_demographics'), { lifecycle: 'Deprecated' });
  // the price and discount columns are commercially sensitive: Confidential on the columns, and so on the order tables, Revenue and the rest above
  for (const c of ['unit_price', 'discount']) set(col('order_details', c), { classification: 'Confidential' });
  set(col('products', 'unit_price'), { classification: 'Confidential' });
  // Customer Data (GDPR) on the Customer concept and entity reaches the tables that realise them (ADR-0040): masking is managed per table, while
  // only their pii columns are Restricted
  for (const t of ['employees', 'addresses', 'invoices', 'customers_and_suppliers_by_city', 'customers', 'customer_demographics']) set(T(t), { policies: ['Mask Personal Data'] });
  for (const c of ['contact_name', 'phone', 'fax']) set(col('suppliers', c), { policies: ['Mask Personal Data'] });
  // the masked employee directory is for everyone: HR Confidential (brought by the hr_sensitive tag it inherits from Employee) is switched
  // off there on purpose, and that is accepted
  set(T('employee_directory_masked'), { off: ['HR Confidential'] });
  accept('gov-off:northwind.reporting.employee_directory_masked:HR Confidential');
  rec('Per-level governance: owners, stewards, criticality and lifecycle on each level; classification on the columns that hold personal or commercial data (containers roll it up; minimums on concepts, entities and the HR schema; Internal by default); policies attached at project, concept, entity, table and column; HR Confidential switched off on the masked employee directory (accepted); owner / steward / criticality / retention properties replaced');

  // 3. the semantic level: four metrics over order_details and orders
  const rev = metric({ name: 'Revenue', description: 'Sales value of order lines after discount, in USD. Freight is not included.', calculation: 'order_details.unit_price * order_details.quantity * (1 - order_details.discount)', aggregation: 'sum', grain: ['Order Line'] });
  const cnt = metric({ name: 'Order Count', description: 'Number of orders placed.', calculation: 'orders.order_id', aggregation: 'count_distinct', grain: ['Order'] });
  const aov = metric({ name: 'Average Order Value', description: 'Revenue per order: how much a customer spends on one order on average.', calculation: '{Revenue} / {Order Count}', aggregation: 'none', grain: ['Order'] });
  const units = metric({ name: 'Units Sold', description: 'Number of product units sold.', calculation: 'order_details.quantity', aggregation: 'sum', grain: ['Order Line', 'Product'] });
  place('semantic');
  rec('Add the semantic level: Revenue, Order Count, Average Order Value and Units Sold');
  set(rev, { owner: 'Finance' }); rev.tags = ['certified', 'financial'];
  set(cnt, { owner: 'Sales Operations' }); cnt.tags = ['certified'];
  set(aov, { owner: 'Finance' }); aov.tags = ['certified', 'financial'];
  set(units, { owner: 'Merchandising', lifecycle: 'Proposed' });
  rec('Metric owners; Revenue, Order Count and Average Order Value tagged Certified (their classification rolls up from the columns they read)');
}

// ---------- FpML: trade reporting and record keeping for an OTC derivatives book ----------
function fpml({ m, rec, set, C, E, T, Sc, col, tag, newTag, pol, metric, dropProps, place }) {
  // 1. policies: regulatory reporting (EMIR, Dodd-Frank, MiFID II) and market abuse on top of record retention; GDPR for people
  pol('Record Retention', [], 'retention', { owner: 'Compliance', description: 'Trade, event, valuation and message records are kept for the life of the trade plus at least five years, then deleted.' });
  pol('Regulatory Reporting', [], 'regulatory', { owner: 'Regulatory Reporting', description: 'Derivatives are reported to trade repositories and regulators: complete, accurate and on time, with a UTI for every trade and an LEI for every counterparty.' });
  pol('EMIR', ['Regulatory Reporting', 'Record Retention'], 'regulatory', { jurisdiction: 'EU', owner: 'Regulatory Reporting', description: 'European Market Infrastructure Regulation: every derivative is reported to a trade repository by the next working day; records are kept at least five years after the contract ends.' });
  pol('Dodd-Frank', ['Regulatory Reporting', 'Record Retention'], 'regulatory', { jurisdiction: 'US', owner: 'Regulatory Reporting', description: 'Dodd-Frank Act Title VII (CFTC Parts 43 and 45): swap data goes to a swap data repository, with real-time public reporting; records are kept for the life of the swap plus five years.' });
  pol('MiFID II', ['Regulatory Reporting', 'Record Retention'], 'regulatory', { jurisdiction: 'EU', owner: 'Regulatory Reporting', description: 'MiFID II / MiFIR transaction reporting to the competent authority by the next working day, and post-trade transparency; records are kept five years.' });
  pol('Market Abuse (MAR)', ['Record Retention'], 'regulatory', { jurisdiction: 'EU', owner: 'Compliance', description: 'Market Abuse Regulation: trading is monitored for insider dealing and market manipulation, and suspicious transactions are reported (STOR).' });
  pol('Data Protection', [], 'security', { owner: 'Information Security', description: 'Confidential client and trade data: least-privilege access, and reads are logged.' });
  pol('GDPR', ['Data Protection'], 'privacy', { jurisdiction: 'EU', classification: 'Restricted', owner: 'Data Protection Officer', description: 'EU General Data Protection Regulation for data about people (traders, client contacts): a lawful basis, data-subject rights, breach notification within 72 hours.' });
  pol('Mask Personal Data', ['GDPR'], 'protection', { owner: 'Data Platform', description: 'Names, e-mail addresses and phone numbers are masked for everyone outside client onboarding.' });
  tag('pii').policies = ['GDPR'];
  tag('confidential').policies = ['Data Protection'];
  tag('regulatory_reporting').policies = ['EMIR', 'Dodd-Frank', 'MiFID II'];
  newTag('certified', 'Certified', 'Checked and approved for regulatory and management reporting.', 'Risk', 'Reporting');
  rec('Policies (Regulatory Reporting with EMIR, Dodd-Frank and MiFID II; Market Abuse (MAR); Record Retention; Data Protection, GDPR, Mask Personal Data) and the tags that bring them');

  // 2. governance per level: Front Office, Middle Office, Risk and Operations own the business side, the Data Platform the tables; the old
  // owner / steward / criticality / retention properties become governance values and the Record Retention policy
  const oldProp = (o, p) => (o.properties || {})[p];
  const steward = new Map(m.schemas.map((s) => [s, oldProp(s, 'data_steward')]));
  const crit = (v) => (v ? v[0].toUpperCase() + v.slice(1) : '');
  const tcrit = new Map(m.tables.map((t) => [t, crit(oldProp(t, 'criticality'))]));
  dropProps(['business_owner', 'data_steward', 'criticality', 'retention_years']);
  set(m.project, { conceptual: { owner: 'Front Office', steward: 'Middle Office', lifecycle: 'Active' }, logical: { owner: 'Middle Office', steward: 'Data Platform' }, physical: { owner: 'Data Platform', steward: 'Data Platform' }, semantic: { owner: 'Risk', steward: 'Middle Office' } });
  const concepts = { Trade: ['Front Office', 'Confidential', 'Critical'], Product: ['Front Office', 'Confidential', 'High'], Portfolio: ['Front Office', 'Internal', 'Medium'], Valuation: ['Risk', 'Confidential', 'High'],
    'Market Data': ['Middle Office', 'Internal', 'Medium'], Party: ['Operations', 'Confidential', 'High'], 'Legal Agreement': ['Operations', 'Confidential', 'High'], Message: ['Operations', 'Confidential', 'Medium'], 'Reference Data': ['Operations', 'Public', 'Low'] };
  for (const [n, [owner, classification, criticality]] of Object.entries(concepts)) set(C(n), { owner, classification, criticality });
  set(C('Trade'), { policies: ['Market Abuse (MAR)'] });
  for (const n of ['Valuation', 'Valuation Measure']) set(E(n), { owner: 'Risk' });
  for (const n of ['Party', 'Person', 'Account', 'Party Relationship', 'Master Agreement', 'Message']) set(E(n), { owner: 'Operations' });
  set(E('Trade'), { criticality: 'Critical' });
  set(m.catalogs[0], { classification: 'Internal' });
  // schemas: the steward it had, a classification, and the most common criticality of its tables; tables keep theirs where it differs
  const cls = { trade: 'Confidential', product: 'Confidential', party: 'Confidential', valuation: 'Confidential', messaging: 'Confidential', market: 'Internal', ref: 'Public', reporting: 'Internal' };
  for (const s of m.schemas) {
    const ts = m.tables.filter((t) => t.schemaId === s.id), n = {};
    ts.forEach((t) => { if (tcrit.get(t)) n[tcrit.get(t)] = (n[tcrit.get(t)] || 0) + 1; });
    const common = Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b))[0];
    set(s, { steward: steward.get(s), classification: cls[s.name], criticality: common });
    for (const t of ts) if (tcrit.get(t) && tcrit.get(t) !== common) set(t, { criticality: tcrit.get(t) });
  }
  set(Sc('trade'), { policies: ['Market Abuse (MAR)'] });
  for (const s of ['messaging', 'valuation']) set(Sc(s), { policies: ['Record Retention'] });
  // personal data is masked where it is stored and in the directory view that still shows first names
  for (const t of ['person', 'v_person_directory_masked']) set(T(t), { policies: ['Mask Personal Data'] });
  rec('Governance per level: owners (Front Office, Middle Office, Risk, Operations, Data Platform), stewards, classification, criticality and lifecycle; MAR on trades, Record Retention on messages and valuations, masking of personal data; owner / steward / criticality / retention properties replaced');

  // 3. the semantic level: counts, notionals and mark-to-market, all resolved against real columns
  const trades = metric({ name: 'Trade Count', description: 'Number of trades booked.', calculation: 'trade.trade_id', aggregation: 'count_distinct', grain: ['Trade'] });
  const open = metric({ name: 'Open Positions', description: 'Trades that are live (status Active), per book.', calculation: "CASE WHEN trade.trade_status_code = 'Active' THEN trade.trade_id END", aggregation: 'count_distinct', grain: ['Trade', 'Book'] });
  const irs = metric({ name: 'IRS Notional', description: 'Notional of interest rate swap streams, from their notional step schedules, in the stream currency.', calculation: 'notional_step.notional_amount', aggregation: 'sum', grain: ['Swap Stream'] });
  const cds = metric({ name: 'CDS Notional', description: 'Notional of credit default swaps, in the notional currency.', calculation: 'credit_default_swap.notional_amount', aggregation: 'sum', grain: ['Credit Default Swap'] });
  const gross = metric({ name: 'Gross Notional', description: 'Total notional outstanding across interest rate swaps and credit default swaps, converted to the reporting currency first.', calculation: '{IRS Notional} + {CDS Notional}', aggregation: 'none', grain: ['Trade'] });
  const mtm = metric({ name: 'Net MTM', description: 'Net mark-to-market: the sum of the NPV measures of the valuation sets, in the reporting currency.', calculation: "CASE WHEN valuation_measure.measure_type_code = 'NPV' THEN valuation_measure.amount END", aggregation: 'sum', grain: ['Valuation', 'Trade'] });
  const nov = metric({ name: 'Novation Count', description: 'Number of novations: trades transferred to a new counterparty.', calculation: 'trade_novation.trade_event_id', aggregation: 'count_distinct', grain: ['Trade Event'] });
  place('semantic');
  rec('Add the semantic level: Trade Count, Open Positions, IRS Notional, CDS Notional, Gross Notional, Net MTM and Novation Count');
  set(trades, { owner: 'Operations' }); trades.tags = ['certified'];
  set(open, { owner: 'Front Office' });
  set(gross, { classification: 'Confidential' }); gross.tags = ['certified', 'sensitive_financial'];
  set(mtm, { classification: 'Confidential' }); mtm.tags = ['certified', 'valuation'];
  set(nov, { owner: 'Operations', lifecycle: 'Proposed' });
  rec('Metric owners and classification; Trade Count, Gross Notional and Net MTM tagged Certified');
}

for (const id of which === 'all' ? Object.keys(SAMPLES) : [which]) {
  if (!SAMPLES[id]) { console.error('usage: node tests/build-samples.js [example|northwind|fpml|star|all] [--dry]'); process.exit(2); }
  build(id);
}
