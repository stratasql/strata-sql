#!/usr/bin/env bash
# Regenerates the screenshots used by help.md (media/help/*.png) with headless Chrome against a stub of the VS Code API.
# Run from the repo root:  bash tests/help-shots/run.sh   (set CHROME=/path/to/chrome if it is not the macOS default)
set -e
PORT=${PORT:-8790}
CH=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
python3 -m http.server "$PORT" >/dev/null 2>&1 & SRV=$!
TMP=$(mktemp -d)
trap 'kill $SRV $LIVE $LIVEP 2>/dev/null; rm -rf "$TMP"' EXIT
sleep 1
shot() { "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size="$2" --virtual-time-budget="$3" --screenshot="media/help/$1.png" "$4" >/dev/null 2>&1 && echo "ok  $1"; }
for s in canvas conceptual logical views view-dialog history search scope column governance settings data project tools embed-confirm impact impact-linked impact-safe impact-unused load-order load-order-tree load-order-pipeline sla-dialog hover hover-column code-dialog alignment alignment-mapping entity-dialog table-realises impact-logical load-order-conceptual minimap canvas-controls semantic impact-semantic gov-list gov-view gov-graph gov-edit; do
  shot "$s" 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=$s"
done
for t in catppuccin tokyonight rosepine nord; do
  shot "theme-$t" 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=theme&theme=$t"
done
shot theme-palettes 1280,860 3000 "http://localhost:$PORT/tests/help-shots/palettes.html"
shot alignment-generate 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=alignment-generate&model=example&physical=1"
shot load-order-fpml 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=load-order-fpml&model=fpml"
shot legacy-note 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=legacy-note&model=example&legacy=1"
shot broken-link 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=broken-link&model=example&broken=1"
shot archived-note 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=archived-note&model=northwind&archived=1"
# release 2 part 4 (ADR-0045 extended): the same reference drawn as a labelled cross-part stub (a real split, simulated), and the read-only
# Project View (every table on one canvas, badged and legended by domain) -- see shots.html's ?crosspart=1 / ?domainof=1 for exactly what each sends
shot crosspart-stub 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=crosspart-stub&model=northwind&crosspart=1"
shot project-view 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=project-view&model=northwind&domainof=1"
# release 2 part 8 (ADR-0045 extended): Impact analysis actually selecting/analysing a table in the Project View, and the Tools menu's
# read-only-but-partly-usable state there (ETL/HTML export enabled, embeddings/live view disabled with their own reason)
shot project-view-impact 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=project-view-impact&model=northwind&domainof=1"
shot project-view-tools 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=project-view-tools&model=northwind&domainof=1"
# release 2 part 9 (ADR-0045 amended): the project-index file specifically (?indexfile=1) — Project settings, per-domain embeddings and
# creating a tag/policy are enabled there, unlike the ad hoc Project View panel above (?domainof=1, unaffected by this pass)
shot index-file-tools 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=index-file-tools&model=northwind&indexfile=1"
shot index-file-project 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=index-file-project&model=northwind&indexfile=1"
shot index-file-gov 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=index-file-gov&model=northwind&indexfile=1"
# release 2 part 10 (ADR-0045 amended): adding/editing/deleting a table/concept/entity/relationship/metric from the project-index file, and
# the domain-picker shown for a new one — see shots.html's ?indexfile=1 for exactly what it sends
shot index-file-add-table 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=index-file-add-table&model=northwind&indexfile=1"
# release 2 part 11 (ADR-0045 amended): Navigator reveal now reaching the project-index file's own tab, the Domain field showing on an
# EXISTING, previously-unassigned object, and Add Schema / Add Catalog — see shots.html's ?indexfile=1 for exactly what each scene sends;
# each scene's own PASS/FAIL text (bottom-left) is the same real, end-to-end check tests/host.check.js and tests/project.check.js run in Node.
shot index-file-reveal 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=index-file-reveal&model=northwind&indexfile=1"
shot index-file-domain-existing 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=index-file-domain-existing&model=northwind&indexfile=1"
shot index-file-add-schema 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=index-file-add-schema&model=northwind&indexfile=1"
shot index-file-add-catalog 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=index-file-add-catalog&model=northwind&indexfile=1"
# release 2 part 12: the refresh-after-save fix (a real second 'model' message, the same shape extension.js now sends after
# editProject/projectSettings/governance, applied idempotently — the PASS/FAIL note is the webview-side half of that proof, see
# tests/host.check.js for the host-side half) and the merged, read-only History drawer (every part's own log, plus governance.json's,
# merged chronologically with a part/domain filter) with its own cross-part Undo/Redo.
shot index-file-refresh 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=index-file-refresh&model=northwind&indexfile=1"
shot index-file-history 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=index-file-history&model=northwind&indexfile=1"
shot index-file-undo 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=index-file-undo&model=northwind&indexfile=1"
shot history-merge 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=history-merge&model=example"
shot domains 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=domains&domains=1"
shot domains-edit 1280,800 9000 "http://localhost:$PORT/tests/help-shots/shots.html?scene=domains-edit&domains=1"
shot navigator 320,600 4000 "http://localhost:$PORT/tests/help-shots/nav-shots.html"
shot navigator-governance 320,600 4000 "http://localhost:$PORT/tests/help-shots/nav-shots.html?gov=1"

# live view (real server on a scratch copy of Northwind) and the exported interactive HTML
cp northwind.model.json northwind.model.history.jsonl northwind.model.layout.json "$TMP"/
node live.js "$TMP/northwind.model.json" --port 8791 --no-open >"$TMP/live.log" 2>&1 & LIVE=$!
sleep 1.5
# the live page keeps a server-sent-events connection open, so "virtual time" never finishes: use a real timeout and stop Chrome ourselves
"$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1280,800 --timeout=6000 --screenshot=media/help/live-view.png "$(grep -o 'http://[^ ]*' "$TMP/live.log" | head -1)" >/dev/null 2>&1 & CHP=$!
sleep 14; kill $CHP 2>/dev/null || true; echo "ok  live-view"
# release 2 part 13: the SAME real live server (lib/live.js#startProjectLive), now serving a split project's project-index file — a
# scratch project split into domains (the Northwind template ships starter domains, so this is just create() then split(), no manual setup)
node -e "const P=require('./lib/project.js'); const r=P.create({dir:'$TMP/split-proj', template:'northwind', name:'NW Split', user:{name:'ada'}}); P.split(r.model, {user:{name:'ada'}});"
node live.js "$TMP/split-proj/data_models/nw-split/nw-split.model.json" --port 8792 --no-open >"$TMP/live-project.log" 2>&1 & LIVEP=$!
sleep 1.5
"$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1280,800 --timeout=6000 --screenshot=media/help/live-view-project.png "$(grep -o 'http://[^ ]*' "$TMP/live-project.log" | head -1)" >/dev/null 2>&1 & CHP2=$!
sleep 14; kill $CHP2 2>/dev/null || true; kill $LIVEP 2>/dev/null || true; echo "ok  live-view-project"
node -e "const {exportHtml}=require('./lib/export.js'),fs=require('fs');fs.writeFileSync('$TMP/northwind.html',exportHtml({name:'northwind',modelText:fs.readFileSync('northwind.model.json','utf8'),historyText:fs.readFileSync('northwind.model.history.jsonl','utf8'),layoutText:fs.readFileSync('northwind.model.layout.json','utf8')}))"
shot export-html 1280,800 7000 "file://$TMP/northwind.html"
