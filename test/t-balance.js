/* The AAA-pass gameplay changes: ram cap and the shellback plate, traps,
 * the held extraction gate, the grid sweep clock, capped enemy scaling, the
 * contact-lost stand-down, medal-gated tech, the campaign finale, and the
 * once-per-run bugs (field promotion, coach tips). */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

// a pilot who has walked the coach, ranked high enough for one banked level
global.Settings = { get: (k) => (k === 'coach' ? false : 1) };
global.Progress = { startingTech: () => 1, coachDone: () => true, setCoachDone() {} };

loadScripts(['tutorial.js', 'game.js'],
  'global.Game = Game; global.Coach = Coach; global.ENEMY_TYPES = ENEMY_TYPES; ' +
  'global.EXIT_CHARGE = EXIT_CHARGE; global.SWEEP_START = SWEEP_START; global.RAM_CAP = RAM_CAP; ' +
  'global.CAMPAIGN_END = CAMPAIGN_END; global.UPGRADES = UPGRADES; global.LOSE_CONTACT = LOSE_CONTACT;');
const hud = fakeHud();

function fresh(opts) {
  const g = new Game(hud);
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', opts || {});
  g.enemies.length = 0; g.pendingSpawns.length = 0; g.obstacles.length = 0;
  return g;
}

/* Put the player at the origin, boosting flat out toward -Z, with a hull of
 * `type` sitting 2 units ahead facing `angle`. */
function ramSetup(type, angle) {
  const g = fresh();
  const p = g.player;
  p.x = 0; p.z = 0; p.angle = 0;
  p.speed = p.maxSpeed * 1.6; p.vx = 0; p.vz = -p.maxSpeed * 1.6;
  p.boost = 100; p.input.drive = 1; p.input.boost = true;
  g._spawnEnemy(type, 0, -2.2);
  g.enemies[0].angle = angle;
  return { g, p, e: g.enemies[0] };
}

check('a bare boost-ram deletes a drone and costs shields scaled to the hull', () => {
  const { g, p } = ramSetup('drone', 0);
  const sh = p.shields;
  g._updatePlayer(p, 1 / 60);
  assert(g.enemies.length === 0, 'drone should die to a ram');
  assert(sh - p.shields > 6 && sh - p.shields < 10, 'drone ram cost ' + (sh - p.shields));
});

check('a bare boost-ram is capped: a shellback survives it even from behind', () => {
  const { g, p, e } = ramSetup('shellback', 0);   // facing away (-Z, like the player): plate not in play
  g._updatePlayer(p, 1 / 60);
  assert(g.enemies.length === 1, 'shellback must survive a bare ram');
  assert(e.maxHp - e.hp <= RAM_CAP + 1e-9, 'ram damage should be capped at RAM_CAP, took ' + (e.maxHp - e.hp));
});

check('ramming a shellback PLATE head-on staggers the rammer instead', () => {
  const { g, p, e } = ramSetup('shellback', Math.PI);   // faces +Z, straight at the rammer: plate first
  const sh = p.shields;
  g._updatePlayer(p, 1 / 60);
  assert(g.enemies.length === 1 && e.hp > e.maxHp - 30, 'plate should shrug the ram off');
  assert(p.speed < 0, 'the rammer bounces back, speed = ' + p.speed);
  assert(!p.boosting, 'the bounce kills the boost');
  assert(sh - p.shields >= 19, 'the plate costs 20 shields, cost ' + (sh - p.shields));
});

check('RAM PLATING cracks the plate', () => {
  const { g, p } = ramSetup('shellback', Math.PI);
  p.up.ram = 2;
  g._updatePlayer(p, 1 / 60);
  assert(g.enemies.length === 0, 'two RAM PLATING stacks should shatter a shellback through its plate');
});

check('grenade and mine damage scale with the sector', () => {
  const g = fresh();
  g.level = 1;
  const d1 = g._blastScale();
  g.level = 9;
  assert(g._blastScale() > d1 * 1.5, 'sector 9 blasts should be >50% harder');
});

check('the extraction gate must be HELD for EXIT_CHARGE seconds', () => {
  const g = fresh();
  for (const f of g.flags) f.taken = true;
  g._onFlagSecured();
  g.enemies.length = 0; g.pendingSpawns.length = 0;
  assert(g.exit && g.exit.charge === 0, 'gate opens uncharged');
  const p = g.player;
  p.x = g.exit.x; p.z = g.exit.z; p.vx = p.vz = p.speed = 0;
  for (let i = 0; i < 60; i++) { g.update(1 / 60); g.enemies.length = 0; }
  assert(g.mode === 'playing', 'one second in the ring must not clear the sector');
  assert(g.exit.charge > 0.9 && g.exit.charge < 1.1, 'charge tracks time held, = ' + g.exit.charge);
  // step out: the charge bleeds
  // Step toward arena center. +40 can cross the right wall, which clamps
  // the pilot back into a randomly placed extraction ring.
  p.x = g.exit.x + (g.exit.x > 0 ? -40 : 40);
  for (let i = 0; i < 30; i++) g.update(1 / 60);
  assert(g.exit.charge < 0.5, 'leaving the ring bleeds the charge, = ' + g.exit.charge);
  p.x = g.exit.x;
  for (let i = 0; i < 60 * (EXIT_CHARGE + 0.5) && g.mode === 'playing'; i++) { g.update(1 / 60); g.enemies.length = 0; }
  assert(g.mode === 'levelclear', 'holding the ring for EXIT_CHARGE seconds clears the sector, mode = ' + g.mode);
});

