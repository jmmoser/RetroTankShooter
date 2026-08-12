/* Stealth sensor model: the shared senseRange truth the HUD cones draw, the
 * two-stage detect meter (glimpse telegraph before the alert), and the
 * first-suspicion ping. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

loadScripts(['game.js'],
  'global.Game = Game; global.senseRange = senseRange; ' +
  'global.ENEMY_TYPES = ENEMY_TYPES; global.SENSE_SUS = SENSE_SUS; ' +
  'global.SENSE_RAMP = SENSE_RAMP;');
const hud = fakeHud();

function freshGame() {
  const g = new Game(hud);
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  return g;
}

/* One drone at (0, -dist) staring straight at a parked player at the origin.
 * Positions and signature are pinned, so the fill rate is deterministic. */
function staredown(dist, sig) {
  const g = freshGame();
  g.enemies.length = 0;
  g.obstacles.length = 0;
  g.noises.length = 0;
  const p = g.player;
  p.x = 0; p.z = 0; p.sig = sig;
  g._spawnEnemy('drone', 0, -dist);
  const e = g.enemies[0];
  e.angle = Math.PI;   // facing +Z: straight at the player
  return { g, e };
}

check('senseRange scales a hull\'s sight with the target signature', () => {
  assert(senseRange('drone', 1) === ENEMY_TYPES.drone.sight, 'full signature = full sight');
  assert(Math.abs(senseRange('drone', 0) - ENEMY_TYPES.drone.sight * 0.35) < 1e-9,
    'cold tank shrinks sight to 35%');
  assert(Math.abs(senseRange('sniper', 0.5) - ENEMY_TYPES.sniper.sight * 0.675) < 1e-9,
    'mid signature interpolates');
  assert(senseRange('nosuch', 1) === 0, 'unknown hull type reads as blind');
});

check('the sim detects with senseRange: outside the cone\'s reach nothing fills', () => {
  // reach for a drone vs sig 0.15 is ~24.6 — park just outside it
  const { g, e } = staredown(senseRange('drone', 0.15) + 2, 0.15);
  for (let i = 0; i < 240; i++) g._senseUpdate(e, 1 / 60);
  assert(e.sense === 0 && !e.alerted, 'filled from beyond its own sight range');
});

check('detect meter is two-stage: the climb past SUSPICIOUS runs at SENSE_RAMP', () => {
  const { g, e } = staredown(20, 0.5);
  const dt = 1 / 120;
  let t = 0, tSus = 0, tAlert = 0;
  while (!e.alerted && t < 20) {
    g._senseUpdate(e, dt);
    t += dt;
    if (!tSus && e.sense >= SENSE_SUS) tSus = t;
  }
  tAlert = t;
  assert(e.alerted, 'staredown never alerted');
  assert(tSus > 0 && tAlert > tSus, 'stages out of order');
  // equal rates would give (1-SUS)/SUS = 1.5x the glimpse time; the ramp
  // stretches the confirm stage to 1.5/SENSE_RAMP ~ 2.7x. Assert well past
  // the single-stage ratio so a regression to a flat rate fails loudly.
  assert(tAlert - tSus > tSus * 2.2,
    'confirm stage not stretched: sus at ' + tSus.toFixed(3) + 's, alert at ' + tAlert.toFixed(3) + 's');
});

check('crossing SUSPICIOUS pings once, placed at the hull that noticed', () => {
  const { g, e } = staredown(20, 0.5);
  const pings = () => g.frameSounds.filter((s) => (Array.isArray(s) ? s[0] : s) === 'ping');
  for (let i = 0; i < 2400 && !e.alerted; i++) g._senseUpdate(e, 1 / 120);
  assert(e.alerted, 'staredown never alerted');
  const got = pings();
  assert(got.length === 1, 'expected exactly one ping, got ' + got.length);
  assert(Array.isArray(got[0]) && got[0][1] === Math.round(e.x) && got[0][2] === Math.round(e.z),
    'ping not placed at the sensing hull');
});

check('noise that pushes a patrol past SUSPICIOUS also pings', () => {
  const { g, e } = staredown(60, 0);   // far outside sight reach
  g._noise(e.x + 10, e.z, 30, 0.55);
  g._senseUpdate(e, 1 / 60);
  const got = g.frameSounds.filter((s) => (Array.isArray(s) ? s[0] : s) === 'ping');
  assert(e.sense >= SENSE_SUS, 'noise did not raise suspicion');
  assert(got.length === 1, 'noise crossing did not ping');
});

check('a hull looking away stays blind beyond hearing range', () => {
  const { g, e } = staredown(20, 0.5);
  e.angle = 0;   // facing -Z: player is dead astern, 20 > hearing (9 + 0.5*16)
  for (let i = 0; i < 240; i++) g._senseUpdate(e, 1 / 60);
  assert(e.sense === 0 && !e.alerted, 'filled from outside the vision cone');
});
