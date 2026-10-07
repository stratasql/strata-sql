// Boilerplate ETL / ELT code from a model: an Apache Airflow DAG, Dagster assets or a Jupyter notebook. One task per table / view,
// ordered and wired by the load order (media/order.js: foreign keys, view reads, stages), scheduled from the SLAs, with a starting
// point for the SQL of each load (INSERT ... SELECT from a staging schema, or the view definition). Pure text generation, no DOM.
(function (g) {
  'use strict';
  const SM = typeof require !== 'undefined' && typeof module !== 'undefined' ? require('./model.js') : g.StrataModel;
  const O = typeof require !== 'undefined' && typeof module !== 'undefined' ? require('./order.js') : g.StrataOrder;

  const DIALECT = { 'SQL Server': 'sqlserver', PostgreSQL: 'postgres', MySQL: 'mysql', Oracle: 'oracle', SQLite: 'sqlite', Databricks: 'databricks', Snowflake: 'snowflake', 'Google BigQuery': 'bigquery', 'Trino/Presto': 'trino', DuckDB: 'duckdb' };
  const CONN = { sqlserver: 'mssql_default', postgres: 'postgres_default', mysql: 'mysql_default', oracle: 'oracle_default', sqlite: 'sqlite_default', databricks: 'databricks_default', snowflake: 'snowflake_default', bigquery: 'google_cloud_default', trino: 'trino_default', duckdb: 'duckdb_default' };
  // SQLAlchemy URL prefix / driver hint per platform, shown as a comment next to WAREHOUSE_URL
  const URL_HINT = { sqlserver: 'mssql+pyodbc://user:pass@host/db?driver=ODBC+Driver+18+for+SQL+Server', postgres: 'postgresql+psycopg2://user:pass@host:5432/db', mysql: 'mysql+pymysql://user:pass@host:3306/db', oracle: 'oracle+oracledb://user:pass@host:1521/?service_name=svc',
    sqlite: 'sqlite:///warehouse.db', databricks: 'databricks://token:<token>@<host>?http_path=<path>&catalog=<catalog>', snowflake: 'snowflake://user:pass@account/db/schema?warehouse=wh', bigquery: 'bigquery://project/dataset', trino: 'trino://user@host:8080/catalog', duckdb: 'duckdb:///warehouse.duckdb' };
  const quote = (d, s) => (d === 'sqlserver' ? `[${s}]` : ['mysql', 'bigquery', 'databricks'].includes(d) ? '`' + s + '`' : `"${s}"`);

  const ident = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  const pyStr = (s) => JSON.stringify(String(s)); // a JSON string is a valid single-line Python string literal
  const pyBlock = (s) => '"""' + String(s).replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"') + '"""'; // multi-line SQL
  const pyList = (a, indent) => (a.length ? '[' + a.map((x) => pyBlock(x)).join(', ') + ']' : '[]');

  // cron for a frequency; time is "HH:MM"
  function cron(freq, time) {
    const [h, m] = (time || '00:00').split(':').map(Number);
    return { minute: '* * * * *', hourly: '0 * * * *', daily: `${m} ${h} * * *`, weekly: `${m} ${h} * * 1`, biweekly: `${m} ${h} 1,15 * *`, monthly: `${m} ${h} 1 * *`, quarterly: `${m} ${h} 1 1,4,7,10 *`, yearly: `${m} ${h} 1 1 *` }[freq] || null; // realtime: not a schedule
  }

  // the neutral description of the pipeline all three targets render
  function plan(m, opts = {}) {
    if (!m.project) throw new Error('the model has no project yet');
    const o = O.analyse(m), R = SM.refs(m), byId = new Map(m.tables.map((t) => [t.id, t]));
    const dialect = DIALECT[m.project.technology] || 'postgres', q = (s) => quote(dialect, s), qual = (ref) => ref.split('.').map(q).join('.');
    const mode = opts.mode === 'replace' ? 'replace' : 'append', staging = opts.staging || 'staging';
    const inCycle = (a, b) => o.cycles.some((c) => c.includes(a) && c.includes(b));
    const hh = O.hhmm;

    const tasks = [];
    for (const st of o.stages) for (const id of st.ids) {
      const t = byId.get(id), ref = R.tab.get(id), a = o.avail.get(id), parts = ref.split('.');
      const stg = (parts.length === 3 ? q(parts[0]) + '.' : '') + q(staging) + '.' + q(t.name); // <catalog>.<staging>.<table>
      let statements;
      if (t.kind === 'view') {
        const vt = t.viewType || 'view';
        if (vt === 'materialized') statements = [dialect === 'oracle' ? `BEGIN DBMS_MVIEW.REFRESH('${parts.slice(-2).join('.').replace(/'/g, "''")}'); END;` : dialect === 'snowflake' ? `ALTER MATERIALIZED VIEW ${qual(ref)} REFRESH` : `REFRESH MATERIALIZED VIEW ${qual(ref)}`];
        else if (vt === 'temporary') statements = ['SELECT 1  -- temporary view: it lives in the session that creates it, nothing to load'];
        else if (!t.definition) statements = ['SELECT 1  -- TODO: add the view definition to the model'];
        else statements = dialect === 'sqlite' ? [`DROP VIEW IF EXISTS ${qual(ref)}`, `CREATE VIEW ${qual(ref)} AS\n${t.definition}`] : [`${dialect === 'sqlserver' ? 'CREATE OR ALTER VIEW' : 'CREATE OR REPLACE VIEW'} ${qual(ref)} AS\n${t.definition}`];
      } else {
        const cols = t.columns.map((c) => q(c.name)).join(', ');
        statements = [...(mode === 'replace' ? [`DELETE FROM ${qual(ref)}`] : []), `-- TODO: point the source at where the raw data lands\nINSERT INTO ${qual(ref)} (${cols})\nSELECT ${cols}\nFROM ${stg}`];
      }
      tasks.push({
        id: ref, name: t.name, schema: parts.slice(0, -1).join('.'), kind: t.kind === 'view' ? (t.viewType === 'materialized' ? 'materialized view' : t.viewType === 'temporary' ? 'temporary view' : 'view') : 'table',
        stage: o.stage.get(id), deps: [...o.deps.get(id).keys()].filter((d) => !inCycle(id, d)).map((d) => R.tab.get(d)).sort(), statements,
        slaText: t.sla ? (t.sla.exclude ? 'out of SLA (static / reference)' : `${t.sla.frequency}${t.sla.time ? ' ' + t.sla.time : ''}`) : '',
        reference: !!(t.sla && t.sla.exclude), readyBy: a.ready != null ? hh(a.ready) : '', slaMinutes: a.ready != null && o.beginsAt != null && a.ready >= o.beginsAt ? a.ready - o.beginsAt : null,
        cycle: o.cycles.some((c) => c.includes(id)), selfRef: o.selfRefs.has(id),
      });
    }
    // schedule: the fastest cadence among the SLAs (realtime has no schedule), starting when the pipeline's first data is due
    const freqs = tasks.filter((t) => !t.reference && t.slaText).map((t) => t.slaText.split(' ')[0]);
    const order = ['minute', 'hourly', 'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
    const freq = order.find((f) => freqs.includes(f)) || null;
    const begin = o.beginsAt != null ? hh(o.beginsAt) : '';
    return {
      name: m.project.name, slug: ident(m.project.name.toLowerCase()).replace(/_+/g, '_').replace(/^_|_$/g, '') || 'model', technology: m.project.technology, dialect, mode, staging, conn: CONN[dialect] || 'strata_default', urlHint: URL_HINT[dialect] || '',
      tasks, stages: o.stages.length, widest: o.widest, cycles: o.cycles.map((c) => c.map((id) => R.tab.get(id))), readyBy: o.readyBy != null ? hh(o.readyBy) : '', begin,
      schedule: { frequency: freq, cron: freq ? cron(freq, begin) : null, mixed: new Set(freqs).size > 1 },
    };
  }

  const header = (p, what) => `Generated by Strata SQL from the model "${p.name}" (${p.technology}): ${p.tasks.length} tables and views in ${p.stages} load stages, up to ${p.widest} in parallel.\n${what}`;
  const sqlDoc = (t) => [t.kind, t.slaText && 'SLA ' + t.slaText, t.readyBy && 'ready by ' + t.readyBy, t.reference && 'static / reference data', t.cycle && 'part of a circular dependency: load these together, add foreign keys afterwards', t.selfRef && 'references itself'].filter(Boolean).join(' · ');
  const taskNote = (p) => [p.schedule.mixed && `The SLAs mix several cadences (${[...new Set(p.tasks.filter((t) => !t.reference && t.slaText).map((t) => t.slaText.split(' ')[0]))].join(', ')}); the schedule follows the fastest, so slower tables run more often than their SLA: split them into their own ${'DAG / job'} if that matters.`, p.cycles.length && `Circular dependencies (no edge between the members): ${p.cycles.map((c) => c.join(' <-> ')).join('; ')}.`].filter(Boolean);

  // ---------- Apache Airflow ----------
  function airflow(p) {
    const stages = [];
    p.tasks.forEach((t) => { (stages[t.stage - 1] = stages[t.stage - 1] || []).push(t); });
    const entries = stages.map((ts, i) => `    # Stage ${i + 1}: ${ts.length > 1 ? `${ts.length} tasks can run in parallel` : 'one task'}\n` + ts.map((t) => `    (\n        ${pyStr(t.id)},  # ${sqlDoc(t)}\n        ${pyList(t.statements)},\n        ${JSON.stringify(t.deps)},\n        ${t.slaMinutes == null ? 'None' : t.slaMinutes},\n        ${t.reference ? 'True' : 'False'},\n    ),`).join('\n')).join('\n');
    return `"""${header(p, 'An Apache Airflow DAG: one SQL task per table / view, wired by the load order (a foreign key or a view read means "load after").')}
${taskNote(p).map((x) => '\n' + x).join('')}
Edit: the connection id, the staging schema in the SQL, the schedule and the start date. Times in the SLAs are when data must be READY, so start the DAG earlier.
Needs apache-airflow-providers-common-sql and the provider for ${p.technology}. \`sla=\` is Airflow 2.x: remove it on Airflow 3.
"""
from __future__ import annotations

from datetime import timedelta

import pendulum
from airflow import DAG
from airflow.providers.common.sql.operators.sql import SQLExecuteQueryOperator

CONN_ID = ${pyStr(p.conn)}  # Airflow connection to ${p.technology}
SKIP_REFERENCE = False  # True: leave out tables marked "out of SLA" (static / reference data, usually loaded once)

# (task_id, SQL statements, upstream task ids, SLA in minutes after the DAG starts, is reference data)
LOADS = [
${entries}
]

with DAG(
    dag_id=${pyStr(p.slug + '_load')},
    description=${pyStr('Load ' + p.name + ' (generated by Strata SQL)')},
    schedule=${p.schedule.cron ? pyStr(p.schedule.cron) : 'None'},  # ${p.schedule.frequency ? `${p.schedule.frequency}, from the SLAs${p.begin ? ` (first data due ${p.begin})` : ''}` : 'no clock-time SLA in the model: trigger it yourself or set a cron'}
    start_date=pendulum.datetime(2025, 1, 1, tz="UTC"),
    catchup=False,
    max_active_tasks=${Math.max(p.widest, 1)},  # the widest stage
    default_args={"retries": 1, "retry_delay": timedelta(minutes=5)},
    tags=["strata", ${pyStr(p.dialect)}],
) as dag:
    tasks = {}
    for task_id, statements, _upstream, sla_minutes, is_reference in LOADS:
        if is_reference and SKIP_REFERENCE:
            continue
        tasks[task_id] = SQLExecuteQueryOperator(
            task_id=task_id,
            conn_id=CONN_ID,
            sql=statements,
            sla=timedelta(minutes=sla_minutes) if sla_minutes is not None else None,
        )
    for task_id, _statements, upstream, _sla, _ref in LOADS:
        for up in upstream:
            if task_id in tasks and up in tasks:
                tasks[up] >> tasks[task_id]
`;
  }

  // ---------- Dagster ----------
  function dagster(p) {
    const seen = new Set();
    const fn = (t) => { let n = 'load_' + ident(t.id), k = 2; while (seen.has(n)) n = 'load_' + ident(t.id) + '_' + k++; seen.add(n); return n; };
    const key = (ref) => '[' + ref.split('.').map(pyStr).join(', ') + ']';
    const assets = p.tasks.map((t) => ({ t, fn: fn(t) }));
    const body = assets.map(({ t, fn: f }) => `@dg.asset(
    key=dg.AssetKey(${key(t.id)}),
    deps=[${t.deps.map((d) => `dg.AssetKey(${key(d)})`).join(', ')}],
    group_name=${pyStr(ident(t.schema))},
    metadata={"stage": ${t.stage}, "kind": ${pyStr(t.kind)}, "sla": ${pyStr(t.slaText)}, "ready_by": ${pyStr(t.readyBy)}},
    description=${pyStr(sqlDoc(t))},
)
def ${f}(warehouse: Warehouse) -> None:
    warehouse.execute(${pyList(t.statements)})
`).join('\n\n');
    const ref = assets.filter(({ t }) => t.reference);
    return `"""${header(p, 'Dagster assets: one asset per table / view, with dependencies from the load order (foreign keys, view reads).')}
${taskNote(p).map((x) => '\n' + x).join('')}
Run: dagster dev -f <this file>   (needs dagster, dagster-webserver, sqlalchemy and the driver for ${p.technology}).
Set WAREHOUSE_URL, for example ${p.urlHint || 'a SQLAlchemy URL'}.
"""
import dagster as dg
from sqlalchemy import create_engine, text


class Warehouse(dg.ConfigurableResource):
    """Runs SQL statements against ${p.technology}. Replace with your IO manager / resource if you have one."""

    url: str

    def execute(self, statements: list[str]) -> None:
        engine = create_engine(self.url)
        with engine.begin() as conn:
            for statement in statements:
                conn.execute(text(statement))


${body}

# Static / reference tables (marked "out of SLA") are left out of the schedule; run strata_reference_load by hand when they change.
REFERENCE = [${ref.map(({ t }) => `dg.AssetKey(${key(t.id)})`).join(', ')}]

strata_load = dg.define_asset_job("strata_load", selection=dg.AssetSelection.all() - dg.AssetSelection.assets(*REFERENCE))
strata_reference_load = dg.define_asset_job("strata_reference_load", selection=dg.AssetSelection.assets(*REFERENCE))

defs = dg.Definitions(
    assets=[${assets.map((a) => a.fn).join(', ')}],
    jobs=[strata_load${ref.length ? ', strata_reference_load' : ''}],
    schedules=[${p.schedule.cron ? `dg.ScheduleDefinition(job=strata_load, cron_schedule=${pyStr(p.schedule.cron)})` : ''}],${p.schedule.cron ? `  # ${p.schedule.frequency}${p.begin ? `, first data due ${p.begin}` : ''}` : ''}
    resources={"warehouse": Warehouse(url=dg.EnvVar("WAREHOUSE_URL"))},
)
`;
  }

  // ---------- Jupyter notebook ----------
  function notebook(p) {
    const md = (s) => ({ cell_type: 'markdown', metadata: {}, source: s.split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l)) });
    const code = (s) => ({ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: s.split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l)) });
    const stages = [];
    p.tasks.forEach((t) => { (stages[t.stage - 1] = stages[t.stage - 1] || []).push(t); });
    const cells = [
      md(`# ${p.name}: load ${p.technology}\n\n${header(p, 'Run the cells top to bottom: each stage runs after the one before, and the tables inside a stage run in parallel.')}\n\n${p.schedule.cron ? `Suggested schedule: \`${p.schedule.cron}\` (${p.schedule.frequency}${p.begin ? `, first data due ${p.begin}` : ''}).` : 'No clock-time SLA in the model, so no schedule is suggested.'}${p.readyBy ? ` Pipeline ready by **${p.readyBy}**.` : ''}\n${taskNote(p).map((x) => '\n- ' + x).join('')}\n\n| Stage | Tables and views | Needs |\n|---|---|---|\n${p.tasks.map((t) => `| ${t.stage} | \`${t.id}\` (${t.kind}${t.slaText ? ', ' + t.slaText : ''}) | ${t.deps.map((d) => '`' + d + '`').join(', ') || '-'} |`).join('\n')}`),
      code(`import os\nfrom concurrent.futures import ThreadPoolExecutor\n\nfrom sqlalchemy import create_engine, text\n\nDRY_RUN = True  # True: only print the SQL. Set False and WAREHOUSE_URL to run it.\nWAREHOUSE_URL = os.environ.get("WAREHOUSE_URL", "")  # e.g. ${p.urlHint || 'a SQLAlchemy URL'}\nengine = None if DRY_RUN else create_engine(WAREHOUSE_URL)\n\n\ndef run(name, statements):\n    """Run the statements of one table / view."""\n    if DRY_RUN:\n        print(f"-- {name}")\n        print(";\\n".join(statements) + ";\\n")\n        return name\n    with engine.begin() as conn:\n        for statement in statements:\n            conn.execute(text(statement))\n    return name\n\n\ndef run_stage(number, loads):\n    """The tables of a stage do not depend on each other: run them in parallel."""\n    with ThreadPoolExecutor(max_workers=len(loads)) as pool:\n        done = list(pool.map(lambda item: run(*item), loads.items()))\n    print(f"stage {number} done: {len(done)} loaded")`),
    ];
    stages.forEach((ts, i) => {
      cells.push(md(`## Stage ${i + 1}: ${ts.length > 1 ? `${ts.length} tables load in parallel` : 'one table'}\n\n${ts.map((t) => `- \`${t.id}\`: ${sqlDoc(t)}${t.deps.length ? '. Needs ' + t.deps.map((d) => '`' + d + '`').join(', ') : ''}`).join('\n')}`));
      cells.push(code(`STAGE_${i + 1} = {\n${ts.map((t) => `    ${pyStr(t.id)}: ${pyList(t.statements)},`).join('\n')}\n}\nrun_stage(${i + 1}, STAGE_${i + 1})`));
    });
    return { cells, metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 4 };
  }

  const TARGETS = { airflow: { label: 'Apache Airflow DAG', ext: 'py', suffix: '_dag' }, dagster: { label: 'Dagster assets', ext: 'py', suffix: '_dagster' }, notebook: { label: 'Jupyter notebook', ext: 'ipynb', suffix: '_load' } };
  // -> { name, text }
  function generate(m, target, opts) {
    const t = TARGETS[target];
    if (!t) throw new Error('unknown target ' + target + ' (airflow, dagster or notebook)');
    const p = plan(m, opts);
    return { name: p.slug + t.suffix + '.' + t.ext, text: target === 'airflow' ? airflow(p) : target === 'dagster' ? dagster(p) : JSON.stringify(notebook(p), null, 1) + '\n' };
  }

  const api = { plan, generate, cron, TARGETS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else g.StrataCodegen = api;
})(typeof window !== 'undefined' ? window : globalThis);