check('the grid sweeps: past SWEEP_START a blind patrol warps in near a live uplink', () => {
  const g = fresh();
  g.levelTime = SWEEP_START + 0.5;
  g.sweepT = 0;
  g._updateSweep(1 / 60);
  assert(g.pendingSpawns.length === 1, 'one sweep patrol queued');
  assert(!g.pendingSpawns[0].al, 'a sweep patrol arrives blind, not hunting');
  const s = g.pendingSpawns[0];
  const near = g.flags.some((f) => !f.taken && Math.hypot(f.x - s.x, f.z - s.z) < 40);
  assert(near, 'it warps in near an uplink site');
  g._updateSweep(1 / 60);
  assert(g.pendingSpawns.length === 1, 'and not again until SWEEP_EVERY has passed');
});

check('no sweep before the clock, none on the way out', () => {
  const g = fresh();
  g.levelTime = SWEEP_START - 1; g.sweepT = 0;
  g._updateSweep(1 / 60);
  assert(g.pendingSpawns.length === 0, 'too early');
  g.levelTime = SWEEP_START + 1; g.exit = { x: 0, z: 0, charge: 0 };
  g._updateSweep(1 / 60);
  assert(g.pendingSpawns.length === 0, 'the extraction has its own pressure');
});

check('enemy speed scaling is capped; HP climbs with depth instead', () => {
  const g = fresh();
  g.level = 30;
  g._spawnEnemy('hunter', 0, 0);
  const e = g.enemies[0];
  const spec = ENEMY_TYPES.hunter;
  assert(e.speed <= spec.speed * 1.5 * 1.15 + 1e-9, 'deep hunters must not outrun a boosting hull, speed ' + e.speed);
  assert(e.maxHp > spec.hp * 1.3 && e.maxHp <= spec.hp * 1.6 * 1.6 + 1e-9, 'hp scales with the sector, ' + e.maxHp);
});

check('the last hull to lose contact ends the alarm — no phantom countdown', () => {
  const g = fresh();
  g._spawnEnemy('drone', 30, 30);
  const e = g.enemies[0];
  g._alertEnemy(e, 0, 0);
  assert(g.alarmT > 0, 'alarm raised');
  g._loseContact(e);
  assert(!e.alerted, 'hull dropped its lock');
  assert(g.alarmT === 0, 'nobody is hunting: the alarm must end now, not in ' + g.alarmT + 's');
});

check('the alarm stays up while ANY hull still has a lock', () => {
  const g = fresh();
  g._spawnEnemy('drone', 30, 30);
  g._spawnEnemy('drone', -30, 30);
  g._alertEnemy(g.enemies[0], 0, 0);
  g.enemies[1].alerted = true; g.enemies[1].seenT = 0;
  g._loseContact(g.enemies[0]);
  assert(g.alarmT > 0, 'the second hull is still hunting');
});

check('medal-gated tech stays out of the draft until the medal is earned', () => {
  const gated = UPGRADES.filter((u) => u.medal).map((u) => u.id);
  assert(gated.length >= 3, 'at least three earned upgrades');
  global.Medals = { has: () => false };
  const g = fresh();
  const p = g.player;
  for (let i = 0; i < 60; i++) {
    p.pendingOffers = null;
    g._rollOffers(p);
    for (const id of p.pendingOffers) assert(gated.indexOf(id) < 0, 'offered locked tech ' + id);
  }
  global.Medals = { has: () => true };
  let seen = false;
  for (let i = 0; i < 80 && !seen; i++) {
    p.pendingOffers = null;
    g._rollOffers(p);
    seen = p.pendingOffers.some((id) => gated.indexOf(id) >= 0);
  }
  assert(seen, 'with the medals earned the gated tech is back in the pool');
  delete global.Medals;
});

check('FIELD PROMOTION pays out on every run, not once per page load', () => {
  const g = new Game(hud);
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  assert(g.player.techLvl >= 1, 'first run banks the promotion');
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  assert(g.player.techLvl >= 1, 'second run on the same Game instance banks it too');
});

check('coach callouts fire once per RUN — a new sector does not replay them', () => {
  const c = new Coach();
  c.tipsFired.pot = true;
  c.resetLevel();
  assert(c.tipsFired.pot, 'resetLevel must not wipe fired tips');
});

check('a sector that failed to place any uplink opens its gate instead of trapping the run', () => {
  const g = fresh();
  g._genFlags = () => {};   // every placement fails
  g.exit = null;
  g.startLevel();
  assert(g.exit, 'no uplink sites: the gate opens straight away');
});

check('mines restock between sectors like grenades', () => {
  const g = fresh();
  const p = g.player;
  p.mines = 0;
  g.gates = [{ id: 'standard', name: 'STANDARD SECTOR', tech: 0 }];
  g.nextLevel('standard');
  assert(p.mines >= 1, 'a mine came back for the next sector');
});

check('clearing sector CAMPAIGN_END completes the campaign and pays for it', () => {
  const g = fresh();
  g.level = CAMPAIGN_END;
  const before = g.score;
  g._levelClear();
  assert(g.campaignWon, 'campaign flagged complete');
  assert(g.score - before >= 5000, 'the finale pays a bonus');
  assert(g.gates, 'and the run can continue through a gate into the deep');
});

check('TWIN CANNON runs hotter per trigger pull', () => {
  const g = fresh();
  const p = g.player;
  p.input.fire = true; p.fireCd = 0; p.heat = 0;
  g._updatePlayer(p, 1 / 60);
  const plain = p.heat;
  p.up.twin = 2; p.fireCd = 0; p.heat = 0; p.input.fire = true;
  g._updatePlayer(p, 1 / 60);
  assert(p.heat > plain * 1.5, 'two extra barrels cost more heat: ' + plain + ' vs ' + p.heat);
});
