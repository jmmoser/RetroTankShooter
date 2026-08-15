/* Movement must never dead-end. "Momentum is everything" is the stated pillar,
 * and in a stealth game sitting still is how you die — so there is no input a
 * player can hold that parks the hull against geometry. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

loadScripts(['game.js'], 'global.Game = Game; global.ARENA_HALF = ARENA_HALF;');

/* Drive full throttle from (sx,sz) at whatever is at (tx,tz), for `secs`, and
 * report the longest stretch the hull failed to move at all. Facing is derived
 * from the target rather than passed in, so a test cannot accidentally drive
 * away from the thing it means to hit. */
function driveAt(setup, sx, sz, tx, tz, turn, secs) {
  const g = new Game(fakeHud());
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  g.enemies.length = 0;
  g.obstacles.length = 0;
  if (setup) setup(g);
  const p = g.player;
  p.x = sx; p.z = sz;
  p.angle = Math.atan2(-(tx - sx), -(tz - sz));   // game convention: angleTo()
  p.vx = 0; p.vz = 0; p.speed = 0;
  let stuck = 0, worst = 0, path = 0;
  for (let i = 0; i < secs * 60; i++) {
    p.input.drive = 1; p.input.turn = turn; p.input.boost = false;
    const bx = p.x, bz = p.z;
    g.update(1 / 60);
    const step = Math.hypot(p.x - bx, p.z - bz);
    path += step;
    if (step < 0.02) { stuck++; worst = Math.max(worst, stuck); }
    else stuck = 0;
  }
  // ground covered is the honest "did it keep moving" measure — a final-frame
  // speed reading can land mid-rebound and slander a hull that never stalled
  return { worst: worst / 60, path, speed: Math.hypot(p.vx, p.vz), p };
}
const slab = (x, z, w, d) => (g) => g._addSlab(x, z, w, d, 7, 'block', 0);

check('holding forward into a flat slab face slides along it, it does not weld', () => {
  // dead-on into an axis-aligned face is the degenerate case: no tangential
  // component survives the normal clamp, so the hull used to sit at zero
  // velocity under full throttle indefinitely
  for (const [sx, sz, name] of [[0, 40, '-Z face'], [0, -40, '+Z face'],
                                [40, 0, '-X face'], [-40, 0, '+X face']]) {
    const r = driveAt(slab(0, 0, 26, 26), sx, sz, 0, 0, 0, 10);
    assert(r.worst < 1, 'wedged for ' + r.worst.toFixed(1) + 's on the ' + name);
    // a welded hull covers ~25 units (the run-up) and then nothing; a sliding
    // one clears the slab and keeps going
    assert(r.path > 120, 'covered only ' + r.path.toFixed(0) + ' units off the ' + name);
  }
});

check('an inside corner does not trap the hull', () => {
  const corner = (g) => { g._addSlab(0, -16, 40, 8, 7, 'block', 0); g._addSlab(-16, 0, 8, 40, 7, 'block', 0); };
  for (const [tx, tz, name] of [[-16, -16, 'the corner itself'], [-6, -40, 'the -Z face'], [-40, -6, 'the -X face']]) {
    const r = driveAt(corner, -6, -6, tx, tz, 0, 10);
    assert(r.worst < 1, 'wedged for ' + r.worst.toFixed(1) + 's driving at ' + name);
  }
});

check('the arena rim and its corners do not trap the hull', () => {
  // held against the rim at speed the hull rebounds, re-accelerates and
  // rebounds again — that is the intended arcade answer to driving into a
  // wall. Only a stall is a failure, so the floor here just has to beat the
  // ~20-unit run-up a welded hull would manage.
  const rim = driveAt(null, 0, ARENA_HALF - 20, 0, ARENA_HALF + 40, 0, 10);
  assert(rim.worst < 1, 'wedged on the arena rim for ' + rim.worst.toFixed(1) + 's');
  assert(rim.path > 60, 'the rim held it to ' + rim.path.toFixed(0) + ' units');
  const corner = driveAt(null, ARENA_HALF - 20, ARENA_HALF - 20,
    ARENA_HALF + 40, ARENA_HALF + 40, 0, 10);
  assert(corner.worst < 1, 'wedged in the arena corner for ' + corner.worst.toFixed(1) + 's');
  assert(corner.path > 50, 'the arena corner held it to ' + corner.path.toFixed(0) + ' units');
});

check('a narrow slot is a corridor, not a trap', () => {
  const slot = (g) => { g._addSlab(-6, 0, 4, 40, 7, 'block', 0); g._addSlab(6, 0, 4, 40, 7, 'block', 0); };
  const r = driveAt(slot, 0, 30, 0, -40, 0, 10);
  assert(r.worst < 1, 'wedged in a slot for ' + r.worst.toFixed(1) + 's');
  assert(r.path > 120, 'the slot only let it cover ' + r.path.toFixed(0) + ' units');
});

check('open ground is untouched — the slide only fires against a surface', () => {
  const r = driveAt(null, 0, 0, 0, -60, 0, 3);
  const p = r.p;
  // driving straight across empty floor must stay straight
  assert(Math.abs(p.x) < 0.5, 'the hull drifted ' + p.x.toFixed(2) + ' units off a straight line');
  assert(r.speed > p.maxSpeed * 0.9, 'never reached cruise on open ground');
});

check('a graze still keeps its own tangential line rather than being overridden', () => {
  // approaching a face at a shallow angle already slid correctly; the new
  // dead-on case must not hijack that
  const r = driveAt(slab(0, 0, 26, 26), -40, -30, 40, 6, 0, 6);
  assert(r.worst < 1, 'a shallow graze wedged for ' + r.worst.toFixed(1) + 's');
  assert(r.path > 90, 'a shallow graze covered only ' + r.path.toFixed(0) + ' units');
});

check('a fast head-on hit still rebounds — the bounce is not replaced', () => {
  const g = new Game(fakeHud());
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  g.enemies.length = 0;
  g.obstacles.length = 0;
  g._addSlab(0, 0, 26, 26, 7, 'block', 0);
  const p = g.player;
  p.x = 0; p.z = 30; p.angle = Math.atan2(-(0 - 0), -(0 - 30));   // facing the slab
  p.speed = p.maxSpeed; p.vx = 0; p.vz = -p.maxSpeed;
  // the rebound is over in a frame with the throttle held, so watch the
  // cooldown the bounce arms rather than trying to sample the negative speed
  let bounced = false;
  for (let i = 0; i < 240; i++) {
    p.input.drive = 1; p.input.turn = 0;
    g.update(1 / 60);
    if (p.bounceCd > 0) { bounced = true; break; }
  }
  assert(bounced, 'slamming a slab at full speed no longer rebounds');
});
