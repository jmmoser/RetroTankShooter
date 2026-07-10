/* Network protocol: host lobby handling (full-rejection, roster pruning),
 * client rejection flow, snapshot serialize/apply round-trip, and
 * interpolation over cached snapshot indexes — all against fake peers. */
const { loadScripts, fakeHud, check, assert } = require('./helpers');

// net.js reads game.js globals (SENSE_SUS, BOSS_TURRET_OFFSETS, wrapAngle),
// so both load into one script context.
loadScripts(['game.js', 'net.js'], 'global.Game = Game; global.Net = Net;');
const hud = fakeHud();

/* PeerJS stand-ins: capture handlers, record sent messages. */
class FakePeer {
  constructor() { FakePeer.last = this; this.h = {}; }
  on(ev, cb) { this.h[ev] = cb; }
  connect(id) { this.conn = mkConn(id); return this.conn; }
  destroy() {}
}
function mkConn(id) {
  return {
    peer: id, sent: [], h: {}, open: true, closed: false,
    on(ev, cb) { this.h[ev] = cb; },
    send(m) { this.sent.push(m); },
    close() { this.closed = true; if (this.h.close) this.h.close(); },
  };
}
global.window.Peer = FakePeer;

check('host: full lobby rejects the 4th joiner and unsubscribes it', () => {
  Net.leave();
  Net.hostCreate('HOST', 1);
  const peer = FakePeer.last;
  peer.h.open();
  const conns = [];
  for (let i = 0; i < 4; i++) {
    const c = mkConn('p' + i);
    conns.push(c);
    peer.h.connection(c);
    c.h.open();
    c.h.data({ t: 'join', name: 'P' + i, loadoutIndex: 0 });
  }
  assert(Net.state.roster.length === 4, 'roster should cap at 4, got ' + Net.state.roster.length);
  const rejected = conns[3];
  assert(rejected.sent.some((m) => m.t === 'full'), 'rejected joiner never told "full"');
  assert(!Net.state.conns.includes(rejected), 'rejected conn still subscribed to broadcasts');
  assert(Net.state.conns.includes(conns[0]), 'accepted conn was dropped');
});

check('host: mid-game leaver is pruned from the rematch roster', () => {
  Net.hostStartGame();
  assert(Net.state.started, 'game did not start');
  const leaver = Net.state.conns[0];
  leaver.close();   // triggers hostDropConn
  assert(!Net.state.roster.some((r) => r.id === leaver.peer),
    'leaver still in roster — would spawn a ghost tank on rematch');
  assert(Net.state.roster.some((r) => r.id === 'host'), 'host fell out of the roster');
});

check('client: "full" stops the feed before start/snapshots arrive', () => {
  Net.leave();
  const errors = [];
  let started = 0;
  Net.cb.onError = (t) => errors.push(t);
  Net.cb.onStart = () => started++;
  Net.cb.onState = () => { throw new Error('snapshot processed after rejection'); };
  Net.clientJoin('ABCD', 'X', 1);
  const peer = FakePeer.last;
  peer.h.open('client-id');
  const hc = peer.conn;
  hc.h.open();
  hc.h.data({ t: 'full' });
  hc.h.data({ t: 'start', defs: [{ id: 'host', loadoutIndex: 1 }], mode: 'coop' });
  hc.h.data({ t: 's', pl: [], en: [], pr: [] });
  assert(Net.state.rejected, 'rejected flag not set');
  assert(hc.closed, 'client kept the connection open');
  assert(started === 0, 'client was dragged into the game after rejection');
  assert(errors.length === 1 && /full/i.test(errors[0]),
    'expected exactly the "full" error, got ' + JSON.stringify(errors));
  Net.cb.onError = Net.cb.onStart = Net.cb.onState = null;
});

check('host: hostile input packets are clamped, never NaN', () => {
  Net.leave();
  Net.hostCreate('HOST', 1);
  const peer = FakePeer.last;
  peer.h.open();
  const c = mkConn('evil');
  peer.h.connection(c);
  c.h.open();
  c.h.data({ t: 'join', name: 42, loadoutIndex: 0 });   // non-string name must not throw
  assert(Net.state.roster.length === 2, 'join with numeric name was not accepted');
  assert(typeof Net.state.roster[1].name === 'string' && Net.state.roster[1].name.length > 0,
    'numeric name not replaced with a default');
  c.h.data({ t: 'input', in: { t: 1e9, d: {}, f: 1 } });
  const inp = Net.state.inputs['evil'];
  assert(inp.t === 1, 'huge turn not clamped: ' + inp.t);
  assert(inp.d === 0, 'non-numeric drive not zeroed: ' + inp.d);
  assert(inp.f === 1, 'legit fire flag lost');
  Net.leave();
});

