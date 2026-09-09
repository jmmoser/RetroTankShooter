const assert = require('assert/strict');
const { loadScripts, check } = require('./helpers');
loadScripts(['challenge.js'], 'global.Challenge = Challenge;');
const today = '2026-09-09';
const parse = (s) => Challenge.parse(new URLSearchParams(s), today, 'v37');

check('challenge accepts a current date and bounded self-reported target', () => {
  assert.deepEqual(parse('daily=2026-09-09&score=1200&v=v37'),
    { day: today, score: 1200, sameVersion: true, current: true });
});
check('challenge rejects impossible, future, and injected dates', () => {
  for (const day of ['2026-02-30', '2026-09-10', '<script>', 'not-a-date']) {
    assert.equal(parse('daily=' + encodeURIComponent(day)), null);
  }
});
check('challenge discards negative, enormous, and nonnumeric score targets', () => {
  for (const score of ['-1', '1000000000', 'NaN', 'Infinity', '<img>', '1.5']) {
    assert.equal(parse('daily=' + today + '&v=v37&score=' + encodeURIComponent(score)).score, 0);
  }
});
check('expired and different-build challenges are explicitly distinguishable', () => {
  assert.equal(parse('daily=2026-09-08&score=1200&v=v37').current, false);
  assert.equal(parse('daily=' + today + '&score=1200&v=v36').score, 0);
});
check('daily share payload round-trips its seed, score, and build', () => {
  const params = Challenge.params(today, 1200, 'v37');
  assert.equal(Challenge.parse(new URLSearchParams(params), today, 'v37').score, 1200);
  const payload = Challenge.payload({ day: today, score: 1200, sector: 3, streak: 2 }, 'https://example.com');
  assert(payload.text.includes(today)); assert(payload.text.includes('STREAK 2 DAYS'));
  assert.equal(payload.url, 'https://example.com');
});

(async () => {
  const payload = { text: 'SCORE 12', url: 'https://example.com' };
  assert.equal(await Challenge.share(payload, { share: async () => {} }), 'shared');
  assert.equal(await Challenge.share(payload, { share: async () => { throw { name: 'AbortError' }; },
    clipboard: { writeText: () => { throw Error('must not copy after cancel'); } } }), 'cancelled');
  let copied;
  assert.equal(await Challenge.share(payload, { share: async () => { throw Error('unsupported'); },
    clipboard: { writeText: async (v) => { copied = v; } } }), 'copied');
  assert.equal(copied, 'SCORE 12\nhttps://example.com');
  assert.equal(await Challenge.share(payload, {}), 'failed');
  console.log('PASS native sharing, cancellation, clipboard fallback, and unavailable clipboard');
})().catch((e) => { console.log('FAIL sharing — ' + e.message); process.exitCode = 1; });
