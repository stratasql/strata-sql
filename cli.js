#!/usr/bin/env node
// Strata SQL on the command line (npm: `strata-sql`; the command is `strata-sql`). Everything the New Project wizard does is here too, plus the
// browser editor: init, live, import-dbt, import-sql, split, join. `strata-sql --help` lists them, `strata-sql <command> --help` explains one.
// Node built-ins only; the same lib/project.js the wizard uses.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const project = require('./lib/project.js');
const dbt = require('./lib/dbt.js');
const sqlimport = require('./lib/sqlimport.js');
const SM = require('./media/model.js');
const BRAND = require('./media/brand.js');

const git = (key) => { try { return cp.execFileSync('git', ['config', '--get', key], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const user = () => ({ name: git('user.name') || os.userInfo().username, email: git('user.email'), system: os.hostname() });


// ---------- help: one table drives `strata-sql --help` and `strata-sql <command> --help` ----------
const PLATFORMS = Object.keys(SM.PLATFORMS).join(', '), METHODS = SM.METHODS.join(', ');
const COMMANDS = {
  init: { about: 'Create a project: blank, or from a sample', usage: 'strata-sql init [options]',
    options: [['--name <name>', "Project name (default: the folder's name)"], ['--dir <folder>', 'Where to create it (default: this folder)'],
      ['--template <id>', `${Object.keys(project.TEMPLATES).join(' | ')} (default: blank)`], ['--platform <database>', 'Blank projects only: ' + PLATFORMS], ['--methodology <method>', 'Blank projects only: ' + METHODS],
      ['--no-git', 'Do not write .gitattributes and .gitignore'], ['--ignore-layout', 'Git-ignore the card-position files']],
    notes: ['Never overwrites anything.'], examples: ['strata-sql init --name "Sales" --template star --dir ./sales'] },
  live: { about: 'Open the editor in your browser', usage: 'strata-sql live [<model.json>] [options]',
    options: [['<model.json>', "The model to open (default: the project's model in --dir)"], ['--dir <folder>', 'A project folder (default: this folder)'], ['--port <n>', 'Port (default: a free one)'],
      ['--host <address>', 'Address to listen on (default: 127.0.0.1, this computer only; 0.0.0.0 for Docker)'], ['--no-open', 'Only print the link, do not open the browser'],
      ['--demo', 'Try the sample models instead of a project: nothing is saved, changes stay in the browser tab (STRATA_DEMO=1 does the same)']],
    notes: ['Prints a link with an access token. Edits are saved to the model file and its version log, as in VS Code. Ctrl+C stops it.',
      'Set STRATA_TOKEN (16+ letters, digits, - or _) to keep the same link between runs.'],
    examples: ['strata-sql live', 'strata-sql live shop.model.json --port 8787', 'strata-sql live --demo'] },
  'import-dbt': { about: 'Import a dbt project (needs target/manifest.json)', usage: 'strata-sql import-dbt --from <dbt project | manifest.json> [options]',
    options: [['--from <path>', 'The dbt project folder, or its manifest.json (optional once the project remembers it)'], ['--catalog <catalog.json>', 'Column types from `dbt docs generate`'],
      ['--dir <folder>', 'The project folder (default: this folder)'], ['--name <name>', 'Name of a new project'], ['--model <file>', 'Re-sync this model instead'],
      ['--all-packages', 'Also import tables of installed dbt packages'], ['--dry-run', 'Show what would change, write nothing'], ['--verbose', 'List every change, not the first few']],
    notes: ['Run `dbt parse` first if there is no manifest. In a folder with no project it creates one; otherwise it re-syncs: adds what is new, updates what dbt owns, never deletes or overwrites your work.'],
    examples: ['strata-sql import-dbt --from ./analytics --name "Jaffle Shop" --dry-run'] },
  'import-sql': { about: 'Import CREATE TABLE scripts and queries', usage: 'strata-sql import-sql --ddl <files|folders...> [options]',
    options: [['--ddl <paths...>', 'Schema scripts (CREATE / ALTER), files or folders'], ['--dml <paths...>', 'Query scripts (SELECT, views, INSERT ... SELECT): metrics, joins and lineage'],
      ['--dialect <name>', `One of ${sqlimport.DIALECTS.join(', ')} (default: detected)`], ['--dir <folder>', 'The project folder (default: this folder)'], ['--name <name>', 'Name of a new project'],
      ['--model <file>', 'Re-sync this model instead'], ['--sample-rows <n>', 'Also import the first n INSERT ... VALUES rows as sample data (0 to 100000)'],
      ['--dry-run', 'Show what would change, write nothing'], ['--verbose', 'List every change, not the first few']],
    notes: ['Reads SQL, never runs it and never connects to a database. In a folder with no project it creates one; otherwise it re-syncs and never deletes your work.'],
    examples: ['strata-sql import-sql --ddl schema.sql --dml reports.sql --dry-run'] },
  split: { about: 'Split a project into one file per domain', usage: 'strata-sql split --model <file.model.json>',
    options: [['--model <file>', 'The project model to split']],
    notes: ['Needs domains in the project manifest. Adds _shared and _unassigned parts; the original files stay on disk. Refuses, writing nothing, if a target already exists.'], examples: ['strata-sql split --model data_models/shop/shop.model.json'] },
  join: { about: 'Join the parts of a split project back into one', usage: 'strata-sql join [--dir <folder>]',
    options: [['--dir <folder>', 'The project folder (default: this folder)']], notes: ['The split parts stay on disk.'], examples: ['strata-sql join'] },
};
const pad = (rows) => { const w = Math.max(...rows.map((r) => r[0].length)) + 2; return rows.map(([a, b]) => '  ' + a.padEnd(w) + b).join('\n'); };
function helpFor(cmd) {
  if (!cmd) return `${BRAND.name} ${require('./package.json').version}: model, govern and version your data.\n\nUsage: strata-sql <command> [options]\n\nCommands:\n${pad(Object.entries(COMMANDS).map(([k, c]) => [k, c.about]))}\n`
    + `\nGet started:\n  strata-sql init --template northwind\n  strata-sql live\n\nHelp for one command: strata-sql <command> --help\n${BRAND.url}`;
  const c = COMMANDS[cmd];
  return `strata-sql ${cmd}: ${c.about}\n\nUsage: ${c.usage}\n\nOptions:\n${pad(c.options)}\n\n${c.notes.join('\n')}\n\nExample:\n${c.examples.map((e) => '  ' + e).join('\n')}`;
}
const rel = (p) => path.relative(process.cwd(), p) || '.';
// a list of lines, the first few unless --verbose
const some = (lines, o, n = 8) => (o.verbose || lines.length <= n + 1 ? lines : [...lines.slice(0, n), `... and ${lines.length - n} more (--verbose lists all)`]).map((l) => '  ' + l).join('\n');
const next = (o, cmd) => `\nNext: ${cmd}`;

function parse(argv, extra = [], positional = false) {
  const o = {}, flags = ['no-git', 'ignore-layout', 'dry-run', 'all-packages', 'no-open', 'verbose', 'demo'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { if (positional && o.file === undefined) { o.file = a; continue; } throw new Error(`unexpected "${a}"`); }
    const k = a.slice(2);
    if (k === 'ddl' || k === 'dml') { // several files: --ddl a.sql b.sql, or the option again
      const list = o[k] || (o[k] = []);
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) list.push(argv[++i]);
      if (!list.length) throw new Error(`--${k} needs a file or folder`);
    } else if (flags.includes(k)) o[k] = true;
    else if (['name', 'dir', 'template', 'platform', 'methodology', ...extra].includes(k)) { if (argv[i + 1] === undefined) throw new Error(`--${k} needs a value`); o[k] = argv[++i]; }
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

// the file `strata-sql live` opens: the one given, else the project's index file or its only part, else the only *.model.json in the folder
function liveTarget(o) {
  if (o.file) { const f = path.resolve(o.file); if (!fs.existsSync(f)) throw new Error('no such file: ' + o.file); return f; }
  const dir = path.resolve(o.dir || '.'), man = project.readManifest(dir);
  if (man && man.index) return path.resolve(dir, man.index);
  const found = man && Array.isArray(man.parts) && man.parts.length ? man.parts.filter((p) => p && p.model).map((p) => path.resolve(dir, p.model))
    : fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.model.json') && !project.isArchived(f)).map((f) => path.join(dir, f)) : [];
  if (found.length === 1) return found[0];
  throw new Error(found.length ? 'several models here, name one: strata-sql live <file.model.json>\n  ' + found.map(rel).join('\n  ') : `no model found in ${rel(dir)} (give a .model.json file, or --dir <project folder>)`);
}

async function live(o) {
  try {
    const port = o.port === undefined ? 0 : +o.port, host = o.host || '127.0.0.1', token = process.env.STRATA_TOKEN || undefined;
    if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) throw new Error('--port needs a whole number from 0 to 65535');
    if (o.file && /^(localhost|[\d.]+|[\da-f:]+:[\da-f:]*)$/i.test(o.file)) throw new Error(`"${o.file}" is an address, not a model: use --host ${o.file}`);
    const demo = o.demo || /^(1|true|yes)$/i.test(process.env.STRATA_DEMO || ''), { startLive, startDemo, openBrowser } = require('./lib/live.js'); // loaded here: the other commands stay light
    if (demo && (o.file || o.dir)) throw new Error('--demo opens the sample models, not a project: leave the model and --dir out');
    const file = demo ? null : liveTarget(o), srv = demo ? await startDemo({ port, host, token }) : await startLive({ file, port, host, token });
    console.log((demo ? `${BRAND.name} demo: pick a sample model in the browser\n  ${srv.url}\n  Ctrl+C to stop. Nothing is saved: your changes stay in the browser tab and are discarded when you close it.`
      : `${BRAND.name} live view: ${path.basename(file)}\n  ${srv.url}\n  Ctrl+C to stop. Edits are saved to the model file and its version log.`)
      + (srv.open ? `\n  Listening on ${host}: anyone who can reach this port and has the link can ${demo ? 'use the demo' : 'edit the model'}, over plain HTTP. Publish the port to this computer only, or put TLS in front.` : ''));
    if (!o['no-open']) openBrowser(srv.url);
    process.on('SIGINT', async () => { await srv.close(); process.exit(0); });
    process.on('SIGTERM', async () => { await srv.close(); process.exit(0); });
  } catch (err) { console.error('strata-sql: ' + (err.code === 'EADDRINUSE' ? 'that port is in use; leave --port out to pick a free one' : err.message)); return 1; }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--version' || cmd === '-v') { console.log(require('./package.json').version); return 0; }
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(helpFor()); return 0; }
  if (cmd === 'help') { console.log(helpFor(COMMANDS[rest[0]] ? rest[0] : undefined)); return 0; }
  if (!COMMANDS[cmd]) { console.error(`strata-sql: unknown command "${cmd}"\n\n${helpFor()}`); return 2; }
  if (rest.includes('--help') || rest.includes('-h')) { console.log(helpFor(cmd)); return 0; }
  let o;
  try { o = parse(rest, cmd === 'split' ? ['model'] : cmd === 'import-dbt' ? ['model', 'from', 'catalog'] : cmd === 'import-sql' ? ['model', 'dialect', 'sample-rows'] : cmd === 'live' ? ['port', 'host'] : [], cmd === 'live'); }
  catch (err) { console.error(`strata-sql: ${err.message}\nRun "strata-sql ${cmd} --help" for the options.`); return 2; }
  if (cmd === 'live') return live(o); // a promise: the server keeps the process alive
  try {
    const dir = path.resolve(o.dir || '.'), where = dir === process.cwd() ? '' : ` --dir ${rel(dir)}`;
    if (cmd === 'init') {
      const template = o.template || 'blank', name = o.name || path.basename(dir);
      const r = project.create({ dir, name, template, platform: o.platform, methodology: o.methodology, git: !o['no-git'], ignoreLayout: !!o['ignore-layout'], user: user() });
      const others = r.files.filter((f) => f !== r.model).map(rel);
      console.log(`Created "${name}" (${template}) in ${rel(dir)}\n  ${rel(r.model)}\n` + (others.length ? some(others, o, 0) + '\n' : '')
        + `\nNext: strata-sql live${where}   (or open the .model.json in VS Code with the ${BRAND.name} extension)`);
    } else if (cmd === 'import-dbt' || cmd === 'import-sql') { // the same shape: a re-sync of one model, or a new project in a folder without one
      const man = project.readManifest(dir), one = man && (man.parts || []).length === 1 && !o.name && path.resolve(dir, man.parts[0].model);
      const model = o.model ? path.resolve(o.model) : one;
      const opts = { dryRun: !!o['dry-run'], stop: dir, user: user() }, fresh = { dir, name: o.name || undefined, git: !o['no-git'], ignoreLayout: !!o['ignore-layout'] };
      let r, what;
      if (cmd === 'import-dbt') {
        Object.assign(opts, { from: o.from, catalog: o.catalog, allPackages: !!o['all-packages'] }); what = 'dbt';
        r = model ? dbt.sync(model, opts) : dbt.importNew({ ...opts, ...fresh });
      } else {
        const rows = o['sample-rows'] === undefined ? undefined : +o['sample-rows'];
        if (rows !== undefined && !(Number.isInteger(rows) && rows >= 0 && rows <= 100000)) throw new Error('--sample-rows needs a whole number from 0 to 100000');
        Object.assign(opts, { ddl: o.ddl, dml: o.dml, dialect: o.dialect, sampleRows: rows }); what = 'SQL scripts';
        r = model ? sqlimport.sync(model, opts) : sqlimport.importNew({ ...opts, ...fresh });
      }
      console.log((model ? `Re-sync of ${rel(model)} from ${what}: ` : `New project from ${what} in ${rel(dir)}: `) + r.headline + (opts.dryRun ? ' (dry run, nothing written)' : '') + (r.lines.length ? '\n' + some(r.lines, o) : '')
        + (r.notes.length ? '\nNotes:\n' + r.notes.map((n) => '  ' + n).join('\n') : '') + (opts.dryRun ? '\nRun it again without --dry-run to apply.' : r.model ? next(o, `strata-sql live${where}`) : ''));
    } else if (cmd === 'split') {
      if (!o.model) throw new Error('--model <path.model.json> is required');
      const r = project.split(path.resolve(o.model), { user: user() });
      console.log(`Split into ${r.parts.length} parts: ${r.parts.map((p) => p.name).join(', ')}\n` + some(r.files.map(rel), o, 5) + (r.warnings.length ? '\nWarnings:\n' + r.warnings.map((w) => '  ' + w).join('\n') : ''));
    } else {
      const r = project.join(dir, { user: user() });
      console.log('Joined into ' + rel(r.model) + '\n' + some(r.files.map(rel), o, 5));
    }
    return 0;
  } catch (err) { console.error('strata-sql: ' + err.message); return 1; }
}

if (require.main === module) Promise.resolve(main(process.argv.slice(2))).then((code) => { if (code !== undefined) process.exit(code); });
module.exports = { main };
