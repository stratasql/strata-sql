// Self-check for media/embed.js: a fake fetch mimics OpenAI, Gemini and Voyage; the two local providers are replaced by fakes.
// Offline and key-free. The real local models are checked by tests/embed.local.check.js. Run: node tests/embed.check.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../media/embed.js');

// deterministic "embedding": hashed bag of words, so texts sharing words are close
const vec = (text) => { const v = new Array(768).fill(0); String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).forEach((w) => { let h = 7; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 768] += 1; }); return v; };
const calls = [];
const fakeFetch = (fail = []) => async (url, init) => {
  const body = JSON.parse(init.body);
  const who = url.includes('openai') ? 'openai' : url.includes('googleapis') ? 'gemini' : 'claude';
  calls.push({ who, n: (body.input || body.requests || []).length, headers: init.headers });
  if (fail.includes(who)) return { ok: false, status: 500, text: async () => 'boom' };
  const json = who === 'openai' || who === 'claude' ? { data: body.input.map((t, i) => ({ index: i, embedding: vec(t) })).reverse() } // reversed: index must be honoured
    : { embeddings: body.requests.map((r) => ({ values: vec(r.content.parts[0].text) })) };
  return { ok: true, status: 200, json: async () => json };
};

let localFails = false;
const local = async (f, key, texts) => { if (localFails) throw new Error('boom'); return texts.map((t) => { const v = vec(t).slice(0, 512); const n = Math.hypot(...v) || 1; return v.map((x) => x / n); }); };
E.PROVIDERS.gemma.embed = local; E.PROVIDERS.minilm.embed = local;

(async () => {
  const modelText = fs.readFileSync(path.join(__dirname, '../sample_data_models/northwind.model.json'), 'utf8');
  const F = JSON.parse(modelText);
  const chunks = E.buildChunks(F);
  assert(chunks.length > 60 && chunks.some((c) => c.kind === 'view' && /Definition:/.test(c.text)), 'chunks: tables, views with definitions, relationships, tags');
  assert(!chunks.some((c) => /@/.test(c.text)), 'e-mail addresses must be redacted from every chunk');
  assert(!chunks.some((c) => /Sales Operations Lead|data\.architect/.test(c.text)), 'stakeholder names/e-mails are not sent');

  const keys = { openai: 'k1', gemini: 'k2', claude: 'k3' };
  const all = E.PROVIDER_IDS;
  const g1 = await E.generate({ modelText, modelName: 'northwind.model.json', previous: null, enabled: all, keys, fetch: fakeFetch() });
  assert(all.length === 5 && all.every((p) => g1.results[p].ok && g1.results[p].reused === 0), 'hosted and local providers generated');
  const parsed = JSON.parse(E.serialize(g1.file)); // serialised file must be valid JSON
  for (const p of all) { const items = parsed.providers[p].items; assert.strictEqual(items.length, chunks.length); assert.strictEqual(items[0].v.length, 512); assert(Math.abs(items[0].v.reduce((s, x) => s + x * x, 0) - 1) < 1e-3, 'normalised'); }
  assert.strictEqual(parsed.contentHash, E.contentHash(F));
  assert(calls.some((c) => c.who === 'openai' && c.headers.authorization === 'Bearer k1') && calls.some((c) => c.who === 'gemini' && c.headers['x-goog-api-key'] === 'k2'), 'keys sent as headers');

  // incremental refresh: nothing changed -> nothing embedded; one description changed -> exactly that chunk
  calls.length = 0;
  const g2 = await E.generate({ modelText, modelName: 'x', previous: parsed, enabled: all, keys, fetch: fakeFetch() });
  assert(all.every((p) => g2.results[p].embedded === 0) && calls.length === 0, 'unchanged model makes no API calls');
  const F2 = JSON.parse(modelText); F2.tables.find((t) => t.name === 'orders').description = 'Changed text';
  const g3 = await E.generate({ modelText: JSON.stringify(F2), modelName: 'x', previous: parsed, enabled: ['openai'], keys, fetch: fakeFetch() });
  assert.strictEqual(g3.results.openai.embedded, 1);
  assert(!g3.file.providers.gemini, 'disabled providers are dropped from the file');

  // missing key / failing provider keep their previous block and report the reason
  localFails = true;
  const g4 = await E.generate({ modelText: JSON.stringify(F2), modelName: 'x', previous: parsed, enabled: all, keys: { openai: 'k1' }, fetch: fakeFetch() });
  localFails = false;
  assert(g4.results.gemini.skipped && g4.results.gemini.error.includes('no API key') && !g4.results.gemma.skipped && g4.results.gemma.error.includes('boom') && g4.file.providers.gemini && g4.file.providers.gemma, 'missing key = skipped, failure = error, old vectors kept');
  const g5 = await E.generate({ modelText, modelName: 'x', previous: null, enabled: all, keys: {}, fetch: fakeFetch() });
  assert(g5.results.gemma.ok && g5.results.minilm.ok && g5.results.openai.skipped, 'with no API keys the local providers still generate');

  // search: vector and lexical agree that the orders table answers this question
  const q = 'order header freight shipped_date required_date ship_name';
  const v = await E.search({ file: parsed, query: q, keys, fetch: fakeFetch() });
  assert.strictEqual(v.mode, 'vector');
  assert(v.results.slice(0, 3).some((r) => r.ref === 'northwind.sales.orders'), 'vector search finds orders: ' + v.results.map((r) => r.ref).join(', '));
  const l = await E.search({ file: parsed, query: q, keys: {}, provider: 'lexical' });
  assert.strictEqual(l.mode, 'lexical');
  assert(l.results.slice(0, 3).some((r) => r.ref === 'northwind.sales.orders'), 'lexical fallback finds orders: ' + l.results.map((r) => r.ref).join(', '));
  const down = await E.search({ file: parsed, query: q, keys, fetch: fakeFetch(['openai']) }); // provider failure degrades to keyword search
  assert(down.mode === 'lexical' && /openai query failed/.test(down.warning) && down.results.length, 'failed vector search falls back');
  const stale = JSON.parse(JSON.stringify(parsed)); stale.chunks.find((c) => c.ref === 'northwind.sales.orders').hash = 'x';
  assert((await E.search({ file: stale, query: q, keys, fetch: fakeFetch() })).skippedStale >= 1, 'items whose chunk changed are skipped');
  console.log('embed check ok:', chunks.length, 'chunks;', Math.round(E.serialize(g1.file).length / 1024), 'KB for 5 providers');
})().catch((e) => { console.error(e); process.exit(1); });
