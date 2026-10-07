#!/usr/bin/env node
// Builds and publishes the extension on the VS Code Marketplace (<publisher>.<name>): node scripts/publish-vsce.js [--yes]
// Without --yes nothing is sent: it runs the tests, builds the .vsix, and proves it holds the repository's code. With --yes it then publishes.
// Needs VSCE_PAT (a Personal Access Token of the publisher in package.json, https://aka.ms/vscodepat) and a GitHub URL in package.json's "repository"
// (the Marketplace page needs it for the README's links and images). The version is package.json's: the Marketplace never accepts one twice.
const path = require('path');
const R = require('./release-lib.js');

function preflight() { // before anything is published
  if (!process.env.VSCE_PAT) R.stop(`VSCE_PAT is not set (a Personal Access Token for the "${R.publisher}" publisher, https://aka.ms/vscodepat)`);
  if (!R.repo) R.stop('package.json "repository" must be a GitHub URL (https://github.com/<owner>/<repo>): the Marketplace page builds its README links and images from it');
  if (R.onMarketplace()) R.stop(`${R.publisher}.${R.name}@${R.version} is already on the Marketplace: bump the version in package.json and commit`);
}

function run(go, { tests = true } = {}) {
  R.step(`VS Code extension ${R.publisher}.${R.name}@${R.version}${go ? '' : ' (dry run: nothing is published; add --yes to publish)'}`);
  R.cleanTree(go);
  if (go) preflight(); else if (!R.repo) R.warn('package.json "repository" is not a GitHub URL: a real publish will stop until it is');
  if (tests) R.tests();
  R.step('build the extension'); R.sh('node', [path.join('scripts', 'build-vsce.js')]);
  R.step('check the extension is the repository\'s code'); R.sh('node', [path.join('scripts', 'check-builds.js'), '--vsix', R.vsix]);
  if (!go) return console.log('\ndry run done. To publish: node scripts/publish-vsce.js --yes');
  R.step(`Marketplace publish ${R.publisher}.${R.name}@${R.version}`); R.sh('npx', ['--yes', '@vscode/vsce', 'publish', '--packagePath', R.vsix]);
  R.step(`published ${R.publisher}.${R.name}@${R.version}. Tag it: git tag v${R.version}`);
}

if (require.main === module) run(process.argv.includes('--yes'));
module.exports = { run, preflight };
