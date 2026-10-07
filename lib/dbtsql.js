// SQL reading for the dbt import (ADR-0049, ADR-0050): what a model selects, which relations it reads, how they are joined, which items aggregate.
// Two readers behind one shape:
//   1. node-sql-parser (the one runtime dependency besides the local-embeddings library, ADR-0050), required lazily and only here, with the dialect of
//      the dbt adapter. It reads the whole statement: every branch of UNION / INTERSECT / EXCEPT chains, CTEs (with their scoping), sub-selects in FROM,
//      WHERE, HAVING and select items.
//   2. the simple reader below (kept from ADR-0049): used when node-sql-parser is not installed or rejects a statement. It reads the same shape from
//      the text with regular expressions and never guesses: what it does not understand is left out.
// Shape: analyse(sql) -> {ctes: [{name, sel}], main: sel | null, marks: [raw jinja], via: 'parser' | 'simple' | 'skipped', error?, warn: Set(code)}
// sel = {partial (a relation was not readable), items, from, rest: [sel] (the other branches of a set operation), subs: [sel] (sub-selects in expressions), ctes: [{name, sel}] (nested WITH),
//        refs: [{rel, name}] (columns its expressions read), aliases: Set (lower-case item aliases), where: [cond] (a.x = b.y in WHERE),
//        filter: {expr, calc(look)} | null (the WHERE as text), group: [{expr, calc(look)}] (the GROUP BY terms; ADR-0051)}
// item = {expr, alias, name, star (true | alias), exclude? (Set of lower-case names a star leaves out), col: {rel, name} | null, type?, agg: {fn, distinct, arg, calc(look) -> text | null} | null}
// relation = {parts: [name...] | sub: sel, alias, on: [cond], scope?: Map (visible CTEs)}, cond = {a: [alias, column], b: [alias, column]}
// The columns of a set operation are the first branch's (SQL semantics); tables, joins and aggregates come from every branch: see allSels.
const ID = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
const unq = (x) => x.trim().replace(/^["`[]|["`\]]$/g, '');
const lc = (s) => String(s == null ? '' : s).toLowerCase();
const KW = /^(?:end|over|asc|desc|null|true|false|and|or|not|is|in|like|distinct|then|else|when|case|current_date|current_timestamp)$/i;
const NILADIC = /^(?:current_(?:date|time|timestamp|user|role|schema|catalog|database)|local(?:time|timestamp)|session_user|system_user|user|sysdate|systimestamp|sysdatetime|getdate|utc_timestamp)$/i; // parsed as columns, but they are functions without parentheses
const WORDS = new Set('and or not null is in like ilike between case when then else end distinct cast as interval true false extract from numeric decimal int integer bigint smallint float double precision real varchar char text date timestamp boolean year month day hour minute second'.split(' '));
const PARSER_MAX = 60000, MAX = 300000; // characters of one model's SQL: above PARSER_MAX the simple reader is used (the parser is fast on normal SQL, but its time grows faster than the text on machine-generated walls of it, ~2 s at 90 kB of CTEs), above MAX the statement is skipped
const AGGS = new Set(['SUM', 'COUNT', 'AVG', 'MIN', 'MAX']);

// ---------- the parser (lazy) and the dialects ----------
// dbt adapter (metadata.adapter_type) -> node-sql-parser dialect; an unknown adapter is read as PostgreSQL (the most common shape), then falls back to the simple reader.
const DIALECTS = { postgres: 'postgresql', postgresql: 'postgresql', redshift: 'redshift', snowflake: 'snowflake', bigquery: 'bigquery', mysql: 'mysql', mariadb: 'mariadb', sqlserver: 'transactsql', fabric: 'transactsql', synapse: 'transactsql',
  trino: 'trino', starburst: 'trino', presto: 'trino', athena: 'athena', databricks: 'hive', spark: 'hive', hive: 'hive', duckdb: 'postgresql', sqlite: 'sqlite', db2: 'db2', flink: 'flinksql' };
const dialectOf = (adapter) => DIALECTS[lc(adapter)] || 'postgresql';
let P; // undefined = not tried, null = not installed; STRATA_SQL_PARSER=off forces the simple reader (tests, and an escape hatch)
const parser = () => { if (process.env.STRATA_SQL_PARSER === 'off') return null; if (P === undefined) { try { const { Parser } = require('node-sql-parser'); P = new Parser(); } catch { P = null; } } return P; };
const available = () => !!parser();

// ---------- shared text handling ----------
// comments and jinja out (strings kept whole); ref() / source() / any other {{ }} become __j<n>__ placeholders (the raw text kept in marks)
function prep(sql) {
  const marks = [];
  const s = String(sql || '').replace(/\{#[\s\S]*?#\}/g, ' ').replace(/\{%[\s\S]*?%\}/g, ' ')
    .replace(/'(?:[^']|'')*'|"[^"\n]*"|`[^`\n]*`|\/\*[\s\S]*?\*\/|--[^\n]*/g, (t) => (t[0] === '/' || t[0] === '-' ? ' ' : t))
    .replace(/\{\{-?\s*config\s*\([\s\S]*?\)\s*-?\}\}/g, ' ').replace(/\{\{[\s\S]*?\}\}/g, (t) => { marks.push(t); return ` __j${marks.length - 1}__ `; });
  return { s, marks };
}
// The text with everything inside parentheses and quotes blanked (same length): a regex on it sees only the top level, and its indexes slice the original.
function mask(s) {
  let d = 0, q = null, o = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { o += '\0'; if (ch === q) q = null; }
    else if (ch === "'" || ch === '"' || ch === '`') { q = ch; o += '\0'; }
    else if (ch === '(') o += d++ ? '\0' : '(';
    else if (ch === ')') { if (d > 0) { d--; o += d ? '\0' : ')'; } else o += ')'; }
    else o += d ? '\0' : ch;
  }
  return o;
}
const at = (s, re) => { const m = new RegExp(re.source, 'i').exec(mask(s)); return m ? { index: m.index, end: m.index + m[0].length } : null; };
const cut = (s, re) => { // s split at the top-level matches of re
  const M = mask(s), g = new RegExp(re.source, 'gi'), out = []; let last = 0, m;
  while ((m = g.exec(M))) { out.push(s.slice(last, m.index)); last = m.index + m[0].length; if (!m[0]) g.lastIndex++; }
  return [...out, s.slice(last)];
};
// s split at its top-level UNION / INTERSECT / EXCEPT / MINUS (`select * except (a)` is no set operation: a select must follow)
function branches(s) {
  const M = mask(s), g = /\b(?:union|intersect|except|minus)\b/gi, out = []; let last = 0, m;
  while ((m = g.exec(M))) {
    const rest = s.slice(m.index + m[0].length), k = /^\s*(?:all\b|distinct\b)?\s*(?=select\b|\(\s*(?:select|with)\b)/i.exec(rest);
    if (k) { out.push(s.slice(last, m.index)); last = m.index + m[0].length + k[0].length; }
  }
  return [...out, s.slice(last)];
}
const bare = (s) => { s = s.trim(); for (;;) { const M = mask(s); if (M[0] === '(' && M.indexOf(')') === M.length - 1) s = s.slice(1, -1).trim(); else return s; } };

// ---------- the simple reader (regular expressions) ----------
const ref2 = new RegExp(`(${ID})\\s*\\.\\s*(${ID})`, 'g');
function itemOf(t) {
  t = t.trim();
  let expr = t, alias = null, m = new RegExp(`^([\\s\\S]*?)\\s+as\\s+(${ID})$`, 'i').exec(t);
  if (m) { expr = m[1].trim(); alias = unq(m[2]); }
  else if ((m = /^([\s\S]*[\w)"'\]])\s+([A-Za-z_]\w*)$/.exec(t)) && !KW.test(m[2])) { expr = m[1].trim(); alias = m[2]; } // implicit alias: `sum(x) total`
  const star = new RegExp(`^(?:(${ID})\\s*\\.\\s*)?\\*$`).exec(expr), ref = new RegExp(`^(?:(${ID})\\s*\\.\\s*)?(${ID})$`).exec(expr);
  const col = ref && !KW.test(ref[2]) && !/^__j\d+__$/.test(ref[2]) && !(!ref[1] && NILADIC.test(unq(ref[2]))) ? { rel: ref[1] ? unq(ref[1]) : null, name: unq(ref[2]) } : null;
  const ag = /^(sum|count|avg|min|max)\s*\(\s*(distinct\s+)?([\s\S]*)\)$/i.exec(expr), whole = ag && /^\w+\s*\(\0*\)$/.test(mask(expr));
  const agg = whole ? { fn: ag[1].toLowerCase(), distinct: !!ag[2], arg: ag[3].trim() } : null;
  if (agg) agg.calc = (look) => qualify(agg.arg, look);
  return { expr, alias, name: alias || (col && col.name) || null, star: star ? (star[1] ? unq(star[1]) : true) : null, col, agg };
}
function relOf(t) {
  t = t.trim();
  const on = at(t, /\b(?:on|using)\b/), head = (on ? t.slice(0, on.index) : t).trim(), conds = [];
  if (on && /^on/i.test(t.slice(on.index))) {
    const c = bare(t.slice(on.end));
    for (const p of cut(c, /\band\b/)) {
      const m = new RegExp(`^\\(?\\s*(${ID})\\s*\\.\\s*(${ID})\\s*=\\s*(${ID})\\s*\\.\\s*(${ID})\\s*\\)?$`).exec(p.trim());
      if (m) conds.push({ a: [unq(m[1]), unq(m[2])], b: [unq(m[3]), unq(m[4])] });
    }
  }
  if (head[0] === '(') {
    const close = head.lastIndexOf(')'), al = new RegExp(`^(?:as\\s+)?(${ID})`, 'i').exec(head.slice(close + 1).trim());
    return { sub: selectOf(head.slice(1, close)), alias: al ? unq(al[1]) : null, on: conds };
  }
  const m = new RegExp(`^(${ID}(?:\\s*\\.\\s*${ID})*)(?:\\s+(?:as\\s+)?(${ID}))?$`, 'i').exec(head);
  if (!m) return null;
  const parts = m[1].split(/\s*\.\s*/).map(unq);
  return { parts, alias: m[2] ? unq(m[2]) : parts[parts.length - 1], on: conds };
}
// one select, without its set-operation branches -> sel | null
function oneSelect(s) {
  s = bare(s);
  const i = at(s, /\bselect\b/);
  if (!i) return null;
  const body = s.slice(i.end), f = at(body, /\bfrom\b/), head = (f ? body.slice(0, f.index) : body).replace(/^\s*(?:distinct|all)\b\s*/i, '');
  let from = f ? body.slice(f.end) : '';
  const e = at(from, /\b(?:where|group\s+by|order\s+by|having|limit|qualify|window|offset|fetch)\b/);
  if (e) from = from.slice(0, e.index);
  const all = from.trim() ? cut(from, /,|\b(?:natural\s+)?(?:(?:inner|left|right|full|cross)\s+)?(?:outer\s+)?join\b|\blateral\b/).map(relOf) : [], rels = all.filter(Boolean);
  const items = cut(head, /,/).filter((x) => x.trim()).map(itemOf), refs = [];
  const tail = f ? body.slice(f.end) : '', w = at(tail, /\bwhere\b/), gbm = at(tail, /\bgroup\s+by\b/);
  const clip = (t) => { const e2 = at(t, /\b(?:group\s+by|order\s+by|having|limit|qualify|window|offset|fetch|union|intersect|except)\b/); return (e2 ? t.slice(0, e2.index) : t).trim(); };
  const tx = (t) => ({ expr: t, calc: (look) => qualify(t, look) });
  const JOINEQ = new RegExp(`^\\(?\\s*${ID}\\s*\\.\\s*${ID}\\s*=\\s*${ID}\\s*\\.\\s*${ID}\\s*\\)?$`), keep = w ? cut(clip(tail.slice(w.end)), /\band\b/).map((x) => x.trim()).filter((x) => x && !JOINEQ.test(x)) : [];
  const filter = keep.length ? tx(keep.join(' and ')) : null;
  const group = gbm ? cut(clip(tail.slice(gbm.end)), /,/).map((x) => x.trim()).filter(Boolean).map((x) => { const it = /^\d+$/.test(x) ? items[+x - 1] : items.find((y) => y.alias && lc(y.alias) === lc(x)); return tx(it && it.expr ? it.expr : x); }) : [];
  for (const it of items) { if (it.col) refs.push(it.col); for (const m of it.expr.matchAll(ref2)) refs.push({ rel: unq(m[1]), name: unq(m[2]) }); }
  return { items, from: rels, rest: [], subs: [], refs, aliases: new Set(items.map((x) => lc(x.alias)).filter(Boolean)), where: [], partial: rels.length !== all.length, filter, group };
}
// the first branch, the others in .rest
function selectOf(s) {
  const [first, ...more] = branches(s), sel = oneSelect(first);
  if (sel) sel.rest = more.map(oneSelect).filter(Boolean);
  return sel;
}
function simple(s, marks) {
  const ctes = [];
  let rest = s;
  const w = /^\s*with\b(?:\s+recursive\b)?/i.exec(s);
  if (w) {
    const M = mask(s), head = new RegExp(`\\s*(${ID})\\s*(?:\\([^)]*\\))?\\s+as\\s*(?:not\\s+materialized\\s*|materialized\\s*)?\\(`, 'iy');
    let p = w[0].length;
    for (;;) {
      head.lastIndex = p;
      const m = head.exec(s);
      if (!m) break;
      const open = m.index + m[0].length - 1, close = M.indexOf(')', open);
      if (close < 0) break;
      ctes.push({ name: unq(m[1]), sel: selectOf(s.slice(open + 1, close)) });
      p = close + 1;
      const comma = /^\s*,/.exec(s.slice(p));
      if (!comma) break;
      p += comma[0].length;
    }
    rest = s.slice(p);
  }
  return { ctes, main: selectOf(rest), marks, via: 'simple', warn: new Set() };
}

// ---------- the parser reader (node-sql-parser AST) ----------
const S = (x) => (x == null ? null : typeof x === 'object' ? (x.expr ? S(x.expr) : x.value != null ? String(x.value) : null) : String(x));
const IDENT_QUOTES = /^(?:postgresql|redshift|snowflake|transactsql|trino|athena|sqlite|db2|flinksql)$/; // a "double quoted" word is an identifier here (a string in MySQL, BigQuery, Hive)
const isCol = (e, ctx) => { // a column reference (not a star, a jinja placeholder or a niladic function); a "double quoted" word too where that is an identifier
  if (!e || !((e.type === 'column_ref' && e.column !== '*') || (e.type === 'double_quote_string' && IDENT_QUOTES.test(ctx.dialect)))) return false;
  const name = e.type === 'column_ref' ? S(e.column) : String(e.value);
  return !/^__j\d+__$/.test(name) && !(e.type === 'column_ref' && !e.table && NILADIC.test(name));
};
const colOf = (e) => (e.type === 'column_ref' ? { rel: S(e.table), name: S(e.column) } : { rel: null, name: String(e.value) });
const eqs = (e, ctx, out) => { // the a.x = b.y equalities an AND chain is made of
  if (!e || e.type !== 'binary_expr') return;
  const op = String(e.operator).toUpperCase();
  if (op === 'AND') { eqs(e.left, ctx, out); eqs(e.right, ctx, out); }
  else if (op === '=' && isCol(e.left, ctx) && isCol(e.right, ctx)) { const a = colOf(e.left), b = colOf(e.right); if (a.rel && b.rel) out.push({ a: [a.rel, a.name], b: [b.rel, b.name] }); }
};
// the columns an expression reads and the sub-selects inside it (found anywhere in the tree; a sub-select is not descended into, selOf reads it)
function scan(o, ctx, scope, out) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { for (const x of o) scan(x, ctx, scope, out); return; }
  if (o.type === 'select') { out.subs.push(select(o, scope, ctx)); return; }
  if (isCol(o, ctx)) { out.refs.push(colOf(o)); return; }
  if (o.type === 'column_ref') return; // a star
  for (const k in o) if (k !== 'tableList' && k !== 'columnList' && k !== 'loc') scan(o[k], ctx, scope, out);
}
// an expression as text with every column replaced by fn(rel, name) (null = give up); null for anything it does not know, so no calculation is ever invented
function render(e, fn, ctx) {
  const R = (x) => render(x, fn, ctx), wrap = (t) => (t == null ? null : e.parentheses ? `(${t})` : t);
  if (!e || typeof e !== 'object') return null;
  switch (e.type) {
    case 'column_ref': case 'double_quote_string': { if (!isCol(e, ctx)) return null; const c = colOf(e); return /^[A-Za-z_]\w*$/.test(c.name) ? fn(c.rel, c.name) : null; }
    case 'number': return String(e.value);
    case 'bool': return e.value ? 'TRUE' : 'FALSE';
    case 'null': return 'NULL';
    case 'single_quote_string': case 'string': return `'${String(e.value).replace(/'/g, "''")}'`;
    case 'binary_expr': {
      const l = R(e.left), r = R(e.right), op = String(e.operator).toUpperCase();
      if (l == null || r == null) return null;
      if (/BETWEEN$/.test(op) && e.right && e.right.type === 'expr_list') { const [a, b] = (e.right.value || []).map(R); return a == null || b == null ? null : wrap(`${l} ${op} ${a} AND ${b}`); }
      return wrap(`${l} ${op} ${/IN$/.test(op) && e.right && e.right.type === 'expr_list' ? `(${r})` : r}`);
    }
    case 'unary_expr': { const x = R(e.expr); return x == null ? null : wrap(`${e.operator} ${x}`); }
    case 'cast': { const t = typeText(e); const x = R(e.expr); return t && x != null ? wrap(`CAST(${x} AS ${t})`) : null; }
    case 'expr_list': { const v = (e.value || []).map(R); return v.includes(null) ? null : v.join(', '); }
    case 'function': {
      const name = e.name && (e.name.name || []).map((x) => x.value).join('.'), a = e.args ? R(e.args) : '';
      return name && a != null && /^[\w.]+$/.test(name) ? wrap(`${name}(${a})`) : null;
    }
    case 'case': {
      let out = 'CASE' + (e.expr ? ' ' + R(e.expr) : '');
      for (const w of e.args || []) {
        if (w.type === 'when') { const c = R(w.cond), r = R(w.result); if (c == null || r == null) return null; out += ` WHEN ${c} THEN ${r}`; }
        else { const r = R(w.result); if (r == null) return null; out += ` ELSE ${r}`; }
      }
      return wrap(out + ' END');
    }
    default: return null;
  }
}
function typeText(e) { // a cast's target type as text: NUMERIC(10,2)
  const t = [].concat(e.target || [])[0];
  return t && t.dataType && /^[A-Za-z_][\w ]*$/.test(t.dataType) ? String(t.dataType).toUpperCase() + (t.length != null ? `(${t.length}${t.scale != null ? ',' + t.scale : ''})` : '') : null;
}
function itemAst(c, ctx, scope, sel) {
  const e = c.expr, alias = S(c.as);
  if (e && e.type === 'column_ref' && e.column === '*') { // `*`, `t.*`, BigQuery `* except (a, b)`, Snowflake `* exclude (a, b)`; any other modifier (rename, replace, ilike) is not understood: no columns rather than wrong ones
    const star = e.table ? S(e.table) : true, names = (l) => (l || []).map((x) => S((x.expr || x).column)).filter(Boolean);
    if (c.type === 'except') return { expr: '*', alias: null, name: null, star, exclude: new Set(names(c.expr_list).map(lc)), col: null, agg: null };
    if (e.suffix) return String(S((e.suffix.name || {}).name && e.suffix.name.name[0])).toLowerCase() === 'exclude' ? { expr: '*', alias: null, name: null, star, exclude: new Set(names(e.suffix.args && e.suffix.args.value).map(lc)), col: null, agg: null } : { expr: '*', alias: null, name: null, star: null, col: null, agg: null };
    return { expr: '*', alias: null, name: null, star, col: null, agg: null };
  }
  const col = isCol(e, ctx) ? colOf(e) : null, item = { expr: '', alias, name: alias || (col && col.name) || null, star: null, col, agg: null };
  if (e && e.type === 'cast') { const t = typeText(e); if (t) item.type = t; }
  if (e && e.type === 'aggr_func' && !e.over && AGGS.has(String(e.name).toUpperCase())) {
    const a = e.args || {}, star = a.expr && a.expr.type === 'star';
    item.agg = { fn: String(e.name).toLowerCase(), distinct: a.distinct === 'DISTINCT', arg: star ? '*' : '', calc: (look) => (star ? null : render(a.expr, (rel, name) => { const k = look(rel, name); return k == null ? null : `${k}.${name}`; }, ctx)) };
    if (!star) item.agg.arg = render(a.expr, (rel, name) => (rel ? rel + '.' : '') + name, ctx) || '';
    item.expr = `${item.agg.fn}(${a.distinct === 'DISTINCT' ? 'distinct ' : ''}${item.agg.arg})`;
  } else item.expr = col ? (col.rel ? col.rel + '.' : '') + col.name : '';
  const found = { refs: sel.refs, subs: sel.subs };
  if (e) scan(e, ctx, scope, found);
  return item;
}
function relAst(f, scope, ctx, sel) {
  const on = [];
  if (f.on) { eqs(f.on, ctx, on); scan(f.on, ctx, scope, { refs: [], subs: sel.subs }); }
  const sub = f.expr && (f.expr.ast && f.expr.ast.type === 'select' ? f.expr.ast : f.expr.type === 'select' ? f.expr : null);
  if (sub) return { sub: select(sub, scope, ctx), alias: S(f.as), on, scope };
  if (f.type === 'dual') return null;
  if (f.table == null || f.expr) { ctx.warn.add('relation'); return null; } // a table function, VALUES, UNNEST, LATERAL over a function: no table to read
  let parts = (f.schema != null ? [f.db, f.schema, f.table] : [f.db, f.table]).filter((x) => x != null).map(S);
  if (f.surround && f.surround.table === '`') parts = parts.flatMap((x) => x.split('.')); // BigQuery: `project.dataset.table` in one pair of backticks
  return { parts, alias: S(f.as) || parts[parts.length - 1], on, scope, using: (f.using || []).map(S) };
}
// one select without its set-operation chain; scope = the CTEs visible to it (lower-case name -> sel)
function branch(s, scope, ctx) {
  const sel = { items: [], from: [], rest: [], subs: [], refs: [], aliases: new Set(), where: [], ctes: [] };
  if (s.with && s.with.length) { [scope, sel.ctes] = withAst(s.with, scope, ctx); }
  const cols = s.columns === '*' ? [{ expr: { type: 'column_ref', column: '*' } }] : s.columns || [];
  for (const c of cols) sel.items.push(itemAst(c, ctx, scope, sel));
  sel.aliases = new Set(sel.items.map((x) => lc(x.alias)).filter(Boolean));
  const list = [].concat(s.from || []);
  for (const f of list) { const r = relAst(f, scope, ctx, sel); if (r) sel.from.push(r); else if (f.type !== 'dual') sel.partial = true; }
  sel.from.forEach((r, i) => { if (r.using && r.using.length && i === 1) for (const c of r.using) r.on.push({ a: [sel.from[0].alias, c], b: [r.alias, c] }); }); // USING (id): joins the two relations when there are only two
  for (const k of ['where', 'having', 'groupby', 'qualify']) if (s[k]) scan(s[k], ctx, scope, sel);
  eqs(s.where, ctx, sel.where);
  // the WHERE and GROUP BY as text (ADR-0051): {expr: as written with the aliases, calc(look) -> the same with every column as <key>.<column> | null}
  const plain = (rel, name) => (rel ? rel + '.' : '') + name, textOf = (e) => ({ expr: render(e, plain, ctx), calc: (look) => render(e, (rel, name) => { const k = look(rel, name); return k == null ? null : `${k}.${name}`; }, ctx) });
  // the filter leaves out the a.x = b.y equalities (old-style joins): they are joins, not filters
  const conj = (e, out) => { if (e && e.type === 'binary_expr' && String(e.operator).toUpperCase() === 'AND') { conj(e.left, out); conj(e.right, out); } else out.push(e); return out; };
  const isJoin = (e) => e.type === 'binary_expr' && e.operator === '=' && isCol(e.left, ctx) && isCol(e.right, ctx) && colOf(e.left).rel && colOf(e.right).rel;
  const fl = s.where ? conj(s.where, []).filter((e) => !isJoin(e)).map(textOf) : [];
  if (fl.length) sel.filter = { expr: fl.map((f) => (f.expr == null ? '(not readable)' : f.expr)).join(' AND '), calc: (look) => { const t = fl.map((f) => f.calc(look)); return t.includes(null) ? null : t.join(' AND '); } };
  const gb = s.groupby && (s.groupby.columns || s.groupby);
  if (gb) sel.group = [].concat(gb).filter(Boolean).map((g) => {
    const byAlias = g.type === 'column_ref' && !g.table && cols.find((c) => S(c.as) && lc(S(c.as)) === lc(S(g.column)));
    return textOf(g.type === 'number' && cols[g.value - 1] ? cols[g.value - 1].expr : byAlias ? byAlias.expr : g);
  }).filter((g) => g.expr);
  return sel;
}
function select(s, scope, ctx) {
  const sel = branch(s, scope, ctx);
  for (let n = s._next; n; n = n._next) sel.rest.push(branch(n, scope, ctx));
  return sel;
}
function withAst(list, scope, ctx) { // -> [scope after the WITH, [{name, sel}]]
  const out = [];
  for (const w of list) {
    const name = S(w.name), st = (w.stmt && w.stmt.ast) || w.stmt, inner = w.recursive ? new Map(scope) : scope, sel = select(st, inner, ctx);
    if (w.columns && w.columns.length && sel.items.length === w.columns.length && !sel.items.some((x) => x.star)) sel.items.forEach((x, i) => { x.name = x.alias = S(w.columns[i]); }); // WITH r(x, y) AS (...) renames the columns
    scope = new Map(inner).set(lc(name), sel);
    if (w.recursive) inner.set(lc(name), sel);
    out.push({ name, sel });
  }
  return [scope, out];
}
function viaParser(p, s, marks, dialect) {
  const ast = p.astify(s, { database: dialect }), ctx = { dialect, parser: p, warn: new Set() };
  const list = [].concat(ast).filter((x) => x && x.type === 'select');
  if (!list.length) return { ctes: [], main: null, marks, via: 'parser', warn: ctx.warn, notSelect: true };
  const st = list[0];
  let scope = new Map(), ctes = [];
  if (st.with && st.with.length) [scope, ctes] = withAst(st.with, scope, ctx);
  return { ctes, main: select({ ...st, with: null }, scope, ctx), marks, via: 'parser', warn: ctx.warn };
}

// ---------- the front door ----------
// o: {dialect, cache (Map, one per import: the same SQL is read once)}
function analyse(sql, o = {}) {
  const { s, marks } = prep(sql);
  if (s.length > MAX) return { ctes: [], main: null, marks, via: 'skipped', reason: `the SQL is ${Math.round(s.length / 1000)} kB (limit ${MAX / 1000} kB)`, warn: new Set() };
  const key = o.cache && (o.dialect || '') + '\0' + s;
  if (key && o.cache.has(key)) return { ...o.cache.get(key), marks };
  let a, p = o.dialect && s.length <= PARSER_MAX && parser(), error = null;
  if (p) { try { a = viaParser(p, s, marks, o.dialect); } catch (err) { error = err.location ? `line ${err.location.start.line}, column ${err.location.start.column}` : String(err.message).slice(0, 80); } }
  if (!a) { a = simple(s, marks); if (error) a.error = error; if (!p && o.dialect) { if (s.length > PARSER_MAX) a.large = true; else a.noParser = true; } }
  if (key) o.cache.set(key, a);
  return a;
}

// every select of an analysis: the main one and every branch, the CTEs (also nested ones), the sub-selects in FROM and in expressions
function allSels(a) {
  const out = [];
  const walk = (sel) => {
    if (!sel) return;
    out.push(sel);
    for (const c of sel.ctes || []) walk(c.sel);
    for (const r of sel.from) walk(r.sub);
    for (const b of sel.rest) walk(b);
    for (const x of sel.subs || []) walk(x);
  };
  for (const c of a.ctes) walk(c.sel);
  walk(a.main);
  return out;
}
// the a.x = b.y equalities of a select: its JOIN ... ON conditions and (old-style joins) its WHERE
const conds = (sel) => [...sel.from.flatMap((r) => r.on), ...(sel.where || [])];

// Rewrites the columns an expression reads as `<key>.<column>`; look(relation | null, column) -> key | null. null when a name cannot be resolved
// (or the text is not a plain expression), so a caller never invents a reference. (Text version, for the simple reader.)
function qualify(expr, look) {
  let bad = false;
  const out = String(expr).replace(/'(?:[^']|'')*'|"[^"]*"|::\s*\w+|\d[\w.]*|([A-Za-z_][\w$]*)(?:\s*\.\s*([A-Za-z_][\w$]*))?(\s*\()?/g, (t, a, b, call) => {
    if (a === undefined) { if (t[0] === '"') bad = true; return t; }
    if (call) return t;
    if (b !== undefined) { const k = look(a, b); if (k == null) bad = true; return k == null ? t : `${k}.${b}`; }
    if (WORDS.has(a.toLowerCase())) return t;
    const k = look(null, a);
    if (k == null) bad = true;
    return k == null ? t : `${k}.${a}`;
  });
  return bad ? null : out;
}

module.exports = { analyse, allSels, conds, qualify, dialectOf, available, ID, unq, MAX, PARSER_MAX };