check('client: buffered start after leave() cannot drag us into a phantom run', () => {
  Net.leave();
  let started = 0;
  Net.cb.onStart = () => started++;
  Net.clientJoin('ABCD', 'X', 1);
  const peer = FakePeer.last;
  peer.h.open('client-id');
  const hc = peer.conn;
  hc.h.open();
  Net.leave();   // player pressed LEAVE; 'start' was already in the channel buffer
  hc.h.data({ t: 'start', defs: [{ id: 'host', loadoutIndex: 1 }], mode: 'coop' });
  hc.h.data({ t: 'lv', level: 1, score: 0, obstacles: [], flags: [] });
  assert(started === 0, 'post-leave start still reached the game');
  assert(!Net.state.started, 'started flag flipped after leave');
  Net.cb.onStart = null;
});

check('snapshot round-trip: host state survives serialize -> applyLevel/applyState', () => {
  Net.leave();
  const defs = [{ id: 'host', loadoutIndex: 1 }, { id: 'c1', loadoutIndex: 2 }];
  const host = new Game(hud);
  host.newRun(defs, 'host', {});
  host.players[0].input.drive = 1;
  for (let i = 0; i < 30; i++) host.update(1 / 60);

  const cap = mkConn('capture');
  Net.state.conns.push(cap);
  Net.broadcastLevel(host);
  Net.broadcastState(host);
  Net.state.conns.length = 0;
  const [lvMsg, sMsg] = cap.sent;

  const client = new Game(hud);
  client.players = defs.map((d, i) => client._makePlayer(d, i));
  client.localId = 'c1';
  client.player = client.players[1];
  Net.applyLevel(client, lvMsg);
  Net.applyState(client, sMsg);

  assert(client.level === host.level && client.score === host.score, 'level/score mismatch');
  assert(client.obstacles.length === host.obstacles.length, 'obstacle count mismatch');
  assert(client.enemies.length === host.enemies.length, 'enemy count mismatch');
  for (let i = 0; i < host.enemies.length; i++) {
    const he = host.enemies[i], ce = client.enemies[i];
    assert(ce.type === he.type, 'enemy ' + i + ' type mismatch');
    assert(Math.abs(ce.x - he.x) < 1e-6 && Math.abs(ce.z - he.z) < 1e-6, 'enemy ' + i + ' position mismatch');
  }
  for (let i = 0; i < host.players.length; i++) {
    assert(Math.abs(client.players[i].shields - host.players[i].shields) < 1e-6, 'player ' + i + ' shields mismatch');
    assert(client.players[i].alive === host.players[i].alive, 'player ' + i + ' alive mismatch');
  }
  assert(client.flags.length === host.flags.length, 'flag count mismatch');
  for (let i = 0; i < host.flags.length; i++) {
    assert(client.flags[i].taken === host.flags[i].taken, 'flag ' + i + ' taken mismatch');
  }
});

check('clientInterpolate blends entities across cached snapshot indexes', () => {
  Net.leave();
  Net.clientJoin('ABCD', 'X', 1);
  const peer = FakePeer.last;
  peer.h.open('me');
  const hc = peer.conn;
  hc.h.open();

  const mkSnap = (ex, px) => ({
    t: 's', md: 'playing', sc: 0, lv: 1, sk: 0,
    pl: [
      { id: 'me', x: px, z: 0, a: 0, sh: 100, ms: 100, al: 1, sp: 0, mp: 20, vx: 0, vz: 0, ov: 0, rp: 0, ci: 0, bo: 100, bs: 0, nd: 3 },
      { id: 'host', x: px + 5, z: 0, a: 0, sh: 100, ms: 100, al: 1, sp: 0, mp: 20, vx: 0, vz: 0, ov: 0, rp: 0, ci: 1, bo: 100, bs: 0, nd: 3 },
    ],
    en: [{ i: 7, k: 0, x: ex, z: 0, a: 0, h: 0, c: 0, el: 0, aw: 0 }],
    mi: [], pr: [], pu: [], fg: [], fc: [], al: 0, alm: 0, sus: 0, ex: null,
    cb: 0, ct: 0, mu: 1, cw: 4, pt: 0, bo: null, ri: [], snd: [], bu: [], de: [],
  });
  hc.h.data(mkSnap(0, 0));    // enemy at x=0, remote player at x=5
  hc.h.data(mkSnap(10, 2));   // enemy at x=10, remote player at x=7
  assert(Net.state.snaps.length === 2 && Net.state.snaps[0].idx, 'snapshots missing cached idx');

  // pin snapshot times so the render time lands exactly halfway between them
  const now = performance.now() / 1000;
  Net.state.snaps[0].t = now - 0.2;   // rt = now - INTERP_DELAY(0.1) -> k = 0.5
  Net.state.snaps[1].t = now;

  const client = new Game(hud);
  client.players = [{ id: 'me', loadoutIndex: 1 }, { id: 'host', loadoutIndex: 1 }]
    .map((d, i) => client._makePlayer(d, i));
  client.localId = 'me';
  client.player = client.players[0];
  Net.applyState(client, Net.state.snaps[1].msg);
  Net.clientInterpolate(client);

  assert(Math.abs(client.enemies[0].x - 5) < 0.5,
    'enemy not interpolated to midpoint: x=' + client.enemies[0].x);
  assert(Math.abs(client.players[1].x - 6) < 0.5,
    'remote player not interpolated: x=' + client.players[1].x);
  Net.leave();
});
