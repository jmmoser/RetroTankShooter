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
  const ID_PREFIX = 'phantom-arena-v4-';   // namespaces our ids on the shared broker
                                           // (v4: held gate, wrecks, host clock)
  const MAX_PLAYERS = 4;
  const CODE_LEN = 5;      // 32^5 ≈ 33M rooms: not scannable in a lunch break
  const JOIN_TIMEOUT = 10000;   // ms before a silent connect is reported
  const INPUT_HZ = 30;     // client input send rate (was every render frame)

  // Optional TURN/STUN override for deployments behind symmetric NAT:
  // window.PA_ICE_SERVERS = [{ urls: 'turn:...', username, credential }]
  function peerOpts() {
    try {
      const ice = window.PA_ICE_SERVERS;
      if (Array.isArray(ice) && ice.length) return { config: { iceServers: ice } };
    } catch (e) {}
    return undefined;
  }

  // Interpolation: clients render remote entities this far in the past so
  // there are always two snapshots to blend between — motion stays 60 fps
  // smooth instead of stepping at the 30 Hz snapshot rate. The delay is the
  // floor; it grows with measured arrival jitter (see clientHandle 's').
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
    snaps: [],           // client: [{ t, msg, idx }] snapshot history for interpolation
    rejected: false,     // client: host said 'full' — ignore everything after
    clockOff: null,      // client: host clock minus local clock (seconds)
    jitter: 0,           // client: smoothed lateness of snapshot arrivals
    delay: INTERP_DELAY, // client: live interpolation delay
    joinTimer: null,     // client: connect watchdog
    inSeq: 0,            // client: input sequence number
    inLast: 0,           // client: time of the last input send
    inPrev: '',          // client: the last input payload, to send on change only
  };

  /* Build an id -> entry map once per snapshot (interpolation runs at render
   * rate, snapshots only arrive at 30 Hz — indexing per frame was pure churn). */
  function indexBy(arr, key) {
    const m = {};
    if (arr) for (const d of arr) m[d[key]] = d;
    return m;
  }

  // Callbacks wired up by main.js.
  const cb = {
    onRoster: null,   // (roster)
    onCode: null,     // (code)          host: room code is ready
    onStart: null,    // (defs, localId, mode) client: begin the run
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
    for (let i = 0; i < CODE_LEN; i++) s += A[(Math.random() * A.length) | 0];
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

    const peer = new Peer(peerIdFor(code), peerOpts());
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
    // always prune the roster — leaving mid-game entries in place made the
    // next relaunch (bt-again / vs rematch) spawn permanently idle ghost
    // tanks for players who had disconnected. The live game's player object
    // stays (frozen via onPeerLeft); only the next launch's roster changes.
    const before = state.roster.length;
    state.roster = state.roster.filter((r) => r.id !== id);
    if (state.roster.length !== before && !state.started) {
      if (cb.onRoster) cb.onRoster(state.roster);
      broadcast({ t: 'roster', roster: state.roster, mode: state.mode });
    }
    if (cb.onPeerLeft) cb.onPeerLeft(id);
  }

  // Remote peers can send anything — a stray NaN written into the sim never
  // heals (it spreads through physics into every snapshot), so numbers from
  // the wire get coerced and clamped before they touch authoritative state.
  function finite01(v, lim) {
    v = +v;
    return v === v ? Math.max(-lim, Math.min(lim, v)) : 0;
  }

  function hostHandle(conn, msg) {
    if (!msg || state.role !== 'host') return;
    if (msg.t === 'join') {
      if (state.started || state.roster.length >= MAX_PLAYERS) {
        // rejected joiners must not stay subscribed to the game feed —
        // otherwise they keep receiving rosters/snapshots and get yanked
        // into a broken spectator view by the next 'start'/'lv' broadcast
        try { conn.send({ t: 'full' }); } catch (e) {}
        state.conns = state.conns.filter((c) => c !== conn);
        setTimeout(() => { try { conn.close(); } catch (e) {} }, 250);
        return;
      }
      if (!state.roster.some((r) => r.id === conn.peer)) {
        state.roster.push({
          id: conn.peer,
          name: ((typeof msg.name === 'string' && msg.name) || ('PLAYER ' + (state.roster.length + 1))).slice(0, 14),
          loadoutIndex: validLoadout(msg.loadoutIndex),
        });
      }
      if (cb.onRoster) cb.onRoster(state.roster);
      broadcast({ t: 'roster', roster: state.roster, mode: state.mode });
    } else if (msg.t === 'loadout' && !state.started) {
      const r = state.roster.find((x) => x.id === conn.peer);
      if (r) { r.loadoutIndex = validLoadout(msg.loadoutIndex); if (cb.onRoster) cb.onRoster(state.roster); broadcast({ t: 'roster', roster: state.roster, mode: state.mode }); }
    } else if (msg.t === 'input') {
      const i = msg.in;
      if (i && typeof i === 'object') {
        // sequenced: an old packet arriving after a newer one is dropped
        const seq = msg.q | 0;
        const prev = state.inputs[conn.peer];
        if (prev && seq && prev.q && seq < prev.q && prev.q - seq < 1e6) return;
        state.inputs[conn.peer] = {
          t: finite01(i.t, 1), d: finite01(i.d, 1),
          f: i.f ? 1 : 0, g: i.g ? 1 : 0, b: i.b ? 1 : 0,
          m: i.m ? 1 : 0, v: i.v ? 1 : 0, q: seq,
        };
      }
    } else if (msg.t === 'pick') {
      // client answered a TECH draft — the host's sim validates and applies
      if (cb.onPick) cb.onPick(conn.peer, msg.u);
    }
  }

  /* A client's chassis pick is clamped to the free ones: the locked MARAUDER
   * is the host's unlock to share, not a client's to claim off the wire. */
  function validLoadout(v) {
    v = v | 0;
    const maxFree = 2;
    let allowed = maxFree;
    try { if (typeof Progress !== 'undefined' && Progress.marauderUnlocked()) allowed = 3; } catch (e) {}
    return Math.max(0, Math.min(allowed, v));
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
    });
  }

  function serializeState(game, snd, bu, de, wr) {
    return {
      t: 's',
      hs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,   // host clock
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
          dm: e.hp < e.maxHp * 0.35 ? 1 : 0,   // trailing smoke
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
      ex: game.exit ? { x: game.exit.x, z: game.exit.z, c: Math.round((game.exit.charge || 0) * 100) / 100 } : null,
      cb: game.combo, ct: game.comboT, mu: game.mult, cw: game.comboWin,
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
      wr: (wr || game.frameWrecks || []).map((w) => ({ t: w.t, x: w.x, z: w.z, a: w.a, el: w.el })),
    };
  }

  function broadcastState(game, snd, bu, de, wr) { broadcast(serializeState(game, snd, bu, de, wr)); }
  function broadcastScreen(msg) { broadcast(Object.assign({ t: 'sc' }, msg)); }

  // ---- CLIENT -------------------------------------------------------------

  function clientJoin(code, name, loadoutIndex) {
    if (!libReady()) { if (cb.onError) cb.onError('Network library failed to load.'); return; }
    code = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    state.role = 'client';
    state.code = code;
    state.rejected = false;

    const peer = new Peer(peerOpts());
    state.peer = peer;
    state.clockOff = null; state.jitter = 0; state.delay = INTERP_DELAY;
    state.inSeq = 0; state.inLast = 0; state.inPrev = '';

    // Watchdog: behind symmetric NAT (no TURN) the data channel never opens
    // and PeerJS never says so — the UI sat on CONNECTING… forever.
    const clearWatch = () => { if (state.joinTimer) { clearTimeout(state.joinTimer); state.joinTimer = null; } };
    state.joinTimer = setTimeout(() => {
      state.joinTimer = null;
      if (state.role !== 'client' || (state.hostConn && state.hostConn.open)) return;
      try { peer.destroy(); } catch (e) {}
      if (cb.onError) cb.onError('Could not reach the host — a firewall or NAT is in the way. Try again, or another network.');
    }, JOIN_TIMEOUT);

    peer.on('open', (id) => {
      state.id = id;
      const conn = peer.connect(peerIdFor(code), { reliable: true });
      state.hostConn = conn;
      conn.on('open', () => {
        clearWatch();
        try { conn.send({ t: 'join', name: name || 'PLAYER', loadoutIndex: loadoutIndex || 0 }); } catch (e) {}
      });
      conn.on('data', (msg) => clientHandle(msg));
      conn.on('close', () => { clearWatch(); if (!state.rejected && cb.onError) cb.onError('Disconnected from host.'); });
      conn.on('error', () => { clearWatch(); if (!state.rejected && cb.onError) cb.onError('Connection error.'); });
    });
    peer.on('error', (err) => {
      clearWatch();
      const type = err && err.type;
      if (type === 'peer-unavailable') { if (cb.onError) cb.onError('No game found for code ' + code + '.'); }
      else if (cb.onError) cb.onError('Network error: ' + (type || err));
    });
  }

  function clientSetLoadout(idx) {
    const c = state.hostConn;
    if (!c) return;
    const msg = { t: 'loadout', loadoutIndex: idx | 0 };
    // picks made during the connect window used to be silently swallowed by
    // the try/catch — queue them behind the 'join' the open handler sends
    if (c.open) { try { c.send(msg); } catch (e) {} }
    else c.on('open', () => { try { c.send(msg); } catch (e) {} });
  }

  function clientHandle(msg) {
    // role check: leave() can't unhook an already-queued data event, and a
    // buffered 'start'/'lv' landing after LEAVE would yank the ex-client
    // into a connectionless phantom run
    if (!msg || state.rejected || state.role !== 'client') return;
    switch (msg.t) {
      case 'roster':
        if (!Array.isArray(msg.roster)) break;
        state.roster = msg.roster; state.mode = msg.mode || 'coop'; if (cb.onRoster) cb.onRoster(msg.roster); break;
      case 'full':
        // we're not in this game — stop listening before the host's next
        // 'start'/'lv'/'s' broadcast drags us into a broken spectator view
        state.rejected = true;
        if (cb.onError) cb.onError('Game is full or already in progress.');
        try { if (state.hostConn) state.hostConn.close(); } catch (e) {}
        break;
      case 'start':
        if (!Array.isArray(msg.defs)) break;
        state.started = true; state.mode = msg.mode || 'coop'; if (cb.onStart) cb.onStart(msg.defs, state.id, state.mode); break;
      case 'lv':
        if (!Array.isArray(msg.obstacles) || !Array.isArray(msg.flags)) break;
        state.snaps.length = 0;   // new arena: stale history would tween across it
        if (cb.onLevel) cb.onLevel(msg);
        break;
      case 's':
        if (!Array.isArray(msg.pl) || !Array.isArray(msg.en) || !Array.isArray(msg.pr) ||
            !Array.isArray(msg.pu) || !Array.isArray(msg.fg)) break;
        // Snapshots are timestamped on the HOST's clock, not on receipt, so
        // network jitter no longer maps 1:1 into interpolation stutter. The
        // clock offset tracks the earliest (least delayed) arrivals and decays
        // slowly to follow drift; each packet's lateness against it feeds a
        // smoothed jitter figure, and the render delay grows with it.
        {
          const now = performance.now() / 1000;
          if (typeof msg.hs === 'number' && Number.isFinite(msg.hs)) {
            const off = msg.hs - now;
            if (state.clockOff == null) state.clockOff = off;
            else state.clockOff = Math.max(off, state.clockOff - 0.0002);
            const late = Math.max(0, state.clockOff - off);
            state.jitter += (late - state.jitter) * 0.1;
            state.delay = Math.max(INTERP_DELAY, Math.min(0.3, INTERP_DELAY + 2 * state.jitter));
          }
        }
        state.snaps.push({
          t: (typeof msg.hs === 'number' && Number.isFinite(msg.hs))
            ? msg.hs - (state.clockOff || 0) : performance.now() / 1000,
          msg,
          idx: {
            pl: indexBy(msg.pl, 'id'), en: indexBy(msg.en, 'i'),
            pr: indexBy(msg.pr, 'i'), ri: indexBy(msg.ri, 'i'),
          },
        });
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

  /* Client input goes up at INPUT_HZ or on change, sequenced — not once per
   * render frame. 144 unsequenced messages a second over the one reliable
   * channel had the 30 Hz state stream queueing behind lost input packets.
   * force=true bypasses the rate limit (a zeroing packet on tab hide). */
  function sendInput(input, force) {
    const c = state.hostConn;
    if (!c || !c.open) return;
    const payload = {
      t: +input.turn || 0, d: +input.drive || 0,
      f: input.fire ? 1 : 0, g: input.nade ? 1 : 0, b: input.boost ? 1 : 0,
      m: input.mine ? 1 : 0, v: input.vent ? 1 : 0,
    };
    const key = payload.t.toFixed(2) + payload.d.toFixed(2) + payload.f + payload.g + payload.b + payload.m + payload.v;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!force && key === state.inPrev && now - state.inLast < 1000 / INPUT_HZ * 4) return;
    if (!force && key !== state.inPrev && now - state.inLast < 1000 / INPUT_HZ * 0.5) return;
    state.inPrev = key;
    state.inLast = now;
    state.inSeq = (state.inSeq + 1) | 0;
    try { c.send({ t: 'input', q: state.inSeq, in: payload }); } catch (e) {}
  }

  // ---- client-side snapshot application -----------------------------------
  // Writes incoming network data straight into a (client-owned) Game instance
  // so the existing renderer and HUD can read it without changes.

  function applyLevel(game, msg) {
    game.level = msg.level;
    game.score = msg.score;
    game.obstacles = msg.obstacles;
    game.flags = msg.flags.map((f) => ({ x: f.x, z: f.z, taken: f.taken, spin: f.spin || 0, cap: 0, contested: false, spiked: false }));
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
    game.wrecks = [];
    game.versus = !!msg.vs;
    game.killTarget = msg.kt || 10;
    game.killCounts = {};
    game.bossLevel = !game.versus && msg.level >= BOSS_EVERY && msg.level % BOSS_EVERY === 0;
    game.alert = 0;
    game.alarmT = 0;
    game.suspicion = false;
    game.exit = null;
    game.combo = 0; game.comboT = 0; game.mult = 1;
    game.mutator = msg.mut || null;
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
      damaged: !!d.dm,
      // hp is not on the wire; give the cosmetic smoke cadence something to read
      hp: d.dm ? 1 : 100, maxHp: 100,
    }));
    game.mines = (msg.mi || []).map((d) => ({ x: d.x, z: d.z, arm: d.a ? 0 : 1, life: 60, owner: null }));
    if (msg.vk) game.killCounts = msg.vk;
    game.projectiles = msg.pr.map((d) => ({ nid: d.i, x: d.x, y: d.y, z: d.z, angle: d.a, from: d.e ? 'enemy' : 'player', kind: d.k ? 'nade' : undefined }));
    game.powerups = msg.pu.map((d) => ({ type: d.k, x: d.x, z: d.z, spin: d.s, bob: d.b }));
    for (let i = 0; i < game.flags.length && i < msg.fg.length; i++) game.flags[i].taken = !!msg.fg[i];
    if (msg.fc) {
      for (let i = 0; i < game.flags.length && i < msg.fc.length; i++) {
        const f = game.flags[i];
        // any progress at all means the spike is planted and running — the
        // hack no longer needs a tank in the ring, so "rising" is not the tell
        f.cap = msg.fc[i] || 0;
        f.spiked = f.cap > 0;
        f.contested = f.spiked;
      }
    }

    game.alert = msg.al || 0;
    game.alarmT = msg.alm ? 1 : 0;   // clients only need on/off for HUD + music
    game.suspicion = !!msg.sus;
    const hadExit = !!game.exit;
    game.exit = msg.ex ? { x: msg.ex.x, z: msg.ex.z, charge: (msg.ex.c || 0) * EXIT_CHARGE } : null;
    if (!hadExit && game.exit) {
      game.hud.message('UPLINK COMPLETE — REACH THE GATE AND HOLD IT', '#4fd6bb', 3.2, 'alert');
    }
    game.combo = msg.cb || 0;
    game.comboT = msg.ct || 0;
    game.mult = msg.mu || 1;
    game.comboWin = msg.cw || 4;

    game.boss = (msg.bo && Array.isArray(msg.bo.tu)) ? {
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

    if (msg.bu) for (const b of msg.bu) {
      game._burst(b.x, b.y, b.z, b.n, b.c, b.p);
      // a burst this big was a detonation: burn the floor here too, so a
      // client's arena carries the same scars as the host's
      if (b.n >= 24) game._addDecal(b.x, b.z, 2.5 + b.n * 0.09, 26, 'scorch', 0, 0.6);
    }
    if (msg.de) for (const d of msg.de) game._spawnShards(d.x, d.z, d.c, false);
    if (msg.wr && game._addWreck) {
      for (const w of msg.wr) {
        if (typeof w.t !== 'string' || !Number.isFinite(w.x) || !Number.isFinite(w.z)) continue;
        game._addWreck(w.t, w.x, w.z, +w.a || 0, !!w.el, false);
      }
    }
    if (msg.snd) {
      for (const s of msg.snd) {
        // a placed sound arrives as [key, x, z]; a flat one as a bare string.
        // Clients spatialize it against their *own* listener, so the same
        // host event sounds like it came from where it happened for everyone.
        const placed = Array.isArray(s);
        const k = placed ? s[0] : s;
        if (typeof k !== 'string') continue;
        AudioSys.play(k, placed && Number.isFinite(s[1]) && Number.isFinite(s[2])
          ? { x: s[1], z: s[2] } : null);
        // clients don't run the sim — mirror the host's event banners off
        // the sounds that always accompany them
        if (k === 'alarm') game.hud.message('ALARM — THE GRID IS HUNTING', '#ff4a3c', 2.4, 'alert');
        else if (k === 'coreExposed') game.hud.message('CORE EXPOSED — ATTACK', '#ffd24a', 3);
        else if (k === 'bossDown') game.hud.message('WARLORD DESTROYED', '#3cff78', 3);
        else if (k === 'comboBreak') game.hud.message('COMBO BROKEN', '#ff4a3c', 1.5);
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
    const rt = now - (state.delay || INTERP_DELAY);

    let i = snaps.length - 1;
    while (i > 0 && snaps[i].t > rt) i--;
    const a = snaps[i];
    const b = snaps[Math.min(i + 1, snaps.length - 1)];
    const span = b.t - a.t;
    const k = span > 0.0001 ? Math.max(0, Math.min(1, (rt - a.t) / span)) : 1;

    const lerp = (x, y) => x + (y - x) * k;
    const lerpA = (x, y) => x + wrapAngle(y - x) * k;

    const pa = a.idx.pl, pb = b.idx.pl;
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
    const dl = newest.idx.pl[game.localId];
    const lp = game.player;
    if (lp && dl && dl.al) {
      const age = Math.min(Math.max(0, now - newest.t), 0.12);
      lp.x = dl.x + (dl.vx || 0) * age;
      lp.z = dl.z + (dl.vz || 0) * age;
      lp.angle = dl.a;
    }

    const ea = a.idx.en, eb = b.idx.en;
    for (const e of game.enemies) {
      const da = ea[e.nid], db = eb[e.nid];
      if (da && db) {
        e.x = lerp(da.x, db.x);
        e.z = lerp(da.z, db.z);
        e.angle = lerpA(da.a, db.a);
      }
    }

    const ra = a.idx.pr, rb = b.idx.pr;
    for (const pr of game.projectiles) {
      const da = ra[pr.nid], db = rb[pr.nid];
      if (da && db) {
        pr.x = lerp(da.x, db.x);
        pr.y = lerp(da.y, db.y);
        pr.z = lerp(da.z, db.z);
        pr.angle = lerpA(da.a, db.a);
      }
    }

    const ga = a.idx.ri, gb = b.idx.ri;
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
    if (state.joinTimer) { clearTimeout(state.joinTimer); state.joinTimer = null; }
    try { if (state.peer) state.peer.destroy(); } catch (e) {}
    state.role = 'solo'; state.peer = null; state.hostConn = null;
    state.conns = []; state.roster = []; state.inputs = {};
    state.started = false; state.id = null; state.code = null;
    state.mode = 'coop';
    state.snaps = [];
    state.rejected = false;
    state.clockOff = null; state.jitter = 0; state.delay = INTERP_DELAY;
    state.inSeq = 0; state.inLast = 0; state.inPrev = '';
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
    interpDelay: () => state.delay,
    codeLength: CODE_LEN,
    get role() { return state.role; },
  };
})();
