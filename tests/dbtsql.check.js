// Self-check for reading the SQL of dbt models (ADR-0049, ADR-0050): lib/dbtsql.js and how lib/dbt.js uses it (columns, tables read, joins, aggregates).
// Every case runs with node-sql-parser and again with the simple reader (STRATA_SQL_PARSER=off); a few need the parser and say so.
// Run: node tests/dbtsql.check.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const SQL = require('../lib/dbtsql.js');
const D = require('../lib/dbt.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-dbtsql-'));
delete process.env.STRATA_SQL_PARSER; // this suite sets it per reader itself
const HAVE = SQL.available();

// a manifest made of models (name, sql, cols?) and sources (source_name, name, cols): cold, like `dbt parse`
let seq = 0;
const run = (models, o = {}) => {
  const dir = path.join(scratch, 'm' + seq++); fs.mkdirSync(dir);
  const nodes = {}, sources = {};
  for (const m of models) nodes['model.p.' + m.name] = { resource_type: 'model', unique_id: 'model.p.' + m.name, package_name: 'p', name: m.name, alias: m.name, schema: 'public', database: 'db', columns: Object.fromEntries((m.cols || []).map((c) => [c, { name: c }])), tags: [], meta: {}, description: '', [m.compiled ? 'compiled_code' : 'raw_code']: m.sql, language: 'sql', config: { materialized: m.mat || 'view' }, depends_on: { nodes: [] } };
  for (const s of o.sources || []) sources[`source.p.${s.source_name}.${s.name}`] = { resource_type: 'source', unique_id: `source.p.${s.source_name}.${s.name}`, package_name: 'p', source_name: s.source_name, name: s.name, identifier: s.name, schema: 'raw', database: 'db', columns: Object.fromEntries((s.cols || []).map((c) => [c, { name: c }])), tags: [], meta: {}, description: '' };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json', dbt_version: '1.9.0', project_name: 'p', adapter_type: o.adapter || 'postgres' }, nodes, sources }));
  return D.readDbt(dir);
};
const node = (r, name) => r.nodes.find((n) => n.name === name), cols = (r, name) => node(r, name).columns.map((c) => c.name), deps = (r, name) => node(r, name).deps.map((d) => d.split('.').slice(-1)[0]).sort();
const src = (name, ...c) => ({ source_name: 's', name, cols: c });
const S = (t) => `{{ source('s', '${t}') }}`, R = (t) => `{{ ref('${t}') }}`;
const SRC = [src('a', 'id', 'name', 'amt', 'k'), src('b', 'id', 'name', 'amt', 'k'), src('c', 'cid', 'x'), src('d', 'id', 'name'), src('orders', 'order_id', 'customer_id', 'amount'), src('customers', 'customer_id', 'name')];

