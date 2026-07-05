/* Co-op multiplayer over WebRTC (PeerJS), host-authoritative.
 *
 * One player HOSTS: their browser runs the full game simulation and broadcasts
 * authoritative snapshots. Everyone else JOINS as a thin client that streams
 * its input up and renders the snapshots it receives. A short room code is the
 * only thing players need to share — signaling rides on PeerJS's free public
 * broker, so nothing extra has to be hosted alongside the static site.
 */
const Net = (() => {
  const ENEMY_ORDER = ['drone', 'hunter', 'sniper', 'phantom'];
  const ID_PREFIX = 'phantom-arena-v1-';   // namespaces our ids on the shared broker
  const MAX_PLAYERS = 4;

  const state = {
    role: 'solo',        // 'solo' | 'host' | 'client'
    peer: null,
    id: null,            // our local id ('host' for the host, peer id for clients)
    code: null,          // room code
    conns: [],           // host: connected client DataConnections
    hostConn: null,      // client: connection to the host
    roster: [],          // [{ id, name, loadoutIndex }] — host is authoritative
    inputs: {},          // host: peerId -> latest input {t,d,f}
    started: false,
  };

  // Callbacks wired up by main.js.
  const cb = {
    onRoster: null,   // (roster)
    onCode: null,     // (code)          host: room code is ready
    onStart: null,    // (defs, localId) client: begin the run
    onLevel: null,    // (msg)           client: new sector arena
    onState: null,    // (msg)           client: snapshot
    onScreen: null,   // (msg)           client: screen transition (clear/over)
    onError: null,    // (text)
    onPeerLeft: null, // (id)
  };

  function libReady() { return typeof window.Peer === 'function'; }

  function randCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — easier to read aloud
    let s = '';
    for (let i = 0; i < 4; i++) s += A[(Math.random() * A.length) | 0];
    return s;
  }
  function peerIdFor(code) { return ID_PREFIX + code; }

  function broadcast(msg) {
    for (const c of state.conns) { try { c.send(msg); } catch (e) {} }
  }

  // ---- HOST ---------------------------------------------------------------

  function hostCreate(name, loadoutIndex, attempt) {
    if (!libReady()) { if (cb.onError) cb.onError('Network library failed to load.'); return; }
    attempt = attempt || 0;
    const code = randCode();
    state.role = 'host';
    state.code = code;
    state.id = 'host';
    state.roster = [{ id: 'host', name: name || 'PLAYER 1', loadoutIndex: loadoutIndex || 0 }];

    const peer = new Peer(peerIdFor(code));
    state.peer = peer;

    peer.on('open', () => {
      if (cb.onCode) cb.onCode(code);
      if (cb.onRoster) cb.onRoster(state.roster);
    });
    peer.on('error', (err) => {
      const type = err && err.type;
      if (type === 'unavailable-id' && attempt < 6) {
        try { peer.destroy(); } catch (e) {}
        hostCreate(name, loadoutIndex, attempt + 1); // code collision — try another
      } else if (cb.onError) {
        cb.onError('Host error: ' + (type || err));
      }
    });
    peer.on('connection', (conn) => {
      conn.on('open', () => { if (state.conns.indexOf(conn) < 0) state.conns.push(conn); });
      conn.on('data', (msg) => hostHandle(conn, msg));
      conn.on('close', () => hostDropConn(conn));
      conn.on('error', () => hostDropConn(conn));
    });
  }

  function hostDropConn(conn) {
    state.conns = state.conns.filter((c) => c !== conn);
    const id = conn.peer;
    delete state.inputs[id];
    if (!state.started) {
      const before = state.roster.length;
      state.roster = state.roster.filter((r) => r.id !== id);
      if (state.roster.length !== before) {
        if (cb.onRoster) cb.onRoster(state.roster);
        broadcast({ t: 'roster', roster: state.roster });
      }
    }
    if (cb.onPeerLeft) cb.onPeerLeft(id);
  }

  function hostHandle(conn, msg) {
    if (!msg) return;
    if (msg.t === 'join') {
      if (state.started || state.roster.length >= MAX_PLAYERS) { try { conn.send({ t: 'full' }); } catch (e) {} return; }
      if (!state.roster.some((r) => r.id === conn.peer)) {
        state.roster.push({
          id: conn.peer,
          name: (msg.name || ('PLAYER ' + (state.roster.length + 1))).slice(0, 14),
          loadoutIndex: msg.loadoutIndex || 0,
        });
      }
      if (cb.onRoster) cb.onRoster(state.roster);
      broadcast({ t: 'roster', roster: state.roster });
    } else if (msg.t === 'loadout' && !state.started) {
      const r = state.roster.find((x) => x.id === conn.peer);
      if (r) { r.loadoutIndex = msg.loadoutIndex | 0; if (cb.onRoster) cb.onRoster(state.roster); broadcast({ t: 'roster', roster: state.roster }); }
    } else if (msg.t === 'input') {
      state.inputs[conn.peer] = msg.in;
    }
  }

  function hostSetLocalLoadout(idx) {
    if (state.role !== 'host' || !state.roster[0]) return;
    state.roster[0].loadoutIndex = idx | 0;
    if (cb.onRoster) cb.onRoster(state.roster);
    broadcast({ t: 'roster', roster: state.roster });
  }

  function hostStartGame() {
    state.started = true;
    const defs = state.roster.map((r) => ({ id: r.id, name: r.name, loadoutIndex: r.loadoutIndex }));
    broadcast({ t: 'start', defs: defs });
    return { defs: defs, localId: 'host' };
  }

  // Push the latest received client inputs into the live game's player objects.
  function applyInputs(game) {
    for (const p of game.players) {
      if (p.id === 'host') continue;
      const inp = state.inputs[p.id];
      if (inp) {
        p.input.turn = inp.t; p.input.drive = inp.d;
        p.input.fire = !!inp.f; p.input.nade = !!inp.g; p.input.boost = !!inp.b;
      }
    }
  }

  function broadcastLevel(game) {
    broadcast({
      t: 'lv',
      level: game.level,
      score: game.score,
      obstacles: game.obstacles,
      flags: game.flags.map((f) => ({ x: f.x, z: f.z, taken: f.taken, spin: f.spin })),
      depots: game.depots,
    });
  }

  function serializeState(game, snd, bu, de) {
    return {
      t: 's',
      md: game.mode,
      sc: game.score,
      sk: game.shake,
      lv: game.level,
      pl: game.players.map((p) => ({
        id: p.id, x: p.x, z: p.z, a: p.angle,
        sh: p.shields, ms: p.maxShields, am: p.ammo, ma: p.maxAmmo,
        al: p.alive ? 1 : 0, sp: p.speed, mp: p.maxSpeed,
        ov: p.fx.overdrive, rp: p.fx.rapid, ci: p.colorIdx,
        bo: Math.round(p.boost || 0), bs: p.boosting ? 1 : 0, nd: p.nades || 0,
      })),
      en: game.enemies.map((e) => ({
        k: ENEMY_ORDER.indexOf(e.type), x: e.x, z: e.z, a: e.angle, h: e.hitFlash,
        c: e.cloak ? Math.round(e.cloak * 100) / 100 : 0,
      })),
      pr: game.projectiles.map((pr) => ({
        x: pr.x, y: pr.y, z: pr.z, a: pr.angle,
        e: pr.from === 'enemy' ? 1 : 0, k: pr.kind === 'nade' ? 1 : 0,
      })),
      pu: game.powerups.map((u) => ({ k: u.type, x: u.x, z: u.z, s: u.spin, b: u.bob })),
      fg: game.flags.map((f) => (f.taken ? 1 : 0)),
      al: game.alert,
      cb: game.combo, ct: game.comboT, mu: game.mult,
      // WARLORD boss: turret offsets are rebuilt client-side by index
      bo: (game.boss && !game.boss.dead) ? {
        x: game.boss.x, z: game.boss.z, a: game.boss.angle,
        ch: Math.round(game.boss.coreHp), cm: game.boss.coreMax,
        vu: game.boss.vulnerable ? 1 : 0,
        st: game.boss.state === 'telegraph' ? 1 : game.boss.state === 'charge' ? 2 : 0,
        hf: game.boss.hitFlash,
        tu: game.boss.turrets.map((t) => ({ v: t.hp > 0 ? 1 : 0, a: t.aim })),
      } : null,
      ri: game.rings.map((r) => ({ x: r.x, z: r.z, r: r.r })),
      // slabs the boss has crushed (only ever changes on boss sectors)
      og: game.bossLevel ? game.obstacles.map((o) => (o.dead ? 0 : 1)) : undefined,
      snd: snd || game.frameSounds.slice(),
      bu: (bu || game.frameBursts).map((b) => ({ x: b.x, y: b.y, z: b.z, n: b.n, c: b.c, p: b.p })),
      de: (de || game.frameDebris).map((d) => ({ x: d.x, z: d.z, c: d.c })),
    };
  }

  function broadcastState(game, snd, bu, de) { broadcast(serializeState(game, snd, bu, de)); }
  function broadcastScreen(msg) { broadcast(Object.assign({ t: 'sc' }, msg)); }

  // ---- CLIENT -------------------------------------------------------------

  function clientJoin(code, name, loadoutIndex) {
    if (!libReady()) { if (cb.onError) cb.onError('Network library failed to load.'); return; }
    code = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    state.role = 'client';
    state.code = code;

    const peer = new Peer();
    state.peer = peer;

    peer.on('open', (id) => {
      state.id = id;
      const conn = peer.connect(peerIdFor(code), { reliable: true });
      state.hostConn = conn;
      conn.on('open', () => { try { conn.send({ t: 'join', name: name || 'PLAYER', loadoutIndex: loadoutIndex || 0 }); } catch (e) {} });
      conn.on('data', (msg) => clientHandle(msg));
      conn.on('close', () => { if (cb.onError) cb.onError('Disconnected from host.'); });
      conn.on('error', () => { if (cb.onError) cb.onError('Connection error.'); });
    });
    peer.on('error', (err) => {
      const type = err && err.type;
      if (type === 'peer-unavailable') { if (cb.onError) cb.onError('No game found for code ' + code + '.'); }
      else if (cb.onError) cb.onError('Network error: ' + (type || err));
    });
  }

  function clientSetLoadout(idx) {
    if (state.hostConn) { try { state.hostConn.send({ t: 'loadout', loadoutIndex: idx | 0 }); } catch (e) {} }
  }

  function clientHandle(msg) {
    if (!msg) return;
    switch (msg.t) {
      case 'roster': state.roster = msg.roster; if (cb.onRoster) cb.onRoster(msg.roster); break;
      case 'full':   if (cb.onError) cb.onError('Game is full or already in progress.'); break;
      case 'start':  state.started = true; if (cb.onStart) cb.onStart(msg.defs, state.id); break;
      case 'lv':     if (cb.onLevel) cb.onLevel(msg); break;
      case 's':      if (cb.onState) cb.onState(msg); break;
      case 'sc':     if (cb.onScreen) cb.onScreen(msg); break;
    }
  }

  function sendInput(input) {
    const c = state.hostConn;
    if (c && c.open) {
      try {
        c.send({ t: 'input', in: {
          t: input.turn, d: input.drive,
          f: input.fire ? 1 : 0, g: input.nade ? 1 : 0, b: input.boost ? 1 : 0,
        } });
      } catch (e) {}
    }
  }

  // ---- client-side snapshot application -----------------------------------
  // Writes incoming network data straight into a (client-owned) Game instance
  // so the existing renderer and HUD can read it without changes.

  function applyLevel(game, msg) {
    game.level = msg.level;
    game.score = msg.score;
    game.obstacles = msg.obstacles;
    game.flags = msg.flags.map((f) => ({ x: f.x, z: f.z, taken: f.taken, spin: f.spin || 0 }));
    game.depots = msg.depots || [];
    game.enemies = [];
    game.projectiles = [];
    game.powerups = [];
    game.particles = [];
    game.debris = [];
    game.boss = null;
    game.rings = [];
    game.bossLevel = msg.level >= BOSS_EVERY && msg.level % BOSS_EVERY === 0;
    game.alert = 0;
    game.combo = 0; game.comboT = 0; game.mult = 1;
    game.mode = 'playing';
  }

  function applyState(game, msg) {
    game.frameSounds.length = 0;
    game.frameBursts.length = 0;
    game.mode = msg.md;
    game.score = msg.sc;
    game.level = msg.lv;
    // NOTE: msg.sk (the host's shake) is intentionally ignored — screen shake is
    // local feedback, so each client owns its own (decayed in main's client loop,
    // bumped below when THIS player takes damage).

    const byId = {};
    for (const p of game.players) byId[p.id] = p;
    game.players = msg.pl.map((d) => {
      const p = byId[d.id] || { input: { turn: 0, drive: 0, fire: false }, fx: {} };
      p.id = d.id; p.x = d.x; p.z = d.z; p.angle = d.a;
      p.shields = d.sh; p.maxShields = d.ms; p.ammo = d.am; p.maxAmmo = d.ma;
      p.alive = !!d.al; p.speed = d.sp; p.maxSpeed = d.mp;
      p.fx = { overdrive: d.ov, rapid: d.rp };
      p.colorIdx = d.ci;
      p.boost = d.bo; p.maxBoost = 100; p.boosting = !!d.bs;
      p.nades = d.nd; p.maxNades = 6;
      return p;
    });
    game.player = game.players.find((p) => p.id === game.localId) || game.players[0];

    // local damage feedback (clients don't run the sim, so derive it from the snapshot)
    const lp = game.player;
    if (lp) {
      const prevSh = game._prevSh == null ? lp.shields : game._prevSh;
      const prevAlive = game._prevAlive == null ? lp.alive : game._prevAlive;
      if (lp.shields < prevSh - 0.01) {
        game.hud.damage(Math.min(0.8, (prevSh - lp.shields) / 30));
        game.shake = Math.min(1.2, game.shake + 0.5);
      }
      if (prevAlive && !lp.alive) game.shake = 2;
      game._prevSh = lp.shields;
      game._prevAlive = lp.alive;
    }

    game.enemies = msg.en.map((d) => ({ type: ENEMY_ORDER[d.k] || 'drone', x: d.x, z: d.z, angle: d.a, hitFlash: d.h, cloak: d.c || 0 }));
    game.projectiles = msg.pr.map((d) => ({ x: d.x, y: d.y, z: d.z, angle: d.a, from: d.e ? 'enemy' : 'player', kind: d.k ? 'nade' : undefined }));
    game.powerups = msg.pu.map((d) => ({ type: d.k, x: d.x, z: d.z, spin: d.s, bob: d.b }));
    for (let i = 0; i < game.flags.length && i < msg.fg.length; i++) game.flags[i].taken = !!msg.fg[i];

    game.alert = msg.al || 0;
    game.combo = msg.cb || 0;
    game.comboT = msg.ct || 0;
    game.mult = msg.mu || 1;

    game.boss = msg.bo ? {
      x: msg.bo.x, z: msg.bo.z, angle: msg.bo.a,
      coreHp: msg.bo.ch, coreMax: msg.bo.cm,
      vulnerable: !!msg.bo.vu,
      state: msg.bo.st === 1 ? 'telegraph' : msg.bo.st === 2 ? 'charge' : 'roam',
      hitFlash: msg.bo.hf || 0,
      dead: false,
      turrets: msg.bo.tu.map((t, i) => ({
        hp: t.v ? 1 : 0, aim: t.a,
        dx: BOSS_TURRET_OFFSETS[i][0], dz: BOSS_TURRET_OFFSETS[i][1],
      })),
    } : null;
    game.rings = (msg.ri || []).map((r) => ({ x: r.x, z: r.z, r: r.r }));
    if (msg.og) {
      for (let i = 0; i < game.obstacles.length && i < msg.og.length; i++) {
        game.obstacles[i].dead = !msg.og[i];
      }
    }

    if (msg.bu) for (const b of msg.bu) game._burst(b.x, b.y, b.z, b.n, b.c, b.p);
    if (msg.de) for (const d of msg.de) game._spawnShards(d.x, d.z, d.c, false);
    if (msg.snd) {
      for (const s of msg.snd) {
        AudioSys.play(s);
        // clients don't run the sim — mirror the host's event banners off
        // the sounds that always accompany them
        if (s === 'alarm') game.hud.message('REINFORCEMENTS INBOUND', '#ff4a3c', 2.4);
        else if (s === 'coreExposed') game.hud.message('CORE EXPOSED — ATTACK', '#ffd24a', 3);
        else if (s === 'bossDown') game.hud.message('WARLORD DESTROYED', '#3cff78', 3);
        else if (s === 'comboBreak') game.hud.message('COMBO BROKEN', '#ff4a3c', 1.5);
      }
    }
  }

  function leave() {
    try { if (state.peer) state.peer.destroy(); } catch (e) {}
    state.role = 'solo'; state.peer = null; state.hostConn = null;
    state.conns = []; state.roster = []; state.inputs = {};
    state.started = false; state.id = null; state.code = null;
  }

  return {
    state: state, cb: cb,
    libReady: libReady,
    hostCreate: hostCreate, hostStartGame: hostStartGame, hostSetLocalLoadout: hostSetLocalLoadout, applyInputs: applyInputs,
    broadcastLevel: broadcastLevel, broadcastState: broadcastState, broadcastScreen: broadcastScreen,
    clientJoin: clientJoin, clientSetLoadout: clientSetLoadout, sendInput: sendInput,
    applyLevel: applyLevel, applyState: applyState,
    leave: leave,
    get role() { return state.role; },
  };
})();
