// Reading SQL scripts (change 33, ADR-0051): the statements of a DDL / DML script as a neutral in-memory database, for lib/sqlimport.js. Node only, no vscode import,
// NO dependencies: the DDL reader is hand-written (one tolerant reader for all eleven dialects instead of eleven parser dialects that each reject something), and
// it never calls node-sql-parser; SELECTs are handed to lib/dbtsql.js, which stays the only file that does (ADR-0050).
//   split(text, dialect)  -> [{sql, line, col}]: one entry per statement. Knows quotes, comments, dollar quoting, `DELIMITER`, `GO`, Oracle's `/`, psql's `\` lines and
//                            COPY ... FROM stdin data, MySQL's /*!50001 ... */ wrappers, and keeps the body of a procedure, function or trigger in one piece.
//   detect(text)          -> {dialect, scores}: cheap heuristics over the start of the text
//   read(text, file, S)   -> reads every statement into the shared state S (see state()): tables, views, columns, constraints, indexes, comments, schemas, the SELECTs
//                            of views / CREATE TABLE AS / INSERT ... SELECT / MERGE / UPDATE ... FROM / plain queries (`S.dml`), INSERT ... VALUES rows (`S.samples`)
// What is not understood is never guessed: it is kept as a `sql_*` property (clauses, options), or counted and named in `S.skipped`, or reported in `S.notes` with line and column.
const lc = (s) => String(s == null ? '' : s).toLowerCase();