for (const reader of ['parser', 'simple']) {
  if (reader === 'parser' && !HAVE) { console.log('dbtsql.check: node-sql-parser is not installed, the parser cases were skipped (npm install)'); continue; }
  process.env.STRATA_SQL_PARSER = reader === 'simple' ? 'off' : 'on';
  const P = reader === 'parser', T = (msg) => `[${reader}] ${msg}`;

  // ---- UNION / INTERSECT / EXCEPT: names from the first branch, everything else from every branch ----
  let r = run([
    { name: 'top', sql: `select id, name from ${S('a')} union all select id as id2, sum(amt) as name2 from ${S('b')} join ${S('c')} on b.id = c.cid group by id` },
    { name: 'in_cte', sql: `with u as (select id, name from ${S('a')} union select id, name from ${S('b')}) select * from u` },
    { name: 'in_sub', sql: `select t.id, t.name from (select id, name from ${S('a')} union all select id, name from ${R('top')}) t` },
    { name: 'three', sql: `select id from ${S('a')} union select id from ${S('b')} intersect select cid from ${S('c')} except select id from ${S('d')}` },
    { name: 'paren', sql: `(select id, name from ${S('a')}) union all (select id, name from ${S('b')})` },
    { name: 'star', sql: `select * from ${S('a')} union all select * from ${S('b')}` },
  ], { sources: SRC });
  assert.deepStrictEqual(cols(r, 'top'), ['id', 'name'], T('the columns of a union are the first branch\'s (SQL semantics), not the second branch\'s id2 / name2'));
  assert.deepStrictEqual(deps(r, 'top'), ['a', 'b', 'c'], T('the tables of every branch are read'));
  assert.deepStrictEqual(r.aggs.filter((a) => a.node === 'model.p.top').map((a) => a.fn + '(' + a.calc + ')'), ['sum(source.p.s.b.amt)'], T('an aggregate in the second branch is found'));
  assert.deepStrictEqual(cols(r, 'in_cte'), ['id', 'name'], T('a union inside a CTE: first branch names'));
  assert.deepStrictEqual(deps(r, 'in_cte'), ['a', 'b'], T('a union inside a CTE: both branches read'));
  assert.deepStrictEqual(cols(r, 'in_sub'), ['id', 'name'], T('a union in a sub-select'));
  assert.deepStrictEqual(deps(r, 'in_sub'), ['a', 'top'], T('a union in a sub-select: both branches read'));
  assert.deepStrictEqual(deps(r, 'three'), ['a', 'b', 'c', 'd'], T('UNION / INTERSECT / EXCEPT chain: every branch read'));
  assert.deepStrictEqual(deps(r, 'paren'), ['a', 'b'], T('parenthesised branches'));
  assert.deepStrictEqual(cols(r, 'star'), ['id', 'name', 'amt', 'k'], T('select * over a union: first branch columns'));
  assert.deepStrictEqual(deps(r, 'star'), ['a', 'b']);
  // `select * except (col)` (BigQuery) / `select * exclude (col)` (Snowflake) is no set operation and leaves the column out; a modifier that is not understood gives no columns, not wrong ones
  if (P) {
    r = run([{ name: 'bq_except', sql: `select * except (name, k) from ${S('a')}` }], { sources: SRC, adapter: 'bigquery' });
    assert.deepStrictEqual(cols(r, 'bq_except'), ['id', 'amt'], T('BigQuery * except (...)'));
    assert.deepStrictEqual(deps(r, 'bq_except'), ['a']);
    r = run([{ name: 'sf_exclude', sql: `select * exclude (name, k) from ${S('a')}` }, { name: 'sf_rename', sql: `select * rename (name as nm) from ${S('a')}` }], { sources: SRC, adapter: 'snowflake' });
    assert.deepStrictEqual(cols(r, 'sf_exclude'), ['id', 'amt'], T('Snowflake * exclude (...)'));
    assert.deepStrictEqual(cols(r, 'sf_rename'), [], T('* rename (...) is not understood: no columns rather than wrong ones'));
  } else {
    r = run([{ name: 'bq_except', sql: `select * except (name) from ${S('a')}` }], { sources: SRC, adapter: 'bigquery' });
    assert.deepStrictEqual(cols(r, 'bq_except'), [], T('the simple reader does not guess what * except (...) leaves'));
    assert.deepStrictEqual(deps(r, 'bq_except'), ['a']);
  }
  // joins and ON equalities in a later branch: a relationship is inferred from every branch
  r = run([{ name: 'j', sql: `select o.order_id from ${S('orders')} o join ${S('customers')} c on o.customer_id = c.customer_id union all select o2.order_id from ${S('orders')} o2 join ${S('customers')} c2 on o2.customer_id = c2.customer_id` },
    { name: 'j2', sql: `select 1 as x from ${S('d')} union all select o.order_id from ${S('orders')} o join ${S('customers')} c on c.customer_id = o.customer_id` }], { sources: SRC });
  assert.ok(r.aggs.length === 0);
  const joinRel = node(r, 'orders').rels.find((x) => x.col === 'customer_id');
  assert.ok(joinRel && joinRel.to === 'source.p.s.customers' && joinRel.field === 'customer_id', T('a join in the second branch of a union infers the relationship'));
  // aggregates and joins in the branches of a union inside a CTE and inside a sub-select
  r = run([{ name: 'cte_agg', sql: `with u as (select sum(amt) as t from ${S('a')} union all select sum(amt) as t from ${S('b')}) select t from u` },
    { name: 'sub_agg', sql: `select x.t from (select max(amt) as t from ${S('a')} union select min(amt) as t from ${S('b')}) x` },
    { name: 'cte_join', sql: `with u as (select 1 as one from ${S('d')} union all select o.order_id from ${S('orders')} o join ${S('customers')} c on o.customer_id = c.customer_id) select * from u` }], { sources: SRC });
  assert.deepStrictEqual(r.aggs.filter((a) => a.node === 'model.p.cte_agg').map((a) => a.fn + '(' + a.calc + ')').sort(), ['sum(source.p.s.a.amt)', 'sum(source.p.s.b.amt)'], T('aggregates in both branches of a union in a CTE'));
  assert.deepStrictEqual(r.aggs.filter((a) => a.node === 'model.p.sub_agg').map((a) => a.fn + '(' + a.calc + ')').sort(), ['max(source.p.s.a.amt)', 'min(source.p.s.b.amt)'], T('aggregates in both branches of a union in a sub-select'));
  assert.ok(node(r, 'orders').rels.some((x) => x.col === 'customer_id' && x.to === 'source.p.s.customers'), T('a join in the second branch of a union in a CTE infers the relationship'));
  // union in an expression sub-select (WHERE ... IN (... UNION ...)): parser only
  if (P) {
    r = run([{ name: 'w', sql: `select id from ${S('a')} where id in (select id from ${S('b')} union select cid from ${S('c')}) and exists (select 1 from ${S('d')} where d.id = a.id)` }], { sources: SRC });
    assert.deepStrictEqual(deps(r, 'w'), ['a', 'b', 'c', 'd'], T('sub-selects in WHERE, with a union inside, are read'));
    r = run([{ name: 'sel', sql: `select id, (select max(amt) from ${S('b')}) as mx from ${S('a')}` }], { sources: SRC });
    assert.deepStrictEqual(deps(r, 'sel'), ['a', 'b'], T('a scalar sub-select in the select list is read'));
    assert.deepStrictEqual(cols(r, 'sel'), ['id', 'mx']);
  }
  // union in a nested CTE (a WITH inside a sub-select): parser only
  if (P) {
    r = run([{ name: 'nested', sql: `select * from (with x as (select id from ${S('a')} union all select id from ${S('b')}) select id from x) y` }], { sources: SRC });
    assert.deepStrictEqual(deps(r, 'nested'), ['a', 'b'], T('a WITH nested in a sub-select, with a union inside'));
    assert.deepStrictEqual(cols(r, 'nested'), ['id']);
  }

  // ---- CTE shadowing, aliases, qualified and quoted names, case ----
  r = run([
    { name: 'stg', sql: `select order_id, customer_id from ${S('orders')}` },
    { name: 'shadow', sql: `with orders as (select order_id from ${R('stg')}) select order_id from orders` },
    { name: 'shadow2', sql: `with stg as (select 1 as one), x as (select one from stg) select one from x` },
    { name: 'qual', sql: `select o.order_id from raw.orders o` },
    { name: 'upper', sql: `select ORDER_ID from RAW.ORDERS` },
    { name: 'db3', sql: `select o.order_id from db.raw.orders as o` },
    { name: 'hard', sql: `select id from legacy.old_table` },
  ], { sources: SRC });
  assert.deepStrictEqual(deps(r, 'shadow'), ['stg'], T('a CTE named like a real table shadows it: only the model behind the CTE is a dependency'));
  assert.ok(!r.nodes.some((n) => n.type === 'undeclared' && /orders/.test(n.name)), T('no phantom table for the CTE'));
  assert.deepStrictEqual(deps(r, 'shadow2'), [], T('a CTE named like a model shadows it in later CTEs'));
  assert.deepStrictEqual(deps(r, 'qual'), ['orders'], T('schema.table resolves to the source'));
  assert.deepStrictEqual(deps(r, 'upper'), ['orders'], T('case-insensitive names'));
  assert.deepStrictEqual(deps(r, 'db3'), ['orders'], T('db.schema.table resolves to the source'));
  assert.deepStrictEqual(node(r, 'hard') && r.nodes.filter((n) => n.type === 'undeclared').map((n) => n.schema + '.' + n.name), ['legacy.old_table'], T('a hard-coded table is imported as an undeclared table'));
  if (P) {
    r = run([{ name: 'nested_shadow', sql: `with x as (select id from ${S('a')}) select * from (with x as (select cid as id from ${S('c')}) select id from x) y` }], { sources: SRC });
    assert.deepStrictEqual(deps(r, 'nested_shadow'), ['a', 'c'], T('an inner WITH shadows the outer CTE of the same name (lexical scope)'));
    r = run([{ name: 'quoted', sql: `select "Order_Id", o."customer_id" from "raw"."Orders" o` }], { sources: SRC });
    assert.deepStrictEqual(deps(r, 'quoted'), ['orders'], T('quoted identifiers resolve case-insensitively'));
    assert.deepStrictEqual(cols(r, 'quoted'), ['Order_Id', 'customer_id'], T('and keep the spelling of the SQL'));
  }

  // ---- select *, t.*, ambiguity ----
  r = run([
    { name: 'sj', sql: `select o.*, c.name from ${S('orders')} o join ${S('customers')} c on o.customer_id = c.customer_id` },
    { name: 'sj2', sql: `select c.*, o.amount from ${S('orders')} o join ${S('customers')} c on o.customer_id = c.customer_id` },
    { name: 'dup', sql: `select * from ${S('a')} a join ${S('b')} b on a.id = b.id` },
    { name: 'amb', sql: `select id from ${S('a')} a join ${S('b')} b on a.k = b.k` },
  ], { sources: SRC });
  assert.deepStrictEqual(cols(r, 'sj'), ['order_id', 'customer_id', 'amount', 'name'], T('t.* expands only that relation'));
  assert.deepStrictEqual(cols(r, 'sj2'), ['customer_id', 'name', 'amount'], T('the other relation\'s t.* and an item'));
  assert.deepStrictEqual(cols(r, 'dup'), ['id', 'name', 'amt', 'k'], T('select * over joined tables with equal column names keeps each name once'));
  assert.ok(r.notes.some((n) => /select \* over joined tables that share a column name/.test(n) && /dup/.test(n)), T('and says so'));
  assert.ok(r.notes.some((n) => /without a table prefix that two joined tables both have/.test(n) && /amb/.test(n)), T('an unqualified column both tables have is reported, not guessed'));

  if (P) {
    r = run([{ name: 'nil', sql: `select id, sysdate as loaded, localtimestamp as l2, a.k from ${S('a')} a where a.k is not null` }], { sources: SRC });
    assert.deepStrictEqual(node(r, 'a').columns.map((c) => c.name), ['id', 'name', 'amt', 'k'], T('a function without parentheses (sysdate, current_user) is no column of the table'));
    assert.deepStrictEqual(cols(r, 'nil'), ['id', 'loaded', 'l2', 'k'], T('but its alias is a column of the model'));
  }

  r = run([{ name: 'crlf', sql: `-- models/x.sql\r\n\r\nselect\r\n    o.order_id, /* the key */\r\n    c.name -- trailing\r\nfrom\r\n    ${S('orders')} o\r\n  join ${S('customers')} c on o.customer_id = c.customer_id -- no newline at the end` }], { sources: SRC });
  assert.deepStrictEqual(cols(r, 'crlf'), ['order_id', 'name'], T('Windows line endings and comments'));
  assert.deepStrictEqual(deps(r, 'crlf'), ['customers', 'orders']);

  // ---- item names, casts, aggregates ----
  r = run([{ name: 'items', sql: `select a.id, a.amt * 2, count(*), sum(a.amt) as total, cast(a.k as numeric(10, 2)) as kk from ${S('a')} a` }], { sources: SRC });
  assert.deepStrictEqual(cols(r, 'items'), ['id', 'total', 'kk'], T('expressions without an alias are not columns'));
  assert.ok(r.notes.some((n) => /expressions without an alias/.test(n) && /items/.test(n)), T('and are reported'));
  if (P) {
    assert.strictEqual(node(r, 'items').columns.find((c) => c.name === 'kk').type, 'NUMERIC(10,2)', T('the type of a cast'));
    r = run([{ name: 'agg', sql: `select sum(case when a.k > 1 then a.amt * 2 else 0 end) as big, count(distinct a.id) as n, avg(coalesce(a.amt, 0)) as m, sum(a.amt) over (partition by a.k) as w from ${S('a')} a` }], { sources: SRC });
    assert.deepStrictEqual(r.aggs.map((a) => a.name + ':' + a.fn + ':' + a.calc), ['big:sum:CASE WHEN source.p.s.a.k > 1 THEN source.p.s.a.amt * 2 ELSE 0 END', 'n:count_distinct:source.p.s.a.id', 'm:avg:coalesce(source.p.s.a.amt, 0)'], T('aggregates as calculations; a window function is not one'));
  }

  // ---- the plumbing of the analysis itself ----
  const one = (sql, o = {}) => SQL.analyse(sql, { dialect: reader === 'parser' ? 'postgresql' : null, ...o });
  assert.ok(one('select 1').main, T('a statement with no FROM'));
  assert.strictEqual(one('select 1 from a; ').via, reader === 'parser' ? 'parser' : 'simple', T('a trailing semicolon'));
  assert.strictEqual(one('-- it\'s a comment\nselect \'--\' as x, id from a').main.items.length, 2, T('comment stripping leaves strings alone'));
  assert.ok(one('x'.repeat(SQL.MAX + 1)).via === 'skipped', T('a huge statement is skipped'));
  { const big = 'select ' + Array.from({ length: 4000 }, (_, i) => `coalesce(a.c${i}, 0) as c${i}`).join(', ') + ' from t a'; const b = one(big); assert.strictEqual(b.via, 'simple', T('a statement over the parser limit is read by the simple reader')); assert.strictEqual(b.main.items.length, 4000); if (reader === 'parser') assert.ok(b.large); }
  const cache = new Map(), q = 'select id from {{ ref("a") }} union all select id from {{ ref("b") }}';
  one(q, { cache }); one(q, { cache });
  assert.strictEqual(cache.size, 1, T('the same SQL is read once per import'));
}

