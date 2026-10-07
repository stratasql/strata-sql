// Real local embeddings (no API key): loads MiniLM through @huggingface/transformers and checks the vectors are sensible.
// First run downloads ~25 MB into STRATA_MODEL_CACHE (default ~/.cache/strata/models). EmbeddingGemma (~200 MB) is opt-in:
//   node tests/embed.local.check.js            # MiniLM
//   STRATA_TEST_GEMMA=1 node tests/embed.local.check.js
const assert = require('assert');
const E = require('../media/embed.js');
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

(async () => {
  for (const id of process.env.STRATA_TEST_GEMMA ? ['minilm', 'gemma'] : ['minilm']) {
    const p = E.PROVIDERS[id];
    const t0 = Date.now();
    const v = await p.embed(null, '', ['Order header with freight and shipping', 'Carriers that deliver orders', 'Employee birth date and home phone'], 'document');
    assert.strictEqual(v.length, 3);
    assert(v.every((x) => x.length === (id === 'minilm' ? 384 : 512) && Math.abs(dot(x, x) - 1) < 1e-3), 'expected dimensions, unit length');
    assert(dot(v[0], v[1]) > dot(v[0], v[2]), `${id}: orders should be closer to carriers than to employees`);
    console.log(`\n${id} ok in ${Date.now() - t0} ms (${p.model})`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
