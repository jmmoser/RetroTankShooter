/* Presentation-layer regressions: the impact/hit-stop feedback funnel, the
 * ground-decal pool, tread-print cadence, and the positional-sound encoding
 * that has to survive the co-op wire. All of this is cosmetic, which is
 * exactly why it needs tests — a bug here degrades quietly instead of
 * crashing, and none of it is covered by the combat suites. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

// capture what the game hands to the audio layer
const played = [];
global.AudioSys = { play(name, at) { played.push({ name, at }); } };

loadScripts(['game.js'], 'global.Game = Game; global.DECAL_CAP = DECAL_CAP; global.TREAD_SPACING = TREAD_SPACING;');
const hud = fakeHud();

function freshGame() {
  played.length = 0;
  const g = new Game(hud);
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  return g;
}

// ---- impact feedback --------------------------------------------------------

check('_impact accumulates trauma and kick, and takes the longest hit-stop', () => {
  const g = freshGame();
  g.shake = 0; g.kickX = 0; g.kickZ = 0; g.hitStop = 0;
  g._impact(0.3, 2, -1, 0.05);
  g._impact(0.4, 1, 1, 0.02);        // shorter stop must not shorten the first
  assert(Math.abs(g.shake - 0.7) < 1e-9, 'trauma ' + g.shake);
  assert(g.kickX === 3 && g.kickZ === 0, 'kick ' + g.kickX + ',' + g.kickZ);
  assert(Math.abs(g.hitStop - 0.05) < 1e-9, 'hitStop ' + g.hitStop);
});

check('trauma saturates at 2 no matter how much lands at once', () => {
  const g = freshGame();
  g.shake = 0;
  for (let i = 0; i < 20; i++) g._impact(0.5, 0, 0, 0);
  assert(g.shake === 2, 'shake ' + g.shake);
});

check('a new sector clears impact state so it cannot bleed across a load', () => {
  const g = freshGame();
  g._impact(1.5, 9, 9, 0.4);
  g.nextLevel('standard');
  assert(g.shake === 0 && g.hitStop === 0 && g.kickX === 0 && g.kickZ === 0,
    'stale impact state: ' + [g.shake, g.hitStop, g.kickX, g.kickZ].join(','));
});

// ---- decals -----------------------------------------------------------------

check('decals fade out and are reaped on expiry', () => {
  const g = freshGame();
  g.decals.length = 0;
  g._addDecal(10, 10, 4, 2, 'scorch', 0, 0.5);
  assert(g.decals.length === 1, 'not added');
  g._updateDecals(1);
  assert(g.decals.length === 1 && Math.abs(g.decals[0].life - 1) < 1e-9, 'early reap');
  g._updateDecals(1.01);
  assert(g.decals.length === 0, 'never reaped');
});

check('the decal pool is hard-capped and drops the oldest marks first', () => {
  const g = freshGame();
  g.decals.length = 0;
  for (let i = 0; i < DECAL_CAP + 40; i++) g._addDecal(i, 0, 3, 20, 'scorch', 0, 0.5);
  assert(g.decals.length <= DECAL_CAP, 'pool overflowed to ' + g.decals.length);
  const first = g.decals[0].x, last = g.decals[g.decals.length - 1].x;
  assert(last === DECAL_CAP + 39, 'newest mark lost, got ' + last);
  assert(first > 0, 'oldest mark survived the cap');
});

check('non-finite decal positions are refused, not stored as NaN', () => {
  const g = freshGame();
  g.decals.length = 0;
  g._addDecal(NaN, 3, 4, 10, 'scorch', 0, 0.5);
  g._addDecal(3, undefined, 4, 10, 'scorch', 0, 0.5);
  assert(g.decals.length === 0, 'NaN decal stored');
});

check('a detonation burns exactly one scorch into the floor', () => {
  const g = freshGame();
  g.decals.length = 0;
  g._nadeBoom({ x: 40, z: -20, y: 0.4, angle: 0, dmg: 60, owner: 'solo', kind: 'nade' });
  const scorch = g.decals.filter((d) => d.kind === 'scorch');
  assert(scorch.length === 1, 'scorch count ' + scorch.length);
  assert(scorch[0].x === 40 && scorch[0].z === -20, 'scorch misplaced');
});

// ---- tread prints -----------------------------------------------------------

check('tread prints drop per distance travelled, two per hull', () => {
  const g = freshGame();
  g.decals.length = 0;
  const p = g.player;
  p.speed = 20; p.angle = 0;
  p.x = 0; p.z = 0;
  g._updateTreads(0.016);                 // primes the odometer, drops nothing
  assert(g.decals.length === 0, 'dropped on the priming tick');
  p.z = -(TREAD_SPACING + 0.1);
  g._updateTreads(0.016);
  assert(g.decals.length === 2, 'expected a pair of prints, got ' + g.decals.length);
  assert(g.decals.every((d) => d.kind === 'tread'), 'wrong decal kind');
  // the pair straddles the hull's centre line
  assert(Math.abs(g.decals[0].x + g.decals[1].x) < 1e-6, 'prints not symmetric');
});

check('a parked hull leaves no tracks', () => {
  const g = freshGame();
  g.decals.length = 0;
  const p = g.player;
  p.speed = 0;
  for (let i = 0; i < 30; i++) g._updateTreads(0.05);
  assert(g.decals.length === 0, 'idle hull laid ' + g.decals.length + ' prints');
});

check('a cloaked phantom leaves no tracks either', () => {
  const g = freshGame();
  g.decals.length = 0;
  g.enemies.length = 0;
  g._spawnEnemy('phantom', 20, 20);
  const e = g.enemies[0];
  e.speed = 20; e.cloak = 1;
  g._updateTreads(0.016);
  e.x = 20; e.z = 20 - (TREAD_SPACING + 0.1);
  g._updateTreads(0.016);
  assert(g.decals.length === 0, 'cloaked hull left tracks');
});

// ---- positional sound encoding ---------------------------------------------

check('_sfx places a sound locally and encodes it as [key, x, z] for the wire', () => {
  const g = freshGame();
  g.frameSounds.length = 0;
  played.length = 0;
  g._sfx('explosion', 12.4, -7.6);
  assert(Array.isArray(g.frameSounds[0]), 'flat encoding for a placed sound');
  assert(g.frameSounds[0][0] === 'explosion', 'key lost');
  assert(g.frameSounds[0][1] === 12 && g.frameSounds[0][2] === -8, 'position ' + g.frameSounds[0]);
  assert(played[0].at && played[0].at.x === 12.4, 'local play was not placed');
});

check('_sfx without a position stays a bare string on the wire', () => {
  const g = freshGame();
  g.frameSounds.length = 0;
  played.length = 0;
  g._sfx('alarm');
  assert(g.frameSounds[0] === 'alarm', 'unexpected encoding: ' + JSON.stringify(g.frameSounds[0]));
  assert(played[0].at === null, 'flat sound was placed anyway');
});

check('a non-finite position degrades to a flat sound instead of NaN panning', () => {
  const g = freshGame();
  g.frameSounds.length = 0;
  played.length = 0;
  g._sfx('fire', NaN, 4);
  assert(g.frameSounds[0] === 'fire', 'NaN position reached the wire');
  assert(played[0].at === null, 'NaN position reached the mixer');
});
