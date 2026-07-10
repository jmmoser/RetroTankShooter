/* Daily-ops persistence: seed-dated bests, UTC-midnight straddles, streak
 * chains, and corrupted-storage hardening. */
const { loadScripts, check, assert } = require('./helpers');

const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
loadScripts(['settings.js'], 'global.Progress = Progress; global.Medals = Medals;');

const today = Progress.todayKey();
const d = new Date(today + 'T00:00:00Z');
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const yesterday = iso(d.getTime() - 86400000);
const twoDaysAgo = iso(d.getTime() - 2 * 86400000);

check('consecutive days extend the streak; same day is idempotent', () => {
  Progress.recordDailyPlayed(yesterday);
  assert(Progress.recordDailyPlayed(today).streak === 2, 'chain did not extend');
  assert(Progress.recordDailyPlayed(today).streak === 2, 'not idempotent');
});

check('a stale yesterday-run after today does not regress the chain', () => {
  assert(Progress.recordDailyPlayed(yesterday).streak === 2, 'regressed');
  assert(Progress.dailyStreak() === 2, 'display wrong');
});

check('a skipped day resets the streak to 1', () => {
  store.pa_streak = JSON.stringify({ last: twoDaysAgo, streak: 5, best: 5 });
  assert(Progress.recordDailyPlayed(today).streak === 1, 'gap did not reset');
});

check('malformed pa_streak.last cannot brick recording', () => {
  store.pa_streak = JSON.stringify({ last: 'Wed Jul 09 2026', streak: 3 });
  const s = Progress.recordDailyPlayed(today);
  assert(s.last === today && s.streak === 1, 'corrupt last not sanitized: ' + JSON.stringify(s));
});

check('midnight straddle: yesterday-seed run cannot clobber today\'s best', () => {
  store.pa_daily = JSON.stringify({ date: today, score: 1000, sector: 3 });
  assert(Progress.recordDaily(2000, 5, yesterday) === false, 'stale run recorded as best');
  assert(JSON.parse(store.pa_daily).score === 1000, 'today\'s best clobbered');
});

check('same-day best updates only on a higher score', () => {
  assert(Progress.recordDaily(1500, 4, today) === true, 'higher score rejected');
  assert(Progress.recordDaily(200, 1, today) === false, 'lower score accepted');
  assert(Progress.dailyBest().score === 1500, 'best readout wrong');
});

check('dailyBest(day) reads the record for the requested day', () => {
  store.pa_daily = JSON.stringify({ date: yesterday, score: 777, sector: 2 });
  assert(Progress.dailyBest() === null, 'today matched yesterday\'s record');
  assert(Progress.dailyBest(yesterday).score === 777, 'seed-day lookup failed');
});

check('medals: first award true, repeat false, unknown id rejected', () => {
  assert(Medals.award('firstblood') === true, 'first award failed');
  assert(Medals.award('firstblood') === false, 'repeat award succeeded');
  assert(Medals.award('not-a-medal') === false, 'unknown medal accepted');
  assert(Medals.has('firstblood'), 'has() lost the award');
});
