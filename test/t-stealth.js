/* Stealth sensor model: the shared senseRange truth the HUD cones draw, the
 * senseNear hearing bubble the HUD rings draw, the two-stage detect meter
 * (glimpse telegraph before the alert), and the first-suspicion ping. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

loadScripts(['game.js'],
  'global.Game = Game; global.senseRange = senseRange; global.senseNear = senseNear; ' +
  'global.ENEMY_TYPES = ENEMY_TYPES; global.SENSE_SUS = SENSE_SUS; ' +
  'global.SENSE_RAMP = SENSE_RAMP; global.AMBUSH_MUL = AMBUSH_MUL;');
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

/* AMBUSH: the cannon's way into the stealth game — a shell on a hull that
 * never alerted hits at AMBUSH_MUL, so a base shell (25) one-shots an
 * unaware drone (60 hp) and the kill counts as silent. */

function fieldWith(type) {
  const g = freshGame();
  g.enemies.length = 0;
  g.obstacles.length = 0;
  g._spawnEnemy(type, 40, 40);
  return { g, e: g.enemies[0] };
}

check('AMBUSH: one cold shell deletes an unaware drone, silently', () => {
  const { g } = fieldWith('drone');
  g._hurtEnemy(0, 25, 'solo', 'cannon');
  assert(g.enemies.length === 0, 'unaware drone survived an ambush shell');
  assert(g.runStats.silentKills === 1, 'ambush kill not counted as silent');
  assert(g.alarmT <= 0, 'a clean ambush kill raised the alarm');
});

check('AMBUSH: an alerted hull takes plain cannon damage', () => {
  const { g, e } = fieldWith('drone');
  e.alerted = true; e.sense = 1;
  g._hurtEnemy(0, 25, 'solo', 'cannon');
  assert(g.enemies.length === 1, 'alerted drone died to one plain shell');
  assert(Math.abs(e.hp - (e.maxHp - 25)) < 1e-9,
    'expected plain damage, hp = ' + e.hp);
});

check('AMBUSH is cannon-only: grenades on unaware hulls stay at listed damage', () => {
  const { g, e } = fieldWith('drone');
  g._hurtEnemy(0, 25, 'solo', 'nade');
  assert(g.enemies.length === 1 && Math.abs(e.hp - (e.maxHp - 25)) < 1e-9,
    'nade damage was multiplied');
});

check('AMBUSH survivor still alerts and raises the alarm — commit to kills', () => {
  const { g, e } = fieldWith('hunter');   // 85 hp: a cold ambush (75) wounds
  g._hurtEnemy(0, 25, 'solo', 'cannon');
  assert(g.enemies.length === 1, 'hunter should survive a cold ambush shell');
  assert(Math.abs(e.hp - (e.maxHp - 25 * AMBUSH_MUL)) < 1e-9,
    'ambush shell not multiplied, hp = ' + e.hp);
  assert(e.alerted, 'surviving an ambush must alert the hull');
  assert(g.alarmT > 0, 'a failed ambush must raise the sector alarm');
});

/* ---- the hearing bubble -----------------------------------------------------
 * A patrol detects on cone OR proximity. The proximity half used to be drawn
 * by nothing, so a player routing perfectly around every cone on the floor
 * still got made — caught by a rule with no display. Both halves are one
 * exported function now, and both are drawn from it. */

check('senseNear shrinks with signature, like everything else a sensor does', () => {
  assert(senseNear(1) > senseNear(0.15) * 1.7,
    'cold ' + senseNear(0.15).toFixed(1) + ' vs redlined ' + senseNear(1).toFixed(1));
  assert(senseNear(0.15) > 4, 'a cold tank is inaudible at touching distance');
});

check('a hull looking the other way still hears you inside the bubble', () => {
  const near = (dist) => {
    const g = freshGame();
    const p = g.player;
    p.x = 0; p.z = 0; p.sig = 1;
    g.obstacles.length = 0;
    g.enemies.length = 1;
    const e = g.enemies[0];
    e.type = 'drone'; e.x = 0; e.z = dist; e.cloak = 0;
    e.alerted = false; e.sense = 0; e.invT = 0;
    e.angle = Math.PI;                 // facing +Z: directly AWAY from the player at the origin
    for (let i = 0; i < 30; i++) g._senseUpdate(e, 1 / 60);
    return e.sense;
  };
  const inside = senseNear(1) - 3, outside = senseNear(1) + 6;
  assert(near(inside) > 0, 'a hull did not hear a redlined tank at ' + inside.toFixed(0) + ' units behind it');
  assert(near(outside) === 0, 'a hull heard a tank at ' + outside.toFixed(0) + ' units behind it');
});

check('the bubble is the sim\'s own number, not a second constant', () => {
  // the renderer and the radar both call senseNear; the detection test has to
  // be the same function or the drawing is decoration
  const src = require('fs').readFileSync(require('path').join(__dirname, '../js/game.js'), 'utf8');
  const uses = (src.match(/senseNear\(/g) || []).length;
  assert(uses >= 2, 'senseNear is declared but the sim does not detect with it');
  assert(!/d > 9 \+ sig \* 16/.test(src), 'the hearing radius is inlined again, so the HUD can drift from it');
});
