/* Losing a hunt. Getting spotted has to be a setback you can play out of:
 * hunters chase the last KNOWN contact rather than your live position, their
 * re-acquire reach answers to signature, a hull that has had nothing gives up
 * its lock, converge waves stop once the contact is stale, and with all of
 * that the sector alarm can actually time out. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

loadScripts(['game.js'],
  'global.Game = Game; global.LOSE_CONTACT = LOSE_CONTACT;' +
  ' global.PRESSURE_GRACE = PRESSURE_GRACE; global.senseRange = senseRange;' +
  ' global.REACQUIRE_MUL = REACQUIRE_MUL; global.REACQUIRE_MIN = REACQUIRE_MIN;' +
  ' global.ENEMY_TYPES = ENEMY_TYPES; global.angleTo = angleTo;');

/* A sector with one alerted drone and a stationary player, no cover. */
function hunt(opts) {
  opts = opts || {};
  const g = new Game(fakeHud());
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  g.obstacles.length = 0;
  g.enemies.length = 1;
  const p = g.player;
  p.x = 0; p.z = 0; p.angle = 0; p.vx = 0; p.vz = 0; p.speed = 0;
  p.sig = opts.sig != null ? opts.sig : 0.15;
  p.heat = 0;
  const e = g.enemies[0];
  e.type = 'drone'; e.x = 0; e.z = 100; e.angle = angleTo(0 - 0, 0 - 100); e.cloak = 0;
  e.alerted = true; e.sense = 1; e.seenT = 0; e.relocT = 0; e.invT = 0;
  g.alarmT = g._diff().alarm;
  g.lastKnownX = opts.lkX != null ? opts.lkX : p.x;
  g.lastKnownZ = opts.lkZ != null ? opts.lkZ : p.z;
  return { g, p, e };
}

check('a hunter that cannot see you drives at the last known contact', () => {
  // player at the origin; the grid last had them 120 units the other way
  const { g, p, e } = hunt({ lkX: 0, lkZ: -120 });
  // the player is now in a far corner, well outside the hunter's cold reach
  p.x = 140; p.z = 140;
  e.angle = angleTo(0 - e.x, -120 - e.z);   // already pointed at the stale contact
  e.seenT = 1;                   // no eyes on it this frame
  const before = e.z;
  // the hull steers at 1.8 rad/s, so give it real time to commit to a heading
  for (let i = 0; i < 180; i++) { e.seenT = 1; g._updateEnemies(1 / 60); }
  assert(e.z < before - 5,
    'hunter went to the live player, not the stale contact (z ' + before.toFixed(0) + ' -> ' + e.z.toFixed(0) + ')');
});

check('a hunter with eyes on you drives at you', () => {
  const { g, p, e } = hunt({ sig: 1 });
  e.x = 0; e.z = 60;
  e.angle = angleTo(p.x - e.x, p.z - e.z);
  const before = Math.hypot(e.x - p.x, e.z - p.z);
  for (let i = 0; i < 180; i++) g._updateEnemies(1 / 60);
  const after = Math.hypot(e.x - p.x, e.z - p.z);
  assert(e.seenT < LOSE_CONTACT, 'hunter lost contact it should have held');
  assert(after < before - 3, 'hunter with eyes on closed only ' + (before - after).toFixed(1));
});

check('re-acquire reach answers to signature', () => {
  const spec = ENEMY_TYPES.drone;
  const reach = (sig) => Math.max(senseRange('drone', sig) * REACQUIRE_MUL, spec.sight * REACQUIRE_MIN);
  assert(reach(1) > reach(0.15) * 1.5,
    'a cold hull is held at ' + reach(0.15).toFixed(0) + ' vs a redlined ' + reach(1).toFixed(0));
  assert(reach(0.15) >= spec.sight * REACQUIRE_MIN, 'the point-blank floor is gone');
});

check('a cold tank slips a hunter that a redlined one could not', () => {
  const mk = (sig) => {
    const h = hunt({ sig });
    h.e.x = 0; h.e.z = 42;       // outside a cold reach, inside a hot one
    for (let i = 0; i < 20; i++) h.g._senseUpdate(h.e, 1 / 60);
    return h.e.seenT;
  };
  assert(mk(1) < 0.001, 'a redlined tank at 42 units was not held');
  assert(mk(0.15) > 0.1, 'a cold tank at 42 units was still held');
});

check('a hunter with nothing for LOSE_CONTACT seconds drops its lock', () => {
  const { g, e } = hunt();
  g.player.x = 500;              // gone
  for (let i = 0; i < Math.ceil((LOSE_CONTACT + 0.5) * 60); i++) g._senseUpdate(e, 1 / 60);
  assert(!e.alerted, 'hunter still alerted after ' + e.seenT.toFixed(1) + 's of nothing');
  assert(e.invT > 0, 'a hull that gave up its lock is not searching');
});

check('converge waves stop once the contact goes stale', () => {
  const { g } = hunt();
  g.pressureT = 0;
  g.contactT = 0;                // live contact — a wave is due
  g._updatePressure(1 / 60);
  assert(g.pendingSpawns.length > 0, 'no wave while the grid had contact');
  g.pendingSpawns.length = 0;
  g.pressureT = 0;
  g.contactT = PRESSURE_GRACE + 1;   // lost them
  g._updatePressure(1 / 60);
  assert(g.pendingSpawns.length === 0, 'a wave converged on a contact the grid had lost');
});

check('a clean break times the whole hunt out', () => {
  const { g, p } = hunt();
  // every hull alerted, then the squad is 200 units away and cold
  for (const e of g.enemies) { e.alerted = true; e.sense = 1; e.seenT = 0; }
  g.lastKnownX = 0; g.lastKnownZ = 0;
  p.x = -130; p.z = -130; p.sig = 0.15;
  let t = 0, down = false;
  while (t < 40) {
    p.x = -130; p.z = -130; p.sig = 0.15; p.speed = 0; p.vx = 0; p.vz = 0;
    p.input.drive = 0; p.input.turn = 0; p.input.fire = false;
    g.update(1 / 60);
    t += 1 / 60;
    if (g.alarmT <= 0) { down = true; break; }
    if (g.mode !== 'playing') break;
  }
  assert(down, 'the hunt never stood down in 40s with the squad 200 units clear and cold');
});

check('the HUD can tell "they are hunting" from "the clock is running"', () => {
  const { g, e } = hunt();
  g.update(1 / 60);
  assert(typeof g.hunted === 'boolean', 'no hunted flag for the HUD to read');
  e.x = 0; e.z = 8; e.seenT = 0; g.player.sig = 1;
  g.update(1 / 60);
  assert(g.hunted, 'a hull staring at the player from 8 units does not read as hunting');
  g.player.x = 500;
  g.update(1 / 60);
  assert(!g.hunted, 'still reads as hunting with the squad off the map');
});
