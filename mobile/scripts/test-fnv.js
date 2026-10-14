const assert = require('node:assert/strict');
const fnv1a32 = require('../bridge/fnv1a');

const vectors = [
  ['', '811c9dc5'],
  ['hello', '4f9f2cab'],
  ['🎵/é', '1c07a122'],
];

for (const [input, expected] of vectors) {
  assert.equal(fnv1a32(input), expected, `FNV-1a mismatch for ${JSON.stringify(input)}`);
}

console.log(`Verified ${vectors.length} FNV-1a vectors.`);
