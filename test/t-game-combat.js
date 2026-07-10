/* Combat-core regressions: splash/chain array safety, line of sight,
 * piercing shells, and a long combat soak. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

loadScripts(['game.js'], 'global.Game = Game;');
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
