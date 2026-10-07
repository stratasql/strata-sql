// Not part of the suites (like tests/bench.js): times the dbt import on a synthetic cold project (manifest only, no catalog, no compiled SQL).
// Run: node tests/bench.dbt.js [models=2000]   (5,000 nodes / ~20,000 declared columns at the default size)
const fs = require('fs'), os = require('os'), path = require('path');
const D = require('../lib/dbt.js');
const N = +process.argv[2] || 2000, SRC = 300, SEEDS = 200, TESTS = 2500;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-dbt-bench-'));
const cols = (n) => Object.fromEntries(['id', 'name', 'amount', 'qty', 'created_at', 'status', 'region_id', 'customer_id'].slice(0, n).map((c) => [c, { name: c, description: '', meta: {}, tags: [] }]));
const nodes = {}, sources = {};
for (let i = 0; i < SRC; i++) sources[`source.p.s.t${i}`] = { resource_type: 'source', unique_id: `source.p.s.t${i}`, package_name: 'p', source_name: 's', name: `t${i}`, identifier: `t${i}`, schema: 'raw', database: 'db', columns: cols(8), tags: [], meta: {}, description: '' };
for (let i = 0; i < SEEDS; i++) nodes[`seed.p.seed${i}`] = { resource_type: 'seed', unique_id: `seed.p.seed${i}`, package_name: 'p', name: `seed${i}`, alias: `seed${i}`, schema: 'public', database: 'db', columns: cols(8), tags: [], meta: {}, description: '', config: { materialized: 'seed' }, depends_on: { nodes: [] } };
const ref = (i) => `{{ ref('m${i}') }}`, sql = (i) => {
  const h = (k) => Math.imul(i + 1, k) >>> 0, a = i > 1 ? h(2654435761) % i : 0, b = i > 1 ? h(40503) % i : 0, s = i % SRC;
  switch (i % 5) {
    case 0: return `with src as (select id, name, amount from ${ref(a)}), agg as (select id, sum(amount) as total, count(distinct name) as n from src group by id)\nselect x.id, x.total, y.name, ${i} as m_${i} from agg x join ${ref(b)} y on x.id = y.id`;
    case 1: return `select id, amount, 'a' as src, ${i} as m_${i} from ${ref(a)}\nunion all\nselect id, amount, 'b' from {{ source('s', 't${s}') }}\nunion all\nselect id, amount, 'c', ${i} from ${ref(b)}`;
    case 2: return i % 10 === 2 ? `select * from ${ref(a)} where m_${i} > 0` : `select region_id, sum(amount) as revenue_${i}, sum(qty * amount) as gross_${i} from ${ref(a)} group by region_id`;
    case 3: return `with u as (select id, amount from ${ref(a)} union select id, amount from ${ref(b)}) select u.id, sum(u.amount * 2) as revenue_${i} from u group by u.id`;
    default: return `select t.id, t.name, o.amount, o.qty, ${i} as m_${i} from (select id, name from ${ref(a)} union all select id, name from {{ source('s', 't${s}') }}) t left join hard_coded_${i % 40} o on o.id = t.id`;
  }
};
for (let i = 0; i < N; i++) nodes[`model.p.m${i}`] = { resource_type: 'model', unique_id: `model.p.m${i}`, package_name: 'p', name: `m${i}`, alias: `m${i}`, schema: 'public', database: 'db', columns: cols(8), tags: [], meta: {}, description: '', raw_code: sql(i), language: 'sql', config: { materialized: i % 3 ? 'view' : 'table' }, depends_on: { nodes: [] } };
for (let i = 0; i < TESTS; i++) {
  const m = `model.p.m${(Math.imul(i, 2246822519) >>> 0) % N}`, k = i % 3 ? ['unique', 'not_null'][i % 2] : 'relationships';
  nodes[`test.p.t${i}`] = { resource_type: 'test', unique_id: `test.p.t${i}`, package_name: 'p', name: `t${i}`, column_name: 'id', attached_node: m, depends_on: { nodes: [m] }, config: {},
    test_metadata: { name: k, kwargs: k === 'relationships' ? { column_name: 'id', to: `ref('m${(Math.imul(i, 3266489917) >>> 0) % N}')`, field: 'id', model: `{{ get_where_subquery(ref('${m.split('.').pop()}')) }}` } : { column_name: 'id' } } };
}
const manifest = { metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json', dbt_version: '1.9.0', project_name: 'p', adapter_type: 'postgres' }, nodes, sources };
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
const lap = (label, t0) => console.log(label.padEnd(34), String(Math.round(performance.now() - t0)).padStart(6), 'ms');
console.log(`${Object.keys(nodes).length} nodes, ${Object.keys(sources).length} sources, ${[...Object.values(nodes), ...Object.values(sources)].reduce((n, x) => n + Object.keys(x.columns || {}).length, 0)} declared columns, ${N} SQL models`);
let t = performance.now();
const imp = D.readDbt(dir);
lap('readDbt (manifest + SQL)', t);
t = performance.now();
const base = D.fresh(imp, 'Bench'), r = D.merge(base, imp);
lap('merge into a new model', t);
t = performance.now();
const r2 = D.merge(r.F, imp);
lap('re-sync merge (no change)', t);
console.log(`${imp.nodes.length} tables, ${imp.nodes.reduce((n, x) => n + x.columns.length, 0)} columns, ${r.F.relationships.length} relationships, ${(r.F.semantic || { metrics: [] }).metrics.length} metrics, ${r2.changes.length} changes on re-sync; heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`);
console.log('notes:', imp.notes.length, imp.notes.slice(0, 5).map((x) => String(x).slice(0, 140)));

fs.rmSync(dir, { recursive: true, force: true });
if (process.env.DBG) console.log('aggs', imp.aggs.length, imp.aggs.slice(0, 2), r.notes.slice(0, 4));
