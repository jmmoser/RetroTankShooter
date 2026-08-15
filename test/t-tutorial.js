/* Field coach: the ordered walk, out-of-order skipping, situational
 * callouts, and the guards that keep it out of co-op/daily/versus. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

// Settings/Progress stand in for localStorage-backed modules; the coach only
// runs when both say so, so the suite can arm and disarm it directly.
const store = { coach: true, done: false };
global.Settings = { get: (k) => (k === 'coach' ? store.coach : 1), set() {} };
global.Progress = {
  coachDone: () => store.done,
  setCoachDone: (v) => { store.done = !!v; },
};

loadScripts(['tutorial.js', 'game.js'],
  'global.Game = Game; global.Coach = Coach; global.COACH_STEPS = COACH_STEPS;' +
  ' global.CAP_RADIUS = CAP_RADIUS;');

function newGame(opts) {
  store.coach = true; store.done = false;
  const g = new Game(fakeHud());
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', opts || {});
  return g;
}
/* Run the sim with the player parked, so only the scripted state advances. */
function idle(g, secs) {
  for (let i = 0; i < secs * 60; i++) { if (g.mode !== 'playing') break; g.update(1 / 60); }
}

check('a fresh solo campaign arms the coach on its first step', () => {
  const g = newGame();
  assert(g.coach, 'no coach on a fresh solo run');
  g.update(1 / 60);
  assert(g.coach.card && g.coach.card.id === 'move', 'first card is ' + JSON.stringify(g.coach.card));
});

check('the coach never runs in versus, daily or co-op', () => {
  const vs = new Game(fakeHud());
  vs.newRun([{ id: 'a' }, { id: 'b' }], 'a', { versus: true });
  assert(!vs.coach, 'coach armed in versus');
  const daily = new Game(fakeHud());
  daily.newRun([{ id: 'solo' }], 'solo', { dailySeed: '2026-01-01' });
  assert(!daily.coach, 'coach armed on a daily');
  const coop = new Game(fakeHud());
  coop.newRun([{ id: 'a' }, { id: 'b' }], 'a', {});
  assert(!coop.coach, 'coach armed in co-op');
});

check('a pilot who has already been walked through gets no coach', () => {
  store.done = true;
  const g = new Game(fakeHud());
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  assert(!g.coach, 'coach re-armed after coachDone');
  store.done = false;
});

check('the setting switches it off', () => {
  store.coach = false;
  const g = new Game(fakeHud());
  g.newRun([{ id: 'solo', loadoutIndex: 1 }], 'solo', {});
  assert(!g.coach, 'coach armed with the setting off');
  store.coach = true;
});

check('driving satisfies the move step and the card advances', () => {
  const g = newGame();
  const p = g.player;
  p.input.drive = 1;
  // a slow constant turn so a randomly generated slab can't wedge the hull
  // and turn an arena roll into a coin flip
  for (let i = 0; i < 60 * 12 && g.mode === 'playing'; i++) {
    p.input.turn = 0.35;
    g.update(1 / 60);
  }
  assert(g.coach.state.dist > 60, 'bot covered only ' + g.coach.state.dist.toFixed(0));
  assert(g.coach.card && g.coach.card.id !== 'move', 'still on move: ' + JSON.stringify(g.coach.card));
});

check('the walk skips lessons the pilot already satisfied out of order', () => {
  const g = newGame();
  const p = g.player;
  // spike a zone and bank some distance before ever being taught either
  p.x = g.flags[0].x; p.z = g.flags[0].z;
  g.coach.state.dist = 999;
  g.coach.state.coldT = 999;
  g.runStats.kills = 3;
  g.update(1 / 60);
  assert(g.flags[0].spiked, 'zone did not spike on contact');
  g.update(1 / 60);
  const id = g.coach.card && g.coach.card.id;
  assert(id === 'clear' || id === 'extract', 'coach stalled on an earned step: ' + id);
});

check('heat is taught by callout, not by an ordered step that blocks the mission', () => {
  assert(!COACH_STEPS.some((s) => s.id === 'vent'), 'vent is an ordered step again');
  const g = newGame();
  const seen = [];
  g.hud.message = (t) => seen.push(t);
  g.player.heat = 0;
  g.update(1 / 60);
  assert(seen.length === 0, 'talked about heat with a cold gun: ' + JSON.stringify(seen));
  g.player.heat = g.player.maxHeat * 0.7;
  g.update(1 / 60);
  assert(seen.length === 1 && /VENT/.test(seen[0]), 'warm gun taught nothing: ' + JSON.stringify(seen));
});

check('clearing the sector retires the coach for good', () => {
  const g = newGame();
  g._levelClear();
  assert(g.coach.finished, 'coach still running after a sector clear');
  assert(store.done, 'sector clear did not persist coachDone');
  g.coach.update(g, 1 / 60);
  assert(g.coach.card === null, 'retired coach still drawing a card');
});

check('situational callouts fire once each, never two at a time', () => {
  const g = newGame();
  const seen = [];
  g.hud.message = (t) => seen.push(t);
  g.alarmT = 20;
  g.update(1 / 60);
  g.update(1 / 60);            // inside the 3s cooldown — must not stack
  g.player.overheatT = 99;
  assert(seen.length === 1, 'callouts stacked: ' + JSON.stringify(seen));
  for (let i = 0; i < 200; i++) { g.player.overheatT = 99; g.alarmT = 20; g.update(1 / 60); }
  assert(seen.length === 2, 'second callout never fired: ' + JSON.stringify(seen));
  const before = seen.length;
  g.coach.tipsFired.alarm && g.update(1 / 60);
  assert(seen.length === before, 'a fired callout repeated');
});

check('every step declares the state it needs and a control that reaches it', () => {
  for (const s of COACH_STEPS) {
    assert(s.id && s.title && s.hint && s.touch, 'incomplete step ' + s.id);
    assert(typeof s.done === 'function', 'step ' + s.id + ' has no completion test');
  }
});
