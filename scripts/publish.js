#!/usr/bin/env node
// All three builds of one version in one go: node scripts/publish.js [--only npm,vsce,docker] [--yes]
// npm and the extension each have their own script, publish-npm.js and publish-vsce.js (use those to release one of them); this runs both and adds the Docker image:
//   docker  <DOCKER_IMAGE>:<version> and :latest on Docker    needs `docker login` and DOCKER_IMAGE (for example myname/strata-sql)
// Without --yes nothing is published. With --yes the order is npm, vsce, docker (the image installs the package from npm, so the package comes first), and every
// login is checked BEFORE the first publish, so a missing token cannot leave you with half a release.
const path = require('path');
const R = require('./release-lib.js');
const npm = require('./publish-npm.js'), vsce = require('./publish-vsce.js');

const args = process.argv.slice(2), go = args.includes('--yes');
const only = (args.includes('--only') ? args[args.indexOf('--only') + 1] : 'npm,vsce,docker').split(',');
for (const s of only) if (!['npm', 'vsce', 'docker'].includes(s)) { console.error(`unknown step "${s}" (npm, vsce, docker)`); process.exit(2); }
const image = process.env.DOCKER_IMAGE;

R.step(`release ${R.version}: ${only.join(', ')}${go ? '' : ' (dry run: nothing is published; add --yes to publish)'}`);
R.cleanTree(go);
if (go) {
  if (only.includes('docker')) { if (!image) R.stop('DOCKER_IMAGE is not set (for example: DOCKER_IMAGE=myname/strata-sql)'); try { R.out('docker', ['info']); } catch { R.stop('the Docker daemon is not running'); } }
  if (only.includes('npm')) npm.preflight();
  if (only.includes('vsce')) vsce.preflight();
}
R.tests();
if (only.includes('npm')) npm.run(go, { tests: false });
if (only.includes('vsce')) vsce.run(go, { tests: false });
if (only.includes('docker')) {
  R.step('check the Docker images'); R.sh('node', [path.join('scripts', 'check-builds.js'), '--docker', ...(only.includes('vsce') ? ['--vsix', R.vsix] : ['--no-vsix'])]);
  if (go) {
    R.step(`docker push ${image}:${R.version} and :latest`);
    for (let i = 0; ; i++) { if (R.onNpm()) break; if (i > 30) R.stop('the npm package is not visible yet: run again with --only docker in a minute'); require('child_process').execFileSync('sleep', ['4']); } // the registry takes a moment
    R.sh('docker', ['buildx', 'build', '--platform', 'linux/amd64,linux/arm64', '--push', '-t', `${image}:${R.version}`, '-t', `${image}:latest`, '--build-arg', `PACKAGE=${R.npm}@${R.version}`, '--build-arg', `VERSION=${R.version}`, 'docker']);
  }
}
console.log(go ? `\nreleased ${R.version}. Tag it: git tag v${R.version}` : '\ndry run done. To publish: node scripts/publish.js --yes' + (only.length < 3 ? ' --only ' + only.join(',') : ''));
