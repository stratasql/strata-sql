#!/usr/bin/env node
// Checks that the three builds are the same code: node scripts/check-builds.js [--docker] [--vsix <file>]
//   VS Code extension (.vsix)  built from this repository by `npm run build`
//   npm package (strata-sql)   staged from the same files by scripts/build-cli.js
//   Docker image               installs the npm package, never this source
// It builds the npm package, then checks: one version everywhere; every file the npm package carries is byte-identical to the repository's (and to the
// .vsix's, when one exists); the Dockerfile installs the package instead of copying source; the packed tarball installs on its own and runs (the `strata-sql`
// command, a project, the live view over HTTP); with --docker the image built from that tarball does the same inside a container, with a mounted folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
let bad = 0;
const ok = (m) => console.log('ok   ' + m), fail = (m) => { bad++; console.log('FAIL ' + m); };
const run = (cmd, a, o = {}) => cp.execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-builds-'));

(async () => {
  run('node', [path.join(__dirname, 'build-cli.js')]);
  const out = path.join(root, 'dist', 'cli'), cli = require(path.join(out, 'package.json'));

  // 1. one version
  cli.name === pkg.config.npmName ? ok(`the npm package is named ${cli.name} (package.json config.npmName)`) : fail(`the npm package is ${cli.name}, package.json config.npmName says ${pkg.config.npmName}`);
  cli.version === pkg.version ? ok(`npm package ${cli.name}@${cli.version} has the extension's version`) : fail(`npm package is ${cli.version}, package.json says ${pkg.version}`);
  const dockerfile = fs.readFileSync(path.join(root, 'docker', 'Dockerfile'), 'utf8');
  /\nCMD \["live", "--host", "0\.0\.0\.0",/.test(dockerfile) ? ok('the Dockerfile starts the live view on --host 0.0.0.0 (a bare address would be read as a model file)') : fail('the Dockerfile CMD must be ["live", "--host", "0.0.0.0", ...]');
  new RegExp(pkg.config.npmName.replace(/[/@]/g, '\\$&') + '@\\d').test(dockerfile) || /COPY\s+(?!pkg)/.test(dockerfile) ? fail('the Dockerfile pins a version or copies source: it must install PACKAGE (the npm package)') : ok('the Dockerfile installs the npm package (no pinned version, no copied source)');
  dockerfile.includes(`ARG PACKAGE=${pkg.config.npmName}\n`) ? ok('the Dockerfile installs the package by its scoped name') : fail(`the Dockerfile's PACKAGE default is not ${pkg.config.npmName}`);

  // 1a. the two Dockerfiles (from npm, from source) differ only in how the package gets in: same labels, same runtime (WORKDIR to the end)
  const srcDockerfile = fs.readFileSync(path.join(root, 'docker', 'Dockerfile.source'), 'utf8'), part = (t, re) => (t.match(re) || [''])[0];
  const labels = /LABEL[\s\S]*?image\.version="\$\{VERSION\}"\n/, runtime = /WORKDIR \/data[\s\S]*$/;
  part(dockerfile, labels) && part(dockerfile, labels) === part(srcDockerfile, labels) && part(dockerfile, runtime) && part(dockerfile, runtime) === part(srcDockerfile, runtime)
    ? ok('docker/Dockerfile and docker/Dockerfile.source share the same labels and runtime') : fail('docker/Dockerfile and docker/Dockerfile.source differ in their labels or runtime (WORKDIR to the end): they must be the same');

  // 1c. the links in the help that open a sample in the extension (vscode://<publisher>.<name>/...) name the extension that is actually published
  const helpIds = [...fs.readFileSync(path.join(root, 'help.md'), 'utf8').matchAll(/vscode:\/\/([\w.-]+)\//g)].map((m) => m[1]);
  helpIds.length && helpIds.every((id) => id === `${pkg.publisher}.${pkg.name}`) ? ok(`the vscode:// links in help.md name ${pkg.publisher}.${pkg.name}`) : fail(`help.md has vscode:// links to ${[...new Set(helpIds)].join(', ') || 'nothing'}, the extension is ${pkg.publisher}.${pkg.name}`);

  // 1b. one licence: package.json, the LICENSE file, the npm package (which carries the file) and the image label
  const lic = fs.existsSync(path.join(root, 'LICENSE')) ? fs.readFileSync(path.join(root, 'LICENSE'), 'utf8') : '';
  /Apache License\s+Version 2\.0/.test(lic) && pkg.license === 'Apache-2.0' && cli.license === 'Apache-2.0' && fs.existsSync(path.join(out, 'LICENSE')) && /licenses="Apache-2\.0"/.test(dockerfile)
    ? ok('licence: Apache-2.0 in package.json, LICENSE, the npm package and the Docker label') : fail('the licence differs between package.json, LICENSE, the npm package and the Dockerfile (all must be Apache-2.0)');

  // 2. the npm package carries exactly the repository's files
  const mine = walk(out).filter((f) => !f.startsWith('node_modules') && !['package.json', 'README.md'].includes(f));
  const differ = mine.filter((f) => !fs.existsSync(path.join(root, f)) || sha(fs.readFileSync(path.join(out, f))) !== sha(fs.readFileSync(path.join(root, f))));
  differ.length ? fail('npm package files that differ from the repository: ' + differ.join(', ')) : ok(`${mine.length} files of the npm package are byte-identical to the repository`);

  // 3. ... and to the .vsix, when there is one
  const vsix = args.includes('--no-vsix') ? null : opt('vsix') || path.join(root, `${pkg.name}-${pkg.version}.vsix`); // --no-vsix: only the npm package and the images are being released
  if (vsix && fs.existsSync(vsix)) {
    const inVsix = run('unzip', ['-Z1', vsix], { maxBuffer: 1 << 26 }).split('\n').filter((f) => f.startsWith('extension/')).map((f) => f.slice(10));
    const asIn = (f) => (f === 'LICENSE' ? 'LICENSE.txt' : f); // vsce stores the licence as LICENSE.txt
    const missing = mine.filter((f) => !inVsix.includes(asIn(f))), changed = mine.filter((f) => inVsix.includes(asIn(f)) && sha(cp.execFileSync('unzip', ['-p', vsix, 'extension/' + asIn(f)], { maxBuffer: 1 << 26 })) !== sha(fs.readFileSync(path.join(root, f))));
    const vv = JSON.parse(cp.execFileSync('unzip', ['-p', vsix, 'extension/package.json'], { encoding: 'utf8' })).version;
    missing.length || changed.length || vv !== pkg.version ? fail(`${path.basename(vsix)}: missing ${missing.join(', ') || 'none'}; differing ${changed.join(', ') || 'none'}; version ${vv}`) : ok(`${path.basename(vsix)} holds the same ${mine.length} files at the same version`);
  } else if (vsix) console.log(`     (no ${path.basename(vsix)}: build it with npm run build to include the extension in this check)`);

  // 4. the packed tarball installs by itself (bundled parser, no downloads) and works
  const tgz = path.join(tmp, run('npm', ['pack', out, '--pack-destination', tmp, '--silent']).trim().split('\n').pop());
  const app = path.join(tmp, 'app'); fs.mkdirSync(app);
  run('npm', ['install', tgz, '--prefix', app, '--no-audit', '--no-fund', '--offline']);
  const bin = path.join(app, 'node_modules', '.bin');
  const strata = (...a) => run(path.join(bin, 'strata-sql'), a, { cwd: path.join(tmp, 'proj') });
  fs.mkdirSync(path.join(tmp, 'proj'));
  strata('--version').trim() === pkg.version ? ok('`strata-sql --version` from the installed tarball') : fail('strata-sql --version differs');
  Object.keys(cli.bin).join() === 'strata-sql' && fs.existsSync(path.join(bin, 'strata-sql')) ? ok('the one command, strata-sql, is installed') : fail('the bin is not exactly strata-sql');
  strata('init', '--name', 'Smoke', '--template', 'northwind', '--no-git');
  /table/.test(run(path.join(bin, 'strata-sql'), ['import-sql', '--ddl', path.join(root, 'tests/fixtures/sql/postgres/pg_dump.sql'), '--dry-run'], { cwd: tmp })) ? ok('init and import-sql (with the bundled SQL parser) work from the tarball') : fail('import-sql printed nothing useful');
  await live(path.join(bin, 'strata-sql'), ['live', '--no-open', '--port', '0'], path.join(tmp, 'proj'), 'the installed command serves the editor over HTTP');
  await live(path.join(bin, 'strata-sql'), ['live', '--demo', '--no-open', '--port', '0'], path.join(tmp, 'empty'), 'the installed command serves the demo (no project needed)', true);

  // 5. the image, built from that same tarball
  if (args.includes('--docker')) {
    fs.copyFileSync(tgz, path.join(root, 'docker', 'pkg', path.basename(tgz)));
    try {
      run('docker', ['build', '-q', '-t', 'strata-sql:check', '--build-arg', `PACKAGE=/pkg/${path.basename(tgz)}`, '--build-arg', `VERSION=${pkg.version}`, path.join(root, 'docker')]);
      // the image built from the source (docker/Dockerfile.source, context = the repository) holds the same package files as the one built from the tarball
      run('docker', ['build', '-q', '-f', path.join(root, 'docker', 'Dockerfile.source'), '-t', 'strata-sql:check-source', '--build-arg', `VERSION=${pkg.version}`, root]);
      const files = (img) => run('docker', ['run', '--rm', '--entrypoint', 'sh', img, '-c', 'cd "$(npm root -g)/' + cli.name + '" && find . -type f -not -path "./node_modules/*" | sort | xargs sha256sum'], { maxBuffer: 1 << 26 });
      files('strata-sql:check') === files('strata-sql:check-source') && files('strata-sql:check').includes('cli.js') ? ok('docker: the image built from source holds the same package files as the one built from the npm tarball') : fail('docker: the source-built image differs from the tarball-built one');
      run('docker', ['run', '--rm', 'strata-sql:check-source', '--version']).trim() === pkg.version ? ok('docker: the source-built image runs the same version') : fail('docker: the source-built image reports another version');
      const data = path.join(tmp, 'data'); fs.mkdirSync(data);
      const d = (...a) => run('docker', ['run', '--rm', '-v', `${data}:/data`, ...a]);
      d('strata-sql:check', '--version').trim() === pkg.version ? ok('docker: the image runs the same version') : fail('docker: version differs');
      d('strata-sql:check', 'init', '--name', 'Smoke', '--template', 'star', '--no-git');
      fs.readdirSync(data).includes('strata.project.json') ? ok('docker: init wrote into the mounted folder') : fail('docker: nothing in the mounted folder');
      const name = 'strata-check-' + process.pid;
      run('docker', ['run', '-d', '--rm', '--name', name, '-v', `${data}:/data`, '-e', 'STRATA_TOKEN=check_token_0123456789', '-p', '127.0.0.1:0:8787', 'strata-sql:check']);
      try {
        const port = run('docker', ['port', name, '8787/tcp']).trim().split(':').pop();
        await waitFor(`http://127.0.0.1:${port}/?t=check_token_0123456789`, 'docker: the editor answers over HTTP on the published port');
        (await fetch(`http://127.0.0.1:${port}/`)).status === 403 ? ok('docker: the page is refused without the token') : fail('docker: no token was accepted');
      } finally { run('docker', ['rm', '-f', name]); }
      const demo = name + '-demo'; // STRATA_DEMO=1: the samples, no folder mounted
      run('docker', ['run', '-d', '--rm', '--name', demo, '-e', 'STRATA_DEMO=1', '-e', 'STRATA_TOKEN=check_token_0123456789', '-p', '127.0.0.1:0:8787', 'strata-sql:check']);
      try {
        const port = run('docker', ['port', demo, '8787/tcp']).trim().split(':').pop();
        await waitFor(`http://127.0.0.1:${port}/demo/sample?t=check_token_0123456789&id=northwind`, 'docker: STRATA_DEMO=1 serves the demo samples');
      } finally { run('docker', ['rm', '-f', demo]); }
    } finally { fs.rmSync(path.join(root, 'docker', 'pkg', path.basename(tgz)), { force: true }); try { run('docker', ['rmi', 'strata-sql:check', 'strata-sql:check-source']); } catch { /* not built */ } }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `\n${bad} check(s) failed: the builds are NOT in sync` : '\nthe builds are in sync');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e.stderr || e); process.exit(1); });

async function waitFor(url, label) {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).status === 200) return ok(label); } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 250)); }
  fail(label);
}
// start the command, read the link it prints, fetch it, stop it
async function live(cmd, a, cwd, label, demo) {
  fs.mkdirSync(cwd, { recursive: true });
  const p = cp.spawn(cmd, a, { cwd }); let text = '';
  p.stdout.on('data', (c) => (text += c));
  try {
    for (let i = 0; i < 40 && !/http:\/\/\S+/.test(text); i++) await new Promise((r) => setTimeout(r, 250));
    const url = (text.match(/http:\/\/\S+/) || [])[0];
    url ? await waitFor(demo ? url.replace('/?', '/demo/sample?') + '&id=northwind' : url, label) : fail(label + ' (no link printed)');
  } finally { p.kill('SIGINT'); }
}
