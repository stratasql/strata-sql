#!/usr/bin/env node
// Builds the VS Code extension package, strata-sql-<version>.vsix: node scripts/build-vsce.js  (`npm run build` does the same)
// Dependencies are not in Git: it installs them when missing. The Marketplace page turns the README's relative links and images into absolute ones from
// package.json's "repository" (a GitHub URL, https://github.com/<owner>/<repo>); without one the package still builds for local use, with the links left as written.
const R = require('./release-lib.js');

R.ensureDeps();
const args = ['--yes', '@vscode/vsce', 'package', '--out', R.vsix];
if (!R.repo) {
  R.warn('package.json "repository" is not a GitHub URL (https://github.com/<owner>/<repo>): this .vsix is for local use, its README links will not resolve. Set it before publishing.');
  args.push('--allow-missing-repository', '--no-rewrite-relative-links');
}
R.sh('npx', args);
