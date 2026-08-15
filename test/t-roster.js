/* Sector composition is a difficulty curve, so it is asserted like one:
 * one new idea per sector on the way up, a readable drone baseline early,
 * and the deep end thinning that baseline out rather than repeating itself. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

loadScripts(['game.js'], 'global.Game = Game; global.ENEMY_TYPES = ENEMY_TYPES;');

const g = new Game(fakeHud());
const size = (L) => Math.min(5 + Math.floor(L * 1.1), 12);
function census(L) {
  const c = {};
  for (const t of g._roster(L, size(L))) c[t] = (c[t] || 0) + 1;
  return c;
}
const kinds = (L) => Object.keys(census(L)).sort();

check('sector 1 is drones and nothing else', () => {
  assert(kinds(1).join() === 'drone', 'sector 1 rosters ' + kinds(1).join());
});

check('every sector adds exactly one new hull type, all the way up', () => {
  // sectors 5 and 10 are WARLORD sectors with no roster, so the debuts step
  // around them — compare each rostered sector to the previous rostered one
  let prev = new Set(kinds(1));
  // the roster is complete by sector 8; after that the ramp is depth, not
  // breadth, which the escalation check below covers
  for (let L = 2; L <= 8; L++) {
    if (L % 5 === 0) continue;
    const now = kinds(L);
    const fresh = now.filter((t) => !prev.has(t));
    assert(fresh.length === 1,
      'sector ' + L + ' introduces ' + fresh.length + ' new types (' + fresh.join() + ')');
    prev = new Set(now);
  }
});

check('sector 2 fields ONE hunter — the first hull that can hit a moving tank', () => {
  const c = census(2);
  assert(c.hunter === 1, 'sector 2 fields ' + c.hunter + ' hunters');
  assert(!c.rusher, 'sector 2 also fields a rusher');
});

check('a roster always fills the sector exactly', () => {
  for (let L = 1; L <= 14; L++) {
    const r = g._roster(L, size(L));
    assert(r.length === size(L), 'sector ' + L + ': ' + r.length + ' hulls for ' + size(L) + ' slots');
    for (const t of r) assert(ENEMY_TYPES[t], 'sector ' + L + ' rostered unknown type ' + t);
  }
});

check('drones stay the readable baseline early and thin out deep', () => {
  for (let L = 1; L <= 6; L++) {
    const c = census(L);
    assert((c.drone || 0) >= size(L) / 4,
      'sector ' + L + ' has only ' + (c.drone || 0) + ' drones of ' + size(L));
  }
  assert((census(11).drone || 0) < (census(4).drone || 0),
    'the deep end is no denser in specials than sector 4');
});

check('the deep end keeps escalating instead of repeating sector 7', () => {
  const specials = (L) => size(L) - (census(L).drone || 0);
  assert(specials(11) > specials(7), 'sector 11 is not harsher than sector 7');
});

check('no hull type appears before the sector it is introduced in', () => {
  const FIRST = { hunter: 2, rusher: 3, shellback: 4, sniper: 6, warden: 7, phantom: 8 };
  for (let L = 1; L <= 14; L++) {
    for (const t of Object.keys(census(L))) {
      if (t === 'drone') continue;
      assert(L >= FIRST[t], t + ' showed up in sector ' + L + ', before sector ' + FIRST[t]);
    }
  }
});

check('a converge wave is no place to meet a hull type for the first time', () => {
  const FIRST = { hunter: 2, rusher: 3, shellback: 4, sniper: 6, warden: 7, phantom: 8 };
  for (let L = 1; L <= 10; L++) {
    g.level = L;
    g.mutator = null;
    for (let i = 0; i < 400; i++) {
      for (const t of [g._reinforcementType(), g._pressureType()]) {
        if (t === 'drone') continue;
        assert(L >= FIRST[t], 'a sector-' + L + ' wave can spawn a ' + t);
      }
    }
  }
});

check('a hunter can only shoot on its lunge', () => {
  const gg = new Game(fakeHud());
  gg.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  gg.obstacles.length = 0;
  gg.enemies.length = 1;
  const p = gg.player;
  p.x = 0; p.z = 0; p.vx = 0; p.vz = 0; p.speed = 0;
  const e = gg.enemies[0];
  e.type = 'hunter'; e.alerted = true; e.sense = 1; e.seenT = 0; e.cloak = 0;
  e.x = 0; e.z = -30; e.angle = Math.atan2(-(p.x - e.x), -(p.z - e.z));
  e.fireCd = 0; e.phaseT = 999;
  const shotsIn = (phase) => {
    gg.projectiles.length = 0;
    e.phase = phase;
    for (let i = 0; i < 600; i++) {
      e.phase = phase; e.phaseT = 999;      // hold the phase steady
      e.x = 0; e.z = -30; e.angle = Math.atan2(-(p.x - e.x), -(p.z - e.z));
      gg._updateEnemies(1 / 60);
    }
    return gg.projectiles.filter((pr) => pr.from === 'enemy').length;
  };
  assert(shotsIn('lunge') > 0, 'a lunging hunter never fired');
  assert(shotsIn('flank') === 0, 'a flanking hunter fired — the rhythm has no quiet beat');
});
