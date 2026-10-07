#!/usr/bin/env node
// Builds and publishes the npm package (@stratasql/strata-sql, the command strata-sql): node scripts/publish-npm.js [--yes]
// Without --yes nothing is sent: it runs the tests, builds dist/cli, proves the package is the repository's code, and runs `npm publish --dry-run`.
// With --yes it then publishes. Needs `npm login` (npm asks for a one-time code with 2FA). The version is package.json's: bump it for every release
// (`npm version patch --no-git-tag-version`, then commit): a registry never accepts a version twice.
const path = require('path');
const R = require('./release-lib.js');

// the very command that publishes (an absolute folder: a bare `dist/cli` is read by npm as the GitHub repository dist/cli). npm retries twice by
// default and each retry sends the whole package again: a flaky connection needs more
const publish = ['publish', path.join(R.root, 'dist', 'cli'), '--access', 'public', '--fetch-retries=12', '--fetch-retry-mintimeout=1000'];

function preflight() { // before anything is published: a missing login must not cost a build, or half a release
  try { R.out('npm', ['whoami']); } catch { R.stop('not logged in to npm: run npm login'); }
  if (R.onNpm()) R.stop(`${R.npm}@${R.version} is already on npm: bump the version in package.json (npm version patch --no-git-tag-version) and commit`);
}

function run(go, { tests = true } = {}) {
  R.step(`npm ${R.npm}@${R.version}${go ? '' : ' (dry run: nothing is published; add --yes to publish)'}`);
  R.cleanTree(go);
  if (go) preflight();
  if (tests) R.tests();
  R.step('build the package (dist/cli)'); R.sh('node', [path.join('scripts', 'build-cli.js')]);
  R.step('check the package is the repository\'s code'); R.sh('node', [path.join('scripts', 'check-builds.js'), '--no-vsix']);
  if (R.onNpm()) R.warn(`${R.npm}@${R.version} is already on npm, so npm would refuse it: skipping npm publish --dry-run. Bump the version to release.`);
  else { R.step('npm publish --dry-run (the command that will run, nothing is sent)'); R.sh('npm', [...publish, '--dry-run']); }
  if (!go) return console.log('\ndry run done. To publish: node scripts/publish-npm.js --yes');
  R.step(`npm publish ${R.npm}@${R.version}`); R.sh('npm', publish);
  R.step(`published ${R.npm}@${R.version}. Tag it: git tag v${R.version}`);
}

if (require.main === module) run(process.argv.includes('--yes'));
module.exports = { run, preflight };
