// Times the SQL import on a synthetic script: N tables (DDL with keys, foreign keys, comments, indexes) and M DML statements (reports, views, INSERT ... SELECT, MERGE).
// Not part of the suites. Run: node tests/bench.sql.js [tables=5000] [statements=20000]
const fs = require('fs'), os = require('os'), path = require('path');
const I = require('../lib/sqlimport.js');
const SS = require('../lib/sqlscript.js');
const SM = require('../media/model.js');
const N = +process.argv[2] || 5000, M = +process.argv[3] || 20000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-bench-sql-'));
const ddl = [], dml = [];
for (let i = 0; i < N; i++) {
  const s = 'sch' + (i % 25);
  ddl.push(`CREATE TABLE ${s}.t${i} (\n  id bigint NOT NULL,\n  code varchar(40) NOT NULL DEFAULT 'x',\n  parent_id bigint${i ? ` REFERENCES ${'sch' + ((i - 1) % 25)}.t${i - 1}(id)` : ''},\n  amount numeric(12,2),\n  qty int,\n  status text,\n  created_at timestamp DEFAULT now(),\n  note text,\n  PRIMARY KEY (id)\n);`);
  ddl.push(`COMMENT ON TABLE ${s}.t${i} IS 'Table number ${i}';`);
  ddl.push(`COMMENT ON COLUMN ${s}.t${i}.amount IS 'Amount of ${i}';`);
  ddl.push(`CREATE INDEX ix_t${i}_code ON ${s}.t${i} (code);`);
}
const t = (i) => `sch${i % 25}.t${i % N}`;
for (let i = 0; i < M; i++) {
  const a = (i * 7) % N, b = (i * 13 + 1) % N, k = i % 5;
  if (k === 0) dml.push(`SELECT x.status, sum(x.amount * x.qty) AS revenue_${i % 400}, count(distinct x.id) AS n FROM ${t(a)} x JOIN ${t(b)} y ON y.id = x.parent_id WHERE x.status = 'paid' AND x.created_at > '2024-01-01' GROUP BY 1;`);
  else if (k === 1) dml.push(`CREATE VIEW sch0.v${i} AS SELECT x.id, x.code, y.amount FROM ${t(a)} x LEFT JOIN ${t(b)} y ON y.id = x.parent_id;`);
  else if (k === 2) dml.push(`INSERT INTO ${t(a)} (id, code, amount) SELECT id, code, sum(amount) FROM ${t(b)} GROUP BY id, code;`);
  else if (k === 3) dml.push(`MERGE INTO ${t(a)} AS t USING ${t(b)} AS s ON t.id = s.id WHEN MATCHED THEN UPDATE SET amount = s.amount;`);
  else dml.push(`INSERT INTO ${t(a)} (id, code, amount) VALUES (${i}, 'c${i}', ${i}.5), (${i + 1}, 'it''s ${i}', NULL);`);
}
fs.writeFileSync(path.join(dir, 'ddl.sql'), ddl.join('\n'));
fs.writeFileSync(path.join(dir, 'dml.sql'), dml.join('\n'));
const mb = (f) => (fs.statSync(path.join(dir, f)).size / 1e6).toFixed(1) + ' MB';
console.log(`${N} tables (${mb('ddl.sql')}, ${ddl.length} statements), ${M} DML statements (${mb('dml.sql')})`);
const time = (label, fn) => { const t0 = process.hrtime.bigint(), r = fn(); console.log(label.padEnd(34), (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0).padStart(7), 'ms'); return r; };
const txt = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const d1 = txt('ddl.sql'), d2 = txt('dml.sql');
time('split DDL', () => SS.split(d1, 'postgres'));
time('split DML', () => SS.split(d2, 'postgres'));
time('detect dialect', () => SS.detect(d1 + d2));
const imp = time('read (DDL + DML, parse SELECTs)', () => I.readSql({ ddl: path.join(dir, 'ddl.sql'), dml: path.join(dir, 'dml.sql'), dialect: 'postgres', sampleRows: 0 }));
const r = time('merge into a new project', () => I.merge(I.fresh(imp, 'Bench'), imp));
console.log(`result: ${r.F.tables.length} tables, ${r.F.relationships.length} relationships, ${(r.F.semantic && r.F.semantic.metrics || []).length} metrics, ${r.changes.length} changes, ${r.notes.length} notes`);
time('merge again (re-sync)', () => { const r2 = I.merge(r.F, imp); console.log(`  second merge: ${r2.changes.length} changes (the 500-metric cap per import brings the next batch; everything else is idempotent)`); });
time('toFile(fromFile) round trip', () => SM.toFile(SM.fromFile(r.F)));
const proj = path.join(dir, 'project');
const made = time('importNew (read + merge + write project)', () => I.importNew({ ddl: path.join(dir, 'ddl.sql'), dml: path.join(dir, 'dml.sql'), dialect: 'postgres', dir: proj, name: 'Bench', git: false }));
console.log('  model file', (fs.statSync(made.model).size / 1e6).toFixed(1), 'MB, history', (fs.statSync(path.join(proj, 'history/bench.history.jsonl')).size / 1e6).toFixed(1), 'MB');
time('plan (re-sync: read, verify the log, merge)', () => { const p = I.plan(made.model); console.log(`  ${p.changes.length} changes`); });
console.log('heap', (process.memoryUsage().heapUsed / 1e6).toFixed(0), 'MB');
