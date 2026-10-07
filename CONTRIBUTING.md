# Contributing to Strata SQL

Strata SQL is Apache-2.0 and built from one source tree into three artefacts: a VS Code extension, an npm package (`@stratasql/strata-sql`, the command `strata-sql`) and a Docker image. This page is for people who build, test and release it; the product page is [README.md](README.md) and the user manual is [help.md](help.md).

## Run from source

**Run (dev):** run `npm install` once (the dbt SQL parser and local embeddings), open this folder in VS Code, press **F5**, then open `sample_data_models/example.model.json` (small: every level, a few policies and metrics) or the larger `sample_data_models/northwind.model.json` (Northwind, 3NF) / `sample_data_models/fpml.model.json` (FpML OTC derivatives, 3NF) (the files in `sample_data_models/` are flat pairs, opened as bare models, and the sources of the templates; or run *Strata SQL: New Project* — Command Palette, right-click a folder in the Explorer, or the empty-state screen — or `node cli.js init` from a terminal, for the foldered project layout).

The Extension Development Host's integrated terminal has no `strata-sql` command by itself: it is a fresh shell, not this repo, and nothing runs `npm link` for you. Either run `npm link` once in this folder (puts `strata-sql` on PATH for every terminal; separate from publishing the package to npm), or call the script directly: `node /path/to/strata/cli.js init ...` from any terminal.

**Three builds, one source.** The VS Code extension, the npm package and the Docker image are built from the same files, and `npm run check:builds` proves it (one version, byte-identical files, the packed package installs and runs, with `--docker` the image does too). Dependencies are not in Git: `npm ci` restores them, and the build scripts download what they need.

| Build | What it is | How |
|---|---|---|
| VS Code extension | `strata-sql-<version>.vsix`, Marketplace (`<publisher>.strata-sql`) | `npm run build` (`scripts/build-vsce.js`) |
| npm | `@stratasql/strata-sql`, the command is `strata-sql`: `npm install -g @stratasql/strata-sql`, `npx @stratasql/strata-sql live` | `npm run cli:build` stages `dist/cli` (about 11 MB, 10 of them the help screenshots): only what `cli.js` loads, `media/`, `help.md`, the templates and the SQL parser, without VS Code or the embeddings library |
| Docker | the npm package served over HTTP, your folder mounted at `/data` | `docker/Dockerfile` installs `@stratasql/strata-sql` from npm, so it is the npm code by construction. **From source instead:** `docker build -f docker/Dockerfile.source -t strata-sql .` (run it in the repository root) builds the same package from the working tree, for unreleased changes, CI or an offline network |

```
docker run --rm -v "$PWD":/data strata-sql init --template northwind       # create a project in this folder
docker run --rm -v "$PWD":/data -p 127.0.0.1:8787:8787 -e STRATA_TOKEN=pick-a-long-token-1234 strata-sql
docker run --rm -p 127.0.0.1:8787:8787 -e STRATA_DEMO=1 strata-sql             # the demo: the sample models, nothing mounted or saved (npm: strata-sql live --demo)
# then open http://localhost:8787/?t=pick-a-long-token-1234   (without STRATA_TOKEN the link is in `docker logs`)
```
On Linux add `--user "$(id -u):$(id -g)"` if the folder belongs to you and not to uid 1000. Publish the port to `127.0.0.1` only: the server speaks plain HTTP and the link's token is its only protection.

**Release:** bump `version` in `package.json` (a registry never accepts a version twice) and commit. Each target has its own build and publish script; every one is a dry run unless you add `--yes`, and checks its login or token before it builds:

| Script | What it does | Needs |
|---|---|---|
| `node scripts/publish-npm.js` (`npm run publish:npm`) | tests, builds `dist/cli`, proves it is the repository's code, `npm publish --dry-run`; with `--yes` publishes `@stratasql/strata-sql` | `npm login` (a one-time code with 2FA) |
| `node scripts/publish-vsce.js` (`npm run publish:vsce`) | tests, builds the `.vsix` (`scripts/build-vsce.js`), proves it is the repository's code; with `--yes` publishes `<publisher>.<name>` on the Marketplace | `VSCE_PAT`, and a GitHub URL in `package.json` `repository` |
| `node scripts/publish.js` | all three in one go (`--only npm,vsce,docker` for part), adds the Docker image | both of the above, `DOCKER_IMAGE` and `docker login` |

**Build & install:**

| Command | What it does |
|---|---|
| `npm run build` | Packages `strata-sql-<version>.vsix` (includes the dbt SQL parser, about 2.5 MB; installs the dependencies first when they are missing; without a GitHub `repository` in `package.json` it builds for local use and warns that README links will not resolve) |
| `npm run install-ext` | Builds the VSIX and installs it into VS Code |
| `npm run clean` | Removes `.vsix` files |
| `npm run uninstall-ext` | Uninstalls Strata SQL from VS Code |

## Tests

Every suite is a plain Node script that prints one `ok` line (no framework):

```
for t in tests/*.check.js; do node "$t" || break; done      # all of them (embed.local.check.js downloads a model: skip it)
STRATA_SQL_PARSER=off node tests/dbt.check.js                 # and these two again, with the simple SQL reader
STRATA_SQL_PARSER=off node tests/sqlimport.check.js
```

`node scripts/check-builds.js [--docker]` proves the three builds are the same code. `.claude/agents/strata-engineer.md` lists which suite belongs to which file.

