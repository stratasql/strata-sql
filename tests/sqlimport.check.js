// Self-check for the DDL / SQL import (change 33, ADR-0051): lib/sqlscript.js (statements, dialect detection, the DDL reader), lib/sqlimport.js (merging into a Strata
// model: tables, keys, relationships, views, metrics, lineage, the plan / apply re-sync), `strata-sql import-sql` (cli.js), the manifest's `sql` block and the extension side
// (the New Project wizard and the two commands, through a stubbed vscode). The fixtures in tests/fixtures/sql are HAND-WRITTEN from knowledge of what each tool writes,
// not captured from real databases. Run: node tests/sqlimport.check.js   (also with STRATA_SQL_PARSER=off: the simple SQL reader must give the same results)
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process'), Module = require('module');
const REPO = path.join(__dirname, '..'), SAMPLES = path.join(REPO, 'sample_data_models'), FIX = path.join(__dirname, 'fixtures', 'sql');
const SM = require('../media/model.js');
const GV = require('../media/gov.js');
const P = require('../lib/project.js');
const SS = require('../lib/sqlscript.js');
const I = require('../lib/sqlimport.js');
const PARSER = require('../lib/dbtsql.js').available();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-sql-'));
const user = { name: 'Ada', email: 'ada@x.io', system: 'laptop' };
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8'), J = (...p) => JSON.parse(read(...p));
const MODEL = (stem) => `data_models/${stem}/${stem}.model.json`, HISTORY = (stem) => `history/${stem}.history.jsonl`;
const fx = (...p) => path.join(FIX, ...p);
const tree = (dir) => { const out = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p).split(path.sep).join('/')); } })(dir); return out; };
const tab = (F, ref) => F.tables.find((t) => t.schema + '.' + t.name === ref), col = (t, n) => t.columns.find((c) => c.name === n);
const metric = (F, re) => ((F.semantic || {}).metrics || []).find((m) => re.test(m.name));
const rel = (F, parent, child) => F.relationships.find((r) => r.parent === parent && r.child === child);
// files -> {imp, r (merge result into a new project), F}
const run = (files, dialect, o = {}) => { const imp = I.readSql({ ddl: files, dialect, ...o }), r = I.merge(I.fresh(imp, 'T'), imp); return { imp, r, F: r.F }; };
const note = (r, re) => r.notes.find((n) => re.test(n));
// the files of a project agree with each other: the model matches its log, the log's chain holds, one head per stream
const verify = (dir, stem) => {
  const F = J(dir, MODEL(stem)), log = SM.parseLog(read(dir, HISTORY(stem))).history;
  assert.deepStrictEqual(SM.verify(log, SM.flatten(F)), [], stem + ': the model matches its history and the chain is intact');
  for (const s of SM.STREAMS) assert.ok(SM.headsOf(log, s).length <= 1, s + ': one head');
  return { F, log };
};
const userEdit = (modelFile, fn, message = 'User edit') => { // what the editor does for a user edit: canonical file, one version per changed stream, log before model
  const r = P.resolve(modelFile), F = JSON.parse(fs.readFileSync(modelFile, 'utf8')), log = SM.parseLog(fs.readFileSync(r.history, 'utf8')).history;
  fn(F);
  const G = SM.toFile(SM.fromFile(F)), flat = SM.flatten(G);
  for (const s of SM.STREAMS) SM.commit(log, s, null, flat[s], { user: 'Ada', email: user.email, message });
  fs.writeFileSync(r.history, SM.logText(log)); fs.writeFileSync(modelFile, SM.stringify(G) + '\n');
};
const validate = (modelFile) => cp.spawnSync('node', [path.join(REPO, '.claude/skills/strata-model/scripts/strata.js'), 'validate', modelFile], { encoding: 'utf8' });
// every model an import makes is a model like any other: round trip stable, no warnings Strata would show, strata.js validate clean
const sound = (F, label) => {
  assert.deepStrictEqual(SM.toFile(SM.fromFile(F)), F, label + ': fromFile(toFile(m)) is identity');
  const m = SM.fromFile(F, 'physical'); assert.deepStrictEqual(m.warnings, [], label + ': no load warnings'); assert.deepStrictEqual(m.dangling, [], label + ': nothing dangling');
  const bad = GV.check(m).filter((w) => ['metric-ref', 'gov-unknown', 'broken-ref'].includes(w.kind)); assert.deepStrictEqual(bad.map((w) => w.text), [], label + ': no metric-ref / unknown tag warnings');
  const f = path.join(scratch, 'v-' + label.replace(/\W+/g, '_') + '.model.json'); fs.writeFileSync(f, SM.stringify(F) + '\n'); const v = validate(f); assert.strictEqual(v.status, 0, label + ': strata.js validate: ' + v.stdout + v.stderr);
};

// ---- statements: the splitter knows quotes, comments, dollar quoting, DELIMITER, GO, Oracle's slash, COPY data, procedure bodies ----
{
  const sp = (t, d = 'postgres') => SS.split(t, d).stmts;
  let s = sp(`select 'a;b'; -- x; y\nselect "c;d" /* e; f */ from t; select 3`);
  assert.deepStrictEqual(s.map((x) => x.sql), [`select 'a;b'`, `select "c;d" /* e; f */ from t`, 'select 3'], 'semicolons in strings, quoted names and comments do not split');
  assert.deepStrictEqual(s.map((x) => [x.line, x.col]), [[1, 1], [2, 1], [2, 33]], 'line and column of each statement (first character of the SQL)');
  s = sp(`create function f() returns int language plpgsql as $body$ begin perform 1; return 2; end; $body$; select 1;`);
  assert.strictEqual(s.length, 2, 'a dollar-quoted body is one piece'); assert.ok(/^create function/.test(s[0].sql));
  s = sp(`select E'it\\'s; ok'; select 'C:\\'; select 2;`);
  assert.strictEqual(s.length, 3, 'E\'..\\\'..\' escapes in PostgreSQL, plain backslash otherwise');
  s = sp(`DELIMITER ;;\ncreate trigger t before insert on a for each row begin set @x = 1; set @y = 2; end ;;\nselect 1 ;;\nDELIMITER ;\nselect 2;`, 'mysql');
  assert.deepStrictEqual(s.map((x) => x.sql.slice(0, 14)), ['create trigger', 'select 1', 'select 2'], 'DELIMITER (MySQL)');
  s = sp(`create table a (id int)\nGO\ncreate table b (id int)\ngo 2\nselect 1;`, 'sqlserver');
  assert.deepStrictEqual(s.map((x) => x.sql), ['create table a (id int)', 'create table b (id int)', 'select 1'], 'GO batch separators (T-SQL)');
  s = sp(`create procedure p as begin\n  if 1 = 1 begin select 1; end\n  select case when 1 = 1 then 2 end;\nend\ncreate table b (id int);`, 'sqlserver');
  assert.strictEqual(s.length, 2, 'BEGIN / END nesting keeps a T-SQL procedure body whole without GO');
  s = sp(`create or replace procedure p is\nbegin\n  insert into t values (1);\n  commit;\nend p;\n/\ncreate table a (id number);`, 'oracle');
  assert.deepStrictEqual(s.map((x) => x.sql.slice(0, 20)), ['create or replace pr', 'create table a (id n'], "Oracle's / line");
  s = sp(`/*!40101 SET NAMES utf8 */;\n/*!50001 CREATE ALGORITHM=UNDEFINED */\n/*!50001 VIEW v AS select 1 */;\nselect 2;`, 'mysql');
  assert.deepStrictEqual(s.map((x) => x.sql.replace(/\s+/g, ' ')), ['SET NAMES utf8', 'CREATE ALGORITHM=UNDEFINED VIEW v AS select 1', 'select 2'], "MySQL's conditional comments are code, and a statement may span several");
  const c = SS.split(`copy t (a) from stdin;\n1\n2;3\n\\.\nselect 1;`, 'postgres'); assert.strictEqual(c.copies, 1); assert.deepStrictEqual(c.stmts.map((x) => x.sql), ['copy t (a) from stdin', 'select 1'], 'COPY ... FROM stdin data is skipped, semicolons and all');
  s = sp(`\\connect shop\nselect 1;`); assert.deepStrictEqual(s.map((x) => x.sql), ['select 1'], 'psql backslash lines');
  s = sp(`create table a (b int); -- no newline at the end`); assert.strictEqual(s.length, 1);
  s = sp('select `a;b` from t; select 2', 'mysql'); assert.strictEqual(s.length, 2, 'backtick names');
  s = sp('select [a;b] from t; select 2', 'sqlserver'); assert.strictEqual(s.length, 2, '[brackets] in T-SQL');
}

// ---- dialects: detected from the text, cheap, and always overridable ----
{
  const want = { 'postgres/pg_dump.sql': 'postgres', 'mysql/mysqldump.sql': 'mysql', 'sqlserver/ssms.sql': 'sqlserver', 'snowflake/get_ddl.sql': 'snowflake', 'bigquery/ddl.sql': 'bigquery', 'databricks/show_create.sql': 'databricks', 'oracle/ddl.sql': 'oracle', 'northwind/ddl.sql': 'postgres' };
  for (const [f, d] of Object.entries(want)) assert.strictEqual(SS.detect(read(FIX, f)).dialect, d, f + ' is detected as ' + d);
  assert.strictEqual(SS.detect('select 1').dialect, 'postgres', 'nothing to go on: PostgreSQL, and not "confident"'); assert.ok(!SS.detect('select 1').confident);
  assert.strictEqual(SS.detect('create table t (id integer primary key autoincrement) without rowid;').dialect, 'sqlite');
  assert.strictEqual(SS.detect('create table t (a int, b int) distkey(a) sortkey(b);').dialect, 'redshift');
  assert.strictEqual(SS.dialectId('PostgreSQL'), 'postgres'); assert.strictEqual(SS.dialectId('T-SQL'), 'sqlserver'); assert.strictEqual(SS.dialectId('spark'), 'databricks'); assert.strictEqual(SS.dialectId('nope'), null);
  assert.deepStrictEqual([...SS.DIALECTS].sort(), ['bigquery', 'databricks', 'duckdb', 'mysql', 'oracle', 'postgres', 'redshift', 'snowflake', 'sqlite', 'sqlserver', 'trino'], 'the eleven dialects the request names');
  assert.ok(SS.DIALECTS.every((d) => require('../media/model.js').PLATFORMS[SS.PLATFORM[d]]), 'each one maps to a Strata platform');
  assert.throws(() => I.readSql({ ddl: fx('postgres/pg_dump.sql'), dialect: 'cobol' }), /unknown dialect/);
  const auto = I.readSql({ ddl: fx('mysql/mysqldump.sql') }); assert.strictEqual(auto.dialect, 'mysql'); assert.ok(auto.detected && auto.info.read.includes('(detected')); assert.strictEqual(I.readSql({ ddl: fx('mysql/mysqldump.sql'), dialect: 'postgres' }).detected, null, 'an explicit dialect wins, nothing is detected');
}