// ---------- dialects ----------
const DIALECTS = ['postgres', 'mysql', 'sqlserver', 'oracle', 'snowflake', 'bigquery', 'databricks', 'trino', 'sqlite', 'duckdb', 'redshift'];
const ALIAS = { postgresql: 'postgres', pg: 'postgres', tsql: 'sqlserver', 't-sql': 'sqlserver', mssql: 'sqlserver', 'sql server': 'sqlserver', 'transact-sql': 'sqlserver', mariadb: 'mysql', spark: 'databricks', hive: 'databricks', presto: 'trino', athena: 'trino', 'google bigquery': 'bigquery', 'trino/presto': 'trino' };
const dialectId = (d) => { d = lc(d).trim(); d = ALIAS[d] || d; return DIALECTS.includes(d) ? d : null; };
// dialect -> Strata platform (SM.PLATFORMS); Redshift is PostgreSQL-like and has no platform of its own
const PLATFORM = { postgres: 'PostgreSQL', redshift: 'PostgreSQL', mysql: 'MySQL', sqlserver: 'SQL Server', oracle: 'Oracle', snowflake: 'Snowflake', bigquery: 'Google BigQuery', databricks: 'Databricks', trino: 'Trino/Presto', sqlite: 'SQLite', duckdb: 'DuckDB' };
const LABEL = { postgres: 'PostgreSQL', redshift: 'Amazon Redshift', mysql: 'MySQL / MariaDB', sqlserver: 'SQL Server (T-SQL)', oracle: 'Oracle', snowflake: 'Snowflake', bigquery: 'Google BigQuery', databricks: 'Databricks / Spark / Hive', trino: 'Trino / Presto / Athena', sqlite: 'SQLite', duckdb: 'DuckDB' };
const SIGNS = { // [pattern, weight]: what each dialect's scripts tend to contain
  sqlserver: [[/^[ \t]*GO[ \t]*$/im, 3], [/\[\w+\]\.\[\w+\]/, 3], [/\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i, 3], [/\bNVARCHAR\b|\bVARCHAR\(MAX\)/i, 2], [/\bSET\s+ANSI_NULLS\b|\bSET\s+QUOTED_IDENTIFIER\b/i, 3], [/\bCLUSTERED\b/i, 2], [/\bUNIQUEIDENTIFIER\b|\bDATETIME2\b|\bSMALLDATETIME\b/i, 2], [/\bsp_addextendedproperty\b/i, 3], [/\bTEXTIMAGE_ON\b|\bON\s+\[PRIMARY\]/i, 2]],
  mysql: [[/\bENGINE\s*=\s*\w+/i, 3], [/\bAUTO_INCREMENT\b/i, 3], [/\/\*!\d{5}/, 3], [/\bUNLOCK TABLES\b|\bLOCK TABLES\b/i, 2], [/`\w+`/, 1], [/\bDEFAULT CHARSET\b|\bCHARACTER SET\b/i, 2], [/\b(?:TINYINT|MEDIUMINT|LONGTEXT|MEDIUMTEXT)\b/i, 2], [/\bUNSIGNED\b/i, 1], [/^DELIMITER\s/im, 2]],
  postgres: [[/\bSERIAL\b|\bBIGSERIAL\b/i, 2], [/::\s*\w+/, 2], [/\bpg_catalog\b/i, 3], [/\bFROM stdin;/i, 3], [/\bCREATE EXTENSION\b/i, 3], [/\bOWNER TO\b/i, 2], [/\$\$|\$\w+\$/, 1], [/\bplpgsql\b/i, 2], [/\bSET search_path\b/i, 2], [/\bwithout time zone\b|\bcharacter varying\b/i, 2], [/\bBYTEA\b|\bJSONB\b/i, 2]],
  redshift: [[/\bDISTKEY\b|\bSORTKEY\b|\bDISTSTYLE\b/i, 4], [/\bENCODE\s+\w+/i, 3], [/\bBACKUP\s+(?:YES|NO)\b/i, 2]],
  snowflake: [[/\bCLUSTER BY\b/i, 1], [/\bVARIANT\b|\bTIMESTAMP_NTZ\b|\bTIMESTAMP_LTZ\b/i, 3], [/\bNUMBER\(\s*38\s*,\s*0\s*\)/i, 3], [/\bCREATE OR REPLACE TRANSIENT\b|\bTRANSIENT TABLE\b/i, 3], [/\bCOMMENT\s*=\s*'/i, 1], [/\bDATA_RETENTION_TIME_IN_DAYS\b|\bUSE\s+WAREHOUSE\b|\bCREATE\s+WAREHOUSE\b|\bWAREHOUSE\s*=/i, 3], [/\bGET_DDL\b|\bCOPY INTO\b/i, 3], [/\bSECURE VIEW\b/i, 2]],
  bigquery: [[/\bINT64\b|\bFLOAT64\b|\bBYTES\b|\bBOOL\b/i, 3], [/`[\w-]+\.[\w-]+\.[\w-]+`/, 3], [/\bOPTIONS\s*\(/i, 2], [/\bSTRUCT</i, 2], [/\bPARTITION BY\b/i, 1], [/\bNOT ENFORCED\b/i, 2], [/\bCREATE (?:OR REPLACE )?SNAPSHOT\b/i, 1]],
  databricks: [[/\bUSING\s+(?:DELTA|PARQUET|ORC|CSV|JSON)\b/i, 4], [/\bTBLPROPERTIES\b/i, 3], [/\bPARTITIONED BY\b/i, 2], [/\bSTORED AS\b/i, 2], [/\bLOCATION\s+'/i, 2], [/\bSTRING\b/i, 1], [/\bdelta\./i, 2], [/\bCREATE (?:OR REPLACE )?(?:CATALOG|EXTERNAL TABLE)\b/i, 1]],
  oracle: [[/\bVARCHAR2\b|\bNVARCHAR2\b/i, 4], [/\bNUMBER\s*\(/i, 2], [/\bTABLESPACE\b/i, 2], [/\bPCTFREE\b|\bSTORAGE\s*\(/i, 3], [/\bDBMS_\w+/i, 3], [/\bENABLE\b\s*;/i, 1], [/^\/[ \t]*$/m, 2], [/\bCLOB\b|\bBLOB\b|\bRAW\(/i, 1], [/\bSYSDATE\b/i, 2]],
  sqlite: [[/\bAUTOINCREMENT\b/i, 3], [/\bWITHOUT ROWID\b/i, 4], [/\bPRAGMA\b/i, 3], [/\bsqlite_sequence\b/i, 4]],
  duckdb: [[/\bCREATE SEQUENCE\b.*\bnextval\b/i, 1], [/\bread_csv|\bread_parquet\b/i, 4], [/\bUBIGINT\b|\bHUGEINT\b|\bUTINYINT\b/i, 4]],
  trino: [[/\bWITH\s*\(\s*format\s*=/i, 4], [/\bhive\.\w+\.\w+/i, 2], [/\bVARCHAR\b(?!\s*\()/i, 1], [/\bROW\(/i, 1]],
};
function detect(text) {
  const s = String(text).slice(0, 400000), scores = {};
  for (const [d, list] of Object.entries(SIGNS)) { let n = 0; for (const [re, w] of list) if (re.test(s)) n += w; scores[d] = n; }
  const hdr = /^-- Generated from .* for (\w+)\s*$/m.exec(s); // Strata SQL's own DDL generator says which dialect it wrote
  if (hdr && scores[hdr[1].toLowerCase()] !== undefined) scores[hdr[1].toLowerCase()] += 10;
  const order = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, second] = order;
  return { dialect: top[1] > 0 ? top[0] : 'postgres', scores, confident: top[1] > 0 && top[1] - second[1] >= 2 };
}

// ---------- splitting ----------
const BSESC = new Set(['mysql', 'bigquery', 'databricks', 'snowflake', 'redshift']); // backslash escapes in '...'
const DQSTR = new Set(['mysql', 'bigquery', 'databricks']); // "..." is a string here, an identifier elsewhere
const DOLLAR = new Set(['postgres', 'redshift', 'snowflake', 'duckdb']);
const PROC = /^(?:create|alter)\s+(?:or\s+(?:replace|alter)\s+)?(?:(?:definer\s*=\s*\S+|algorithm\s*=\s*\w+|sql\s+security\s+\w+|editionable|noneditionable|secure)\s+)*(?:procedure|proc|function|trigger|package|type\s+body|event|aggregate)\b/i;
const ANON = /^(?:declare\b|begin\b(?!\s*(?:tran\b|transaction\b|work\b|;|isolation\b|deferred\b|immediate\b|exclusive\b|read\b|distributed\b)))/i;
const DIRECTIVE = /^[ \t]*(?:(go)(?:[ \t]+\d+)?[ \t]*(?:--[^\n]*)?|delimiter[ \t]+(\S+)[^\n]*|(\/)[ \t]*|(\\)[^\n]*)(?:\r?\n|$)/i;
// -> {stmts: [{sql, line, col}], copies: n (COPY ... FROM stdin data blocks skipped)}
function split(src, d) {
  const out = [], n = src.length, bs = BSESC.has(d), dq = DQSTR.has(d), dol = DOLLAR.has(d), my = d === 'mysql', wordCh = /[\w$]/;
  let i = 0, line = 1, ls = 0, st = -1, sl = 0, sc = 0, delim = ';', proc = false, blocks = [], unwrap = 0, copies = 0, wrapped = false; // blocks: the BEGIN / CASE that are still open in a procedure body
  // a statement that was split over MySQL's /*!50001 ... */ wrappers: the wrapper text goes, real comments stay (the lexer skips them)
  const unwrapped = (t) => t.replace(/\/\*(?!M?!)[\s\S]*?\*\/|\/\*M?!\d*|\*\//g, (m) => (m.startsWith('/*') && !/^\/\*M?!/.test(m) && m.endsWith('*/') ? m : ' '));
  const end = (to) => { if (st >= 0) { let sql = src.slice(st, to).trim(); if (wrapped) sql = unwrapped(sql).trim(); if (sql) out.push({ sql, line: sl, col: sc }); st = -1; } proc = false; blocks = []; wrapped = false; };
  const nl = (j) => { line++; ls = j + 1; };
  const directive = () => { // a line that is not SQL: GO, DELIMITER, /, or a psql \ command between statements
    const c0 = src.charCodeAt(i);
    if (!(c0 === 71 || c0 === 103 || c0 === 68 || c0 === 100 || c0 === 47 || c0 === 92 || c0 === 32 || c0 === 9)) return false;
    const m = DIRECTIVE.exec(src.slice(i, i + 300));
    if (!m || (m[4] && st >= 0)) return false;
    if (m[4] === undefined) end(i);
    if (m[2]) delim = m[2];
    i += m[0].length; if (/\n$/.test(m[0])) nl(i - 1);
    return true;
  };
  while (directive());
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c <= 32) { i++; if (c === 10) { nl(i - 1); while (directive()); } continue; }
    const ch = src[i], c2 = src[i + 1];
    if ((ch === '-' && c2 === '-') || (my && ch === '#')) { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (ch === '/' && c2 === '*') {
      if (my && (src[i + 2] === '!' || (src[i + 2] === 'M' && src[i + 3] === '!'))) { i += /^\/\*M?!\d*/.exec(src.slice(i, i + 12))[0].length; unwrap++; wrapped = true; continue; }
      let dep = 1, j = i + 2;
      while (j < n && dep) { if (src[j] === '/' && src[j + 1] === '*' && !my) { dep++; j += 2; } else if (src[j] === '*' && src[j + 1] === '/') { dep--; j += 2; } else { if (src[j] === '\n') nl(j); j++; } }
      i = j; continue;
    }
    if (ch === '*' && c2 === '/' && unwrap > 0) { unwrap--; i += 2; continue; }
    if (st < 0) { st = i; sl = line; sc = i - ls + 1; const head = src.slice(i, i + 200); proc = PROC.test(head) || ANON.test(head); blocks = []; }
    if (ch === "'" || (ch === '"' && dq)) {
      const esc = bs || (ch === "'" && /[Ee]/.test(src[i - 1] || '') && !wordCh.test(src[i - 2] || ' '));
      let j = i + 1;
      while (j < n) { const x = src.charCodeAt(j); if (x === 92 && esc) { if (src.charCodeAt(j + 1) === 10) nl(j + 1); j += 2; } else if (x === ch.charCodeAt(0)) { if (src.charCodeAt(j + 1) === x) j += 2; else break; } else { if (x === 10) nl(j); j++; } }
      i = j + 1; continue;
    }
    if (ch === '"' || ch === '`' || (ch === '[' && d === 'sqlserver')) {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < n) { if (src[j] === close) { if (src[j + 1] === close) j += 2; else break; } else { if (src[j] === '\n') nl(j); j++; } }
      i = j + 1; continue;
    }
    if (ch === '$' && dol && !wordCh.test(src[i - 1] || ' ')) {
      const m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(src.slice(i, i + 80));
      if (m) { let j = src.indexOf(m[0], i + m[0].length); j = j < 0 ? n : j + m[0].length; for (let k = i; k < j; k++) if (src.charCodeAt(k) === 10) nl(k); i = j; continue; }
    }
    if (delim === ';' ? ch === ';' : src.startsWith(delim, i)) {
      if (proc && delim === ';' && blocks.length) { i += delim.length; continue; }
      end(i); i += delim.length;
      const last = out[out.length - 1];
      if (last && last.line === sl && /^copy\b[\s\S]*\bfrom\s+stdin\b/i.test(last.sql)) { // COPY ... FROM stdin: the rows follow, up to a line with \.
        const k = src.indexOf('\n\\.', i); const to = k < 0 ? n : k + 3;
        for (let q = i; q < to; q++) if (src.charCodeAt(q) === 10) nl(q);
        i = to; copies++;
      }
      continue;
    }
    if (proc && /[A-Za-z_]/.test(ch) && !wordCh.test(src[i - 1] || ' ')) { // BEGIN ... END nesting, so the `;` inside a body does not end the statement
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 40)), w = m[0].toUpperCase(), after = /^\s+([A-Za-z_]\w*)/.exec(src.slice(i + m[0].length, i + m[0].length + 40));
      const nx = after ? after[1].toUpperCase() : '';
      i += m[0].length;
      if (w === 'BEGIN' && !/^TRAN(SACTION)?$/.test(nx)) blocks.push('B');
      else if (w === 'CASE') blocks.push('C');
      else if (w === 'END' && !/^(IF|LOOP|WHILE|REPEAT|FOR)$/.test(nx) && blocks.pop() === 'B' && !blocks.length && d === 'sqlserver') end(i); // T-SQL without GO: the block is the procedure
      continue;
    }
    i++;
  }
  end(n);
  return { stmts: out, copies };
}

// ---------- tokens ----------
const WORD = /[A-Za-z_@#\u0080-\uffff][\w$@#\u0080-\uffff]*/y, NUM = /\d[\w.]*|\.\d\w*/y;
function lex(s, d) {
  const T = [], n = s.length, bs = BSESC.has(d), dq = DQSTR.has(d), my = d === 'mysql', dol = DOLLAR.has(d);
  let i = 0;
  const push = (k, v, at, e) => T.push({ k, v, u: k === 'w' ? v.toUpperCase() : undefined, at, end: e });
  while (i < n) {
    const ch = s[i], c2 = s[i + 1];
    if (ch <= ' ') { i++; continue; }
    if ((ch === '-' && c2 === '-') || (my && ch === '#')) { const j = s.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (ch === '/' && c2 === '*') {
      if (my && (s[i + 2] === '!' || (s[i + 2] === 'M' && s[i + 3] === '!'))) { i += /^\/\*M?!\d*/.exec(s.slice(i, i + 12))[0].length; continue; }
      let dep = 1, j = i + 2;
      while (j < n && dep) { if (s[j] === '/' && s[j + 1] === '*' && !my) { dep++; j += 2; } else if (s[j] === '*' && s[j + 1] === '/') { dep--; j += 2; } else j++; }
      i = j; continue;
    }
    if (ch === '*' && c2 === '/') { i += 2; continue; } // the end of a /*! ... */ wrapper
    if (ch === "'" || (ch === '"' && dq)) {
      const esc = bs || (ch === "'" && /[Ee]/.test(s[i - 1] || '') && !/[\w$]/.test(s[i - 2] || ' '));
      let j = i + 1;
      while (j < n) { const x = s[j]; if (x === '\\' && esc) j += 2; else if (x === ch) { if (s[j + 1] === ch) j += 2; else break; } else j++; }
      push('s', s.slice(i, j + 1), i, Math.min(j + 1, n)); i = j + 1; continue;
    }
    if (ch === '"' || ch === '`' || (ch === '[' && d === 'sqlserver')) {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1, v = '';
      while (j < n) { if (s[j] === close) { if (s[j + 1] === close) { v += close; j += 2; continue; } break; } v += s[j++]; }
      push('i', v, i, Math.min(j + 1, n)); i = j + 1; continue;
    }
    if (ch === '$' && dol && !/[\w$]/.test(s[i - 1] || ' ')) {
      const m = /^\$(?:[A-Za-z_]\w*)?\$/.exec(s.slice(i, i + 80));
      if (m) { let j = s.indexOf(m[0], i + m[0].length); j = j < 0 ? n : j + m[0].length; push('s', s.slice(i, j), i, j); i = j; continue; }
    }
    WORD.lastIndex = i;
    let m = WORD.exec(s);
    if (m && !(my && ch === '#')) { push('w', m[0], i, i + m[0].length); i += m[0].length; continue; }
    NUM.lastIndex = i; m = NUM.exec(s);
    if (m) { push('n', m[0], i, i + m[0].length); i += m[0].length; continue; }
    if (ch === ':' && c2 === ':') { push('p', '::', i, i + 2); i += 2; continue; }
    push('p', ch, i, i + 1); i++;
  }
  return T;
}
// the text a string token stands for
function strVal(t, d) {
  const r = t.v;
  if (r[0] === '$') { const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(r)[0]; return r.slice(tag.length, Math.max(tag.length, r.length - tag.length)); }
  const q = r[r.length - 1] === r[0] ? r[0] : "'", inner = r.slice(1, r[r.length - 1] === q ? -1 : undefined), doubled = inner.split(q + q).join(q);
  return BSESC.has(d) ? doubled.replace(/\\(.)/g, (_, x) => ({ n: '\n', t: '\t', r: '\r', 0: '\0' }[x] ?? x)) : doubled;
}

// ---------- cursor helpers ----------
const cur = (T, sql, p = 0, e = T.length) => ({ T, sql, p, e });
const peek = (c, o = 0) => (c.p + o < c.e ? c.T[c.p + o] : undefined);
const isW = (t, ...ws) => !!t && t.k === 'w' && ws.includes(t.u);
const stopW = (c, set) => { const t = c.T[c.p]; return isW(t, ...set) && (t.u !== 'CHARACTER' || isW(c.T[c.p + 1], 'SET')); }; // CHARACTER VARYING is a type, CHARACTER SET a modifier
const isP = (t, ch) => !!t && t.k === 'p' && t.v === ch;
const eat = (c, ...ws) => { if (isW(peek(c), ...ws)) { c.p++; return true; } return false; };
const seq = (c, ...ws) => { if (ws.every((w, i) => isW(peek(c, i), w))) { c.p += ws.length; return true; } return false; };
const src = (c, a, b) => (a < b ? c.sql.slice(c.T[a].at, c.T[b - 1].end) : '');
const flat = (t) => t.replace(/\s+/g, ' ').trim();
function group(c) { // at '(': the index range of its content; moves past the ')'. Unbalanced: runs to the end.
  let depth = 0, j = c.p;
  for (; j < c.e; j++) { const t = c.T[j]; if (isP(t, '(')) depth++; else if (isP(t, ')') && --depth === 0) break; }
  const from = c.p + 1; c.p = Math.min(j + 1, c.e);
  return [from, Math.min(j, c.e)];
}
function splitTop(T, from, to, angle) { // index ranges between the commas that are not inside (), or <> after STRUCT / ARRAY / MAP / ROW
  const out = []; let depth = 0, an = 0, a = from;
  for (let j = from; j < to; j++) {
    const t = T[j];
    if (isP(t, '(') || isP(t, '[')) depth++; else if (isP(t, ')') || isP(t, ']')) depth--;
    else if (angle && isP(t, '<') && (an || isW(T[j - 1], 'STRUCT', 'ARRAY', 'MAP', 'ROW'))) an++;
    else if (angle && isP(t, '>') && an) an--;
    else if (isP(t, ',') && !depth && !an) { out.push([a, j]); a = j + 1; }
  }
  if (a < to) out.push([a, to]);
  return out;
}
function nameParts(c, d) { // a.b.c, [a].[b], `p.d.t` (BigQuery), db..t -> ['db', '', 't']
  const out = [];
  for (;;) {
    const t = peek(c);
    if (isP(t, '.')) { out.push(''); c.p++; continue; }
    if (t && (t.k === 'w' || t.k === 'i' || (t.k === 's' && t.v[0] === '"'))) {
      c.p++;
      if (t.k === 'i' && d === 'bigquery') out.push(...t.v.split('.')); else out.push(t.k === 's' ? t.v.slice(1, -1) : t.v);
      if (isP(peek(c), '.')) { c.p++; continue; }
    }
    break;
  }
  return out;
}
function colNames(c) { // ( a, b DESC, c(10) ) -> ['a', 'b', 'c']
  if (!isP(peek(c), '(')) return [];
  const [f, t] = group(c);
  return splitTop(c.T, f, t).map(([a, b]) => (c.T[a] && (c.T[a].k === 'w' || c.T[a].k === 'i') ? c.T[a].v : null)).filter((x) => x != null);
}
const word = (c) => { const t = peek(c); return t && (t.k === 'w' || t.k === 'i') ? (c.p++, t.v) : null; };
// a type as text: keywords upper-cased, strings and quoted names kept, no space before ( or around commas
const TYPEWORD = /^(?:struct|array|map|row|string|int64|float64|bool|bytes|date|datetime|time|timestamp|numeric|bignumeric|geography|json|int|integer|bigint|smallint|tinyint|float|double|decimal|boolean|binary|varchar|char|text|interval|varbinary)$/i;
function typeText(c, a, b) {
  let s = flat(src(c, a, b));
  const nested = s.includes('<'); // STRUCT<path STRING, ...>: the field names keep their case, only the type words are upper-cased
  s = s.replace(/'(?:[^']|'')*'|"[^"]*"|`[^`]*`|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+|\[[A-Za-z_]\w*\]|\[[^\]]*\]|[A-Za-z_][\w$]*/g, (x) => (/^\[[A-Za-z_]/.test(x) ? x.slice(1, -1).toUpperCase() : /^[A-Za-z_]/.test(x) && !x.includes('.') && (!nested || TYPEWORD.test(x)) ? x.toUpperCase() : x)); // a schema-qualified type (an enum) keeps its case; [int] is T-SQL quoting, not an array
  if (!/^STRUCT|<|'/i.test(s)) s = s.replace(/\s*,\s*/g, ',');
  return s.replace(/\s+\(/g, '(').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
}

// ---------- constraints and columns ----------
const CONS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'EXCLUDE', 'PERIOD', 'LIKE', 'PROJECTION']);
const TYPE_STOP = new Set(['NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'CONSTRAINT', 'COMMENT', 'COLLATE', 'CHARACTER', 'CHARSET', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY', 'GENERATED', 'AS', 'ENCODE', 'DISTKEY', 'SORTKEY', 'ON', 'OPTIONS', 'MASKED', 'SPARSE', 'FILESTREAM', 'ROWGUIDCOL', 'COMPRESS', 'INVISIBLE', 'VISIBLE', 'STORAGE', 'COLUMN_FORMAT', 'WITH', 'ENABLE', 'DISABLE', 'VALIDATE', 'NOVALIDATE', 'USING']);
const DEF_STOP = new Set(['NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'CONSTRAINT', 'COMMENT', 'COLLATE', 'GENERATED', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY', 'ON', 'ENCODE', 'DEFAULT', 'OPTIONS', 'CHARACTER', 'CHARSET']);
const FK_WORDS = new Set(['MATCH', 'FULL', 'SIMPLE', 'PARTIAL', 'DEFERRABLE', 'INITIALLY', 'DEFERRED', 'IMMEDIATE', 'ENFORCED', 'RELY', 'NORELY', 'NOVALIDATE', 'VALIDATE', 'ENABLE', 'DISABLE', 'VALID']);
function refs(c, d) { // REFERENCES parent [(cols)] [ON DELETE x] [ON UPDATE y] [MATCH ..] [DEFERRABLE ..] -> {parent, pcols, action}
  const parent = nameParts(c, d), pcols = colNames(c), acts = [];
  for (;;) {
    const t = peek(c);
    if (isW(t, 'ON') && isW(peek(c, 1), 'DELETE', 'UPDATE')) {
      const from = c.p; c.p += 2;
      if (!(seq(c, 'NO', 'ACTION') || seq(c, 'SET', 'NULL') || seq(c, 'SET', 'DEFAULT') || eat(c, 'CASCADE', 'RESTRICT'))) { /* unknown action: kept as written below */ }
      acts.push(flat(src(c, from, c.p)).toUpperCase());
    } else if (isW(t, ...FK_WORDS) || (isW(t, 'NOT') && isW(peek(c, 1), 'DEFERRABLE', 'ENFORCED', 'VALID', 'ENABLED'))) c.p++;
    else break;
  }
  return { parent, pcols, action: acts.join(' ') };
}
// one column definition: name type [modifiers...]. -> {name, type, notNull, nullable, pk, unique, default, description, props, fk, checks}
function colDef(c, d) {
  const nt = peek(c);
  if (!nt || !(nt.k === 'w' || nt.k === 'i' || nt.k === 's')) throw new Error(`a column name was expected at "${nt ? nt.v : 'the end'}"`);
  c.p++;
  const col = { name: nt.k === 's' ? nt.v.slice(1, -1) : nt.v, type: '', props: {}, checks: [] };
  const a = c.p; let depth = 0, an = 0;
  if (isW(peek(c), 'AS') && isP(peek(c, 1), '(')) { /* T-SQL computed column: name AS (expr): no type */ } else
    for (; c.p < c.e; c.p++) {
      const t = c.T[c.p];
      if (isP(t, '(') || isP(t, '[')) depth++; else if (isP(t, ')') || isP(t, ']')) depth--;
      else if (isP(t, '<') && (an || isW(c.T[c.p - 1], 'STRUCT', 'ARRAY', 'MAP', 'ROW'))) an++; else if (isP(t, '>') && an) an--;
      else if (!depth && !an && stopW(c, TYPE_STOP) && !(isW(t, 'WITH') && isW(c.T[c.p + 1], 'TIME', 'LOCAL'))) break;
    }
  col.type = typeText(c, a, c.p);
  let cname = null;
  const skipExpr = () => { // the tokens of one expression, balanced, up to a modifier keyword
    const from = c.p;
    const one = () => { const t = peek(c); if (isP(t, '(')) group(c); else { c.p++; if (isP(peek(c), '(') && t && t.k === 'w') group(c); } };
    if (c.p < c.e) one();
    while (c.p < c.e && !stopW(c, DEF_STOP)) one();
    return src(c, from, c.p);
  };
  while (c.p < c.e) {
    const t = peek(c);
    if (isW(t, 'CONSTRAINT')) { c.p++; cname = word(c); continue; }
    if (isW(t, 'NOT') && isW(peek(c, 1), 'NULL')) { c.p += 2; col.notNull = true; continue; }
    if (isW(t, 'ENABLE', 'DISABLE', 'VALIDATE', 'NOVALIDATE', 'RELY', 'NORELY', 'ENFORCED')) { c.p++; continue; } // Oracle: NOT NULL ENABLE
    if (isW(t, 'NULL')) { c.p++; col.nullable = true; continue; }
    if (isW(t, 'DEFAULT')) { c.p++; const e = skipExpr(); if (!/^null$/i.test(e.trim())) col.default = e; continue; }
    if (isW(t, 'PRIMARY') && isW(peek(c, 1), 'KEY')) { c.p += 2; col.pk = true; eat(c, 'ASC', 'DESC', 'CLUSTERED', 'NONCLUSTERED', 'AUTOINCREMENT'); continue; }
    if (isW(t, 'UNIQUE')) { c.p++; eat(c, 'KEY'); col.unique = true; continue; }
    if (isW(t, 'REFERENCES')) { c.p++; col.fk = { ...refs(c, d), name: cname }; continue; }
    if (isW(t, 'CHECK')) { const from = c.p; c.p++; if (isP(peek(c), '(')) group(c); col.checks.push({ name: cname, text: src(c, from, c.p) }); eat(c, 'NO'); eat(c, 'INHERIT'); continue; }
    if (isW(t, 'COMMENT')) { c.p++; if (isP(peek(c), '=')) c.p++; const s = peek(c); if (s && s.k === 's') { c.p++; col.description = strVal(s, d); } continue; }
    if (isW(t, 'AUTO_INCREMENT', 'AUTOINCREMENT')) { c.p++; col.props.sql_identity = t.v.toUpperCase(); continue; }
    if (isW(t, 'IDENTITY')) { const from = c.p; c.p++; if (isP(peek(c), '(')) group(c); col.props.sql_identity = flat(src(c, from, c.p)).replace(/\s+/g, ''); continue; }
    if (isW(t, 'GENERATED')) {
      const from = c.p; c.p++;
      if (isW(peek(c), 'ALWAYS', 'BY')) { eat(c, 'ALWAYS'); if (eat(c, 'BY')) eat(c, 'DEFAULT'); }
      if (eat(c, 'AS')) { if (eat(c, 'IDENTITY')) { if (isP(peek(c), '(')) group(c); col.props.sql_identity = flat(src(c, from, c.p)); } else { if (isP(peek(c), '(')) group(c); eat(c, 'STORED', 'VIRTUAL', 'PERSISTED'); col.props.sql_generated = flat(src(c, from, c.p)); } }
      continue;
    }
    if (isW(t, 'AS') && isP(peek(c, 1), '(')) { const from = c.p; c.p++; group(c); eat(c, 'STORED', 'VIRTUAL', 'PERSISTED'); col.props.sql_generated = flat(src(c, from, c.p)); continue; }
    if (isW(t, 'OPTIONS') && isP(peek(c, 1), '(')) { const from = c.p; c.p++; const [f, e] = group(c); const o = optParse(c, f, e, d); if (o.description != null) col.description = o.description; if (o.rest) col.props.sql_options = o.rest; continue; }
    // anything else (COLLATE x, CHARACTER SET x, ON UPDATE ..., ENCODE ..., MASKING POLICY ...): kept as text
    const from = c.p; c.p++;
    while (c.p < c.e && !stopW(c, DEF_STOP) && !isW(peek(c), 'AS', 'GENERATED', 'OPTIONS')) { if (isP(peek(c), '(')) group(c); else c.p++; }
    col.props.sql_options = [col.props.sql_options, flat(src(c, from, c.p))].filter(Boolean).join(' ');
  }
  if (col.pk) col.notNull = true;
  return col;
}
function optParse(c, f, e, d) { // OPTIONS(description = "x", labels = [...]): the description, and the other options as text
  const parts = splitTop(c.T, f, e), desc = parts.find(([a]) => isW(c.T[a], 'DESCRIPTION') && isP(c.T[a + 1], '=') && c.T[a + 2] && c.T[a + 2].k === 's');
  const rest = parts.filter((x) => x !== desc).map(([a, b]) => flat(src(c, a, b))).join(', ');
  return { description: desc ? strVal(c.T[desc[0] + 2], d) : null, rest: rest ? `OPTIONS(${rest})` : '' };
}
// a table constraint: -> {type: pk | unique | fk | check | index | other, name, cols, parent, pcols, action, text, forCol?, default?}
function consDef(c, d) {
  const from = c.p;
  let name = null;
  if (eat(c, 'CONSTRAINT')) { const t = peek(c); name = t && !isW(t, 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'DEFAULT') ? word(c) : null; }
  const t = peek(c);
  if (isW(t, 'PRIMARY')) { c.p++; eat(c, 'KEY'); eat(c, 'CLUSTERED', 'NONCLUSTERED', 'HASH'); return { type: 'pk', name, cols: colNames(c) }; }
  if (isW(t, 'UNIQUE')) { c.p++; eat(c, 'KEY', 'INDEX'); eat(c, 'CLUSTERED', 'NONCLUSTERED'); if (!isP(peek(c), '(')) name = name || word(c); return { type: 'unique', name, cols: colNames(c) }; }
  if (isW(t, 'FOREIGN')) { c.p++; eat(c, 'KEY'); if (!isP(peek(c), '(')) name = name || word(c); const cols = colNames(c); if (!eat(c, 'REFERENCES')) return { type: 'other', name, text: flat(src(c, from, c.e)) }; return { type: 'fk', name, cols, ...refs(c, d) }; }
  if (isW(t, 'CHECK')) { const at = c.p; c.p++; if (isP(peek(c), '(')) group(c); return { type: 'check', name, text: flat(src(c, at, c.p)) }; }
  if (isW(t, 'DEFAULT')) { c.p++; const a = c.p; while (c.p < c.e && !isW(peek(c), 'FOR')) c.p++; const expr = src(c, a, c.p); eat(c, 'FOR'); return { type: 'default', name, default: expr, forCol: word(c) }; }
  if (isW(t, 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'PROJECTION')) { const kind = t.u; c.p++; eat(c, 'KEY', 'INDEX'); if (!isP(peek(c), '(')) name = name || word(c); const a = c.p; const cols = colNames(c); return { type: 'index', name, cols, text: (kind === 'FULLTEXT' || kind === 'SPATIAL' ? kind + ' ' : '') + flat(src(c, a, c.e)) }; }
  return { type: 'other', name, text: flat(src(c, from, c.e)) };
}
// the clauses after a table's column list (or after a view's name): ENGINE=.., CLUSTER BY (..), PARTITIONED BY (..), USING DELTA, COMMENT '..', OPTIONS(..), TBLPROPERTIES (..), WITH (..), DISTKEY(..) ...
// -> {description, props, partCols: [{name, type}], select: start token index of `AS SELECT` | -1}
const START = new Set(['ENGINE', 'AUTO_INCREMENT', 'CHARSET', 'CHARACTER', 'COLLATE', 'ROW_FORMAT', 'COMMENT', 'CLUSTER', 'PARTITION', 'PARTITIONED', 'USING', 'LOCATION', 'STORED', 'TBLPROPERTIES', 'OPTIONS', 'WITH', 'TABLESPACE', 'INHERITS', 'DISTSTYLE', 'DISTKEY', 'SORTKEY', 'ORDER', 'ON', 'TEXTIMAGE_ON', 'FILESTREAM_ON', 'DEFAULT', 'ROW', 'DATA_RETENTION_TIME_IN_DAYS', 'BACKUP', 'INTERLEAVED', 'PCTFREE', 'LOGGING', 'NOLOGGING', 'COMPRESS', 'STORAGE', 'ORGANIZATION', 'CACHE', 'PARALLEL', 'CLONE', 'COPY', 'LIFECYCLE', 'BUCKET', 'CLUSTERED', 'SKEWED', 'SERDEPROPERTIES', 'MAX_DATA_EXTENSION_TIME_IN_DAYS', 'CHANGE_TRACKING', 'TAG', 'ENABLE', 'DISABLE', 'NOCOMPRESS', 'UNLOGGED', 'SEGMENT', 'INITRANS', 'MAXTRANS']);
function tail(c, d) {
  const out = { description: '', props: {}, partCols: [], select: -1 };
  let key = null, a = c.p;
  const close = (to) => {
    if (!key) return;
    const v = flat(src(c, a, to)).replace(/^=\s*/, '');
    if (key === 'comment') { const s = c.T[a] && (c.T[a].k === 's' ? c.T[a] : c.T[a + 1]); if (s && s.k === 's') { out.description = strVal(s, d); return; } }
    if (key === 'options') { const cc = cur(c.T, c.sql, a, to); if (isP(peek(cc), '(')) { const [f, e] = group(cc), o = optParse(cc, f, e, d); if (o.description != null) { out.description = o.description; if (o.rest) out.props.sql_options = o.rest; return; } } }
    if (key === 'partitioned_by' && c.T[a] && isP(c.T[a], '(')) { const cc = cur(c.T, c.sql, a, to), [f, e] = group(cc); for (const [x, y] of splitTop(c.T, f, e)) if (y - x >= 2 && c.T[x].k !== 'p' && c.T[x + 1].k === 'w') out.partCols.push({ name: c.T[x].v, type: typeText(c, x + 1, y) }); }
    out.props['sql_' + key] = v || 'true';
  };
  for (let depth = 0; c.p < c.e; c.p++) {
    const t = c.T[c.p];
    if (isP(t, '(')) depth++; else if (isP(t, ')')) depth--;
    if (depth || t.k !== 'w') continue;
    if (t.u === 'AS' && (isW(c.T[c.p + 1], 'SELECT', 'WITH', 'TABLE', 'VALUES') || isP(c.T[c.p + 1], '('))) { close(c.p); key = null; out.select = c.p + 1; break; }
    if (START.has(t.u) && !isP(c.T[c.p - 1], '=')) {
      close(c.p);
      let k = t.u.toLowerCase(), q = c.p;
      if (isW(c.T[q + 1], 'BY', 'AS', 'SET', 'FORMAT')) { k += '_' + c.T[q + 1].u.toLowerCase(); q++; }
      else if (k === 'default' && isW(c.T[q + 1], 'CHARSET', 'CHARACTER', 'COLLATE')) { k = c.T[q + 1].u.toLowerCase(); q++; }
      if (k === 'character' && isW(c.T[q + 1], 'SET')) { k = 'character_set'; q++; }
      key = k; c.p = q; a = q + 1;
    }
  }
  if (out.select < 0) close(c.e);
  return out;
}

// ---------- the shared state ----------
// S: {d, tabs: Map(key -> object), byName: Map(lc name -> [object]), schemas: Map(key -> {nm, description}), cats: Set, pending, dml: [], samples: Map, valuesSeen: Set, notes, skipped: Map(kind -> {n, first}), procs,
//     drops, copies, sawThree, temps, sampleRows, files}
// an object: {kind: 'table' | 'view', nm: {c, s, n}, cols: [column], props, description, fks: [{cols, parent: nm, pcols, name, action, at}], viewType?, definition?, derived? (columns still to be read from its select), at, file}
const state = (d, o = {}) => ({ d, tabs: new Map(), byName: new Map(), schemas: new Map(), cats: [], pending: [], dml: [], samples: new Map(), valuesSeen: new Set(), notes: [], skipped: new Map(), procs: [], drops: 0, copies: 0, sawThree: false, temps: [], sampleRows: o.sampleRows || 0, files: 0, dup: [] });
const key = (nm) => lc(nm.c || '') + '|' + lc(nm.s || '') + '|' + lc(nm.n);
function nmOf(S, parts, ctx) {
  let c = null, s = null, n;
  if (parts.length >= 3) { [c, s, n] = parts.slice(-3); S.sawThree = true; } else if (parts.length === 2) [s, n] = parts; else n = parts[0];
  return { c: c || ctx.c || null, s: s || ctx.s || null, n };
}
function find(S, nm) {
  const hit = S.tabs.get(key(nm));
  if (hit) return hit;
  const all = (S.byName.get(lc(nm.n)) || []).filter((o) => (!nm.c || !o.nm.c || lc(nm.c) === lc(o.nm.c)) && (!nm.s || !o.nm.s || lc(nm.s) === lc(o.nm.s)));
  return all.length === 1 ? all[0] : null;
}
function addObj(S, o, st, replaceOk, ifNot) {
  const k = key(o.nm), old = S.tabs.get(k);
  if (old) {
    if (ifNot) return null;
    if (!replaceOk) S.dup.push(`${fmt(o.nm)} is defined more than once (${old.at}, ${o.at}): the last definition was used`);
    S.byName.set(lc(o.nm.n), (S.byName.get(lc(o.nm.n)) || []).filter((x) => x !== old));
  }
  S.tabs.set(k, o);
  (S.byName.get(lc(o.nm.n)) || S.byName.set(lc(o.nm.n), []).get(lc(o.nm.n))).push(o);
  return o;
}
const fmt = (nm) => [nm.c, nm.s, nm.n].filter(Boolean).join('.');
const where = (S, st) => `${st.file}:${st.line}:${st.col}`;
const skip = (S, kind, st) => { const e = S.skipped.get(kind) || S.skipped.set(kind, { n: 0, first: where(S, st) }).get(kind); e.n++; };
const warn = (S, st, msg) => S.notes.push(`${where(S, st)}: ${msg}`);

function addCons(S, tab, k, st, ctx) { // a table constraint, from CREATE TABLE or ALTER TABLE
  const colOf = (n) => tab.cols.find((x) => lc(x.name) === lc(n));
  const use = (names, fn) => { for (const n of names) { const cc = colOf(n); if (cc) fn(cc); else warn(S, st, `constraint ${k.name || k.type} of ${fmt(tab.nm)} names the column ${n}, which the table does not have`); } };
  if (k.type === 'pk') use(k.cols, (x) => { x.pk = true; x.notNull = true; });
  else if (k.type === 'unique') { if (k.cols.length === 1) use(k.cols, (x) => { x.unique = true; }); else if (k.cols.length) tab.props['sql_unique_' + (k.name || k.cols.join('_'))] = `(${k.cols.join(', ')})`; }
  else if (k.type === 'fk') tab.fks.push({ cols: k.cols, parent: nmOf(S, k.parent, ctx), pcols: k.pcols, name: k.name, action: k.action, at: where(S, st) });
  else if (k.type === 'check') tab.props['sql_check_' + (k.name || colCheck(tab))] = k.text;
  else if (k.type === 'index') tab.props['sql_index_' + (k.name || k.cols.join('_'))] = k.text;
  else if (k.type === 'default') { const x = colOf(k.forCol); if (x) x.default = k.default; }
  else if (k.type === 'other') tab.props['sql_constraint_' + (k.name || Object.keys(tab.props).length)] = k.text;
}
const colCheck = (tab) => 'c' + (Object.keys(tab.props).filter((x) => x.startsWith('sql_check_')).length + 1);
function addCol(S, tab, col, st, ctx) { // a column with its inline constraints
  if (tab.cols.some((x) => lc(x.name) === lc(col.name))) { warn(S, st, `column ${col.name} of ${fmt(tab.nm)} appears twice: the first one was kept`); return; }
  const { fk, checks, nullable, ...c } = col;
  tab.cols.push(c);
  if (fk) tab.fks.push({ cols: [col.name], parent: nmOf(S, fk.parent, ctx), pcols: fk.pcols, name: fk.name, action: fk.action, at: where(S, st) });
  for (const k of checks) tab.props['sql_check_' + (k.name || col.name)] = k.text;
}

// ---------- statements ----------
const KINDS = [
  ['create-table', /^create\s+(?:or\s+replace\s+)?(?:(?:global|local|temp|temporary|unlogged|external|transient|volatile|hybrid|dynamic|iceberg|set|multiset|cached|managed|foreign|virtual|lakehouse)\s+)*table\b/i],
  ['create-view', /^create\s+(?:or\s+(?:replace|alter)\s+)?(?:(?:algorithm\s*=\s*\w+|definer\s*=\s*\S+|sql\s+security\s+\w+|secure|temp|temporary|recursive|materialized|global|local|force|noforce|editionable|noneditionable|external|live)\s+)*view\b/i],
  ['create-schema', /^create\s+(?:or\s+replace\s+)?schema\b/i], ['create-db', /^create\s+(?:or\s+replace\s+)?(?:database|catalog)\b/i],
  ['create-index', /^create\s+(?:or\s+replace\s+)?(?:(?:unique|clustered|nonclustered|bitmap|fulltext|spatial|columnstore|hash)\s+)*index\b/i],
  ['alter-table', /^alter\s+table\b/i], ['comment', /^comment\s+on\b/i], ['use', /^use\b/i],
  ['set-path', /^(?:set\s+(?:(?:local|session)\s+)?(?:search_path|schema|current_schema)\b|alter\s+session\s+set\s+current_schema\b)/i],
  ['drop', /^drop\s+(?:table|view|materialized\s+view|schema|database)\b/i], ['extprop', /^exec(?:ute)?\s+(?:sys\.)?sp_addextendedproperty\b/i],
  ['insert', /^(?:insert|replace)\b/i], ['merge', /^merge\b/i], ['update', /^update\b/i], ['select', /^(?:select|with|\(\s*select|values)\b/i],
];
const kindOf = (sql) => { for (const [k, re] of KINDS) if (re.test(sql)) return k; return PROC.test(sql) ? 'proc' : ANON.test(sql) ? 'proc' : 'other'; };

function read(text, file, S) {
  const { stmts, copies } = split(text, S.d);
  S.copies += copies; S.files++;
  const ctx = { c: null, s: null };
  for (const st of stmts) {
    st.file = file;
    const k = kindOf(st.sql), cx = k === 'use' || k === 'set-path' ? ctx : { ...ctx };
    try {
      if (k === 'create-table') createTable(S, st, cx);
      else if (k === 'create-view') createView(S, st, cx);
      else if (k === 'create-schema') createSchema(S, st, cx);
      else if (k === 'create-db') createDb(S, st, cx);
      else if (k === 'create-index') createIndex(S, st, cx);
      else if (k === 'alter-table') alterTable(S, st, cx);
      else if (k === 'comment') commentOn(S, st, cx);
      else if (k === 'extprop') extProp(S, st, cx);
      else if (k === 'use') useStmt(S, st, cx);
      else if (k === 'set-path') setPath(S, st, cx);
      else if (k === 'drop') dropStmt(S, st, cx);
      else if (k === 'insert') insertStmt(S, st, cx);
      else if (k === 'merge') mergeStmt(S, st, cx);
      else if (k === 'update') updateStmt(S, st, cx);
      else if (k === 'select') { if (/\bfrom\b/i.test(st.sql)) S.dml.push({ kind: 'select', sql: st.sql, at: where(S, st), ctx: { ...ctx } }); else skip(S, 'SELECT without FROM', st); }
      else if (k === 'proc') S.procs.push({ name: procName(st.sql), at: where(S, st) });
      else { const m = /^(\w+)(?:\s+(?:or\s+replace\s+)?(?:global\s+|local\s+|temporary\s+|temp\s+|unique\s+|materialized\s+)*(\w+))?/i.exec(st.sql); skip(S, m ? (/^(?:create|alter|drop)$/i.test(m[1]) && m[2] ? `${m[1]} ${m[2]}` : m[1]).toUpperCase() : 'statement', st); }
    } catch (err) { warn(S, st, `${String(st.sql).slice(0, 60).replace(/\s+/g, ' ')}...: not read (${err.message})`); }
  }
}
const procName = (sql) => { const m = /^(?:create|alter)\s+(?:or\s+(?:replace|alter)\s+)?(?:\w+(?:\s*=\s*\S+)?\s+)*?(procedure|proc|function|trigger|package|type\s+body|event|aggregate)\s+(?:if\s+not\s+exists\s+)?([^\s(]+)/i.exec(sql); return m ? `${m[1].toLowerCase()} ${m[2].replace(/[`"\[\]]/g, '')}` : 'anonymous block'; };

function createTable(S, st, ctx) {
  const T = lex(st.sql, S.d), c = cur(T, st.sql), mods = [];
  while (c.p < c.e && !isW(peek(c), 'TABLE')) mods.push(T[c.p++].u);
  c.p++;
  const ifNot = seq(c, 'IF', 'NOT', 'EXISTS'), parts = nameParts(c, S.d);
  if (!parts.length) throw new Error('no table name');
  if (mods.some((m) => m === 'TEMP' || m === 'TEMPORARY') || /^[#@]/.test(parts[parts.length - 1])) { S.temps.push(parts.join('.')); return; }
  const nm = nmOf(S, parts, ctx), tab = { kind: 'table', nm, cols: [], props: {}, description: '', fks: [], at: where(S, st), file: st.file };
  if (mods.includes('EXTERNAL')) tab.props.sql_external = 'true';
  if (isW(peek(c), 'LIKE') || isW(peek(c), 'CLONE')) { // CREATE TABLE x LIKE y (MySQL), CLONE y (Snowflake): the columns of y, when y is known
    c.p++; const from = find(S, nmOf(S, nameParts(c, S.d), ctx));
    if (from) { tab.cols = from.cols.map((x) => ({ ...x, props: { ...x.props } })); tab.fks = []; } else warn(S, st, `${fmt(nm)} is a copy of a table that is not defined in the scripts: no columns`);
  } else if (isP(peek(c), '(')) {
    const [f, e] = group(c);
    for (const [a, b] of splitTop(T, f, e, true)) {
      const ic = cur(T, st.sql, a, b);
      try { // one definition that cannot be read does not cost the table: it is named, the others are read
        if (isW(T[a], ...CONS)) {
          if (isW(T[a], 'LIKE')) { ic.p++; const from = find(S, nmOf(S, nameParts(ic, S.d), ctx)); if (from) for (const x of from.cols) tab.cols.push({ ...x, props: { ...x.props } }); continue; }
          addCons(S, tab, consDef(ic, S.d), st, ctx);
        } else addCol(S, tab, colDef(ic, S.d), st, ctx);
      } catch (err) { const at = T[a] || T[Math.max(0, a - 1)], before = st.sql.slice(0, at.at); warn(S, { ...st, line: st.line + (before.match(/\n/g) || []).length, col: (before.includes('\n') ? at.at - before.lastIndexOf('\n') : st.col + at.at) }, `${fmt(nm)}: a definition was not read (${err.message})${T[a] ? ': ' + flat(src(ic, a, b)).slice(0, 60) : ''}`); }
    }
  }
  const t = tail(c, S.d);
  tab.description = t.description; Object.assign(tab.props, t.props);
  for (const p of t.partCols) if (!tab.cols.some((x) => lc(x.name) === lc(p.name))) tab.cols.push({ name: p.name, type: p.type, props: {} });
  if (t.select >= 0) { tab.derived = true; S.dml.push({ kind: 'ctas', sql: st.sql.slice(T[t.select].at), target: nm, tab, at: where(S, st), ctx: { ...ctx } }); }
  addObj(S, tab, st, mods.includes('REPLACE'), ifNot);
}
function createView(S, st, ctx) {
  const T = lex(st.sql, S.d), c = cur(T, st.sql), mods = [];
  while (c.p < c.e && !isW(peek(c), 'VIEW')) mods.push(T[c.p++].u);
  c.p++;
  const ifNot = seq(c, 'IF', 'NOT', 'EXISTS'), parts = nameParts(c, S.d);
  if (!parts.length) throw new Error('no view name');
  const nm = nmOf(S, parts, ctx), tab = { kind: 'view', nm, cols: [], props: {}, description: '', fks: [], at: where(S, st), file: st.file, viewType: mods.includes('MATERIALIZED') ? 'materialized' : mods.includes('TEMP') || mods.includes('TEMPORARY') ? 'temporary' : 'view' };
  if (isP(peek(c), '(')) { const [f, e] = group(c); for (const [a, b] of splitTop(T, f, e)) { const ic = cur(T, st.sql, a, b), name = word(ic); let dsc = ''; if (eat(ic, 'COMMENT')) { const s = peek(ic); if (s && s.k === 's') dsc = strVal(s, S.d); } if (name) tab.cols.push({ name, type: '', props: {}, ...(dsc ? { description: dsc } : {}) }); } }
  let a = c.p, depth = 0; // the first AS outside brackets
  for (; c.p < c.e; c.p++) { const t = T[c.p]; if (isP(t, '(')) depth++; else if (isP(t, ')')) depth--; else if (!depth && isW(t, 'AS')) break; }
  if (c.p >= c.e) throw new Error('no AS SELECT');
  const t = tail(cur(T, st.sql, a, c.p), S.d);
  tab.description = t.description; Object.assign(tab.props, t.props);
  let def = st.sql.slice(T[c.p + 1] ? T[c.p + 1].at : st.sql.length).trim();
  def = def.replace(/\s+WITH\s+(?:NO\s+DATA|DATA|CHECK\s+OPTION|READ\s+ONLY)\s*$/i, '').trim();
  tab.definition = def;
  if (!tab.cols.length) tab.derived = true;
  if (addObj(S, tab, st, mods.includes('REPLACE') || mods.includes('ALTER'), ifNot)) S.dml.push({ kind: 'view', sql: def, target: nm, tab, at: where(S, st), ctx: { ...ctx } });
}
function createSchema(S, st, ctx) {
  const T = lex(st.sql, S.d), c = cur(T, st.sql);
  while (!isW(peek(c), 'SCHEMA')) c.p++;
  c.p++; seq(c, 'IF', 'NOT', 'EXISTS');
  const parts = nameParts(c, S.d);
  if (!parts.length) throw new Error('no schema name');
  if (parts.length > 2) S.sawThree = true;
  const s = { c: parts.length > 1 ? parts[parts.length - 2] : ctx.c, n: parts[parts.length - 1] }, t = tail(cur(T, st.sql, c.p, T.length), S.d);
  S.schemas.set(lc(s.c) + '|' + lc(s.n), { c: s.c || null, n: s.n, description: t.description });
}
function createDb(S, st, ctx) {
  const T = lex(st.sql, S.d), c = cur(T, st.sql);
  while (!isW(peek(c), 'DATABASE', 'CATALOG')) c.p++;
  c.p++; seq(c, 'IF', 'NOT', 'EXISTS');
  const parts = nameParts(c, S.d), n = parts[parts.length - 1];
  if (!n) throw new Error('no database name');
  if (S.d === 'mysql') S.schemas.set('|' + lc(n), { c: null, n, description: '' }); else if (!S.cats.some((x) => lc(x) === lc(n))) S.cats.push(n);
}
function createIndex(S, st, ctx) {
  const T = lex(st.sql, S.d), c = cur(T, st.sql), mods = [];
  while (c.p < c.e && !isW(peek(c), 'INDEX')) mods.push(T[c.p++].u);
  c.p++; eat(c, 'CONCURRENTLY'); seq(c, 'IF', 'NOT', 'EXISTS');
  let name = null; if (!isW(peek(c), 'ON')) name = nameParts(c, S.d).pop();
  if (!eat(c, 'ON')) throw new Error('no ON <table>');
  eat(c, 'ONLY');
  const nm = nmOf(S, nameParts(c, S.d), ctx), a = c.p, rest = flat(src(c, a, c.e)), cc = cur(T, st.sql, a, c.e);
  while (cc.p < cc.e && !isP(peek(cc), '(')) cc.p++;
  const cols = colNames(cc), unique = mods.includes('UNIQUE');
  pend(S, nm, st, (tab) => {
    tab.props['sql_index_' + (name || 'on_' + cols.join('_'))] = (unique ? 'UNIQUE ' : '') + rest;
    const x = unique && cols.length === 1 && /^\(\s*[^,()]+\)\s*(?:$|INCLUDE\b)/i.test(rest.replace(/^USING\s+\w+\s*/i, '')) && tab.cols.find((y) => lc(y.name) === lc(cols[0]));
    if (x) x.unique = true;
  });
}
// an ALTER / COMMENT / index whose table is not defined yet waits until the scripts have been read
function pend(S, nm, st, fn) { const tab = find(S, nm); if (tab) fn(tab); else S.pending.push({ nm, fn, st }); }
function alterTable(S, st, ctx) {
  const T = lex(st.sql, S.d), c = cur(T, st.sql);
  c.p += 2; seq(c, 'IF', 'EXISTS'); eat(c, 'ONLY');
  const nm = nmOf(S, nameParts(c, S.d), ctx);
  if (isW(peek(c), 'WITH') && isW(peek(c, 1), 'CHECK', 'NOCHECK')) c.p += 2;
  const clauses = splitTop(T, c.p, T.length);
  let adding = false;
  for (const [a, b] of clauses) {
    const k = cur(T, st.sql, a, b), w = peek(k);
    if (!w) continue;
    if (isW(w, 'ADD')) {
      k.p++; adding = true; eat(k, 'COLUMN'); seq(k, 'IF', 'NOT', 'EXISTS');
      if (isW(peek(k), 'CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'EXCLUDE')) { const con = consDef(k, S.d); pend(S, nm, st, (tab) => addCons(S, tab, con, st, ctx)); }
      else { const col = colDef(k, S.d); pend(S, nm, st, (tab) => addCol(S, tab, col, st, ctx)); }
    } else if (isW(w, 'ALTER', 'MODIFY', 'CHANGE')) {
      const how = w.u; k.p++; eat(k, 'COLUMN');
      let oldName = null;
      if (how === 'CHANGE') oldName = word(k);
      const at = k.p, name = how === 'ALTER' || how === 'MODIFY' ? word(k) : null;
      if (how === 'ALTER' && name) {
        if (seq(k, 'SET', 'DEFAULT')) { const a2 = k.p; const d = src(k, a2, k.e); pend(S, nm, st, (tab) => { const x = tab.cols.find((y) => lc(y.name) === lc(name)); if (x) x.default = d; }); }
        else if (seq(k, 'DROP', 'DEFAULT')) pend(S, nm, st, (tab) => { const x = tab.cols.find((y) => lc(y.name) === lc(name)); if (x) delete x.default; });
        else if (seq(k, 'SET', 'NOT', 'NULL')) pend(S, nm, st, (tab) => { const x = tab.cols.find((y) => lc(y.name) === lc(name)); if (x) x.notNull = true; });
        else if (seq(k, 'DROP', 'NOT', 'NULL')) pend(S, nm, st, (tab) => { const x = tab.cols.find((y) => lc(y.name) === lc(name)); if (x && !x.pk) delete x.notNull; });
        else if (isW(peek(k), 'COMMENT')) { k.p++; const s = peek(k); if (s && s.k === 's') pend(S, nm, st, (tab) => { const x = tab.cols.find((y) => lc(y.name) === lc(name)); if (x) x.description = strVal(s, S.d); }); }
        else if (isW(peek(k), 'SET', 'TYPE')) { eat(k, 'SET'); eat(k, 'DATA'); eat(k, 'TYPE'); let e = k.p; while (e < k.e && !isW(T[e], 'USING', 'COLLATE')) e++; const ty = typeText(k, k.p, e); pend(S, nm, st, (tab) => { const x = tab.cols.find((y) => lc(y.name) === lc(name)); if (x) x.type = ty; }); }
        else { k.p = at; const col = colDef(k, S.d); pend(S, nm, st, (tab) => redefine(tab, col.name, col)); }
      } else { k.p = at; const col = colDef(k, S.d), from = oldName || col.name; pend(S, nm, st, (tab) => redefine(tab, from, col)); }
    } else if (isW(w, 'DROP') && (isW(peek(k, 1), 'COLUMN') || !isW(peek(k, 1), 'CONSTRAINT', 'PRIMARY', 'FOREIGN', 'INDEX', 'KEY', 'CHECK', 'UNIQUE', 'DEFAULT'))) {
      k.p++; eat(k, 'COLUMN'); seq(k, 'IF', 'EXISTS'); const name = word(k);
      if (name) pend(S, nm, st, (tab) => { tab.cols = tab.cols.filter((x) => lc(x.name) !== lc(name)); });
    } else if (isW(w, 'COMMENT')) { k.p++; if (isP(peek(k), '=')) k.p++; const s = peek(k); if (s && s.k === 's') pend(S, nm, st, (tab) => { tab.description = strVal(s, S.d); }); }
    else if (adding && !isW(w, 'OWNER', 'SET', 'ENABLE', 'DISABLE', 'RENAME', 'CHECK', 'NOCHECK', 'REPLICA', 'CLUSTER', 'INHERIT', 'ATTACH', 'DETACH', 'FORCE', 'NO', 'TRIGGER', 'SWITCH', 'REBUILD', 'PARTITION', 'USING', 'CLUSTERED', 'LOCK', 'ENGINE', 'ROW_FORMAT', 'AUTO_INCREMENT', 'CONVERT', 'DEFAULT', 'CHARACTER', 'COLLATE')) { const col = colDef(k, S.d); pend(S, nm, st, (tab) => addCol(S, tab, col, st, ctx)); } // T-SQL: ADD a int, b int
    else skip(S, `ALTER TABLE ${w.u}`, st);
  }
}
function redefine(tab, name, col) { // MODIFY / CHANGE / ALTER COLUMN with a full definition
  const x = tab.cols.find((y) => lc(y.name) === lc(name));
  if (!x) return;
  if (col.type) x.type = col.type;
  if (col.notNull) x.notNull = true; else if (col.nullable && !x.pk) delete x.notNull;
  if (col.default != null) x.default = col.default;
  if (col.description) x.description = col.description;
  Object.assign(x.props, col.props);
  x.name = col.name;
}
function commentOn(S, st, ctx) {
  const T = lex(st.sql, S.d), c = cur(T, st.sql);
  c.p += 2;
  let kind = '';
  while (c.p < c.e && !isW(peek(c), 'IS') && (kind === '' || !(peek(c).k === 'i' || peek(c).k === 'p'))) { kind += ' ' + peek(c).u; c.p++; if (/^ (TABLE|VIEW|COLUMN|SCHEMA|DATABASE|CATALOG|MATERIALIZED VIEW|FOREIGN TABLE)$/.test(kind)) break; }
  kind = kind.trim();
  const parts = nameParts(c, S.d);
  if (!eat(c, 'IS')) throw new Error('no IS');
  const s = peek(c), text = s && s.k === 's' ? strVal(s, S.d) : '';
  if (kind === 'COLUMN') { const col = parts.pop(); pend(S, nmOf(S, parts, ctx), st, (tab) => { const x = tab.cols.find((y) => lc(y.name) === lc(col)); if (x) x.description = text; else warn(S, st, `COMMENT ON COLUMN ${col}: ${fmt(tab.nm)} has no such column`); }); }
  else if (/TABLE|VIEW/.test(kind)) pend(S, nmOf(S, parts, ctx), st, (tab) => { tab.description = text; });
  else if (kind === 'SCHEMA') { const sc = S.schemas.get(lc(parts.length > 1 ? parts[0] : ctx.c) + '|' + lc(parts[parts.length - 1])) || [...S.schemas.values()].find((x) => lc(x.n) === lc(parts[parts.length - 1])); if (sc) sc.description = text; else S.schemas.set(lc(parts.length > 1 ? parts[0] : ctx.c) + '|' + lc(parts[parts.length - 1]), { c: parts.length > 1 ? parts[0] : ctx.c || null, n: parts[parts.length - 1], description: text }); }
  else skip(S, `COMMENT ON ${kind}`, st);
}
function extProp(S, st, ctx) { // SSMS: EXEC sp_addextendedproperty @name = N'MS_Description', @value = N'...', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Orders', @level2type = N'COLUMN', @level2name = N'id'
  const arg = (k) => { const m = new RegExp('@' + k + '\\s*=\\s*N?(\'(?:[^\']|\'\')*\'|\\w+)', 'i').exec(st.sql); return m ? m[1].replace(/^'|'$/g, '').replace(/''/g, "'") : null; };
  if (lc(arg('name')) !== 'ms_description') return skip(S, 'sp_addextendedproperty (not MS_Description)', st);
  const text = arg('value') || '', sch = arg('level0name'), obj = arg('level1name'), col = arg('level2name'), t1 = lc(arg('level1type') || '');
  if (!obj) { if (sch) { const k = '|' + lc(sch); const s = S.schemas.get(k); if (s) s.description = text; } return; }
  if (!/table|view/.test(t1)) return skip(S, 'sp_addextendedproperty (' + t1 + ')', st);
  pend(S, nmOf(S, [sch, obj], ctx), st, (tab) => { if (col) { const x = tab.cols.find((y) => lc(y.name) === lc(col)); if (x) x.description = text; } else tab.description = text; });
}
function useStmt(S, st, ctx) {
  const T = lex(st.sql, S.d), c = cur(T, st.sql);
  c.p++;
  const what = isW(peek(c), 'DATABASE', 'CATALOG', 'SCHEMA', 'WAREHOUSE', 'ROLE', 'NAMESPACE') ? T[c.p++].u : null;
  const parts = nameParts(c, S.d);
  if (!parts.length || what === 'WAREHOUSE' || what === 'ROLE') return;
  if (what === 'DATABASE' || what === 'CATALOG') { ctx.c = parts[parts.length - 1]; if (S.d === 'mysql') { ctx.c = null; ctx.s = parts[parts.length - 1]; } return; }
  if (what === 'SCHEMA' || what === 'NAMESPACE') { ctx.s = parts[parts.length - 1]; if (parts.length > 1) ctx.c = parts[parts.length - 2]; return; }
  if (S.d === 'mysql' || S.d === 'databricks') { ctx.s = parts[parts.length - 1]; if (parts.length > 1) ctx.c = parts[0]; }
  else if (parts.length > 1) { ctx.c = parts[0]; ctx.s = parts[1]; } else ctx.c = parts[0];
}
function setPath(S, st, ctx) {
  const m = /(?:search_path|schema|current_schema)\s*(?:=|to)?\s*(.+)$/i.exec(st.sql);
  if (!m) return;
  const first = m[1].split(',')[0].trim().replace(/^['"`\[]|['"`\]]$/g, '');
  if (first && first !== '$user' && !/^(?:default|local)$/i.test(first)) ctx.s = first.replace(/^.*\./, '');
}
function dropStmt(S, st, ctx) {
  const T = lex(st.sql, S.d), c = cur(T, st.sql);
  c.p++; eat(c, 'MATERIALIZED');
  const what = T[c.p++].u; seq(c, 'IF', 'EXISTS');
  if (what !== 'TABLE' && what !== 'VIEW') return skip(S, 'DROP ' + what, st);
  for (;;) {
    const nm = nmOf(S, nameParts(c, S.d), ctx), old = S.tabs.get(key(nm)) || find(S, nm);
    if (old) { S.tabs.delete(key(old.nm)); S.byName.set(lc(old.nm.n), (S.byName.get(lc(old.nm.n)) || []).filter((x) => x !== old)); S.drops++; }
    if (isP(peek(c), ',')) c.p++; else break;
  }
}

// ---------- DML that the model can use ----------
function insertStmt(S, st, ctx) {
  const T = lex(st.sql.slice(0, 6000), S.d), c = cur(T, st.sql);
  c.p++;
  if (eat(c, 'OR')) c.p++;
  eat(c, 'IGNORE', 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY'); eat(c, 'INTO', 'OVERWRITE'); eat(c, 'TABLE');
  const parts = nameParts(c, S.d);
  if (!parts.length) throw new Error('no target table');
  const nm = nmOf(S, parts, ctx);
  if (isW(peek(c), 'PARTITION') && isP(peek(c, 1), '(')) { c.p++; group(c); }
  let cols = null;
  if (isP(peek(c), '(') && !isW(peek(c, 1), 'SELECT', 'WITH')) cols = colNames(c);
  eat(c, 'OVERRIDING');
  const t = peek(c);
  if (isW(t, 'VALUES')) {
    S.valuesSeen.add(key(nm));
    if (S.sampleRows > 0) sampleRows(S, st, ctx, nm, cols, st.sql.slice(t.end), c);
    return;
  }
  if (!t) return skip(S, 'INSERT', st);
  if (isW(t, 'SELECT', 'WITH') || isP(t, '(')) S.dml.push({ kind: 'insert', sql: st.sql.slice(t.at), target: nm, cols, at: where(S, st), ctx: { ...ctx } });
  else skip(S, 'INSERT ' + t.u, st);
}
function sampleRows(S, st, ctx, nm, cols, rest, c) { // the first rows of one INSERT ... VALUES, as text cells
  const k = key(nm), e = S.samples.get(k) || S.samples.set(k, { nm, cols, rows: [], more: false }).get(k);
  if (e.rows.length >= S.sampleRows) { e.more = true; return; }
  const T = lex(rest.slice(0, Math.min(rest.length, 400000)), S.d);
  let p = 0;
  while (p < T.length && e.rows.length < S.sampleRows) {
    if (!isP(T[p], '(')) { p++; continue; }
    let depth = 0, q = p; for (; q < T.length; q++) { if (isP(T[q], '(')) depth++; else if (isP(T[q], ')') && --depth === 0) break; }
    if (q >= T.length) break; // a tuple cut off by the size cap
    const cc = cur(T, rest, p + 1, q), row = [];
    for (const [a, b] of splitTop(T, p + 1, q)) {
      const t = T[a];
      if (b - a === 1 && t.k === 's') row.push(strVal(t, S.d));
      else if (b - a === 1 && t.k === 'n') row.push(t.v);
      else if (b - a === 1 && isW(t, 'NULL')) row.push('');
      else if (b - a === 2 && isP(t, '-') && T[a + 1].k === 'n') row.push('-' + T[a + 1].v);
      else if (b - a === 1 && isW(t, 'TRUE', 'FALSE')) row.push(t.v.toLowerCase());
      else if (b - a === 2 && isW(t, 'DATE', 'TIMESTAMP', 'TIME', 'DATETIME') && T[a + 1].k === 's') row.push(strVal(T[a + 1], S.d));
      else row.push(flat(rest.slice(T[a].at, T[b - 1].end)));
    }
    void cc;
    if (!e.cols && e.rows.length && e.rows[0].length !== row.length) { p = q + 1; continue; }
    e.rows.push(row);
    p = q + 1;
  }
  if (p < T.length && e.rows.length >= S.sampleRows) e.more = true;
}
function mergeStmt(S, st, ctx) {
  const T = lex(st.sql, S.d), c = cur(T, st.sql), top = (w, from) => { let depth = 0; for (let i = from; i < T.length; i++) { if (isP(T[i], '(')) depth++; else if (isP(T[i], ')')) depth--; else if (!depth && isW(T[i], w)) return i; } return -1; };
  c.p++; eat(c, 'INTO');
  const u = top('USING', c.p);
  if (u < 0) return skip(S, 'MERGE', st);
  const on = top('ON', u + 1), when = top('WHEN', on < 0 ? u : on);
  if (on < 0) return skip(S, 'MERGE', st);
  const tgt = src(c, c.p, u), usingT = src(c, u + 1, on), cond = src(c, on + 1, when < 0 ? T.length : when), tc = cur(T, st.sql, c.p, u), nm = nmOf(S, nameParts(tc, S.d), ctx);
  S.dml.push({ kind: 'merge', sql: `SELECT * FROM ${tgt} JOIN ${usingT} ON ${cond}`, target: nm, at: where(S, st), ctx: { ...ctx } });
}
function updateStmt(S, st, ctx) {
  const T = lex(st.sql, S.d), c = cur(T, st.sql), top = (w, from) => { let depth = 0; for (let i = from; i < T.length; i++) { if (isP(T[i], '(')) depth++; else if (isP(T[i], ')')) depth--; else if (!depth && isW(T[i], w)) return i; } return -1; };
  c.p++;
  const set = top('SET', c.p), from = set < 0 ? -1 : top('FROM', set);
  if (from < 0) return skip(S, 'UPDATE without FROM', st);
  const wh = top('WHERE', from), tgt = src(c, c.p, set), tc = cur(T, st.sql, c.p, set), nm = nmOf(S, nameParts(tc, S.d), ctx);
  const fromT = src(c, from + 1, wh < 0 ? T.length : wh), whereT = wh < 0 ? '' : ' ' + src(c, wh, T.length);
  S.dml.push({ kind: 'update', sql: S.d === 'sqlserver' ? `SELECT * FROM ${fromT}${whereT}` : `SELECT * FROM ${tgt}, ${fromT}${whereT}`, target: nm, at: where(S, st), ctx: { ...ctx } });
}

// waits over: apply what waited for its table, report what never found one
function settle(S) {
  for (const p of S.pending) { const tab = find(S, p.nm); if (tab) p.fn(tab); else warn(S, p.st, `not applied: the table ${fmt(p.nm)} is not defined in the scripts`); }
  S.pending.length = 0;
}

module.exports = { DIALECTS, PLATFORM, LABEL, dialectId, detect, split, state, read, settle, find, key, fmt, kindOf };
