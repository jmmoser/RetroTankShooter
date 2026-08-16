/* The run debrief's data: a stealth run's timeline and what finally ended it.
 * The game-over screen can only report what the sim bothered to record. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

loadScripts(['game.js'], 'global.Game = Game; global.freshRunStats = freshRunStats;');

function solo(opts) {
  const g = new Game(fakeHud());
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', opts || {});
  return g;
}
/* Advance the sim with the tank parked and harmless. */
function idle(g, secs) {
  for (let i = 0; i < Math.round(secs * 60) && g.mode === 'playing'; i++) {
    g.player.input.drive = 0; g.player.input.turn = 0; g.player.input.fire = false;
    g.update(1 / 60);
  }
}

check('a fresh run starts with an empty timeline', () => {
  const rs = freshRunStats();
  for (const k of ['playT', 'undetectedT', 'huntedT', 'ghosts']) {
    assert(rs[k] === 0, k + ' starts at ' + rs[k]);
  }
  assert(rs.deathBy === null && rs.deathHunted === false, 'a fresh run is pre-loaded with a death');
});

check('quiet seconds bank as UNDETECTED, alarm seconds as HUNTED', () => {
  const g = solo();
  g.enemies.length = 0;            // nothing to notice anything
  idle(g, 2);
  const rs = g.runStats;
  assert(rs.playT > 1.9, 'play time did not advance: ' + rs.playT);
  assert(rs.undetectedT > 1.9, 'quiet time did not bank: ' + rs.undetectedT);
  assert(rs.huntedT === 0, 'banked hunted time with no alarm');
  g.alarmT = 30;
  idle(g, 1);
  assert(g.runStats.huntedT > 0.9, 'alarm time did not bank: ' + g.runStats.huntedT);
  assert(Math.abs(g.runStats.undetectedT - rs.undetectedT) < 0.02,
    'banked undetected time while the alarm was up');
});

check('a suspicious sector is neither undetected nor hunted', () => {
  const g = solo();
  g.enemies.length = 0;
  const before = g.runStats.undetectedT;
  // suspicion is rebuilt per frame by _updateEnemies; pin it from outside
  const upd = g._updateEnemies.bind(g);
  g._updateEnemies = (dt) => { upd(dt); g.suspicion = true; };
  idle(g, 1);
  assert(Math.abs(g.runStats.undetectedT - before) < 0.02,
    'a sector with patrols investigating counted as undetected');
  assert(g.runStats.huntedT === 0, 'suspicion counted as a full hunt');
});

check('the run remembers what killed it, and whether the grid had you', () => {
  const g = solo();
  g.alarmT = 0;
  g._damagePlayer(g.player, 99999, null, 'A SNIPER');
  assert(g.runStats.deathBy === 'A SNIPER', 'deathBy is ' + g.runStats.deathBy);
  assert(g.runStats.deathHunted === false, 'a quiet death read as hunted');
});

check('dying with the alarm up says so', () => {
  const g = solo();
  g.alarmT = 12;
  g._damagePlayer(g.player, 99999, null, 'A RUSHER');
  assert(g.runStats.deathHunted === true, 'a hunted death read as quiet');
});

check('an unlabelled hit still names something', () => {
  const g = solo();
  g._damagePlayer(g.player, 99999);
  assert(g.runStats.deathBy, 'an unlabelled kill left the debrief with nothing to say');
});

check('every enemy shell carries the hull that fired it', () => {
  const g = solo();
  g.obstacles.length = 0;
  const p = g.player;
  // park a drone point blank and staring, then let it shoot
  g.enemies.length = 1;
  const e = g.enemies[0];
  e.type = 'drone'; e.alerted = true; e.sense = 1; e.seenT = 0; e.cloak = 0; e.fireCd = 0;
  e.x = p.x; e.z = p.z - 20;
  e.angle = Math.atan2(-(p.x - e.x), -(p.z - e.z));
  for (let i = 0; i < 240 && !g.projectiles.some((pr) => pr.from === 'enemy'); i++) g._updateEnemies(1 / 60);
  const shot = g.projectiles.find((pr) => pr.from === 'enemy');
  assert(shot, 'the drone never fired');
  assert(shot.src === 'A DRONE', 'shell is labelled ' + shot.src);
});

check('a ghost extraction is counted, not just bonused', () => {
  const g = solo();
  g.ghostRun = true;
  g.bossLevel = false;
  g._levelClear();
  assert(g.runStats.ghosts === 1, 'ghost extractions: ' + g.runStats.ghosts);
});

check('versus runs record no stealth timeline', () => {
  const g = new Game(fakeHud());
  g.newRun([{ id: 'a' }, { id: 'b' }], 'a', { versus: true });
  for (let i = 0; i < 60; i++) g.update(1 / 60);
  assert(g.runStats.playT === 0, 'a deathmatch banked stealth time');
});
