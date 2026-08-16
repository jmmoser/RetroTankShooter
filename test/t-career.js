/* The career ladder has to spend. Every run pays XP and the game-over screen
 * says so, but rank bought a word and nothing else, and the first checkpoint
 * sat behind five cleared sectors — so a pilot's twentieth run was
 * mechanically identical to their first for as long as that mattered most. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SETTINGS_SRC = fs.readFileSync(path.join(ROOT, 'js/settings.js'), 'utf8');

/* settings.js declares `const Progress`, which would shadow any global stub
 * game.js later reads — so the persistence half is evaluated in throwaway
 * sandboxes and never in this context. Each call gets a fresh localStorage,
 * which is also the only way to vary the stats it caches at load. */
function withStats(stats, fn) {
  const store = { pa_stats: JSON.stringify(stats) };
  const sandbox = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SETTINGS_SRC + '\n;this.__P = Progress; this.__RANKS = RANKS;', sandbox);
  return fn(sandbox.__P, sandbox.__RANKS);
}
const RANKS = withStats({}, (P, R) => R);

check('a fresh pilot has exactly one start: sector 1', () => {
  withStats({ bestSector: 1, xp: 0 }, (P) => {
    assert(P.checkpoints().join() === '1', 'fresh checkpoints: ' + P.checkpoints().join());
    assert(P.startingTech() === 0, 'a RECRUIT deploys with banked tech');
  });
});

check('the first checkpoint arrives while a pilot is still learning', () => {
  // it used to be sector 6 — five cleared sectors away, which is exactly the
  // stretch someone who needs a checkpoint cannot clear
  withStats({ bestSector: 5, xp: 0 }, (P) => {
    const cps = P.checkpoints();
    assert(cps.length > 1, 'reaching sector 5 still unlocks nothing: ' + cps.join());
    assert(Math.min(...cps.filter((c) => c > 1)) <= 4,
      'the first rung is sector ' + Math.min(...cps.filter((c) => c > 1)));
  });
});

check('a checkpoint is never at or past your deepest sector', () => {
  for (const best of [1, 2, 4, 5, 7, 9, 12, 20]) {
    withStats({ bestSector: best, xp: 0 }, (P) => {
      for (const c of P.checkpoints()) {
        assert(c === 1 || c < best,
          'best ' + best + ' offers a start at ' + c + ' — at or past the record');
      }
    });
  }
});

check('checkpoints are ordered, unique, and always include sector 1', () => {
  withStats({ bestSector: 14, xp: 0 }, (P) => {
    const cps = P.checkpoints();
    assert(cps[0] === 1, 'sector 1 is not the first start');
    assert(new Set(cps).size === cps.length, 'duplicate checkpoints: ' + cps.join());
    for (let i = 1; i < cps.length; i++) assert(cps[i] > cps[i - 1], 'unsorted: ' + cps.join());
  });
});

check('rank buys banked tech, and it never goes backwards', () => {
  let prev = -1;
  for (const [name, xp] of RANKS) {
    withStats({ bestSector: 1, xp }, (P) => {
      const t = P.startingTech();
      assert(t >= prev, name + ' banks ' + t + ', less than the rank below (' + prev + ')');
      assert(t >= 0 && t <= 6, name + ' banks an absurd ' + t);
      prev = t;
    });
  }
  assert(prev > 0, 'the top of the ladder still buys nothing');
});

check('the second rank already pays — the ladder is not backloaded', () => {
  withStats({ bestSector: 1, xp: RANKS[1][1] }, (P) => {
    assert(P.startingTech() >= 1, RANKS[1][0] + ' banks nothing');
  });
});

// ---- the sim half: who actually receives a promotion ------------------------
// a plain global stub, installed BEFORE game.js loads so nothing shadows it
let bankedTech = 0;
global.Progress = { startingTech: () => bankedTech, coachDone: () => true, setCoachDone() {} };
loadScripts(['game.js'], 'global.Game = Game;');

function run(opts, tech) {
  bankedTech = tech;
  const g = new Game(fakeHud());
  const defs = opts.defs || [{ id: 'solo', loadoutIndex: 1 }];
  g.newRun(defs, defs[0].id, opts.run || {});
  return g;
}

check('a solo campaign deploys with the rank banked as real tech levels', () => {
  const g = run({}, 3);
  assert(g.startTech === 3, 'startTech is ' + g.startTech);
  assert(g.player.techLvl === 3, 'tech level is ' + g.player.techLvl);
  assert(g.player.pendingOffers, 'no draft waiting for a promoted pilot');
});

check('Daily Ops stays a level playing field', () => {
  const g = run({ run: { dailySeed: '2026-01-01' } }, 3);
  assert(g.startTech === 0, 'a daily deployed with ' + g.startTech + ' banked tech');
  assert(g.player.techLvl === 0, 'a daily pilot started at tech ' + g.player.techLvl);
});

check('versus and co-op do not inherit one pilot rank', () => {
  const vs = run({ defs: [{ id: 'a' }, { id: 'b' }], run: { versus: true } }, 3);
  assert(vs.startTech === 0, 'versus deployed with banked tech');
  const coop = run({ defs: [{ id: 'a' }, { id: 'b' }] }, 3);
  assert(coop.startTech === 0, "co-op armed everyone off the host's rank");
});

check('the promotion is paid once, not once per sector', () => {
  const g = run({}, 2);
  const lvl = g.player.techLvl;
  g.level++;
  g.startLevel();
  assert(g.player.techLvl === lvl, 'sector 2 paid the promotion again (' + g.player.techLvl + ')');
});
