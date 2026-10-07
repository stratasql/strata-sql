// Self-check for media/md.js. Run: node tests/md.check.js
const assert = require('assert');
const { parse, inline } = require('../media/md.js');
const flat = (n) => n.map((x) => (x.t === 'text' ? x.s : x.t === 'code' ? '`' + x.s + '`' : `<${x.t}>${x.c ? flat(x.c) : ''}`)).join('');

assert.strictEqual(flat(inline('a **bold** and *it* and `x_y` end')), 'a <b>bold and <i>it and `x_y` end');
assert.strictEqual(flat(inline('customer_id and snake_case_name stay plain')), 'customer_id and snake_case_name stay plain', 'underscores in identifiers');
assert.strictEqual(flat(inline('SELECT * FROM t WHERE a * b')), 'SELECT * FROM t WHERE a * b', 'lone stars');
assert.strictEqual(flat(inline('see [docs](https://x.io/a) now')), 'see <a>docs now');
assert.strictEqual(flat(inline('\\*not italic\\*')), '*not italic*');
assert.strictEqual(flat(inline('<script>alert(1)</script>')), '<script>alert(1)</script>', 'HTML stays text');

const b = parse('# Title\n\nFirst line\nsecond line\n\n- one\n- two **b**\n\n1. a\n2. b\n\n> quoted\n\n```\ncode `x`\nline2\n```\n---\nend');
assert.deepStrictEqual(b.map((x) => x.t), ['h', 'p', 'ul', 'ol', 'quote', 'code', 'hr', 'p']);
assert.strictEqual(b[0].n, 1); assert.strictEqual(b[2].items.length, 2); assert.strictEqual(b[5].s, 'code `x`\nline2');
assert.strictEqual(flat(b[1].c), 'First line\nsecond line', 'newline kept as a line break');
assert.deepStrictEqual(parse(''), []); assert.deepStrictEqual(parse('   \n\n'), []);
assert.strictEqual(parse('text\n- item')[1].t, 'ul', 'a list can follow a paragraph directly');
console.log('md check ok');