// ---- parser-only behaviour ----
process.env.STRATA_SQL_PARSER = 'on';
if (HAVE) {
  const bad = SQL.analyse('select from where ((', { dialect: 'postgresql' });
  assert.strictEqual(bad.via, 'simple', 'a statement the parser rejects falls back to the simple reader');
  assert.ok(/line \d+, column \d+/.test(bad.error), 'and says where');
  const r = run([{ name: 'weird', sql: `select id, name from ${S('a')} qualify row_number() over (partition by id order by name) = 1 tablesample bernoulli (10) ~~~ broken` }], { sources: SRC });
  assert.ok(r.notes.some((n) => /could not be parsed as postgresql SQL/.test(n) && /weird/.test(n)), 'the note names the model and the dialect');
  assert.deepStrictEqual(cols(r, 'weird'), ['id', 'name'], 'the simple reader still finds what it can');
  // dialects: the same read for each adapter's own syntax
  const cases = [
    ['snowflake', `select id, name from ${S('a')} qualify row_number() over (partition by id order by name) = 1`],
    ['bigquery', 'select id, safe_cast(name as string) as name from `db.raw.a`'],
    ['sqlserver', 'select top 10 [id], isnull([name], \'\') as name from [raw].[a]'],
    ['trino', `select id, name from ${S('a')} where date_diff('day', current_date, current_date) > 0`],
    ['mysql', 'select `id`, `name` from `raw`.`a`'],
    ['databricks', `select id, name from ${S('a')} where id in (1, 2)`],
    ['redshift', `select id, name from ${S('a')} limit 10`],
    ['athena', `select id, name from ${S('a')}`],
    ['duckdb', `select id, name from ${S('a')}`],
  ];
  for (const [adapter, sql] of cases) {
    const res = run([{ name: 'm', sql }], { sources: SRC, adapter });
    assert.deepStrictEqual(cols(res, 'm'), ['id', 'name'], adapter + ': columns');
    assert.deepStrictEqual(deps(res, 'm'), ['a'], adapter + ': the table read');
    assert.ok(!res.notes.some((n) => /could not be parsed/.test(n)), adapter + ': read by the parser, no fallback (' + res.notes.filter((n) => /parsed/.test(n)) + ')');
  }
  assert.deepStrictEqual(['postgres', 'snowflake', 'bigquery', 'sqlserver', 'databricks', 'spark', 'trino', 'duckdb', 'nonsense', undefined].map(SQL.dialectOf), ['postgresql', 'snowflake', 'bigquery', 'transactsql', 'hive', 'hive', 'trino', 'postgresql', 'postgresql', 'postgresql'], 'the adapter -> dialect table, unknown = postgresql');
  // a USING join, a table function
  let res = run([{ name: 'us', sql: `select a.id, b.name from ${S('a')} a join ${S('d')} b using (id)` }], { sources: SRC });
  assert.deepStrictEqual(deps(res, 'us'), ['a', 'd']);
  res = run([{ name: 'fn', sql: `select a.id, x.v from ${S('a')} a, generate_series(1, 3) as x(v)` }, { name: 'fn2', sql: `select id, k from ${S('a')}, unnest(arr) as u` }], { sources: SRC });
  assert.ok(res.notes.some((n) => /table function, UNNEST, VALUES/.test(n) && /fn2/.test(n)), 'a table function in FROM is reported');
  assert.deepStrictEqual(deps(res, 'fn'), ['a'], 'and the real table next to it is still read');
}

