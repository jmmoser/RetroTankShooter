/* Co-op multiplayer over WebRTC (PeerJS), host-authoritative.
 *
 * One player HOSTS: their browser runs the full game simulation and broadcasts
 * authoritative snapshots. Everyone else JOINS as a thin client that streams
 * its input up and renders the snapshots it receives. A short room code is the
 * only thing players need to share — signaling rides on PeerJS's free public
 * broker, so nothing extra has to be hosted alongside the static site.
 */
const Net = (() => {
  const ENEMY_ORDER = ['drone', 'hunter', 'sniper', 'phantom', 'rusher', 'shellback', 'warden'];
  const ID_PREFIX = 'phantom-arena-v3-';   // namespaces our ids on the shared broker
                                           // (v3: stealth/extraction protocol)
  const MAX_PLAYERS = 4;

  // Interpolation: clients render remote entities this far in the past so
  // there are always two snapshots to blend between — motion stays 60 fps
  // smooth instead of stepping at the 30 Hz snapshot rate.
  const INTERP_DELAY = 0.1;
  const SNAP_KEEP = 30;   // ~1s of history

  // host: monotonically increasing network ids, stamped lazily on the first
  // serialize so clients can match the same enemy/shot across snapshots
  let netSeq = 1;

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
    mode: 'coop',        // 'coop' | 'versus' — host picks in the lobby
    snaps: [],           // client: [{ t, msg }] snapshot history for interpolation
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
    onDraft: null,    // (offers)        client: a TECH draft is waiting
    onPick: null,     // (peerId, id)    host: a client answered a draft
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
        broadcast({ t: 'roster', roster: state.roster, mode: state.mode });
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
      broadcast({ t: 'roster', roster: state.roster, mode: state.mode });
    } else if (msg.t === 'loadout' && !state.started) {
      const r = state.roster.find((x) => x.id === conn.peer);
      if (r) { r.loadoutIndex = msg.loadoutIndex | 0; if (cb.onRoster) cb.onRoster(state.roster); broadcast({ t: 'roster', roster: state.roster, mode: state.mode }); }
    } else if (msg.t === 'input') {
      state.inputs[conn.peer] = msg.in;
    } else if (msg.t === 'pick') {
      // client answered a TECH draft — the host's sim validates and applies
      if (cb.onPick) cb.onPick(conn.peer, msg.u);
    }
  }

  /* Host: deliver a TECH draft (3 upgrade ids) to one remote player. */
  function sendDraft(peerId, offers) {
    for (const c of state.conns) {
      if (c.peer === peerId) { try { c.send({ t: 'draft', of: offers }); } catch (e) {} return; }
    }
  }

  /* Client: answer the open draft with a pick. */
  function sendPick(upgradeId) {
    const c = state.hostConn;
    if (c && c.open) { try { c.send({ t: 'pick', u: upgradeId }); } catch (e) {} }
  }

  function hostSetLocalLoadout(idx) {
    if (state.role !== 'host' || !state.roster[0]) return;
    state.roster[0].loadoutIndex = idx | 0;
    if (cb.onRoster) cb.onRoster(state.roster);
    broadcast({ t: 'roster', roster: state.roster, mode: state.mode });
  }

  /* Host flips the lobby between co-op and versus; clients just see it. */
  function hostSetMode(mode) {
    if (state.role !== 'host') return;
    state.mode = mode === 'versus' ? 'versus' : 'coop';
    if (cb.onRoster) cb.onRoster(state.roster);
    broadcast({ t: 'roster', roster: state.roster, mode: state.mode });
  }

  function hostStartGame() {
    state.started = true;
    const defs = state.roster.map((r) => ({ id: r.id, name: r.name, loadoutIndex: r.loadoutIndex }));
    broadcast({ t: 'start', defs: defs, mode: state.mode });
    return { defs: defs, localId: 'host', mode: state.mode };
  }

  // Push the latest received client inputs into the live game's player objects.
  function applyInputs(game) {
    for (const p of game.players) {
      if (p.id === 'host') continue;
      const inp = state.inputs[p.id];
      if (inp) {
        p.input.turn = inp.t; p.input.drive = inp.d;
        p.input.fire = !!inp.f; p.input.nade = !!inp.g; p.input.boost = !!inp.b;
        p.input.mine = !!inp.m; p.input.vent = !!inp.v;
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
      vs: game.versus ? 1 : 0,
      kt: game.killTarget,
      mut: game.mutator || null,
      bounty: game.bounty ? { name: game.bounty.name, n: game.bounty.n } : null,
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
        sh: p.shields, ms: p.maxShields,
        ht: Math.round(p.heat || 0), mh: p.maxHeat || 100,
        vt: p.venting > 0 ? Math.round(p.venting * 100) / 100 : 0,
        oh: p.overheatT > 0 ? 1 : 0, ss: p.superShots || 0,
        vw: Math.round((((p.up && p.up.vent) || 0) * 0.1) * 100) / 100,
        al: p.alive ? 1 : 0, sp: p.speed, mp: p.maxSpeed,
        vx: Math.round((p.vx || 0) * 100) / 100, vz: Math.round((p.vz || 0) * 100) / 100,
        ov: p.fx.overdrive, rp: p.fx.rapid, ci: p.colorIdx,
        bo: Math.round(p.boost || 0), bs: p.boosting ? 1 : 0, nd: p.nades || 0,
        mn: p.mines || 0, mb: p.maxBoost || 100,
        nx: p.maxNades || 6, mx: p.maxMines || 4,
        tl: p.techLvl || 0, tx: Math.round((p.tech01 || 0) * 100) / 100,
        sg: Math.round((p.sig || 0) * 100) / 100,
      })),
      en: game.enemies.map((e) => {
        if (!e._nid) e._nid = netSeq++;
        return {
          i: e._nid,
          k: ENEMY_ORDER.indexOf(e.type), x: e.x, z: e.z, a: e.angle, h: e.hitFlash,
          c: e.cloak ? Math.round(e.cloak * 100) / 100 : 0,
          el: e.elite ? 1 : 0,
          // awareness for the client's radar/rings: 0 patrol, 1 sus, 2 alerted
          aw: e.alerted ? 2 : ((e.sense || 0) >= SENSE_SUS ? 1 : 0),
        };
      }),
      mi: game.mines.map((m) => ({ x: m.x, z: m.z, a: m.arm <= 0 ? 1 : 0 })),
      vk: game.versus ? game.killCounts : undefined,
      pr: game.projectiles.map((pr) => {
        if (!pr._nid) pr._nid = netSeq++;
        return {
          i: pr._nid,
          x: pr.x, y: pr.y, z: pr.z, a: pr.angle,
          e: pr.from === 'enemy' ? 1 : 0, k: pr.kind === 'nade' ? 1 : 0,
        };
      }),
      pu: game.powerups.map((u) => ({ k: u.type, x: u.x, z: u.z, s: u.spin, b: u.bob })),
      fg: game.flags.map((f) => (f.taken ? 1 : 0)),
      fc: game.flags.map((f) => Math.round((f.cap || 0) * 100) / 100),
      al: game.alert,
      alm: game.alarmT > 0 ? 1 : 0,
      sus: game.suspicion ? 1 : 0,
      ex: game.exit ? { x: game.exit.x, z: game.exit.z } : null,
      cb: game.combo, ct: game.comboT, mu: game.mult, cw: game.comboWin,
      pt: game.pot || 0,
      by: game.bounty ? { p: game.bounty.prog, d: game.bounty.paid ? 1 : 0 } : undefined,
      // WARLORD boss: turret offsets are rebuilt client-side by index
      bo: (game.boss && !game.boss.dead) ? {
        x: game.boss.x, z: game.boss.z, a: game.boss.angle,
        ch: Math.round(game.boss.coreHp), cm: game.boss.coreMax,
        vu: game.boss.vulnerable ? 1 : 0,
        st: game.boss.state === 'telegraph' ? 1 : game.boss.state === 'charge' ? 2 : 0,
        hf: game.boss.hitFlash,
        tu: game.boss.turrets.map((t) => ({ v: t.hp > 0 ? 1 : 0, a: t.aim })),
      } : null,
      ri: game.rings.map((r) => {
        if (!r._nid) r._nid = netSeq++;
        return { i: r._nid, x: r.x, z: r.z, r: r.r, f: r.from === 'player' ? 1 : 0 };
      }),
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
      case 'roster': state.roster = msg.roster; state.mode = msg.mode || 'coop'; if (cb.onRoster) cb.onRoster(msg.roster); break;
      case 'full':   if (cb.onError) cb.onError('Game is full or already in progress.'); break;
      case 'start':  state.started = true; state.mode = msg.mode || 'coop'; if (cb.onStart) cb.onStart(msg.defs, state.id, state.mode); break;
      case 'lv':
        state.snaps.length = 0;   // new arena: stale history would tween across it
        if (cb.onLevel) cb.onLevel(msg);
        break;
      case 's':
        state.snaps.push({ t: performance.now() / 1000, msg });
        if (state.snaps.length > SNAP_KEEP) state.snaps.shift();
        if (cb.onState) cb.onState(msg);
        break;
      case 'sc':
        state.snaps.length = 0;
        if (cb.onScreen) cb.onScreen(msg);
        break;
      case 'draft':
        if (cb.onDraft) cb.onDraft(msg.of || []);
        break;
    }
  }

  function sendInput(input) {
    const c = state.hostConn;
    if (c && c.open) {
      try {
        c.send({ t: 'input', in: {
          t: input.turn, d: input.drive,
          f: input.fire ? 1 : 0, g: input.nade ? 1 : 0, b: input.boost ? 1 : 0,
          m: input.mine ? 1 : 0, v: input.vent ? 1 : 0,
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
    game.flags = msg.flags.map((f) => ({ x: f.x, z: f.z, taken: f.taken, spin: f.spin || 0, cap: 0, contested: false }));
    game.depots = msg.depots || [];
    game.enemies = [];
    game.projectiles = [];
    game.powerups = [];
    game.particles = [];
    game.flashes = [];
    game.debris = [];
    game.mines = [];
    game.boss = null;
    game.rings = [];
    game.versus = !!msg.vs;
    game.killTarget = msg.kt || 10;
    game.killCounts = {};
    game.bossLevel = !game.versus && msg.level >= BOSS_EVERY && msg.level % BOSS_EVERY === 0;
    game.alert = 0;
    game.alarmT = 0;
    game.suspicion = false;
    game.exit = null;
    game.combo = 0; game.comboT = 0; game.mult = 1;
    game.pot = 0;
    game.mutator = msg.mut || null;
    game.bounty = msg.bounty ? { name: msg.bounty.name, n: msg.bounty.n, prog: 0, paid: false } : null;
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
      p.shields = d.sh; p.maxShields = d.ms;
      p.heat = d.ht || 0; p.maxHeat = d.mh || 100;
      p.venting = d.vt || 0; p.overheatT = d.oh ? 1 : 0;
      p.superShots = d.ss || 0; p.ventWiden = d.vw || 0;
      p.alive = !!d.al; p.speed = d.sp; p.maxSpeed = d.mp;
      p.vx = d.vx || 0; p.vz = d.vz || 0;
      p.fx = { overdrive: d.ov, rapid: d.rp };
      p.colorIdx = d.ci;
      p.boost = d.bo; p.maxBoost = d.mb || 100; p.boosting = !!d.bs;
      p.nades = d.nd; p.maxNades = d.nx || 6;
      p.mines = d.mn || 0; p.maxMines = d.mx || 4;
      p.techLvl = d.tl || 0; p.tech01 = d.tx || 0;
      p.sig = d.sg || 0;
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

    // awareness decoded back into alerted/sense so the HUD and renderer can
    // read the same fields on host and client alike
    game.enemies = msg.en.map((d) => ({
      nid: d.i, type: ENEMY_ORDER[d.k] || 'drone', x: d.x, z: d.z, angle: d.a,
      hitFlash: d.h, cloak: d.c || 0, elite: !!d.el,
      alerted: d.aw === 2, sense: d.aw === 2 ? 1 : d.aw === 1 ? 0.6 : 0,
    }));
    game.mines = (msg.mi || []).map((d) => ({ x: d.x, z: d.z, arm: d.a ? 0 : 1, life: 60, owner: null }));
    if (msg.vk) game.killCounts = msg.vk;
    game.projectiles = msg.pr.map((d) => ({ nid: d.i, x: d.x, y: d.y, z: d.z, angle: d.a, from: d.e ? 'enemy' : 'player', kind: d.k ? 'nade' : undefined }));
    game.powerups = msg.pu.map((d) => ({ type: d.k, x: d.x, z: d.z, spin: d.s, bob: d.b }));
    for (let i = 0; i < game.flags.length && i < msg.fg.length; i++) game.flags[i].taken = !!msg.fg[i];
    if (msg.fc) {
      for (let i = 0; i < game.flags.length && i < msg.fc.length; i++) {
        const f = game.flags[i];
        f.contested = (msg.fc[i] || 0) > (f.cap || 0);   // rising uplink = being held
        f.cap = msg.fc[i] || 0;
      }
    }

    game.alert = msg.al || 0;
    game.alarmT = msg.alm ? 1 : 0;   // clients only need on/off for HUD + music
    game.suspicion = !!msg.sus;
    const hadExit = !!game.exit;
    game.exit = msg.ex ? { x: msg.ex.x, z: msg.ex.z } : null;
    if (!hadExit && game.exit) {
      game.hud.message('UPLINK COMPLETE — REACH THE EXTRACTION GATE', '#4fd6bb', 3.2);
    }
    game.combo = msg.cb || 0;
    game.comboT = msg.ct || 0;
    game.mult = msg.mu || 1;
    game.comboWin = msg.cw || 4;
    game.pot = msg.pt || 0;
    if (msg.by && game.bounty) {
      game.bounty.prog = msg.by.p || 0;
      game.bounty.paid = !!msg.by.d;
    }

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
    game.rings = (msg.ri || []).map((r) => ({ nid: r.i, x: r.x, z: r.z, r: r.r, from: r.f ? 'player' : 'boss' }));
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
        if (s === 'alarm') game.hud.message('ALARM — THE GRID IS HUNTING', '#ff4a3c', 2.4);
        else if (s === 'coreExposed') game.hud.message('CORE EXPOSED — ATTACK', '#ffd24a', 3);
        else if (s === 'bossDown') game.hud.message('WARLORD DESTROYED', '#3cff78', 3);
        else if (s === 'comboBreak') game.hud.message('COMBO BROKEN', '#ff4a3c', 1.5);
      }
    }
  }

  // ---- client-side snapshot interpolation ----------------------------------
  // applyState above keeps the game's LOGICAL state (hp, ammo, events) on the
  // newest snapshot the moment it lands; this pass runs every render frame and
  // rewrites only the TRANSFORMS. Remote entities are drawn INTERP_DELAY in
  // the past, blended between the two snapshots that bracket the render time,
  // so they glide at display rate instead of stepping at the 30 Hz snapshot
  // rate. The local tank is the exception: burying your own input under the
  // interpolation delay would feel worse, so it rides the newest snapshot,
  // dead-reckoned forward along its heading to hide the snapshot quantization.

  function clientInterpolate(game) {
    const snaps = state.snaps;
    if (snaps.length < 2) return;
    const now = performance.now() / 1000;
    const rt = now - INTERP_DELAY;

    let i = snaps.length - 1;
    while (i > 0 && snaps[i].t > rt) i--;
    const a = snaps[i];
    const b = snaps[Math.min(i + 1, snaps.length - 1)];
    const span = b.t - a.t;
    const k = span > 0.0001 ? Math.max(0, Math.min(1, (rt - a.t) / span)) : 1;

    const lerp = (x, y) => x + (y - x) * k;
    const lerpA = (x, y) => x + wrapAngle(y - x) * k;
    const index = (arr, key) => {
      const m = {};
      if (arr) for (const d of arr) m[d[key]] = d;
      return m;
    };

    const pa = index(a.msg.pl, 'id'), pb = index(b.msg.pl, 'id');
    for (const p of game.players) {
      if (p.id === game.localId) continue;
      const da = pa[p.id], db = pb[p.id];
      if (da && db && da.al && db.al) {
        p.x = lerp(da.x, db.x);
        p.z = lerp(da.z, db.z);
        p.angle = lerpA(da.a, db.a);
      }
    }

    // own tank: newest state + forward dead-reckoning along the TRUE
    // velocity (drift makes hull facing lie about direction). Capped — a
    // stall should freeze the tank, not launch it through a wall.
    const newest = snaps[snaps.length - 1];
    const dl = index(newest.msg.pl, 'id')[game.localId];
    const lp = game.player;
    if (lp && dl && dl.al) {
      const age = Math.min(Math.max(0, now - newest.t), 0.12);
      lp.x = dl.x + (dl.vx || 0) * age;
      lp.z = dl.z + (dl.vz || 0) * age;
      lp.angle = dl.a;
    }

    const ea = index(a.msg.en, 'i'), eb = index(b.msg.en, 'i');
    for (const e of game.enemies) {
      const da = ea[e.nid], db = eb[e.nid];
      if (da && db) {
        e.x = lerp(da.x, db.x);
        e.z = lerp(da.z, db.z);
        e.angle = lerpA(da.a, db.a);
      }
    }

    const ra = index(a.msg.pr, 'i'), rb = index(b.msg.pr, 'i');
    for (const pr of game.projectiles) {
      const da = ra[pr.nid], db = rb[pr.nid];
      if (da && db) {
        pr.x = lerp(da.x, db.x);
        pr.y = lerp(da.y, db.y);
        pr.z = lerp(da.z, db.z);
        pr.angle = lerpA(da.a, db.a);
      }
    }

    const ga = index(a.msg.ri, 'i'), gb = index(b.msg.ri, 'i');
    for (const r of game.rings) {
      const da = ga[r.nid], db = gb[r.nid];
      if (da && db) r.r = lerp(da.r, db.r);
    }

    if (game.boss && a.msg.bo && b.msg.bo) {
      game.boss.x = lerp(a.msg.bo.x, b.msg.bo.x);
      game.boss.z = lerp(a.msg.bo.z, b.msg.bo.z);
      game.boss.angle = lerpA(a.msg.bo.a, b.msg.bo.a);
      for (let t = 0; t < game.boss.turrets.length; t++) {
        const ta = a.msg.bo.tu[t], tb = b.msg.bo.tu[t];
        if (ta && tb) game.boss.turrets[t].aim = lerpA(ta.a, tb.a);
      }
    }
  }

  function leave() {
    try { if (state.peer) state.peer.destroy(); } catch (e) {}
    state.role = 'solo'; state.peer = null; state.hostConn = null;
    state.conns = []; state.roster = []; state.inputs = {};
    state.started = false; state.id = null; state.code = null;
    state.mode = 'coop';
    state.snaps = [];
  }

  return {
    state: state, cb: cb,
    libReady: libReady,
    hostCreate: hostCreate, hostStartGame: hostStartGame, hostSetLocalLoadout: hostSetLocalLoadout, hostSetMode: hostSetMode, applyInputs: applyInputs,
    broadcastLevel: broadcastLevel, broadcastState: broadcastState, broadcastScreen: broadcastScreen,
    sendDraft: sendDraft, sendPick: sendPick,
    clientJoin: clientJoin, clientSetLoadout: clientSetLoadout, sendInput: sendInput,
    applyLevel: applyLevel, applyState: applyState, clientInterpolate: clientInterpolate,
    leave: leave,
    get role() { return state.role; },
  };
})();