// ---- PostgreSQL: pg_dump style ----
const pg = run([fx('postgres/pg_dump.sql')], undefined);
{
  const { r, F } = pg;
  assert.strictEqual(F.project.technology, 'PostgreSQL'); assert.strictEqual(F.project.naming, 'schema.table', '2-part naming for PostgreSQL');
  assert.deepStrictEqual(F.schemas.map((s) => s.name), ['ref', 'sales'], 'schemas from CREATE SCHEMA and from the tables'); assert.strictEqual(F.schemas.find((s) => s.name === 'sales').description, 'Orders and customers', 'COMMENT ON SCHEMA');
  assert.deepStrictEqual(F.tables.map((t) => t.schema + '.' + t.name).sort(), ['ref.country', 'sales.customer', 'sales.customer_segment', 'sales.order_line', 'sales.orders', 'sales.product', 'sales.revenue_by_region', 'sales.segment'], 'tables and the view; the sequence, type, function, trigger and extension are no tables');
  const c = tab(F, 'sales.customer');
  assert.deepStrictEqual(c.columns.map((x) => [x.name, x.type]), [['customer_id', 'INTEGER'], ['email', 'CHARACTER VARYING(255)'], ['full_name', 'TEXT'], ['country_id', 'INTEGER'], ['region', 'TEXT'], ['created_at', 'TIMESTAMP WITHOUT TIME ZONE'], ['loyalty', 'NUMERIC(5,2)']], 'types, spelled upper case, NUMERIC(5,2) without the space');
  assert.ok(col(c, 'customer_id').pk && !col(c, 'customer_id').notNull, 'PRIMARY KEY added by ALTER TABLE ... ADD CONSTRAINT (a pk is not also "notNull" in the file)');
  assert.ok(col(c, 'email').unique && col(c, 'email').notNull, 'UNIQUE by ALTER TABLE'); assert.strictEqual(col(c, 'created_at').default, 'now()'); assert.strictEqual(col(c, 'loyalty').default, '0.00');
  assert.strictEqual(col(c, 'email').description, 'Login e-mail, unique per customer', 'COMMENT ON COLUMN'); assert.strictEqual(c.description, 'People who bought something', 'COMMENT ON TABLE');
  assert.strictEqual(col(tab(F, 'sales.orders'), 'total').description, "Order total incl. tax; it's what the customer paid", "a '' inside a comment, and a ; inside a string");
  assert.ok(col(tab(F, 'sales.product'), 'tags').type === 'TEXT[]' && col(tab(F, 'sales.product'), 'attrs').type === 'JSONB', 'array and jsonb');
  assert.strictEqual(col(tab(F, 'sales.orders'), 'status').type, 'sales.order_status', 'an enum type keeps its schema-qualified name as written'); assert.strictEqual(col(tab(F, 'sales.orders'), 'status').default, "'new'::sales.order_status");
  assert.deepStrictEqual(tab(F, 'sales.order_line').columns.filter((x) => x.pk).map((x) => x.name), ['order_id', 'line_no'], 'composite primary key');
  assert.strictEqual(col(tab(F, 'sales.order_line'), 'quantity').default, '1');
  // what has no place in the model is kept as sql_* properties, never dropped
  const o = tab(F, 'sales.orders').properties;
  assert.strictEqual(o.sql_check_orders_total_check, 'CHECK ((total >= (0)::numeric))'); assert.strictEqual(o.sql_index_orders_customer_idx, 'USING btree (customer_id)');
  assert.ok(/WHERE \(total > \(0\)::numeric\)$/.test(o.sql_index_orders_lower_status_idx), 'an expression / partial index, as written');
  assert.strictEqual(tab(F, 'sales.product').properties.sql_index_product_sku_idx, 'UNIQUE USING btree (sku)'); assert.ok(col(tab(F, 'sales.product'), 'sku').unique, 'a unique index on one column: the column is unique');
  // relationships: declared foreign keys (inline REFERENCES are in the other fixtures), by ALTER TABLE, with their actions
  assert.strictEqual(rel(F, 'ref.country.country_id', 'sales.customer.country_id').description, 'Foreign key customer_country_fk (on delete set null).');
  assert.strictEqual(rel(F, 'sales.orders.order_id', 'sales.order_line.order_id').description, 'Foreign key order_line_order_fk (on delete cascade).');
  assert.ok(rel(F, 'sales.customer.customer_id', 'sales.orders.customer_id') && rel(F, 'sales.product.product_id', 'sales.order_line.product_id'));
  const mm = F.relationships.find((x) => x.cardinality === 'M..M'); assert.deepStrictEqual([mm.parent, mm.child, mm.via], ['sales.customer', 'sales.segment', 'sales.customer_segment'], 'a table whose key is two foreign keys is a bridge: many-to-many via it, like the Northwind sample');
  assert.ok(/detected/.test(mm.description)); assert.ok(rel(F, 'sales.customer.customer_id', 'sales.customer_segment.customer_id'), 'and its two foreign keys stay');
  // the view: definition as written, columns from its query
  const v = tab(F, 'sales.revenue_by_region'); assert.strictEqual(v.kind, 'view'); assert.ok(/^SELECT c\.region,/.test(v.definition) && /GROUP BY c\.region$/.test(v.definition), 'the definition is what follows AS'); assert.deepStrictEqual(v.columns.map((x) => x.name), ['region', 'revenue', 'order_count']); assert.strictEqual(col(v, 'region').type, 'TEXT', 'typed from the column it reads'); assert.strictEqual(col(v, 'order_count').type, 'BIGINT');
  assert.deepStrictEqual(v.sql.depends_on, ['sales.customer', 'sales.order_line', 'sales.orders'], 'lineage: what the view reads');
  // notes, in the words of the statements
  assert.ok(note(r, /2 procedural objects .*function sales\.touch_updated at pg_dump\.sql:28:1, trigger orders_touch at pg_dump\.sql:165:1/), 'procedural code is listed, not parsed: ' + r.notes.join('\n'));
  assert.ok(note(r, /1 COPY \.\.\. FROM stdin data block skipped/)); assert.ok(note(r, /CREATE EXTENSION x1/) && note(r, /CREATE SEQUENCE x1/) && note(r, /CREATE TYPE x1/) && note(r, /GRANT x1/), 'unsupported statements are counted by kind with where the first one is');
  assert.ok(note(r, /read: 1 file as PostgreSQL \(detected\), 8 table and views/));
  assert.ok(!r.notes.some((n) => /not applied|not read \(/.test(n)), 'nothing failed silently or loudly that should not: ' + r.notes.join('\n'));
  assert.ok(r.changes.every((x) => x.op === 'add') && /^8 tables added, 33 columns added, 7 relationships added, 1 tag added, 2 metrics added, 2 schemas added$/.test(I.headline(r.changes)), I.headline(r.changes));
  sound(F, 'postgres');
}

// ---- MySQL: mysqldump style ----
{
  const { r, F } = run([fx('mysql/mysqldump.sql')]);
  assert.strictEqual(F.project.technology, 'MySQL'); assert.strictEqual(F.project.naming, 'schema.table', 'MySQL: database = schema, two parts');
  assert.deepStrictEqual(F.tables.map((t) => t.schema + '.' + t.name), ['bookshop.authors', 'bookshop.books', 'bookshop.revenue_per_author', 'bookshop.sales'], 'USE `bookshop` is the schema; the view comes from /*!50001 ... */; the stand-in table of the dump is dropped by DROP TABLE');
  const a = tab(F, 'bookshop.authors'), b = tab(F, 'bookshop.books');
  assert.ok(col(a, 'author_id').pk && col(a, 'author_id').properties.sql_identity === 'AUTO_INCREMENT', 'AUTO_INCREMENT is kept as a column property'); assert.strictEqual(col(a, 'name').description, 'Pen name, as printed on the cover', "COMMENT '...' on a column"); assert.ok(col(a, 'name').unique, 'UNIQUE KEY name (col)');
  assert.strictEqual(a.description, 'People who write books', "table COMMENT='...'"); assert.deepStrictEqual([a.properties.sql_engine, a.properties.sql_charset], ['InnoDB', 'utf8mb4'], 'ENGINE and CHARSET are kept');
  assert.strictEqual(col(a, 'born').default, undefined, 'DEFAULT NULL is no default'); assert.strictEqual(col(a, 'name').properties.sql_options, 'COLLATE utf8mb4_unicode_ci', 'a modifier Strata has no place for is kept as text');
  assert.strictEqual(col(b, 'book_id').type, 'INT UNSIGNED'); assert.strictEqual(col(b, 'status').type, "ENUM('draft','live','retired')", 'the values of an ENUM keep their case'); assert.strictEqual(col(b, 'status').default, "'draft'");
  assert.strictEqual(col(b, 'price').default, "'0.00'"); assert.strictEqual(col(b, 'published_at').properties.sql_options, 'ON UPDATE CURRENT_TIMESTAMP');
  assert.ok(col(b, 'isbn').unique && b.properties.sql_index_idx_books_author === '(`author_id`)' && /^FULLTEXT/.test(b.properties.sql_index_ft_title), 'KEY / FULLTEXT KEY become index properties');
  assert.strictEqual(rel(F, 'bookshop.authors.author_id', 'bookshop.books.author_id').description, 'Foreign key fk_books_author (on delete cascade on update restrict).'); assert.ok(rel(F, 'bookshop.books.book_id', 'bookshop.sales.book_id'), 'named and unnamed CONSTRAINT ... FOREIGN KEY');
  const v = tab(F, 'bookshop.revenue_per_author'); assert.strictEqual(v.kind, 'view'); assert.ok(/^select `a`\.`name` AS `name`/.test(v.definition), 'the view, unwrapped from its conditional comments'); assert.deepStrictEqual(v.columns.map((x) => x.name), ['name', 'revenue']); assert.strictEqual(col(v, 'name').type, 'VARCHAR(120)');
  assert.deepStrictEqual(v.sql.depends_on, ['bookshop.authors', 'bookshop.books', 'bookshop.sales'], 'parenthesised join groups (mysqldump, pg_dump write them) are read');
  assert.ok(note(r, /2 procedural objects .*trigger books_bi .*procedure top_books/), 'DELIMITER bodies: trigger and procedure listed'); assert.ok(note(r, /LOCK x1/) && note(r, /1 DROP statement applied/));
  assert.ok(/bookshop\.sales\.qty \* bookshop\.books\.price/.test(metric(F, /^Revenue/).calculation));
  sound(F, 'mysql');
  const s = run([fx('mysql/mysqldump.sql')], 'mysql', { sampleRows: 5 }); const ins = s.r.samples.find((x) => x.ref === 'bookshop.authors');
  assert.deepStrictEqual(ins.rows, [['1', 'Ursula K. Le Guin', '1929-10-21'], ['2', "It's a 'quoted' name; really", '']], 'INSERT ... VALUES rows, with \\\' and \'\' escapes; NULL is an empty cell'); assert.deepStrictEqual(ins.cols, ['author_id', 'name', 'born']);
}

// ---- SQL Server: SSMS scripts (GO, brackets, extended properties), also as UTF-16 ----
{
  const { r, F } = run([fx('sqlserver/ssms.sql')]);
  assert.strictEqual(F.project.technology, 'SQL Server'); assert.strictEqual(F.project.naming, 'catalog.schema.table', 'SQL Server: database.schema.table'); assert.deepStrictEqual(F.catalogs, [{ name: 'Clinic' }], 'USE [Clinic] names the catalog');
  const p = tab(F, 'Clinic.dbo.Patient'), v = tab(F, 'Clinic.dbo.Visit');
  assert.deepStrictEqual(p.columns.map((x) => [x.name, x.type]), [['PatientId', 'INT'], ['FullName', 'NVARCHAR(200)'], ['BirthDate', 'DATE'], ['Active', 'BIT'], ['Notes', 'NVARCHAR(MAX)']], '[int] and [nvarchar](200) lose their brackets');
  assert.ok(col(p, 'PatientId').pk && col(p, 'PatientId').properties.sql_identity === 'IDENTITY(1,1)'); assert.strictEqual(col(p, 'Active').default, '((1))', 'ADD CONSTRAINT ... DEFAULT ... FOR col'); assert.strictEqual(col(v, 'VisitedAt').default, '(getdate())');
  assert.strictEqual(p.description, 'A person who is treated here', 'sp_addextendedproperty MS_Description'); assert.strictEqual(col(p, 'FullName').description, 'Legal name, as on the insurance card');
  assert.strictEqual(col(v, 'FeeWithTax').properties.sql_generated, 'AS ([Fee]*(1.2))', 'a computed column: no type, the expression kept');
  assert.ok(rel(F, 'Clinic.dbo.Patient.PatientId', 'Clinic.dbo.Visit.PatientId') && rel(F, 'Clinic.dbo.Doctor.DoctorId', 'Clinic.dbo.Visit.DoctorId').description === 'Foreign key FK_Visit_Doctor (on delete cascade).', 'WITH CHECK / WITH NOCHECK ADD CONSTRAINT');
  assert.ok(col(tab(F, 'Clinic.dbo.Doctor'), 'Name').unique, 'CREATE UNIQUE NONCLUSTERED INDEX on one column'); assert.ok(/^UNIQUE/.test(tab(F, 'Clinic.dbo.Doctor').properties.sql_index_UX_Doctor_Name));
  assert.deepStrictEqual(tab(F, 'Clinic.dbo.VisitsPerDoctor').columns.map((x) => x.name), ['Name', 'VisitCount', 'TotalFees']); assert.strictEqual(metric(F, /^Visit count/).aggregation, 'count');
  assert.ok(note(r, /2 procedural objects .*procedure dbo\.usp_AddVisit.*trigger dbo\.trg_Patient_Audit/), 'the procedure with BEGIN / END and semicolons, the trigger: not parsed, listed');
  sound(F, 'sqlserver');
  for (const enc of ['utf16le-bom', 'utf16be-bom', 'utf8-bom']) { // SSMS "Save as" / PowerShell write UTF-16
    const raw = Buffer.from(read(FIX, 'sqlserver/ssms.sql'), 'utf8'), d = path.join(scratch, 'enc-' + enc); fs.mkdirSync(d);
    const out = enc === 'utf8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]) : enc === 'utf16le-bom' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(raw.toString('utf8'), 'utf16le')]) : (() => { const b = Buffer.from(raw.toString('utf8'), 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), b]); })();
    fs.writeFileSync(path.join(d, 'x.sql'), out); const strip = (ts) => ts.map(({ sql, ...t }) => t); assert.deepStrictEqual(strip(run([path.join(d, 'x.sql')]).F.tables), strip(F.tables), enc + ' reads like UTF-8');
  }
}

// ---- Snowflake, BigQuery, Databricks, Oracle ----
{
  const { r, F } = run([fx('snowflake/get_ddl.sql')]);
  assert.strictEqual(F.project.technology, 'Snowflake'); assert.strictEqual(F.project.naming, 'catalog.schema.table'); assert.deepStrictEqual(F.catalogs, [{ name: 'ANALYTICS' }]); assert.strictEqual(F.schemas[0].description, 'Core warehouse tables', 'CREATE SCHEMA ... COMMENT');
  const a = tab(F, 'ANALYTICS.CORE.ACCOUNT');
  assert.strictEqual(col(a, 'ACCOUNT_ID').type, 'NUMBER(38,0)'); assert.strictEqual(col(a, 'CREATED_AT').type, 'TIMESTAMP_NTZ(9)'); assert.strictEqual(col(a, 'CREATED_AT').default, 'CURRENT_TIMESTAMP()'); assert.ok(col(a, 'ACCOUNT_ID').pk, 'constraint PK_ACCOUNT primary key (..)');
  assert.deepStrictEqual([a.description, a.properties.sql_cluster_by, a.properties.sql_data_retention_time_in_days], ['Customer accounts', '(TIER)', '7'], "comment='..', cluster by (..), data_retention_time_in_days=7");
  assert.ok(rel(F, 'ANALYTICS.CORE.ACCOUNT.ACCOUNT_ID', 'ANALYTICS.CORE.INVOICE.ACCOUNT_ID'), 'a 3-part REFERENCES'); assert.strictEqual(col(tab(F, 'ANALYTICS.CORE.INVOICE'), 'INVOICE_ID').properties.sql_identity, 'AUTOINCREMENT');
  assert.strictEqual(col(tab(F, 'ANALYTICS.CORE.INVOICE'), 'AMOUNT').description, 'Net amount in EUR', 'COMMENT ON COLUMN');
  const v = tab(F, 'ANALYTICS.CORE.OPEN_INVOICES'); assert.deepStrictEqual(v.columns.map((x) => [x.name, x.type]), [['INVOICE_ID', 'NUMBER(38,0)'], ['ACCOUNT_NAME', 'VARCHAR(16777216)'], ['AMOUNT', 'NUMBER(12,2)']], 'a view with a column list: the names from the list, the types from its query');
  assert.ok(tab(F, 'ANALYTICS.CORE.TOP_ACCOUNTS').kind === 'view' && tab(F, 'ANALYTICS.CORE.STAGE_INVOICE'), 'secure view, transient table'); assert.ok(note(r, /procedure CLOSE_MONTH/), 'a JavaScript procedure with semicolons in its $$ body is one statement');
  sound(F, 'snowflake');
}
{
  const { F } = run([fx('bigquery/ddl.sql')]);
  assert.strictEqual(F.project.technology, 'Google BigQuery'); assert.deepStrictEqual(F.catalogs, [{ name: 'my-proj' }]); assert.deepStrictEqual(F.schemas.map((s) => [s.catalog, s.name, s.description]), [['my-proj', 'events', 'Clickstream events']], 'OPTIONS(description=..) on the dataset');
  const u = tab(F, 'my-proj.events.users'), c = tab(F, 'my-proj.events.clicks');
  assert.ok(col(u, 'user_id').pk && col(c, 'click_id').pk, 'PRIMARY KEY (..) NOT ENFORCED'); assert.ok(rel(F, 'my-proj.events.users.user_id', 'my-proj.events.clicks.user_id'), 'FOREIGN KEY ... NOT ENFORCED; `project.dataset.table` in one pair of backticks');
  assert.strictEqual(col(c, 'page').type, 'STRUCT<path STRING, query_params ARRAY<STRUCT<k STRING, v STRING>>>', 'STRUCT / ARRAY types, field names keep their case'); assert.strictEqual(col(u, 'email').description, 'Login e-mail', 'column OPTIONS(description)');
  assert.deepStrictEqual([u.description, u.properties.sql_partition_by, u.properties.sql_cluster_by, u.properties.sql_options], ['Registered users', 'DATE(signup_ts)', 'country', 'OPTIONS(labels=[("team", "growth")])'], 'table OPTIONS: the description, the other options kept');
  assert.strictEqual(tab(F, 'my-proj.events.clicks_per_country').description, 'Clicks by user country', 'a view with OPTIONS(description)'); sound(F, 'bigquery');
}
{
  const { F } = run([fx('databricks/show_create.sql')]);
  assert.strictEqual(F.project.technology, 'Databricks'); const d = tab(F, 'main.lake.device'), rd = tab(F, 'main.lake.reading');
  assert.deepStrictEqual([d.description, d.properties.sql_using, d.properties.sql_partitioned_by, d.properties.sql_location], ['Installed devices', 'delta', '(installed)', "'s3://bucket/lake/device'"]); assert.ok(/delta\.minReaderVersion/.test(d.properties.sql_tblproperties));
  assert.strictEqual(col(d, 'readings').type, 'ARRAY<DOUBLE>'); assert.strictEqual(col(d, 'device_id').description, 'Serial number'); assert.ok(col(d, 'device_id').pk, 'CONSTRAINT device_pk PRIMARY KEY (..)');
  assert.strictEqual(rd.properties.sql_cluster_by, '(device_id)'); assert.strictEqual(rd.columns.filter((x) => x.name === 'dt').length, 1, 'a typed PARTITIONED BY column is a column, once');
  assert.ok(rel(F, 'main.lake.device.device_id', 'main.lake.reading.device_id')); assert.strictEqual(metric(F, /^Avg value/).calculation, 'main.lake.reading.value', 'Databricks queries with backticks and 3-part names are read'); sound(F, 'databricks');
}
{
  const { r, F } = run([fx('oracle/ddl.sql')]);
  assert.strictEqual(F.project.technology, 'Oracle'); assert.strictEqual(F.project.naming, 'schema.table'); const e = tab(F, 'HR.EMPLOYEES');
  assert.deepStrictEqual([col(e, 'LAST_NAME').type, col(e, 'SALARY').type, col(e, 'LAST_NAME').notNull], ['VARCHAR2(25 BYTE)', 'NUMBER(8,2)', true], 'VARCHAR2(25 BYTE); NOT NULL ENABLE'); assert.ok(col(e, 'EMPLOYEE_ID').pk && rel(F, 'HR.DEPARTMENTS.DEPARTMENT_ID', 'HR.EMPLOYEES.DEPARTMENT_ID'), 'USING INDEX ... ENABLE after a constraint');
  assert.strictEqual(e.description, 'Employees of the company'); assert.strictEqual(col(e, 'SALARY').description, 'Monthly salary'); assert.ok(/TABLESPACE "USERS"$/.test(e.properties.sql_index_EMP_NAME_IX) && e.properties.sql_tablespace === '"USERS"', 'storage clauses are kept as properties');
  assert.deepStrictEqual(tab(F, 'HR.EMP_DETAILS_VIEW').columns.map((x) => x.name), ['EMPLOYEE_ID', 'LAST_NAME']); assert.ok(note(r, /procedure HR\.ADD_JOB_HISTORY/), "the procedure ends at Oracle's / line"); sound(F, 'oracle');
}
// the dialects that have no fixture of their own: a few lines each
{
  const one = (d, sql) => { const f = path.join(scratch, d + '.sql'); fs.writeFileSync(f, sql); return run([f], d).F; };
  let F = one('sqlite', 'CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, n); CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id)) WITHOUT ROWID;');
  assert.strictEqual(F.project.technology, 'SQLite'); assert.deepStrictEqual(tab(F, 'main.a').columns.map((c) => [c.name, c.type]), [['id', 'INTEGER'], ['name', 'TEXT'], ['n', 'STRING']], 'SQLite: a column with no type'); assert.ok(rel(F, 'main.a.id', 'main.b.a_id'));
  F = one('redshift', 'CREATE TABLE t (id INT ENCODE az64 NOT NULL, k VARCHAR(10) ENCODE lzo, PRIMARY KEY (id)) DISTSTYLE KEY DISTKEY (id) SORTKEY (k);');
  assert.strictEqual(F.project.technology, 'PostgreSQL', 'Redshift maps to PostgreSQL'); assert.deepStrictEqual([tab(F, 'public.t').properties.sql_diststyle, tab(F, 'public.t').properties.sql_distkey, tab(F, 'public.t').properties.sql_sortkey], ['KEY', '(id)', '(k)']); assert.strictEqual(col(tab(F, 'public.t'), 'id').properties.sql_options, 'ENCODE az64');
  F = one('trino', "CREATE TABLE hive.web.page (id bigint, url varchar, ts timestamp(3) with time zone) WITH (format = 'PARQUET', partitioned_by = ARRAY['ts']);");
  assert.strictEqual(F.project.technology, 'Trino/Presto'); assert.strictEqual(tab(F, 'hive.web.page').properties.sql_with, "(format = 'PARQUET', partitioned_by = ARRAY['ts'])"); assert.strictEqual(col(tab(F, 'hive.web.page'), 'ts').type, 'TIMESTAMP(3) WITH TIME ZONE');
  F = one('duckdb', 'CREATE TABLE main.t (id UBIGINT PRIMARY KEY, v HUGEINT); CREATE SEQUENCE s;');
  assert.strictEqual(F.project.technology, 'DuckDB');
}

// ---- Northwind: the classic DDL, with the reporting queries ----
const nw = run([fx('northwind/ddl.sql')], undefined, { dml: [fx('northwind/reports.sql')], sampleRows: 10 });
{
  const { r, F } = nw;
  assert.strictEqual(F.tables.filter((t) => t.kind !== 'view').length, 13, 'the 13 Northwind tables'); assert.deepStrictEqual(F.schemas.map((s) => s.name), ['public'], 'no schema named: the platform default');
  assert.strictEqual(F.relationships.filter((x) => x.cardinality !== 'M..M').length, 13, 'every declared FK (13); "REFERENCES t" with no column means the primary key of t');
  assert.ok(rel(F, 'public.employees.employee_id', 'public.employees.reports_to'), 'a self-reference');
  assert.deepStrictEqual(F.relationships.filter((x) => x.cardinality === 'M..M').map((x) => x.via).sort(), ['public.customer_customer_demo', 'public.employee_territories', 'public.order_details'], 'the bridge tables of Northwind: a two-column key of two foreign keys, nothing referencing it (order_details has a payload; the shipped Northwind sample models it as a bridge too)');
  assert.deepStrictEqual(tab(F, 'public.order_details').columns.filter((c) => c.pk).map((c) => c.name), ['order_id', 'product_id']);
  assert.strictEqual(col(tab(F, 'public.customers'), 'customer_id').type, 'BPCHAR'); assert.ok(!note(r, /DROP statement/) && F.tables.length >= 13, 'the DROP TABLE IF EXISTS lines before each CREATE drop nothing that exists, so nothing to report');
  assert.strictEqual(tab(F, 'public.order_subtotals').kind, 'view'); assert.strictEqual(metric(F, /^Subtotal/).aggregation, 'sum'); assert.strictEqual(metric(F, /^Subtotal/).calculation, 'public.order_details.unit_price * public.order_details.quantity * (1.0 - public.order_details.discount)', 'the arithmetic of a report, as a calculation over qualified columns');
  assert.deepStrictEqual(metric(F, /^Product sales/).grain, ['public.order_details'], 'the grain is the table the measure comes from'); assert.ok(/Grouped by public\.categories\.category_id, public\.categories\.category_name, public\.products\.product_name\. Filter: public\.orders\.shipped_date IS NOT NULL/i.test(metric(F, /^Product sales/).description), 'group-by columns and the filter are in the description: ' + metric(F, /^Product sales/).description);
  assert.deepStrictEqual(tab(F, 'public.orders_qry').columns.map((c) => c.name).slice(0, 3), ['order_id', 'customer_id', 'employee_id'], 'o.* in a view is expanded from the table'); assert.ok(col(tab(F, 'public.orders_qry'), 'company_name'));
  assert.ok(r.samples.length === 1 && r.samples[0].ref === 'public.shippers' && r.samples[0].rows.length === 2, 'INSERT ... VALUES');
  sound(F, 'northwind');
}

// ---- round trip: Strata's own DDL generator, then the import, against the shipped samples ----
// What must come back exactly: tables, views (kind, definition), columns (type, key, nullability, default, description), table descriptions, every column-level relationship.
// What cannot: UNIQUE (the Databricks generator does not write it), view descriptions and view column types (DDL has none; they are read from the query), and the many-to-many
// choices of the sample's author that the rule "a table whose key is two foreign-key columns" does not make (FpML: 4 missing, 2 in the other direction).
{
  const D = { 'SQL Server': 'sqlserver', PostgreSQL: 'postgres', MySQL: 'mysql', Oracle: 'oracle', SQLite: 'sqlite', Databricks: 'databricks', Snowflake: 'snowflake', 'Google BigQuery': 'bigquery', 'Trino/Presto': 'trino', DuckDB: 'duckdb' };
  const out = {};
  for (const m of ['northwind', 'example', 'star', 'fpml']) {
    const orig = J(SAMPLES, m + '.model.json'), dia = D[orig.project.technology], file = path.join(scratch, 'gen-' + m + '.sql');
    const gen = cp.spawnSync('node', [path.join(REPO, '.claude/skills/strata-model/scripts/strata.js'), 'ddl', path.join(SAMPLES, m + '.model.json')], { encoding: 'utf8' }); assert.strictEqual(gen.status, 0); fs.writeFileSync(file, gen.stdout);
    assert.strictEqual(SS.detect(gen.stdout).dialect, dia, m + ': the generator\'s own header says which dialect it wrote');
    const { F: G } = run([file], dia); assert.strictEqual(G.project.technology, orig.project.technology, m + ': the platform comes back'); assert.strictEqual(G.project.naming, orig.project.naming);
    const key = (t) => t.schema + '.' + t.name, got = new Map(G.tables.map((t) => [key(t), t])); out[m] = { tables: G.tables.length };
    assert.deepStrictEqual([...got.keys()].sort(), orig.tables.map(key).sort(), m + ': the same tables and views');
    const uniq = dia !== 'databricks' && dia !== 'bigquery';
    for (const t of orig.tables) {
      const u = got.get(key(t)); assert.strictEqual(u.kind || 'table', t.kind || 'table', key(t) + ': kind'); assert.strictEqual(u.viewType || 'view', t.viewType || 'view', key(t) + ': view type (materialized ...)');
      if (t.kind === 'view') { assert.strictEqual(u.definition, t.definition, key(t) + ': definition'); assert.deepStrictEqual(u.columns.map((c) => c.name), t.columns.map((c) => c.name), key(t) + ': view columns, from the query'); continue; }
      assert.strictEqual(u.description || '', t.description || '', key(t) + ': description'); assert.deepStrictEqual(u.columns.map((c) => c.name), t.columns.map((c) => c.name), key(t) + ': columns and their order');
      for (const c of t.columns) { const d = col(u, c.name); for (const f of ['type', 'pk', 'notNull', 'default', 'description', ...(uniq ? ['unique'] : [])]) assert.strictEqual(d[f], c[f], `${key(t)}.${c.name} ${f}`); }
    }
    const fk = (F2) => F2.relationships.filter((x) => !x.via && x.cardinality !== 'M..M').map((x) => `${x.parent}>${x.child}`).sort();
    assert.deepStrictEqual(fk(G), fk(orig), m + ': every column-level relationship'); out[m].fks = fk(G).length;
    const mm = (F2) => F2.relationships.filter((x) => x.cardinality === 'M..M').map((x) => `${x.parent}>${x.child} via ${x.via}`).sort(), want = new Set(mm(orig)), have = new Set(mm(G));
    out[m].mm = [[...want].filter((x) => !have.has(x)).length, [...have].filter((x) => !want.has(x)).length, want.size];
    sound(G, 'round trip ' + m);
  }
  assert.deepStrictEqual(out.northwind.mm, [0, 0, 3], 'Northwind: all three many-to-many relationships come back'); assert.deepStrictEqual(out.star.mm, [0, 0, 0]); assert.deepStrictEqual(out.example.mm, [0, 0, 1], 'and the example sample\'s one');
  assert.deepStrictEqual(out.fpml.mm.slice(0, 2), [4, 2], 'FpML: 4 of the sample author\'s many-to-many choices are not recovered (composite keys of three, or not a link table), 2 have the other direction: said here so it is seen when it changes'); assert.ok(out.fpml.mm[2] >= 5);
}

// ---- metrics: derived from queries, collapsed, reviewed, valid ----
{
  const { r, F } = run([fx('postgres/pg_dump.sql')], undefined, { dml: [fx('postgres/queries.sql')] });
  const ms = F.semantic.metrics;
  assert.ok(ms.every((m) => m.tags.includes('sql-derived') && m.sql.derived === 'sql' && /Review it before you rely on it/.test(m.description)), 'every derived metric is tagged, marked and says it is to be reviewed'); assert.ok(F.governance.tags.some((t) => t.name === 'sql-derived' && /derived automatically/.test(t.description)), 'the tag is defined');
  const rev = ms.filter((m) => m.aggregation === 'sum' && m.calculation === 'sales.order_line.quantity * sales.order_line.unit_price');
  assert.strictEqual(rev.filter((m) => /Filter: sales\.orders\.status = 'paid'/.test(m.description)).length, 1, 'the same calculation and filter in query 1 and query 2 is ONE metric');
  const q1 = rev.find((m) => /queries\.sql:5:1/.test(m.description)); assert.ok(q1 && /Also computed as revenue in the query at queries\.sql:/.test(q1.description), 'and the other occurrence is named: ' + (q1 && q1.description));
  assert.ok(/Grouped by sales\.customer\.region, date_trunc\('month', sales\.orders\.placed_at\)/.test(q1.description), 'GROUP BY 1, 2 resolved to the select items: ' + q1.description); assert.deepStrictEqual(q1.grain, ['sales.order_line']);
  assert.strictEqual(metric(F, /^Order count/).aggregation, 'count_distinct'); assert.strictEqual(metric(F, /^Order count/).calculation, 'sales.orders.order_id'); assert.strictEqual(metric(F, /^Avg order value/).aggregation, 'avg');
  assert.strictEqual(metric(F, /^Units on hand/).calculation, 'sales.stock.on_hand', 'a column of a table the DDL of the query file itself defines');
  if (PARSER) { assert.strictEqual(metric(F, /^Biggest order/).calculation, 'sales.orders.total', 'through a CTE (SELECT * FROM orders) to the real column'); assert.ok(ms.some((m) => m.aggregation === 'count' && m.calculation === 'sales.orders.order_id' && /Filter: sales\.orders\.status = 'paid'/.test(m.description)), 'count(*) from the CTE: the first table counted by its key, and the CTE\'s own WHERE travels with the metric'); assert.ok(/Filter: sales\.orders\.status = 'paid'/.test(metric(F, /^Biggest order/).description), 'the filter of the CTE the column was followed through is in the description'); }
  // the derived name clashes: a second metric with the same name gets the table, then "filtered", then a number: nothing is dropped
  assert.strictEqual(new Set(ms.map((m) => m.name.toLowerCase())).size, ms.length, 'names are unique');
  // join inferred where no foreign key says so
  const inf = rel(F, 'sales.product.sku', 'sales.stock.sku'); assert.ok(inf && /^Inferred from a join in the query at queries\.sql:\d+:1\.$/.test(inf.description), 'inferred join, marked: ' + JSON.stringify(inf));
  assert.ok(!F.relationships.some((x) => /Inferred/.test(x.description || '') && x.child === 'sales.order_line.product_id'), 'a join a foreign key already declares is not inferred again');
  // lineage: INSERT ... SELECT, MERGE, UPDATE ... FROM, CREATE TABLE AS
  assert.deepStrictEqual(tab(F, 'sales.daily_revenue').sql.depends_on, ['sales.orders'], 'CREATE TABLE AS SELECT'); assert.deepStrictEqual(tab(F, 'sales.daily_revenue').columns.map((c) => c.name), ['day', 'revenue'], 'and its columns come from the select');
  assert.deepStrictEqual(tab(F, 'sales.customer_segment').sql.depends_on, ['sales.customer'], 'MERGE ... USING (select ...)'); assert.deepStrictEqual(tab(F, 'sales.orders').sql.depends_on, ['sales.order_line'], 'UPDATE ... FROM (select ...)');
  assert.ok(note(r, /function sales\.revenue_for/) && note(r, /DELETE x1/) && note(r, /VACUUM x1/), 'DELETE, VACUUM and a SQL function are named, not read');
  if (PARSER) assert.ok(note(r, /1 query could not be parsed as PostgreSQL SQL and was read with the simplified reader.*pg_dump\.sql:\d+:1 \(line 7, column \d+\)/), 'what the parser rejected (a cast to a schema-qualified type) is named with its position: ' + r.notes.join('\n')); else assert.ok(note(r, /parser .* is not installed or is switched off/), 'without the parser the simple reader is named');
  assert.ok(!note(r, /^metric .* was not imported/), 'no metric was lost: ' + r.notes.join('\n'));
  sound(F, 'metrics');
  // the parser-free reader finds the same things for the plain queries
  const plain = path.join(scratch, 'plain.sql'); fs.writeFileSync(plain, `CREATE TABLE a (id int PRIMARY KEY, k int); CREATE TABLE b (id int PRIMARY KEY, a_id int, amt numeric(9,2), st text);
SELECT sum(b.amt) AS total, count(distinct b.id) AS n FROM a JOIN b ON b.a_id = a.id WHERE b.st = 'x' GROUP BY a.k;`);
  const pr = run([plain]).F; assert.deepStrictEqual(pr.semantic.metrics.map((m) => [m.name, m.aggregation, m.calculation]).sort(), [['N', 'count_distinct', 'public.b.id'], ['Total', 'sum', 'public.b.amt']], 'aggregates'); assert.ok(rel(pr, 'public.a.id', 'public.b.a_id'), 'inferred join (a.id is the key of a)');
}

// ---- never guess: bad statements are named with their place, the rest is still imported ----
{
  const f = path.join(scratch, 'bad.sql'); fs.writeFileSync(f, `CREATE TABLE ok (id int primary key);
CREATE TABLE broken (id int, , );
ALTER TABLE ok ADD CONSTRAINT x FOREIGN KEY (nope) REFERENCES ok (id);
ALTER TABLE missing ADD COLUMN z int;
CREATE TABLE child (id int, ok_id int, FOREIGN KEY (ok_id) REFERENCES elsewhere (id), FOREIGN KEY (id) REFERENCES ok);
CREATE TABLE dup (a int);
CREATE TABLE dup (a int, b int);
CREATE TABLE IF NOT EXISTS ok (id int, extra int);
CREATE GLOBAL TEMPORARY TABLE tmp (a int);
CREATE TABLE #t (a int);
COMMENT ON COLUMN ok.nothing IS 'x';
`);
  const { r, F } = run([f], 'postgres');
  assert.deepStrictEqual(F.tables.map((t) => t.name).sort(), ['broken', 'child', 'dup', 'ok'], 'the statements that can be read are read; temporary tables are skipped'); assert.ok(note(r, /bad\.sql:2:\d+: broken: a definition was not read \(a column name was expected/), 'one unreadable definition costs only itself, and is named with its place: ' + r.notes.join('\n'));
  assert.deepStrictEqual(tab(F, 'public.dup').columns.map((c) => c.name), ['a', 'b'], 'defined twice: the last definition wins, said'); assert.ok(note(r, /public\.dup is defined more than once/) || note(r, /dup is defined more than once/));
  assert.strictEqual(tab(F, 'public.ok').columns.length, 1, 'IF NOT EXISTS on a known table: the first definition stays');
  assert.ok(note(r, /bad\.sql:3:1: the foreign key x of public\.ok names a column that does not exist \(nope\): not imported/), 'a constraint on a missing column: file:line:column and what is wrong: ' + r.notes.join('\n')); assert.ok(note(r, /bad\.sql:4:1: not applied: the table missing is not defined/));
  assert.ok(note(r, /1 foreign key to tables that are not in the scripts .* child\(ok_id\) -> elsewhere/), 'a foreign key to a table nobody defines'); assert.ok(rel(F, 'public.ok.id', 'public.child.id'), 'while its sibling is imported');
  assert.ok(note(r, /2 temporary tables skipped/)); assert.ok(note(r, /bad\.sql:11:1: COMMENT ON COLUMN nothing: ok has no such column/) || note(r, /COMMENT ON COLUMN nothing/));
  assert.throws(() => I.importNew({ ddl: [fx('README.md')], dir: path.join(scratch, 'none'), dryRun: true }), /no CREATE TABLE/, 'files with no table at all say so instead of making an empty project');
  assert.throws(() => I.readSql({ ddl: [path.join(scratch, 'nope.sql')] }), /does not exist/); assert.throws(() => I.readSql({}), /no SQL files given/);
  const emptyDir = path.join(scratch, 'emptydir'); fs.mkdirSync(emptyDir); assert.throws(() => I.readSql({ ddl: [emptyDir] }), /no \.sql files in/);
  // a folder is read recursively, in name order, each file once
  const dir = path.join(scratch, 'folder'); fs.mkdirSync(path.join(dir, 'sub'), { recursive: true }); fs.writeFileSync(path.join(dir, 'b.sql'), 'CREATE TABLE b (id int);'); fs.writeFileSync(path.join(dir, 'sub', 'a.ddl'), 'CREATE TABLE a (id int);'); fs.writeFileSync(path.join(dir, 'notes.txt'), 'CREATE TABLE c (id int);');
  assert.deepStrictEqual(I.collect([dir, path.join(dir, 'b.sql')]).map((x) => path.relative(dir, x)), ['b.sql', path.join('sub', 'a.ddl')], 'folders are walked for .sql / .ddl / .dml; a file named twice is read once; .txt is not SQL');
}

// ---- a new project: files, history, manifest ----
const newDir = path.join(scratch, 'new'); fs.mkdirSync(newDir);
const dml = [fx('postgres/queries.sql')];
let res = I.importNew({ ddl: [fx('postgres/pg_dump.sql')], dml, dir: newDir, name: 'Shop', user, dryRun: true });
assert.deepStrictEqual(fs.readdirSync(newDir), [], 'a dry run writes nothing'); assert.ok(res.dryRun && res.lines.length && res.dialect === 'postgres');
res = I.importNew({ ddl: [fx('postgres/pg_dump.sql')], dml, dir: newDir, name: 'Shop', user, sampleRows: 10 });
assert.deepStrictEqual(tree(newDir), ['.gitattributes', '.gitignore', 'data_models/shop/data/sales.product.csv', 'data_models/shop/data/sales.segment.csv', MODEL('shop'), HISTORY('shop'), 'strata.project.json'], 'the standard project tree, plus the sample data of the INSERT ... VALUES');
assert.strictEqual(read(newDir, 'data_models/shop/data/sales.segment.csv'), 'segment_id,label\n1,Retail\n2,Wholesale\n3,"Partner; ""special"""\n', 'CSV, quoted the way the editor reads it');
{
  const { F, log } = verify(newDir, 'shop'); sound(F, 'new project');
  assert.strictEqual(log.entries[0].message, `Import from SQL scripts: ${res.headline}`, 'the first version says where it came from');
  const man = J(newDir, 'strata.project.json'); assert.deepStrictEqual([man.sql.ddl, man.sql.dml, man.sql.dialect, man.sql.sampleRows], [[path.relative(newDir, fx('postgres/pg_dump.sql')).split(path.sep).join('/')], [path.relative(newDir, fx('postgres/queries.sql')).split(path.sep).join('/')], 'postgres', 10], 'the manifest remembers the files (relative), the dialect and the sample-row limit'); assert.ok(man.sql.lastSync);
  const v = validate(path.join(newDir, MODEL('shop'))); assert.strictEqual(v.status, 0, v.stdout + v.stderr);
  // the model is a normal model: Strata's own DDL generator reads it back
  const gen = cp.spawnSync('node', [path.join(REPO, '.claude/skills/strata-model/scripts/strata.js'), 'ddl', path.join(newDir, MODEL('shop')), '--dialect', 'postgres'], { encoding: 'utf8' }); assert.strictEqual(gen.status, 0); assert.ok(/CREATE TABLE "sales"\."customer"/.test(gen.stdout) && /ALTER TABLE "sales"\."orders" ADD CONSTRAINT/.test(gen.stdout));
}
const shopModel = path.join(newDir, MODEL('shop'));
// ---- idempotent re-sync ----
{
  const snap = () => [shopModel, path.join(newDir, HISTORY('shop')), path.join(newDir, 'strata.project.json'), path.join(newDir, 'data_models/shop/data/sales.segment.csv')].map((f) => [fs.readFileSync(f, 'utf8'), fs.statSync(f).mtimeMs]);
  const s0 = snap(); let p = I.plan(shopModel, { stop: newDir });
  assert.strictEqual(p.changes.length, 0, 'nothing changed in the scripts: nothing to do: ' + p.lines.join('\n')); assert.strictEqual(p.headline, 'no changes');
  const s = I.sync(shopModel, { user, stop: newDir }); assert.deepStrictEqual(s.entries || [], []); assert.deepStrictEqual(snap(), s0, 'and nothing was written: not the model, not the log, not the manifest (lastSync stays), not the sample data');
  assert.strictEqual(I.plan(shopModel, { stop: newDir, ddl: [fx('postgres/pg_dump.sql')], dml }).changes.length, 0, 'also when the files are given again (the manifest had dml and sampleRows: same result)', 'without sample rows the plan has none');
}

// ---- the user's own work, then the scripts change: add and update what the scripts own, delete and overwrite nothing else ----
const edited = path.join(scratch, 'edited'); fs.mkdirSync(edited); fs.cpSync(fx('postgres'), path.join(edited, 'sql'), { recursive: true });
{
  const d = path.join(scratch, 'pr'); fs.mkdirSync(d);
  const r0 = I.importNew({ ddl: [path.join(edited, 'sql/pg_dump.sql')], dml: [path.join(edited, 'sql/queries.sql')], dir: d, name: 'Edit', user, base: d });
  const model = r0.model; verify(d, 'edit'); fs.writeFileSync(path.join(d, 'data_models/edit/edit.model.layout.json'), JSON.stringify({ strata: 'layout/1', positions: { physical: { 'sales.customer': [10, 20] } } }));
  const metricsBefore = J(model).semantic.metrics.length;
  userEdit(model, (G) => {
    const c = tab(G, 'sales.customer'), o = tab(G, 'sales.orders'), pr = tab(G, 'sales.product');
    c.displayName = 'Customer'; c.sla = { frequency: 'daily', time: '02:00' }; col(c, 'full_name').description = 'The user wrote this'; col(c, 'region').displayName = 'Sales region';
    G.conceptual = { concepts: [{ name: 'Customer', description: 'A person or company that buys.' }] }; G.logical = { entities: [{ name: 'Customer', concept: 'Customer' }] }; c.entity = 'Customer';
    c.tags = ['my_tag']; G.governance = { tags: [...(G.governance.tags || []), { name: 'my_tag', description: 'Mine', enabled: true }] };
    c.columns.push({ name: 'ltv', type: 'DECIMAL(10,2)', description: 'User added' }); G.tables.push({ name: 'scratch', schema: 'sales', columns: [{ name: 'id', type: 'INT', pk: true }] });
    o.governance = { owner: 'Someone Else' }; o.properties.team_note = 'ours'; col(pr, 'title').notNull = true;
    const m = G.semantic.metrics; m.find((x) => /^Avg order value/.test(x.name)).description = 'My definition of AOV.'; m.splice(m.findIndex((x) => /^Units on hand/.test(x.name)), 1); // edited one, deleted one
    G.semantic.metrics.push({ name: 'My own', calculation: 'sales.orders.total', aggregation: 'max' });
    G.relationships.push({ parent: 'sales.customer.customer_id', child: 'sales.scratch.id', cardinality: '1..1' });
  }, 'Model the customer');
  verify(d, 'edit'); const before = read(d, 'data_models/edit/edit.model.layout.json'), n0 = SM.parseLog(read(d, HISTORY('edit'))).history.entries.length;
  // the scripts change: a type, a default, a new column, a new table, a new foreign key, a new query, a comment, a dropped table
  const ddlf = path.join(edited, 'sql/pg_dump.sql');
  fs.writeFileSync(ddlf, read(edited, 'sql/pg_dump.sql').replace('full_name text NOT NULL', 'full_name character varying(300) NOT NULL DEFAULT \'n/a\'').replace('region text,', 'region text,\n    segment_id integer,').replace('CREATE TABLE sales.segment (', 'CREATE TABLE sales.warehouse (wid integer PRIMARY KEY, label text);\nCREATE TABLE sales.segment (').replace("COMMENT ON COLUMN sales.customer.email IS 'Login e-mail, unique per customer';", "COMMENT ON COLUMN sales.customer.email IS 'CHANGED IN THE SCRIPT';\nCOMMENT ON COLUMN sales.customer.full_name IS 'Script says this';").replace(/CREATE TABLE sales\.customer_segment[\s\S]*?\);\n/, '').replace(/ALTER TABLE ONLY sales\.customer_segment[\s\S]*?;\n/g, '').replace(/ALTER TABLE ONLY sales\.customer_segment\n[\s\S]*?;\n/g, ''));
  fs.appendFileSync(path.join(edited, 'sql/queries.sql'), '\nSELECT sum(w.wid) AS wid_total FROM sales.warehouse w;\n');
  const p = I.plan(model, { user, stop: d }); // the manifest's sql block has the files (absolute-relative paths from d)
  assert.ok(p.changes.length && p.lines.some((l) => /~ column sales\.customer\.full_name \(type TEXT -> CHARACTER VARYING\(300\), default\)/.test(l)), 'the script owns types: ' + p.lines.join('\n')); assert.ok(p.lines.some((l) => /\+ table sales\.warehouse/.test(l)) && p.lines.some((l) => /\+ column sales\.customer\.segment_id/.test(l)), 'new table, new column');
  assert.ok(!p.lines.some((l) => /description/.test(l)), 'a description the user wrote stays, and one the script changed is not applied over it (descriptions are set only when empty)');
  assert.ok(p.notes.some((n) => /no longer in the scripts, kept in Strata SQL: sales\.customer_segment/.test(n)), 'a table that left the scripts is kept and reported');
  const sr = I.apply(p, { user }); assert.ok(sr.entries.length >= 1); const { F: G, log } = verify(d, 'edit');
  const c = tab(G, 'sales.customer');
  assert.strictEqual(col(c, 'full_name').type, 'CHARACTER VARYING(300)'); assert.strictEqual(col(c, 'full_name').default, "'n/a'"); assert.strictEqual(col(c, 'full_name').description, 'The user wrote this', 'the user description is kept'); assert.strictEqual(col(c, 'email').description, 'Login e-mail, unique per customer');
  assert.ok(col(c, 'ltv') && tab(G, 'sales.scratch') && tab(G, 'sales.customer_segment'), "the user's column and table, and the table the scripts dropped, are all still there"); assert.ok(c.displayName === 'Customer' && c.sla && c.entity === 'Customer' && c.tags[0] === 'my_tag' && col(c, 'region').displayName === 'Sales region', 'display names, SLA, entity, tags stay');
  assert.strictEqual(tab(G, 'sales.orders').governance.owner, 'Someone Else'); assert.strictEqual(tab(G, 'sales.orders').properties.team_note, 'ours', 'governance and the user\'s own properties stay'); assert.ok(col(tab(G, 'sales.product'), 'title').notNull, 'a NOT NULL the user added stays');
  assert.ok(rel(G, 'sales.customer.customer_id', 'sales.scratch.id') && G.conceptual.concepts.length === 1 && G.logical.entities.length === 1, "the user's relationship, concept and entity stay");
  const ms = G.semantic.metrics; assert.strictEqual(ms.find((x) => /^Avg order value/.test(x.name)).description, 'My definition of AOV.', 'an edited metric is never touched'); assert.ok(!ms.some((x) => /^Units on hand/.test(x.name)), 'a metric the user deleted is never recreated'); assert.ok(ms.some((x) => x.name === 'My own'));
  assert.ok(ms.some((x) => /^Wid total/.test(x.name)) && ms.length === metricsBefore - 1 + 1 + 1, 'and the new query brings its new metric: ' + ms.map((x) => x.name));
  assert.strictEqual(read(d, 'data_models/edit/edit.model.layout.json'), before, 'the layout file is not touched'); assert.ok(log.entries.length > n0 && log.entries.at(-1).message.startsWith('Sync from SQL scripts'), 'one more version, named'); sound(G, 'after the re-sync');
  assert.strictEqual(I.plan(model, { stop: d }).changes.length, 0, 'and a second re-sync finds nothing to do'); assert.strictEqual(J(d, 'strata.project.json').sql.dialect, 'postgres');
}
// ---- refusals: never rewrite history silently, never guess ----
{
  const d = path.join(scratch, 'drift'); const r0 = I.importNew({ ddl: [fx('postgres/pg_dump.sql')], dir: d, name: 'Drift', user });
  const orig0 = read(r0.model), F0 = JSON.parse(orig0); F0.tables[0].description = 'edited outside Strata'; fs.writeFileSync(r0.model, SM.stringify(F0) + '\n');
  assert.throws(() => I.plan(r0.model), /differs from its version log/, 'a model changed without its history: import refuses (open it in Strata and record it first)');
  fs.writeFileSync(r0.model, orig0); I.plan(r0.model);
  fs.writeFileSync(path.join(d, HISTORY('drift')), read(d, HISTORY('drift')) + '{not json\n'); assert.throws(() => I.plan(r0.model), /unreadable/);
}
{ const d = path.join(scratch, 'multi'); const r0 = I.importNew({ ddl: [fx('postgres/pg_dump.sql')], dir: d, name: 'Multi', user }); const m = J(d, 'strata.project.json'); m.parts.push({ name: 'other', model: 'x.model.json' }); fs.writeFileSync(path.join(d, 'strata.project.json'), JSON.stringify(m));
  assert.throws(() => I.plan(r0.model), /one part/, 'a project split into domains is refused, not half-imported'); }
assert.throws(() => I.plan(path.join(newDir, 'data_models/shop/shop.archived.model.json'), { ddl: [fx('postgres/pg_dump.sql')] }), /archived/);
{ const f = path.join(scratch, 'project.index.model.json'); fs.writeFileSync(f, JSON.stringify({ strata: 'project-index/1', name: 'x', parts: [] })); assert.throws(() => I.plan(f, { ddl: [fx('postgres/pg_dump.sql')] }), /project-index file/); }
{ const d = path.join(scratch, 'nosql'); const r0 = P.create({ dir: d, name: 'Plain', user }); assert.throws(() => I.plan(r0.model), /no SQL files given/, 'no sql block and no --ddl: says what is missing'); }
// no history file at all: a baseline entry first, so what was there before the import is still a version
{ const d = path.join(scratch, 'nohist'); const r0 = I.importNew({ ddl: [fx('postgres/pg_dump.sql')], dir: d, name: 'No Hist', user }); const hp = path.join(d, HISTORY('no-hist'));
  const F0 = J(r0.model); F0.tables = F0.tables.filter((t) => t.name !== 'segment'); F0.relationships = F0.relationships.filter((x) => !/segment/.test(x.parent + x.child)); fs.writeFileSync(r0.model, SM.stringify(SM.toFile(SM.fromFile(F0))) + '\n'); fs.rmSync(hp);
  const ps = I.plan(r0.model); assert.ok(ps.baseline && ps.changes.length); I.apply(ps, { user });
  const lg = verify(d, 'no-hist').log; assert.ok(lg.entries.some((e) => e.message === 'Baseline before the first SQL scripts import') && lg.entries.at(-1).message.startsWith('Sync from SQL scripts'), 'baseline first, then the sync'); }
// adopting a model that exists: the same schema.table, case-insensitive; 2-part naming stays
{ const d = path.join(scratch, 'adopt'); const r0 = P.create({ dir: d, name: 'Mine', platform: 'PostgreSQL', user });
  userEdit(r0.model, (G) => { G.schemas.push({ name: 'Sales' }); G.tables.push({ name: 'Customer', schema: 'Sales', description: 'Hand made', columns: [{ name: 'CUSTOMER_ID', type: 'INT', description: 'Hand made key' }, { name: 'nickname', type: 'TEXT' }] }); }, 'A first table');
  const res2 = I.sync(r0.model, { ddl: [fx('postgres/pg_dump.sql')], user }); const { F: G } = verify(d, 'mine');
  const c = G.tables.filter((t) => t.name.toLowerCase() === 'customer' && /^sales$/i.test(t.schema));
  assert.strictEqual(c.length, 1, 'the same schema.name is adopted, not duplicated (case-insensitive)'); assert.ok(col(c[0], 'nickname'), 'its own column stays'); assert.strictEqual(col(c[0], 'CUSTOMER_ID').description, 'Hand made key'); assert.strictEqual(col(c[0], 'CUSTOMER_ID').type, 'INTEGER', 'the script owns the type'); assert.strictEqual(c[0].description, 'Hand made');
  assert.ok(!G.catalogs && G.tables.every((t) => !t.schema.includes('.')), 'a 2-part project keeps 2-part naming'); assert.ok(res2.headline);
  // three-part scripts into a two-part project: the catalog goes, and it is said
  const f3 = path.join(scratch, 'three.sql'); fs.writeFileSync(f3, 'CREATE TABLE db1.sales.extra (id int);'); const pl = I.plan(r0.model, { ddl: [f3], dialect: 'postgres' }); assert.ok(pl.notes.some((n) => /catalog \/ database part of db1 was dropped/.test(n))); assert.ok(pl.lines.includes('+ table sales.extra (1 column)') || pl.lines.some((l) => /table sales\.extra|table Sales\.extra/i.test(l))); }
// a project not made from scripts gets the block at its first import; a 3-part platform default catalog stays
{ const d = path.join(scratch, 'late'); const r0 = P.create({ dir: d, name: 'Late', platform: 'Snowflake', user }); const f = path.join(scratch, 'two.sql'); fs.writeFileSync(f, 'CREATE TABLE core.acct (id int primary key);');
  I.sync(r0.model, { ddl: [f], dialect: 'snowflake', user, base: scratch }); const m = J(d, 'strata.project.json'); assert.ok(m.sql && m.sql.ddl && m.sql.dialect === 'snowflake' && m.name === 'Late'); const F0 = verify(d, 'late').F; assert.ok(F0.catalogs.some((c) => c.name === 'MY_DB') && tab(F0, 'MY_DB.core.acct'), 'two-part names in a three-part project: the existing catalog');
  const mm = J(d, 'strata.project.json'); mm.custom = { keep: 1 }; mm.sql.note = 'mine'; fs.writeFileSync(path.join(d, 'strata.project.json'), JSON.stringify(mm)); fs.writeFileSync(f, 'CREATE TABLE core.acct (id int primary key, n text);'); I.sync(r0.model, { user }); const m3 = J(d, 'strata.project.json');
  assert.deepStrictEqual(m3.custom, { keep: 1 }); assert.strictEqual(m3.sql.note, 'mine', 'unknown keys of the manifest and of the sql block are kept'); assert.ok(m3.sql.lastSync >= mm.sql.lastSync); verify(d, 'late'); }
// ---- metric cap and the parser-free reader ----
{
  const f = path.join(scratch, 'cap.sql'); const lines = ['CREATE TABLE t (id int primary key, v int);']; for (let i = 0; i < 620; i++) lines.push(`SELECT sum(v + ${i}) AS m${i} FROM t;`); fs.writeFileSync(f, lines.join('\n'));
  const r1 = run([f], 'postgres').r; assert.strictEqual(r1.F.semantic.metrics.length, 500, 'at most 500 metrics per import'); assert.ok(note(r1, /120 more metric candidates were not imported/));
  const d = path.join(scratch, 'cap'); const r0 = I.importNew({ ddl: [f], dir: d, name: 'Cap', user }); const p2 = I.plan(r0.model); assert.strictEqual(p2.changes.filter((x) => x.kind === 'metric').length, 120, 're-sync brings the rest'); }

// ---- the command line ----
const cli = (...a) => cp.spawnSync('node', [path.join(REPO, 'cli.js'), ...a], { encoding: 'utf8' });
{ const d = path.join(scratch, 'cli'); fs.mkdirSync(d);
  let c = cli('import-sql', '--ddl', fx('postgres/pg_dump.sql'), '--dml', fx('postgres/queries.sql'), '--dir', d, '--name', 'Cli Shop', '--dry-run'); assert.strictEqual(c.status, 0, c.stderr); assert.ok(/dry run, nothing written/.test(c.stdout) && /\+ table sales\.customer/.test(c.stdout) && /read: 2 files as PostgreSQL/.test(c.stdout) && /Notes:/.test(c.stdout), c.stdout); assert.deepStrictEqual(fs.readdirSync(d), []);
  c = cli('import-sql', '--ddl', fx('postgres/pg_dump.sql'), fx('postgres/queries.sql'), '--dir', d, '--name', 'Cli Shop', '--dialect', 'postgres', '--sample-rows', '5'); assert.strictEqual(c.status, 0, c.stderr); assert.ok(/New project from SQL scripts/.test(c.stdout) && /10 tables added/.test(c.stdout), 'two files after one --ddl: c.stdout' && c.stdout); verify(d, 'cli-shop'); assert.ok(fs.existsSync(path.join(d, 'data_models/cli-shop/data/sales.product.csv')));
  c = cli('import-sql', '--dir', d); assert.strictEqual(c.status, 0, c.stderr); assert.ok(/Re-sync of .* from SQL scripts: no changes/.test(c.stdout), 'the same command in a project of one part is a re-sync, files from the manifest: ' + c.stdout);
  const ch = path.join(d, 'changed.sql'); fs.writeFileSync(ch, read(FIX, 'postgres/pg_dump.sql').replace('title text', 'title character varying(99)'));
  c = cli('import-sql', '--dir', d, '--ddl', ch, '--dry-run'); assert.ok(/~ column sales\.product\.title \(type TEXT -> CHARACTER VARYING\(99\)\)/.test(c.stdout) && /dry run/.test(c.stdout)); assert.ok(/TEXT/.test(read(d, MODEL('cli-shop'))) && !/VARCHAR\(99\)/.test(read(d, MODEL('cli-shop'))), 'dry run: not applied');
  c = cli('import-sql', '--dir', d, '--ddl', ch); assert.strictEqual(c.status, 0, c.stderr); assert.ok(/CHARACTER VARYING\(99\)/.test(read(d, MODEL('cli-shop')))); verify(d, 'cli-shop');
  c = cli('import-sql', '--model', path.join(d, MODEL('cli-shop'))); assert.ok(/no changes/.test(c.stdout), '--model picks the model explicitly, the stored (changed) file is the source');
  fs.mkdirSync(path.join(scratch, 'cli-empty'), { recursive: true }); c = cli('import-sql', '--dir', path.join(scratch, 'cli-empty')); assert.strictEqual(c.status, 1); assert.ok(/no SQL files given/.test(c.stderr), c.stderr);
  c = cli('import-sql', '--ddl', path.join(scratch, 'cli-empty'), '--dir', path.join(scratch, 'cli-empty')); assert.strictEqual(c.status, 1); assert.ok(/no \.sql files in/.test(c.stderr));
  c = cli('import-sql', '--ddl', fx('postgres/pg_dump.sql'), '--dialect', 'cobol', '--dir', path.join(scratch, 'cli-empty')); assert.strictEqual(c.status, 1); assert.ok(/unknown dialect/.test(c.stderr));
  c = cli('import-sql', '--ddl', fx('postgres/pg_dump.sql'), '--sample-rows', 'x', '--dir', path.join(scratch, 'cli-empty')); assert.strictEqual(c.status, 1); assert.ok(/--sample-rows needs a whole number/.test(c.stderr));
  c = cli('import-sql', '--ddl'); assert.strictEqual(c.status, 2); assert.ok(/--ddl needs a file or folder/.test(c.stderr) && /strata-sql import-sql --help/.test(c.stderr));
  c = cli('import-sql', '--bogus'); assert.strictEqual(c.status, 2); assert.ok(/strata-sql import-sql --help/.test(c.stderr));
  c = cli('import-sql', '--ddl', fx('mysql/mysqldump.sql'), '--dir', path.join(scratch, 'cli-mysql'), '--name', 'Books'); assert.strictEqual(c.status, 0, c.stderr); assert.ok(/MySQL/.test(c.stdout), 'the dialect is detected and named'); assert.strictEqual(J(scratch, 'cli-mysql/' + MODEL('books')).project.technology, 'MySQL'); }

// ---- the extension side: the wizard and the two commands, through a stubbed vscode ----
const Uri = { file: (q) => ({ fsPath: q, path: q, scheme: 'file', with(o) { return Uri.file(o.path !== undefined ? o.path : q); } }), joinPath: (u, ...x) => Uri.file(path.join(u.fsPath, ...x)) };
let ws = path.join(scratch, 'workspace'); fs.mkdirSync(ws); const ws1 = ws;
const cmds = {}, seen = { exec: [], info: [], err: [], warn: [], modal: [], asked: [], dialogs: [] };
let script = [], answer = undefined, active = null;
const ask = (kind, o, items) => { const a = script.shift(); seen.asked.push({ kind, title: o && o.title, labels: items && items.map((i) => i.label) }); if (kind === 'dialog') seen.dialogs.push(o); if (a === undefined) throw new Error('unexpected prompt: ' + (o && o.title)); return typeof a === 'function' ? a(items, o) : a; };
const vscode = {
  Uri, ViewColumn: {}, ColorThemeKind: {}, QuickPickItemKind: { Separator: -1 },
  workspace: { get workspaceFolders() { return [{ uri: Uri.file(ws) }]; }, getWorkspaceFolder: () => undefined, fs: {}, onDidChangeTextDocument: () => ({}), onDidChangeConfiguration: () => ({}), getConfiguration: () => ({ get: () => '' }) },
  window: { get activeTextEditor() { return active; }, activeColorTheme: { kind: 2 }, onDidChangeActiveColorTheme: () => ({}), onDidChangeActiveTextEditor: () => ({}), registerCustomEditorProvider: () => ({}), registerWebviewViewProvider: () => ({}), registerUriHandler: () => ({}),
    showQuickPick: async (items, o) => ask('pick', o, items), showInputBox: async (o) => ask('input', o), showOpenDialog: async (o) => ask('dialog', o),
    showInformationMessage: async (m, o, ...items) => { if (items.length) { seen.modal.push({ m, o, items }); return answer; } seen.info.push(m); }, showErrorMessage: (m) => { seen.err.push(m); return Promise.resolve(); }, showWarningMessage: async (m) => { seen.warn.push(m); } },
  commands: { registerCommand: (id, fn) => { cmds[id] = fn; return {}; }, executeCommand: async (...a) => { seen.exec.push(a); } },
};
const orig = Module._load; Module._load = function (req, ...x) { return req === 'vscode' ? vscode : orig.call(this, req, ...x); };
require(REPO + '/extension.js').activate({ subscriptions: { push() {} }, extensionUri: Uri.file(REPO) });
const by = (id) => (items) => items.find((i) => i.id === id);
(async () => {
  const pkg = require(REPO + '/package.json');
  for (const id of ['strata.importSql', 'strata.syncSql']) assert.ok(cmds[id] && pkg.contributes.commands.some((c) => c.command === id), id + ' exists and is in the Command Palette');
  assert.deepStrictEqual(pkg.contributes.commands.filter((c) => /Sql/.test(c.command)).map((c) => c.title), ['Strata SQL: Import from DDL…', 'Strata SQL: Re-sync from SQL scripts']);
  // New Project > From DDL / SQL scripts…: folder, name, starting point, the DDL files, query files (none), the dialect, create
  script = [by('ws'), 'Wizard Shop', by('sql'), () => [Uri.file(fx('postgres/pg_dump.sql'))], by('no'), (items) => items[0], by('go')];
  await cmds['strata.newProject']();
  assert.deepStrictEqual(seen.err, []); const w = verify(ws, 'wizard-shop'); assert.strictEqual(w.F.tables.length, 8); assert.ok(J(ws, 'strata.project.json').sql);
  assert.deepStrictEqual(seen.asked.map((a) => a.kind), ['pick', 'input', 'pick', 'dialog', 'pick', 'pick', 'pick'], 'folder, name, starting point, the DDL files, query files?, the dialect, create: no platform or methodology question (the dialect brings the platform)');
  assert.ok(seen.asked[2].labels.some((l) => /From DDL \/ SQL scripts/.test(l)) && !seen.asked[2].labels.some((l) => /coming soon/.test(l)), 'SQL scripts are a starting point; nothing is "coming soon" any more');
  assert.ok(/PostgreSQL {2}\(detected\)/.test(seen.asked[5].labels[0]) && seen.asked[5].labels.length === 11, 'the dialect question puts the detected dialect first, marked, and offers all eleven: ' + seen.asked[5].labels.join(' | '));
  assert.ok(seen.dialogs[0].canSelectMany && seen.dialogs[0].canSelectFolders && seen.dialogs[0].canSelectFiles, 'one or more files or folders');
  assert.ok(/from SQL scripts \(PostgreSQL\): 8 tables added/.test(seen.info.at(-1)), seen.info.at(-1)); assert.strictEqual(seen.exec.at(-1)[0], 'vscode.openWith');
  // with query files and a different dialect on purpose (in a workspace of its own: a second project in the first one's folder would make it a two-part project)
  ws = path.join(scratch, 'workspace2'); fs.mkdirSync(ws); seen.asked.length = 0; script = [by('ws'), 'Wizard Two', by('sql'), () => [Uri.file(fx('postgres/pg_dump.sql'))], by('dml'), () => [Uri.file(fx('postgres/queries.sql'))], (items) => items.find((i) => i.id === 'redshift'), by('go')];
  await cmds['strata.newProject'](); assert.deepStrictEqual(seen.err, []); const w2 = verify(ws, 'wizard-two'); assert.ok(w2.F.semantic.metrics.length > 3, 'the query files bring metrics'); assert.deepStrictEqual(J(ws, 'strata.project.json').sql.dialect, 'redshift', 'the dialect the user chose is the one stored, detection or not'); assert.strictEqual(w2.F.project.technology, 'PostgreSQL'); ws = ws1;
  // cancelling anywhere writes nothing
  ws = ws1; const before = tree(ws).join();
  for (const sc of [[by('ws'), 'Cx1', by('sql'), () => undefined], [by('ws'), 'Cx2', by('sql'), () => [Uri.file(fx('postgres/pg_dump.sql'))], () => undefined], [by('ws'), 'Cx3', by('sql'), () => [Uri.file(fx('postgres/pg_dump.sql'))], by('no'), () => undefined]]) { script = sc; await cmds['strata.newProject'](); assert.strictEqual(tree(ws).join(), before); }
  // no table in the files: the error is shown, nothing is written
  seen.err.length = 0; script = [by('ws'), 'Empty Sql', by('sql'), () => [Uri.file(fx('README.md'))], by('no'), (items) => items[0], by('go')]; await cmds['strata.newProject'](); assert.ok(/no CREATE TABLE or CREATE VIEW statement found/.test(seen.err[0]), seen.err[0]); assert.strictEqual(tree(ws).join(), before);

  ws = ws1;
  // the commands: preview, then apply
  const mfile = path.join(ws, MODEL('wizard-shop')), doc = { uri: Uri.file(mfile), isDirty: false };
  active = { document: doc };
  seen.info.length = 0; await cmds['strata.syncSql'](); assert.ok(/already up to date/.test(seen.info[0]), 'nothing to do: says so: ' + JSON.stringify([seen.info, seen.err, seen.warn]));
  const nf = path.join(scratch, 'cmd.sql'); fs.writeFileSync(nf, read(FIX, 'postgres/pg_dump.sql').replace('title text', 'title character varying(77)') + "\nINSERT INTO sales.segment (segment_id, label) VALUES (1, 'Retail'), (2, 'Wholesale');\n");
  script = [() => [Uri.file(nf)], by('no'), (items) => items[0]]; answer = undefined; // Import from DDL…: the files, no queries, the dialect, then the preview; the user says no
  await cmds['strata.importSql']();
  assert.strictEqual(seen.dialogs.at(-1).defaultUri.fsPath, ws, 'the dialog starts in the project'); assert.strictEqual(seen.modal.length, 1);
  assert.ok(/^Sync from SQL scripts: 1 updated/.test(seen.modal[0].m) && seen.modal[0].o.modal && /~ column sales\.product\.title \(type TEXT -> CHARACTER VARYING\(77\)\)/.test(seen.modal[0].o.detail) && /one version/.test(seen.modal[0].o.detail) && /read: 1 file as PostgreSQL/.test(seen.modal[0].o.detail), 'a modal preview lists the changes and what was read: ' + JSON.stringify(seen.modal[0]));
  assert.deepStrictEqual(seen.modal[0].items, ['Apply', 'Apply with sample data'], 'INSERT ... VALUES rows were found: the sample data is offered as a second button, never done silently');
  assert.ok(!/VARCHAR\(77\)/.test(read(ws, MODEL('wizard-shop'))), 'not applied without a yes');
  answer = 'Apply with sample data'; script = [() => [Uri.file(nf)], by('no'), (items) => items[0]]; await cmds['strata.importSql']();
  assert.ok(/CHARACTER VARYING\(77\)/.test(read(ws, MODEL('wizard-shop'))) && /synced from SQL scripts/.test(seen.info.at(-1))); verify(ws, 'wizard-shop'); assert.ok(fs.existsSync(path.join(ws, 'data_models/wizard-shop/data/sales.segment.csv')), 'sample data written on request');
  assert.strictEqual(J(ws, 'strata.project.json').sql.ddl[0], path.relative(ws, nf).split(path.sep).join('/'));
  // Re-sync uses the stored paths and asks nothing
  fs.writeFileSync(nf, read(nf).replace('varchar(77)', 'varchar(88)').replace('CHARACTER VARYING(77)', 'CHARACTER VARYING(88)').replace('character varying(77)', 'character varying(88)')); script = []; answer = 'Apply';
  await cmds['strata.syncSql'](); assert.ok(/VARCHAR\(88\)|VARYING\(88\)/.test(read(ws, MODEL('wizard-shop')))); verify(ws, 'wizard-shop');
  // unsaved changes in the editor: asked to save first, nothing written
  doc.isDirty = true; seen.warn.length = 0; const b = read(ws, MODEL('wizard-shop')); await cmds['strata.syncSql'](); assert.ok(/save the model first/.test(seen.warn[0])); assert.strictEqual(read(ws, MODEL('wizard-shop')), b);
  // no model open: Re-sync warns, Import from DDL… starts the wizard (which has the same starting point)
  doc.isDirty = false; active = null; seen.warn.length = 0; await cmds['strata.syncSql'](); assert.ok(/open a \.model\.json file first/.test(seen.warn[0]), 'no model open: a warning, not an error');
  seen.asked.length = 0; script = [() => undefined]; await cmds['strata.importSql'](); assert.strictEqual(seen.asked[0].kind, 'pick', 'no model open: the New Project wizard opens');
  console.log('sqlimport.check: ok' + (PARSER ? '' : ' (simple SQL reader only)'));
})().catch((e) => { console.error(e); process.exit(1); });
