#!/usr/bin/env node
// Strata live view from a terminal (no VS Code needed): node live.js [<file.model.json>] [--port 8787] [--no-open]. The same as `strata-sql live`.
Promise.resolve(require('./cli.js').main(['live', ...process.argv.slice(2)])).then((code) => { if (code !== undefined) process.exit(code); });
