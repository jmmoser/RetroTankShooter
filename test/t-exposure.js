/* EXPOSURE: the sim's "something has live eyes on YOU" read, and the HUD
 * bearing math that points the arc at whoever is looking. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

loadScripts(['game.js'],
  'global.Game = Game; global.senseRange = senseRange; global.SIGHT_CONE = SIGHT_CONE;' +
  ' global.angleTo = angleTo; global.SENSE_SUS = SENSE_SUS;');

/* Park one patrol at (ex,ez) staring at a stationary player at the origin. */
function staged(sig) {
  const g = new Game(fakeHud());
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  g.obstacles.length = 0;
  g.enemies.length = 1;
  const p = g.player;
  p.x = 0; p.z = 0; p.angle = 0; p.vx = 0; p.vz = 0; p.speed = 0;
  // signature is normally derived in _updatePlayer; these tests drive
  // _senseUpdate directly, so set the value the sensors read
  p.sig = sig;
  p.heat = sig >= 0.5 ? p.maxHeat : 0;
  return g;
}
function place(g, ex, ez) {
  const e = g.enemies[0];
  e.x = ex; e.z = ez;
  e.angle = angleTo(-ex, -ez);   // stare at the origin
  e.alerted = false; e.sense = 0; e.type = 'drone'; e.cloak = 0;
  return e;
}

/* One sense tick, driven the way update() drives it: clear last frame's
 * exposure, then let the hull look. Calling _senseUpdate directly keeps the
 * patrol AI from re-aiming the hull out from under the test. */
function look(g, e, secs) {
  const steps = Math.round(secs * 60);
  for (let i = 0; i < steps; i++) {
    g.exposure = null;
    g._senseUpdate(e, 1 / 60);
    if (e.alerted) break;
  }
}

check('a hull looking the other way produces no exposure', () => {
  const g = staged(1);
  const e = place(g, 0, -30);
  e.angle += Math.PI;
  look(g, e, 0.5);
  assert(!g.exposure, 'exposed to a hull looking away: ' + JSON.stringify(g.exposure));
});

check('a hull with eyes on you reports its meter and its position', () => {
  const g = staged(1);
  const e = place(g, 0, -20);
  look(g, e, 0.2);
  assert(g.exposure, 'no exposure while being watched at 20 units, hot');
  assert(g.exposure.level > 0 && g.exposure.level <= 1, 'level ' + g.exposure.level);
  assert(g.exposure.x === e.x && g.exposure.z === e.z, 'exposure is not the watching hull');
});

check('an alerted hull is not exposure — it already knows', () => {
  const g = staged(1);
  const e = place(g, 0, -20);
  e.alerted = true;
  look(g, e, 0.2);
  assert(!g.exposure, 'an alerted hull reported a filling meter');
});

check('exposure clears the frame the eyes come off you', () => {
  const g = staged(1);
  const e = place(g, 0, -20);
  look(g, e, 0.2);
  assert(g.exposure, 'never exposed to begin with');
  g.player.x = 400;              // well outside any sensor reach
  g.exposure = null;
  g._senseUpdate(e, 1 / 60);
  assert(!g.exposure, 'still exposed after breaking contact');
});

check('running cold pulls a hull off you that a hot signature would feed', () => {
  const hot = staged(1);       // redlined: a drone reaches 55
  look(hot, place(hot, 0, -34), 0.3);
  const cold = staged(0.15);   // slow and cold: the same drone reaches ~25
  look(cold, place(cold, 0, -34), 0.3);
  assert(hot.exposure, 'a redlined hull at 34 units went unseen');
  assert(!cold.exposure, 'a cold hull at 34 units was still seen');
});

/* The HUD's bearing math, extracted so the mapping is pinned by a test
 * rather than by a screenshot. Canvas angles run clockwise from +X; the
 * hull's forward must land straight up. */
function canvasAngle(px, pz, pangle, ex, ez) {
  const bearing = Math.atan2(-(ex - px), -(ez - pz)) - pangle;
  return -bearing - Math.PI / 2;
}
const norm = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

check('the exposure arc points at the watcher, not its mirror image', () => {
  const near = (a, b, m) => assert(Math.abs(norm(a - b)) < 1e-6, m + ' — got ' + a.toFixed(3));
  // player at the origin facing -Z (angle 0)
  near(canvasAngle(0, 0, 0, 0, -20), -Math.PI / 2, 'a hull dead ahead must draw straight up');
  near(canvasAngle(0, 0, 0, -20, 0), Math.PI, 'a hull to the LEFT must draw left');
  near(canvasAngle(0, 0, 0, 20, 0), 0, 'a hull to the RIGHT must draw right');
  near(canvasAngle(0, 0, 0, 0, 20), Math.PI / 2, 'a hull behind must draw down');
  // and it rides the hull: turn 90 degrees left and the same watcher swings right
  near(canvasAngle(0, 0, Math.PI / 2, -20, 0), -Math.PI / 2,
    'turning to face a hull must bring it to straight up');
});

check('the arc frame agrees with the radar blip frame', () => {
  // the dish maps world->local with the inverse hull rotation; the arc must
  // land on the same canvas angle as the blip it is describing
  for (const [px, pz, pa, ex, ez] of [[0, 0, 0, -20, 0], [5, -8, 1.1, 30, 12], [-40, 60, -2.4, 0, 0]]) {
    const dx = ex - px, dz = ez - pz;
    const ca = Math.cos(pa), sa = Math.sin(pa);
    const lx = dx * ca - dz * sa, lz = dx * sa + dz * ca;
    const blip = Math.atan2(lz, lx);
    const arc = canvasAngle(px, pz, pa, ex, ez);
    assert(Math.abs(norm(blip - arc)) < 1e-6,
      'arc ' + arc.toFixed(3) + ' vs blip ' + blip.toFixed(3));
  }
});