// ---- raw SQL: what jinja hides is reported, compiled SQL is not judged ----
process.env.STRATA_SQL_PARSER = 'on';
{
  const r = run([{ name: 'mac', sql: `select {{ dbt_utils.star(ref('stg')) }}, id from ${S('a')} {% if is_incremental() %} where id > 1 {% endif %}` }, { name: 'compiled', sql: 'select id from raw.a', compiled: true }], { sources: SRC });
  assert.ok(r.notes.some((n) => /calls macros other than ref\(\) \/ source\(\)/.test(n) && /mac \(dbt_utils.star\)$/.test(n)), 'a macro in raw SQL is reported, with its name');
  assert.ok(r.notes.some((n) => /jinja control flow/.test(n) && /mac/.test(n)), 'jinja control flow in raw SQL is reported');
  assert.deepStrictEqual(cols(r, 'mac'), ['id'], 'the macro\'s columns are not invented');
  assert.deepStrictEqual(cols(r, 'compiled'), ['id'], 'compiled SQL is read as is');
}
// no parser installed: the simple reader is used and the import says so
process.env.STRATA_SQL_PARSER = 'off';
{ const r = run([{ name: 'm', sql: `select id from ${S('a')}` }], { sources: SRC }); assert.ok(r.notes.some((n) => /node-sql-parser\) is not installed or is switched off/.test(n)), 'without the parser the import says so once'); assert.deepStrictEqual(cols(r, 'm'), ['id']); }
delete process.env.STRATA_SQL_PARSER;
fs.rmSync(scratch, { recursive: true, force: true });
console.log('dbtsql.check: ok' + (HAVE ? '' : ' (parser cases skipped)'));
