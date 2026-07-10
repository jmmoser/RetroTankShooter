/* Mode/state-machine coverage: boss sectors, versus rules, sector gates,
 * daily determinism, extraction, mutators, upgrades, warden AI. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

loadScripts(['game.js'], 'global.Game = Game; global.__UPGRADES = UPGRADES;');
const hud = fakeHud();

check('boss sector (level 5): 3000-frame fight does not throw', () => {
  const g = new Game(hud);
  g.newRun([{ id: 'solo', loadoutIndex: 2 }], 'solo', { startLevel: 5 });
  assert(g.bossLevel && g.boss, 'no boss spawned');
  g.player.input.fire = true;
  g.player.input.drive = 1;
  g.player.input.turn = 0.3;
  for (let t = 0; t < 3000; t++) {
    if (g.mode === 'playing') g.update(1 / 60);
    else if (g.mode === 'dying') g.updateDying(1 / 60);
    else break;
  }
});

check('boss turrets then core: exposes, dies, sector clears', () => {
  const g = new Game(hud);
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', { startLevel: 5 });
  for (const tu of g.boss.turrets) g._hurtBossTurret(tu, 99999, 'solo');
  assert(g.boss.vulnerable, 'core not exposed after all turrets down');
  g._hurtBossCore(999999, 'solo');
  assert(g.boss.dead, 'boss not dead');
  for (let t = 0; t < 300 && g.mode === 'playing'; t++) g.update(1 / 60);
  assert(g.mode === 'levelclear', 'no level clear after boss death, mode=' + g.mode);
});

check('versus: 4-player brawl never enters the campaign death flow', () => {
  const defs = [0, 1, 2, 3].map((i) => ({ id: 'p' + i, name: 'P' + i, loadoutIndex: i % 3 }));
  const g = new Game(hud);
  g.newRun(defs, 'p0', { versus: true, killTarget: 3 });
  for (const p of g.players) { p.input.fire = true; p.input.drive = 0.8; p.input.turn = 0.5; }
  for (let t = 0; t < 5000 && g.mode === 'playing'; t++) g.update(1 / 60);
  assert(g.mode !== 'dying' && g.mode !== 'gameover', 'versus entered campaign death flow');
});

check('versus: own grenade cannot damage or credit yourself', () => {
  const g = new Game(hud);
  g.newRun([{ id: 'a', loadoutIndex: 1 }, { id: 'b', loadoutIndex: 1 }], 'a', { versus: true, killTarget: 10 });
  const a = g.players[0];
  a.shields = 1;
  g._nadeBoom({ x: a.x, z: a.z, y: 0.4, angle: 0, dmg: 500, owner: 'a', kind: 'nade' });
  assert(a.alive, 'own grenade killed its owner');
  assert(!g.killCounts.a, 'self-kill counted: ' + g.killCounts.a);
});

check('versus: tie at target is sudden death, unique leader wins', () => {
  const g = new Game(hud);
  g.newRun([{ id: 'a', loadoutIndex: 1 }, { id: 'b', loadoutIndex: 1 }], 'a', { versus: true, killTarget: 3 });
  g.killCounts = { a: 3, b: 3 };
  g._updateVersus(1 / 60);
  assert(g.mode === 'playing', 'tie ended the match, mode=' + g.mode);
  g.killCounts = { a: 4, b: 3 };
  g._updateVersus(1 / 60);
  assert(g.mode === 'versusover' && g.winnerId === 'a', 'unique leader did not win');
});

check('versus: a non-host unique winner wins (no roster-order bias)', () => {
  const g = new Game(hud);
  g.newRun([{ id: 'host', loadoutIndex: 1 }, { id: 'b', loadoutIndex: 1 }], 'host', { versus: true, killTarget: 3 });
  g.killCounts = { host: 1, b: 3 };
  g._updateVersus(1 / 60);
  assert(g.winnerId === 'b', 'winner=' + g.winnerId);
});

check('campaign: three sectors clear through warp gates', () => {
  const g = new Game(hud);
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  for (let lvl = 0; lvl < 3; lvl++) {
    for (const f of g.flags) f.taken = true;
    g._openExtraction();
    g.player.x = g.exit.x; g.player.z = g.exit.z;
    for (let t = 0; t < 300 && g.mode === 'playing'; t++) g.update(1 / 60);
    assert(g.mode === 'levelclear', 'sector ' + g.level + ' did not clear, mode=' + g.mode);
    g.nextLevel(g.gates ? g.gates[1].id : 'standard');
    assert(g.mode === 'playing', 'nextLevel did not resume play');
  }
});

check('daily seed: identical seed generates identical arenas', () => {
  const mk = () => {
    const g = new Game(hud);
    g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', { dailySeed: '2026-07-10' });
    return JSON.stringify(g.obstacles) + '|' + JSON.stringify(g.flags.map((f) => [f.x, f.z]));
  };
  assert(mk() === mk(), 'seeded generation not deterministic');
});

check('extraction completes with the local player dead, teammate alive', () => {
  const g = new Game(hud);
  g.newRun([{ id: 'a', loadoutIndex: 1 }, { id: 'b', loadoutIndex: 1 }], 'a', {});
  g.players[0].alive = false;
  for (const f of g.flags) f.taken = true;
  g._openExtraction();
  assert(g.exit, 'no exit opened');
  g.players[1].x = g.exit.x; g.players[1].z = g.exit.z;
  for (let t = 0; t < 300 && g.mode === 'playing'; t++) g.update(1 / 60);
  assert(g.mode === 'levelclear', 'squad extraction failed, mode=' + g.mode);
});

check('every mutator simulates a hot sector cleanly', () => {
  for (const mut of ['swarm', 'barren', 'elite', 'volatile', 'gauntlet']) {
    const g = new Game(hud);
    g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', { startLevel: 4 });
    g.mutator = mut;
    g.startLevel();
    g.player.input.fire = true;
    g.player.input.drive = 1;
    g._raiseAlarm(g.player.x, g.player.z);
    for (let t = 0; t < 1200 && g.mode === 'playing'; t++) g.update(1 / 60);
  }
});

check('all upgrades stack to max and play fully loaded', () => {
  const g = new Game(hud);
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  const p = g.player;
  for (const u of global.__UPGRADES) {
    for (let i = 0; i < u.max; i++) {
      p.pendingOffers = [u.id];
      assert(g.applyUpgrade('solo', u.id), 'applyUpgrade failed for ' + u.id + ' stack ' + i);
    }
  }
  p.input.fire = true; p.input.drive = 1; p.input.boost = true;
  for (let t = 0; t < 600; t++) g.update(1 / 60);
});

check('maxed build drains every banked tech level for score', () => {
  const g = new Game(hud);
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  const p = g.player;
  for (const u of global.__UPGRADES) p.up[u.id] = u.max;
  const rapid = global.__UPGRADES.find((u) => u.id === 'rapid');
  p.up.rapid = rapid.max - 1;
  p.pendingOffers = ['rapid'];
  p.pendingLevels = 3;
  const before = g.score;
  g.applyUpgrade('solo', 'rapid');
  assert(p.pendingLevels === 0, 'banked levels not drained: ' + p.pendingLevels);
  assert(g.score - before === 1500, 'full-build consolation wrong: ' + (g.score - before));
});

check('warden parks at umbrella range instead of creeping off', () => {
  const g = new Game(hud);
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  g.enemies.length = 0;
  g.obstacles.length = 0;
  g.player.x = 150; g.player.z = 150;   // far away: no hunting
  g._spawnEnemy('drone', 0, 0);
  g._spawnEnemy('warden', 5, 0);        // inside the 10u umbrella range
  const drone = g.enemies[0], w = g.enemies[1];
  drone.wanderT = 999; drone.wanderX = 0; drone.wanderZ = 0;
  drone.speed = 0;
  const x0 = w.x, z0 = w.z;
  for (let t = 0; t < 600; t++) g._updateEnemies(1 / 60);
  const drift = Math.hypot(w.x - x0, w.z - z0);
  assert(drift < 3, 'warden drifted ' + drift.toFixed(1) + 'u while holding');
});
