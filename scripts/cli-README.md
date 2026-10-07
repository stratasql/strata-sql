<h1>
  <a href="https://stratasql.com"><img src="https://raw.githubusercontent.com/stratasql/strata-sql/HEAD/media/icon.png" alt="Strata SQL logo" width="44" height="44" align="absmiddle"></a>
  <a href="https://stratasql.com">Strata SQL</a>
</h1>

**Model, govern and version your data as plain files in Git** — on the command line and in your browser.

- **See it.** A visual editor for your database at four linked levels: business concepts, logical entities, physical tables, and the metrics built on them.
- **Start from what you have.** Import a dbt project or SQL scripts, or begin from a sample (Northwind, FpML, a star schema).
- **Govern it.** Owners, stewards, classification and policies on every level, with impact analysis and load order.
- **Keep it in Git.** The model is one readable `.model.json`; its version history is a hash-chained log that Git merges without conflicts.
- **No server, no account.** Plain files; the editor runs on your machine. Also a VS Code extension and a Docker image.

![A Strata SQL canvas: Northwind tables with relationships, and the hover card showing a column's classification, owner and policies](https://raw.githubusercontent.com/stratasql/strata-sql/HEAD/media/help/canvas.png)

## Try it in 30 seconds

Needs Node.js 20 or newer.

```
npx @stratasql/strata-sql live --demo
```

It opens the sample models in your browser. Nothing is saved: your changes, and the versions they create, stay in the browser tab and are discarded when you close it.

## Use it on your project

```
npm install -g @stratasql/strata-sql      # the command is strata-sql
strata-sql init --name "Sales" --template star --dir ./sales
cd sales && strata-sql live               # the project's model, in your browser
```

Or start from what you have:

```
strata-sql import-dbt --from ./analytics                      # a dbt project (run `dbt parse` first)
strata-sql import-sql --ddl schema.sql --dml reports.sql      # CREATE TABLE scripts and queries, eleven dialects
```

Both can be run again later to re-sync: what you added is never deleted, and `--dry-run` shows what would change.

## Work as a team, through Git

There is no live co-editing: you collaborate with branches and pull requests, like code. Commit `data_models/`, `history/`, `strata.project.json` and `.gitattributes` (`strata-sql init` writes it, with `history/*.jsonl merge=union`), and keep `.strata/` out. The model is sorted, compact JSON, so a pull request shows a new table or column as a few added lines, and each history file merges without conflict markers. If two branches changed the same object, the editor names it and **Record the merge** joins the histories. See the [collaboration guide](https://github.com/stratasql/strata-sql/blob/HEAD/help.md#collaboration).

## Commands

| Command | What it does |
|---|---|
| `live --demo` | Opens the sample models to explore, no project needed. Nothing is saved |
| `init` | Creates a project: a blank model, or a sample (`northwind`, `fpml`, `star`). Refuses to overwrite |
| `live [<model.json>]` | Opens the editor in your browser: canvas, governance, impact, version history. A local-only server prints a link with an access token; Ctrl+C stops it. Edits are saved to the model file and its version log |
| `import-dbt` | Reads dbt's `target/manifest.json` into tables, columns, relationships and starter metrics |
| `import-sql` | Reads `CREATE TABLE` scripts and query files. It reads SQL, it never runs it and never connects to a database |
| `split` / `join` | Split a project into one part per domain, or join the parts back into one |

`strata-sql --help` and `strata-sql <command> --help` print every option. Set `STRATA_TOKEN` (16+ letters, digits, `-` or `_`) to keep the same `live` link between runs.

## What you get in the editor

- **Four linked levels** — conceptual, logical, physical and a semantic layer of metrics, in one file.
- **Ten database technologies** — PostgreSQL, SQL Server, MySQL, Oracle, SQLite, Snowflake, Google BigQuery, Databricks, Trino/Presto, DuckDB.
- **Governance** — tags and policies with parents, owners, stewards, criticality, lifecycle and classification.
- **Impact analysis and load order** — what breaks if you change something; which tables load first.
- **A history you can trust** — three streams, undo and redo, preview, hash-chained entries.
- **Export** — an Airflow DAG, Dagster assets or a Jupyter notebook; one self-contained interactive HTML file.
- **AI-ready** — a compact, readable model file.

Local embedding models (optional semantic search) are not part of this package; hosted providers with your own key still work. `STRATA_SQL_PARSER=off` skips the bundled SQL parser and uses the simple SQL reader.

## Links

[stratasql.com](https://stratasql.com) · [Source and issues](https://github.com/stratasql/strata-sql) · [VS Code extension](https://marketplace.visualstudio.com/items?itemName=strata-sql.strata-sql) · Apache-2.0
