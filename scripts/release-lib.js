// What the release scripts share (publish-npm.js, publish-vsce.js, publish.js): the names and version of one release, small shell helpers, the test suites
// and the questions "is this version already out?". The one version everywhere is package.json's.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
// the GitHub repository package.json names ({owner, repo}), or null: the Marketplace page needs it to turn README links and images into absolute ones
const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository || {}).url || '';
const repo = (/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(repoUrl) || []).slice(1, 3);
const R = {
  root, version: pkg.version, publisher: pkg.publisher, name: pkg.name, npm: pkg.config.npmName, vsix: path.join(root, `${pkg.name}-${pkg.version}.vsix`),
  repo: repo.length ? { owner: repo[0], name: repo[1] } : null,
  sh: (cmd, a, o = {}) => cp.execFileSync(cmd, a, { cwd: root, stdio: 'inherit', ...o }),
  out: (cmd, a) => cp.execFileSync(cmd, a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
  step: (m) => console.log(`\n== ${m}`),
  stop: (m) => { console.error(`\nstopped: ${m}`); process.exit(1); },
  warn: (m) => console.log(`warning: ${m}`),
};

// a real release is a commit you can name; a dry run only warns
R.cleanTree = (go) => {
  if (!R.out('git', ['status', '--porcelain', '--untracked-files=no'])) return;
  if (go) R.stop('the working tree has uncommitted changes: commit them first, so the release is a commit you can name');
  R.warn('uncommitted changes (a real release needs a clean tree)');
};

// dependencies are not in Git: download them when a build needs them
R.ensureDeps = () => {
  try { cp.execFileSync('npm', ['ls', '--omit=dev', '--depth=0'], { cwd: root, stdio: 'ignore' }); } catch { R.step('npm ci (the build needs every dependency installed)'); R.sh('npm', ['ci']); }
};

R.tests = () => {
  R.step('tests');
  const suites = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.check.js') && f !== 'embed.local.check.js').sort();
  for (const f of suites) {
    for (const env of f === 'dbt.check.js' || f === 'sqlimport.check.js' ? [{}, { STRATA_SQL_PARSER: 'off' }] : [{}]) {
      try { cp.execFileSync('node', [path.join('tests', f)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }); console.log('ok   ' + f + (env.STRATA_SQL_PARSER ? ' (simple SQL reader)' : '')); }
      catch (e) { console.error(String(e.stdout || '').slice(-1500) + String(e.stderr || '').slice(-1500)); R.stop(`${f} failed`); }
    }
  }
};

// is this version already out? (a registry refuses to publish over it, even for a dry run)
R.onNpm = () => { try { R.out('npm', ['view', `${R.npm}@${R.version}`, 'version']); return true; } catch { return false; } };
R.onMarketplace = () => { // best effort: `vsce show` gives no usable answer for an extension that was never published
  try { const v = JSON.parse(R.out('npx', ['--yes', '@vscode/vsce', 'show', `${R.publisher}.${R.name}`, '--json'])).versions; return !!v && v.some((x) => x.version === R.version); } catch { return false; }
};
module.exports = R;
