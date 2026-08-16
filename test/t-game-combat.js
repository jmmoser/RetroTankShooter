/* Combat-core regressions: splash/chain array safety, line of sight,
 * piercing shells, and a long combat soak. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

loadScripts(['game.js'], 'global.Game = Game; global.SHELL_SPEED = SHELL_SPEED;');
const hud = fakeHud();

function freshGame() {
  const g = new Game(hud);
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  return g;
}

// Chain kills (rusher pop, VOLATILE HULLS) splice the enemies array while
// splash loops run; the old index-based loops crashed on enemies[j].x of
// undefined. These four scenarios all crashed before the two-phase rewrite.
check('grenade splash into volatile rusher pack kills all, no crash', () => {
  const g = freshGame();
  g.mutator = 'volatile';
  g.enemies.length = 0;
  for (let i = 0; i < 8; i++) g._spawnEnemy(i % 2 ? 'rusher' : 'drone', 50 + i * 0.5, 50 + (i % 3) * 0.5);
  for (const e of g.enemies) e.hp = 5;
  g._nadeBoom({ x: 50, z: 50, y: 0.4, angle: 0, dmg: 60, owner: 'solo', kind: 'nade' });
  assert(g.enemies.length === 0, 'expected empty field, got ' + g.enemies.length);
});

check('mine splash with chain kills does not crash', () => {
  const g = freshGame();
  g.mutator = 'volatile';
  g.enemies.length = 0;
  for (let i = 0; i < 6; i++) g._spawnEnemy('rusher', 30 + i * 0.4, 30);
  for (const e of g.enemies) e.hp = 5;
  g._mineBoom({ x: 30, z: 30, owner: 'solo', arm: 0, life: 10 });
  assert(g.enemies.length === 0, 'pack survived');
});

check('player shockwave ring over chained pack does not crash', () => {
  const g = freshGame();
  g.mutator = 'volatile';
  g.enemies.length = 0;
  for (let i = 0; i < 6; i++) g._spawnEnemy('rusher', 10 + i * 0.3, 0);
  for (const e of g.enemies) e.hp = 5;
  g.obstacles.length = 0;
  g._spawnRing(10, 0, 100, { from: 'player', owner: 'solo', speed: 30, max: 60 });
  for (let t = 0; t < 60; t++) g._updateRings(1 / 60);
});

check('piercing shell through chained pack does not crash', () => {
  const g = freshGame();
  g.mutator = 'volatile';
  g.enemies.length = 0;
  for (let i = 0; i < 6; i++) g._spawnEnemy('rusher', 0, -10 - i * 0.5);
  for (const e of g.enemies) e.hp = 5;
  g.obstacles.length = 0;
  g.projectiles.length = 0;
  g.projectiles.push({ x: 0, z: -8, y: 1.6, angle: 0, speed: 72, from: 'player', owner: 'solo', dmg: 60, life: 2, bounce: 0, pierce: 2 });
  for (let t = 0; t < 30; t++) g._updateProjectiles(1 / 60);
});

check('_losClear: blocked through slabs, clear beside them, exact for thin walls', () => {
  const g = freshGame();
  g.obstacles.length = 0;
  g.obstacles.push({ x: 0, z: 0, w: 8, d: 8, h: 5, type: 'block', color: [1, 1, 1] });
  assert(!g._losClear(-20, 0, 20, 0), 'ray through slab not blocked');
  assert(g._losClear(-20, 10, 20, 10), 'clear ray blocked');
  assert(g._losClear(-20, 0, -10, 0), 'ray ending before slab blocked');
  assert(!g._losClear(0, -20, 0, 20), 'axis-parallel ray through slab not blocked');
  // a thin wall the old 2.5-unit point sampling could slip through
  g.obstacles.push({ x: 15, z: 0, w: 0.5, d: 40, h: 5, type: 'block', color: [1, 1, 1] });
  assert(!g._losClear(10, 0, 20, 0.3), 'thin slab not blocked');
  g.obstacles[0].dead = true;
  g.obstacles[1].dead = true;
  assert(g._losClear(-20, 0, 20, 0), 'dead slab still blocks');
});

// Aim assist used to snap onto a target's live position, overriding a correct
// manual lead with a guaranteed trailing miss on crossing targets at range.
// It must lock the shell-flight intercept point instead.
check('aim assist leads a crossing target to the intercept point', () => {
  const g = freshGame();
  g.enemies.length = 0;
  g.obstacles.length = 0;
  const p = g.player;
  p.x = 0; p.z = 0;
  g._spawnEnemy('drone', 0, -100);
  const e = g.enemies[0];
  e.vx = 14; e.vz = 0;   // crossing left-to-right, orthogonal to the shot
  // player aims roughly at the lead point (a hair off, inside the cone)
  p.angle = -0.19;
  const a = g._aimAssist(p);
  assert(a !== p.angle, 'assist did not engage');
  // fly the shell and the target forward; the snap must produce a hit
  let minD = Infinity;
  for (let t = 0; t < 2; t += 1 / 240) {
    const sx = -Math.sin(a) * SHELL_SPEED * t, sz = -Math.cos(a) * SHELL_SPEED * t;
    minD = Math.min(minD, Math.hypot(sx - (e.x + e.vx * t), sz - (e.z + e.vz * t)));
  }
  assert(minD < 2, 'shell missed the crossing target by ' + minD.toFixed(1));
  // the old behavior — snapping to the live bearing — misses by a hull length+
  const live = 0;   // bearing straight at the spawn position
  let liveD = Infinity;
  for (let t = 0; t < 2; t += 1 / 240) {
    const sx = -Math.sin(live) * SHELL_SPEED * t, sz = -Math.cos(live) * SHELL_SPEED * t;
    liveD = Math.min(liveD, Math.hypot(sx - (e.x + e.vx * t), sz - (e.z + e.vz * t)));
  }
  assert(liveD > 10, 'test premise broken: live-position snap should miss');
});

check('aim assist still snaps exactly onto a stationary target', () => {
  const g = freshGame();
  g.enemies.length = 0;
  g.obstacles.length = 0;
  const p = g.player;
  p.x = 0; p.z = 0;
  g._spawnEnemy('drone', 5, -80);
  const want = Math.atan2(-5, 80);
  p.angle = want + 0.05;   // sloppy but inside the cone
  const a = g._aimAssist(p);
  assert(Math.abs(a - want) < 1e-9, 'expected exact snap, got ' + a + ' vs ' + want);
});

check('enemy velocity is tracked from real displacement', () => {
  const g = freshGame();
  g.enemies.length = 0;
  g.obstacles.length = 0;
  g._spawnEnemy('rusher', 0, 80, true);
  const e = g.enemies[0];
  for (let i = 0; i < 30; i++) g._updateEnemies(1 / 60);
  assert(Number.isFinite(e.vx) && Number.isFinite(e.vz), 'velocity not tracked');
  assert(Math.hypot(e.vx, e.vz) > 1, 'hunting rusher should register speed');
});

check('1500-frame combat soak with alarm and reinforcements', () => {
  const g = freshGame();
  g._raiseAlarm(0, 0);
  g.player.input.fire = true;
  g.player.input.drive = 1;
  for (let t = 0; t < 1500; t++) {
    if (g.mode === 'playing') g.update(1 / 60);
    else break;
  }
});

check('a ram-kill chain cannot walk the boom loop off the end of the array', () => {
  // Ram-killing a rusher runs its chain-pop, which splices `enemies` while the
  // boom resolution is still walking it. A knot of rushers all in ram range
  // shrinks the array from N to 0 inside one iteration, and an index loop then
  // reads `undefined._boom` on the next step — a hard throw out of the game
  // loop. Collect-by-reference is what makes this survivable.
  const g = new Game(fakeHud());
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  g.obstacles.length = 0;
  const p = g.player;
  p.x = 0; p.z = 0;
  // boosting above the ram threshold, so contact resolves as 'ram' not 'det'.
  // _updateEnemies is driven directly: update() would run _updatePlayer first
  // and recompute p.boosting from the (empty) input before the booms resolve.
  p.boosting = true;
  p.vx = p.maxSpeed * 1.4; p.vz = 0;
  g.enemies.length = 0;
  // a tight knot: every one is inside ram range of the player AND inside the
  // 6-unit chain radius of every other, so one ram deletes all of them
  for (let i = 0; i < 6; i++) {
    g._spawnEnemy('rusher', 0.6 + i * 0.5, 0.6, true);
    g.enemies[i].hp = 5;              // well inside the 40-damage chain
  }
  g._updateEnemies(1 / 60);
  assert(g.enemies.every((e) => e.type !== 'rusher'), 'the knot survived the ram');
});

check('killing an index that a chain already removed is a no-op, not a throw', () => {
  const g = new Game(fakeHud());
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  g.enemies.length = 0;
  g._killEnemy(0, 'solo', 'cannon');
  g._killEnemy(99, 'solo', 'cannon');
  assert(g.enemies.length === 0, 'phantom kills mutated the roster');
});
