#!/usr/bin/env node
// Stages the npm package of the command line into dist/cli: node scripts/build-cli.js
// The extension and the command line share one repository, but npm users need neither VS Code nor the local-embeddings library (hundreds of MB),
// so the package is built from exactly the files cli.js can load (found by following its require() calls), the shipped templates, and the SQL parser
// of the imports, copied the way the VSIX ships it (one file, ~2.5 MB instead of the ~90 MB npm install). Publish with `npm run cli:publish`.
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const { builtinModules } = require('module');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist', 'cli');
const pkg = require('../package.json');
const NAME = require('../package.json').config.npmName, CMD = 'strata-sql'; // the npm package is scoped (`strata` is taken on npm); the command keeps the short name
const PARSER = { 'node-sql-parser': ['package.json', 'LICENSE', 'index.js'], 'big-integer': ['package.json', 'LICENSE', 'BigInteger.js'] }; // what the VSIX ships (.vscodeignore)

// 1. every file cli.js can load, by following its require() calls; anything that is not a builtin, a relative file or the parser stops the build.
// The one exception is the local-embeddings library: media/embed.js loads it lazily inside a try / catch, so the live view runs without it (that
// one search option then says it is not installed).
const OPTIONAL = new Set(['@huggingface/transformers']);
const files = new Set(), todo = ['cli.js'];
while (todo.length) {
  const rel = todo.pop();
  if (files.has(rel)) continue;
  files.add(rel);
  const code = fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const [, id] of code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (id.startsWith('.')) { const r = path.join(path.dirname(rel), id.endsWith('.js') || id.endsWith('.json') ? id : id + '.js'); if (r.endsWith('.js')) todo.push(r); else files.add(r); }
    else if (!builtinModules.includes(id.replace(/^node:/, '')) && !PARSER[id] && !OPTIONAL.has(id)) throw new Error(`${rel} requires "${id}", which the command line package does not ship`);
  }
}

// 2. the project templates (lib/project.js reads them from sample_data_models/ in the package)
const { TEMPLATES } = require('../lib/project.js');
// the live view (`strata-sql live`) serves media/ (scripts, styles, help images) and renders help.md at run time, so both ship whole
const copies = [...files, 'media', 'help.md'];
for (const t of Object.keys(TEMPLATES).filter((t) => t !== 'blank')) {
  for (const f of [`${t}.model.json`, `${t}.model.history.jsonl`, `${t}.model.layout.json`, `${t}_model_data`].map((x) => `sample_data_models/${x}`)) if (fs.existsSync(path.join(root, f))) copies.push(f);
}
if (fs.existsSync(path.join(root, 'LICENSE'))) copies.push('LICENSE');

fs.rmSync(out, { recursive: true, force: true });
for (const f of copies) {
  fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
  fs.cpSync(path.join(root, f), path.join(out, f), { recursive: true });
}
fs.copyFileSync(path.join(__dirname, 'cli-README.md'), path.join(out, 'README.md'));
fs.chmodSync(path.join(out, 'cli.js'), 0o755);

// 3. the parser, trimmed like the VSIX, without its type-only dependency. node_modules is not in Git: use the repository's copy when `npm ci` was run,
// else download just these two packages, at the versions package-lock.json pins, into dist/.deps (cached there; ~90 MB instead of the full ~570 MB install)
const bundled = Object.keys(PARSER);
let modules = path.join(root, 'node_modules');
if (!bundled.every((d) => fs.existsSync(path.join(modules, d, PARSER[d][2])))) {
  const lock = require('../package-lock.json').packages, deps = path.join(root, 'dist', '.deps');
  modules = path.join(deps, 'node_modules');
  if (!bundled.every((d) => fs.existsSync(path.join(modules, d, PARSER[d][2])))) {
    console.log('downloading the SQL parser (not installed here) ...');
    cp.execFileSync('npm', ['install', '--prefix', deps, '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', ...bundled.map((d) => `${d}@${lock['node_modules/' + d].version}`)], { stdio: 'inherit' });
  }
}
for (const [dep, list] of Object.entries(PARSER)) {
  const from = path.join(modules, dep);
  for (const f of list) { fs.mkdirSync(path.join(out, 'node_modules', dep), { recursive: true }); fs.copyFileSync(path.join(from, f), path.join(out, 'node_modules', dep, f)); }
}
const parserPkg = path.join(out, 'node_modules', 'node-sql-parser', 'package.json');
const pp = JSON.parse(fs.readFileSync(parserPkg, 'utf8')); delete pp.dependencies['@types/pegjs']; delete pp.devDependencies; delete pp.scripts; delete pp.files;
fs.writeFileSync(parserPkg, JSON.stringify(pp, null, 2) + '\n');

// 4. the manifest: the version follows the extension's
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({
  name: NAME,
  version: pkg.version,
  description: 'Strata SQL on the command line and in your browser: model, govern and version data models as plain files in Git; import dbt and SQL; try the demo with one command.',
  keywords: ['data-modeling', 'data-modelling', 'data-model', 'er-diagram', 'entity-relationship', 'schema', 'sql', 'ddl', 'dbt', 'data-governance', 'data-lineage', 'data-catalog', 'semantic-layer', 'metrics', 'data-warehouse', 'model-as-code', 'git', 'llm', 'cli', 'snowflake', 'bigquery', 'databricks', 'postgresql', 'duckdb', 'airflow', 'dagster'],
  homepage: pkg.homepage,
  repository: pkg.repository,
  bugs: pkg.bugs,
  license: pkg.license,
  bin: { [CMD]: 'cli.js' },
  engines: { node: '>=20' },
  dependencies: { 'node-sql-parser': pp.version, 'big-integer': JSON.parse(fs.readFileSync(path.join(out, 'node_modules', 'big-integer', 'package.json'), 'utf8')).version },
  bundleDependencies: bundled,
}, null, 2) + '\n');

console.log(`dist/cli: ${NAME}@${pkg.version}, ${copies.length} entries from the repository (${[...files].join(', ')}) + the SQL parser`);
