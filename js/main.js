/* Boot, screen flow, camera, scene rendering, main loop.
 *
 * Supports three roles (Net.role): 'solo', 'host', 'client'.
 *  - solo / host run the authoritative Game simulation locally.
 *  - host additionally streams snapshots to clients (see net.js).
 *  - client runs no simulation: it streams input up and renders host snapshots.
 */
(() => {
  const glCanvas = document.getElementById('gl');
  const hudCanvas = document.getElementById('hud');

  let renderer;
  try {
    renderer = new Renderer(glCanvas);
  } catch (err) {
    document.getElementById('screen-title').innerHTML =
      '<div class="panel small"><div class="panel-head red">NO WEBGL</div>' +
      '<div class="clear-stats">This game needs a WebGL-capable browser.</div></div>';
    throw err;
  }

  const hud = new HUD(hudCanvas);
  const game = new Game(hud);

  // ---- meshes -------------------------------------------------------------
  const M = {
    ground: renderer.createMesh(Geometry.ground(ARENA_HALF + 60, 8)),
    grid: renderer.createMesh(Geometry.gridLines(ARENA_HALF, 8), renderer.gl.LINES),
    wall: renderer.createMesh(Geometry.wallSegment()),
    block: renderer.createMesh(Geometry.block([1, 1, 1])),
    pyramid: renderer.createMesh(Geometry.pyramidMesh([1, 1, 1])),
    flag: renderer.createMesh(Geometry.flag()),
    tankDrone: renderer.createMesh(Geometry.tankSolid(Geometry.C.hullEnemy)),
    tankHunter: renderer.createMesh(Geometry.tankSolid(Geometry.C.hullHunter)),
    tankSniper: renderer.createMesh(Geometry.tankSolid(Geometry.C.hullSniper)),
    tankPhantom: renderer.createMesh(Geometry.tankSolid(Geometry.C.hullPhantom)),
    tankPlayer: renderer.createMesh(Geometry.tankSolid(Geometry.C.hullPlayer)),
    shotPlayer: renderer.createMesh(Geometry.shot(Geometry.C.shotPlayer)),
    shotEnemy: renderer.createMesh(Geometry.shot(Geometry.C.shotEnemy)),
    shotNade: renderer.createMesh(Geometry.shot(Geometry.C.shotNade)),
    shard: renderer.createMesh(Geometry.shard()),
    depot: renderer.createMesh(Geometry.depot()),
    powerup: renderer.createMesh(Geometry.powerup()),
    beacon: renderer.createMesh(Geometry.beacon()),
    bossBody: renderer.createMesh(Geometry.bossBody()),
    bossTurret: renderer.createMesh(Geometry.bossTurret()),
    bossCore: renderer.createMesh(Geometry.bossCore()),
    ring: renderer.createMesh(Geometry.ring(), renderer.gl.LINES),
    // ominous backdrop, camera-anchored so it sits at infinity
    sky: renderer.createMesh(Geometry.skyDome(660)),
    mountains: renderer.createMesh(Geometry.mountains(600)),
    stars: renderer.createMesh(Geometry.stars(640, 110), renderer.gl.POINTS),
    eclipse: renderer.createMesh(Geometry.eclipse(630)),
  };
  const TANK_MESH = { drone: M.tankDrone, hunter: M.tankHunter, sniper: M.tankSniper, phantom: M.tankPhantom };

  // ---- ui state -------------------------------------------------------------
  // title | setup | lobby | join | playing | levelclear | gameover | paused
  let uiMode = 'title';
  let loadoutIndex = 1;   // solo loadout
  let lobbyLoadout = 1;   // co-op loadout
  let chaseCam = false;
  let chaseCamUserSet = false;   // stop the touch default from fighting the C toggle
  let highScore = 0;
  try { highScore = parseInt(localStorage.getItem('pa_high') || '0', 10) || 0; } catch (e) {}

  const screens = {
    title: document.getElementById('screen-title'),
    setup: document.getElementById('screen-setup'),
    lobby: document.getElementById('screen-lobby'),
    join: document.getElementById('screen-join'),
    clear: document.getElementById('screen-clear'),
    over: document.getElementById('screen-over'),
    pause: document.getElementById('screen-pause'),
  };

  function showScreen(name) {
    for (const k in screens) screens[k].classList.toggle('hidden', k !== name);
    if (name && menus[name]) menus[name].reset();
  }

  // ---- menu navigation: one focus model for keyboard, mouse and touch --------
  // Browsers synthesize hover events when a screen swap puts a button under the
  // stationary cursor; only real pointer movement may steal menu focus.
  let lastMX = -1, lastMY = -1;

  function makeMenu(screenEl, defaultId) {
    const visible = () =>
      Array.from(screenEl.querySelectorAll('.mbtn')).filter((el) => !el.classList.contains('hidden'));
    let focused = null;
    function setFocus(el, silent) {
      if (focused === el) return;
      focused = el;
      screenEl.querySelectorAll('.mbtn').forEach((b) => b.classList.toggle('focus', b === el));
      if (!silent && el) AudioSys.play('select');
    }
    function move(dir) {
      const list = visible();
      if (!list.length) return;
      const i = list.indexOf(focused);
      setFocus(list[i < 0 ? 0 : (i + dir + list.length) % list.length]);
    }
    function activate() {
      if (focused && !focused.classList.contains('hidden')) focused.click();
    }
    function reset() {
      const list = visible();
      setFocus(list.find((b) => b.id === defaultId) || list[0] || null, true);
    }
    screenEl.addEventListener('mousemove', (e) => {
      const moved = e.clientX !== lastMX || e.clientY !== lastMY;
      lastMX = e.clientX; lastMY = e.clientY;
      if (!moved) return;
      const b = e.target.closest('.mbtn');
      if (b && !b.classList.contains('hidden')) setFocus(b, true);
    });
    return { move, activate, reset, clear: () => setFocus(null, true) };
  }

  const menus = {
    title: makeMenu(screens.title, 'bt-deploy'),
    setup: makeMenu(screens.setup, 'bt-launch'),
    lobby: makeMenu(screens.lobby, 'bt-lobby-launch'),
    join: makeMenu(screens.join, 'bt-join-connect'),
    clear: makeMenu(screens.clear, 'bt-continue'),
    over: makeMenu(screens.over, 'bt-retry'),
    pause: makeMenu(screens.pause, 'bt-resume'),
  };

  function menuKeys(name) {
    const m = menus[name];
    if (!m) return;
    if (Input.consume('ArrowUp') || Input.consume('KeyW')) m.move(-1);
    if (Input.consume('ArrowDown') || Input.consume('KeyS')) m.move(1);
    if (Input.consume('Enter') || Input.consume('NumpadEnter') || Input.consume('Space')) m.activate();
  }

  function bind(id, fn) {
    const el = document.getElementById(id);
    el.addEventListener('click', () => { AudioSys.resume(); AudioSys.play('select'); fn(); });
    return el;
  }

  function updateTitleHigh() {
    document.getElementById('title-high').textContent =
      highScore > 0 ? 'HIGH SCORE ' + String(highScore).padStart(7, '0') : '';
  }
  updateTitleHigh();

  // ---- solo loadout select --------------------------------------------------
  function selectLoadout(i) {
    loadoutIndex = i;
    document.querySelectorAll('.loadout').forEach((el) => {
      el.classList.toggle('selected', parseInt(el.dataset.i, 10) === i);
    });
    AudioSys.play('select');
  }

  document.querySelectorAll('.loadout').forEach((el) => {
    el.addEventListener('click', () => {
      selectLoadout(parseInt(el.dataset.i, 10));
      AudioSys.resume();
    });
    el.addEventListener('dblclick', () => startRun());
  });

  function goSetup() {
    uiMode = 'setup';
    showScreen('setup');
  }

  // On touch devices, launching a run is the user gesture we spend on going
  // fullscreen + landscape, and third person is the friendlier default camera.
  // Everything here is best-effort: browsers that refuse just play windowed.
  function mobileImmersive() {
    if (!Input.touchUI().mode) return;
    if (!chaseCamUserSet) chaseCam = true;
    try {
      const el = document.documentElement;
      if (!document.fullscreenElement && el.requestFullscreen) {
        const r = el.requestFullscreen({ navigationUI: 'hide' });
        if (r && r.catch) r.catch(() => {});
      }
    } catch (e) {}
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
      }
    } catch (e) {}
  }

  function startRun() {
    mobileImmersive();
    game.newRun(loadoutIndex);
    uiMode = 'playing';
    showScreen(null);
    AudioSys.play('deploy');
    hud.message('SECTOR 1 — SECURE ALL FLAGS', '#4fd6bb', 3);
  }

  function recordHighScore() {
    const isHigh = game.score > highScore;
    if (isHigh) {
      highScore = game.score;
      try { localStorage.setItem('pa_high', String(highScore)); } catch (e) {}
      updateTitleHigh();
    }
    return isHigh;
  }

  // Which game-over actions make sense depends on the role: solo runs can be
  // retried instantly, only the co-op host can relaunch the whole squad.
  function configureOverButtons() {
    const solo = Net.role === 'solo';
    document.getElementById('bt-retry').classList.toggle('hidden', !solo);
    document.getElementById('bt-loadout').classList.toggle('hidden', !solo);
    document.getElementById('bt-again').classList.toggle('hidden', Net.role !== 'host');
  }

  function gameOver() {
    uiMode = 'gameover';
    const isHigh = recordHighScore();
    document.getElementById('over-stats').innerHTML =
      `FINAL SCORE <span class="gold">${game.score}</span><br>` +
      `SECTOR REACHED ${game.level}<br>` +
      (isHigh ? '<span class="gold">&#9733; NEW HIGH SCORE &#9733;</span>'
              : `HIGH SCORE ${highScore}`);
    configureOverButtons();
    showScreen('over');
  }

  // ---- multiplayer: lobby ----------------------------------------------------
  const lobbyCodeEl = document.getElementById('lobby-code');
  const lobbyRosterEl = document.getElementById('lobby-roster');
  const lobbyHintEl = document.getElementById('lobby-hint');
  const lobbyCopyHintEl = document.getElementById('lobby-copy-hint');
  const lobbyLaunchBtn = document.getElementById('bt-lobby-launch');
  const joinInput = document.getElementById('join-code');
  const joinError = document.getElementById('join-error');
  let roomCode = '';

  // Clicking the room code copies an invite — a full ?join= link when hosted
  // over http(s), just the code when running from file://.
  const COPY_HINT_DEFAULT = 'CLICK CODE TO COPY INVITE LINK';
  lobbyCodeEl.addEventListener('click', () => {
    if (!roomCode) return;
    AudioSys.resume();
    const invite = /^https?:$/.test(location.protocol)
      ? location.origin + location.pathname + '?join=' + roomCode
      : roomCode;
    const done = () => {
      lobbyCopyHintEl.textContent = 'INVITE COPIED — SEND IT TO YOUR SQUAD';
      AudioSys.play('select');
      setTimeout(() => { lobbyCopyHintEl.textContent = COPY_HINT_DEFAULT; }, 2500);
    };
    const fail = () => { lobbyCopyHintEl.textContent = 'COPY FAILED — CODE IS ' + roomCode; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(invite).then(done, fail);
    } else fail();
  });

  function setRoomCode(code) {
    roomCode = code || '';
    lobbyCopyHintEl.textContent = COPY_HINT_DEFAULT;
    lobbyCopyHintEl.classList.toggle('hidden', !roomCode);
  }

  function selectLobbyLoadout(i) {
    lobbyLoadout = i;
    document.querySelectorAll('#lobby-loadouts .ll').forEach((el) => {
      el.classList.toggle('selected', parseInt(el.dataset.i, 10) === i);
    });
    AudioSys.play('select');
    if (Net.role === 'host') Net.hostSetLocalLoadout(i);
    else if (Net.role === 'client') Net.clientSetLoadout(i);
  }
  document.querySelectorAll('#lobby-loadouts .ll').forEach((el) => {
    el.addEventListener('click', () => { AudioSys.resume(); selectLobbyLoadout(parseInt(el.dataset.i, 10)); });
  });

  function renderRoster(roster) {
    lobbyRosterEl.innerHTML = roster.map((r, i) => {
      const lo = LOADOUTS[r.loadoutIndex] || LOADOUTS[1];
      const you = (Net.role === 'host' && i === 0) || (Net.role === 'client' && r.id === Net.state.id);
      return `<div class="roster-row"><span class="roster-dot c${i}"></span>` +
        `${r.name}${you ? ' <span class="roster-you">(YOU)</span>' : ''}` +
        `<span class="roster-lo">${lo.name}</span></div>`;
    }).join('');
    if (Net.role === 'host') {
      lobbyHintEl.textContent = roster.length > 1
        ? 'ENTER TO LAUNCH — ' + roster.length + ' TANKS READY'
        : 'WAITING FOR PLAYERS — ENTER TO LAUNCH SOLO';
    } else {
      lobbyHintEl.textContent = 'WAITING FOR HOST TO LAUNCH…';
    }
  }

  function enterLobbyAsHost() {
    AudioSys.resume();
    lobbyLoadout = 1;
    selectLobbyLoadout(1);
    lobbyCodeEl.textContent = 'CREATING ROOM…';
    setRoomCode('');
    lobbyLaunchBtn.classList.remove('hidden');
    renderRoster([]);
    uiMode = 'lobby';
    showScreen('lobby');
    Net.hostCreate('PLAYER 1', lobbyLoadout);
  }

  function enterJoin() {
    AudioSys.resume();
    joinError.textContent = '';
    joinInput.value = '';
    uiMode = 'join';
    showScreen('join');
    setTimeout(() => joinInput.focus(), 30);
  }

  function submitJoin() {
    const code = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) { joinError.textContent = 'ENTER A 4-CHARACTER CODE'; return; }
    mobileImmersive();   // last user gesture before the host launches us into play
    joinError.textContent = 'CONNECTING…';
    joinInput.blur();
    lobbyLoadout = 1;
    uiMode = 'lobby';
    lobbyLaunchBtn.classList.add('hidden');
    showScreen('lobby');
    menus.lobby.clear();   // no default action for clients — Enter shouldn't leave
    lobbyCodeEl.textContent = 'ROOM ' + code;
    setRoomCode(code);
    document.querySelectorAll('#lobby-loadouts .ll').forEach((el) => {
      el.classList.toggle('selected', parseInt(el.dataset.i, 10) === 1);
    });
    renderRoster([]);
    Net.clientJoin(code, 'PLAYER', lobbyLoadout);
  }

  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitJoin(); }
    else if (e.key === 'Escape') { e.preventDefault(); leaveToTitle(); }
  });

  // Uppercase as you type, strip junk, and connect the moment 4 chars are in.
  joinInput.addEventListener('input', () => {
    const v = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v !== joinInput.value) joinInput.value = v;
    if (v.length >= 4 && uiMode === 'join') submitJoin();
  });

  function leaveToTitle() {
    Net.leave();
    setRoomCode('');
    game.mode = 'idle';
    uiMode = 'title';
    showScreen('title');
    AudioSys.setEngine(0);
  }

  // ---- multiplayer: run start (host & client) --------------------------------
  function startHostRun() {
    mobileImmersive();
    const info = Net.hostStartGame();
    game.newRun(info.defs, info.localId);   // host owns the arena generation
    uiMode = 'playing';
    showScreen(null);
    AudioSys.play('deploy');
    hud.message('SECTOR 1 — SECURE ALL FLAGS', '#4fd6bb', 3);
    Net.broadcastLevel(game);               // ship the arena to clients
    netState.timer = 0; netState.snd = []; netState.bu = []; netState.de = [];
  }

  function startClientRun(defs, localId) {
    // Build players locally but DON'T generate an arena — the host owns it and
    // streams it via 'lv' + 's' messages.
    game.players = defs.map((d, i) => game._makePlayer(d, i));
    game.localId = localId;
    game.player = game.players.find((p) => p.id === localId) || game.players[0];
    game.level = 1; game.score = 0;
    game.obstacles = []; game.flags = []; game.enemies = [];
    game.projectiles = []; game.powerups = []; game.particles = [];
    game.debris = []; game.depots = [];
    game.boss = null; game.rings = []; game.pendingSpawns = [];
    game.bossLevel = false; game.alert = 0;
    game.combo = 0; game.comboT = 0; game.mult = 1;
    game.mode = 'playing';
    game._prevSh = null; game._prevAlive = null;  // reset damage-feedback tracking
    uiMode = 'playing';
    showScreen(null);
    AudioSys.play('deploy');
    hud.message('CO-OP DEPLOYED — SECURE ALL FLAGS', '#4fd6bb', 3);
  }

  function showClearStats() {
    document.getElementById('clear-stats').innerHTML =
      `SECTOR ${game.level} SECURE<br>` +
      `BONUS <span class="gold">+${game.levelBonus}</span><br>` +
      `SCORE ${game.score}`;
    document.getElementById('bt-continue').classList.toggle('hidden', Net.role === 'client');
    document.getElementById('clear-wait').classList.toggle('hidden', Net.role !== 'client');
  }

  function advanceLevel() {
    if (uiMode !== 'levelclear' || Net.role === 'client') return;
    game.nextLevel();
    uiMode = 'playing';
    showScreen(null);
    hud.message('SECTOR ' + game.level, game.bossLevel ? '#ff4a3c' : '#4fd6bb', 2.5);
    if (Net.role === 'host') { Net.broadcastLevel(game); netState.timer = 0; netState.snd = []; netState.bu = []; netState.de = []; }
  }

  // ---- pause / abort -----------------------------------------------------------
  const btAbort = document.getElementById('bt-abort');
  let abortArmed = false;
  function resetAbort() {
    abortArmed = false;
    btAbort.classList.remove('armed');
    btAbort.innerHTML = 'ABORT MISSION<span class="mkey">Q</span>';
  }
  // Aborting throws away the run, so it takes two presses to go through.
  btAbort.addEventListener('click', () => {
    AudioSys.resume();
    AudioSys.play('select');
    if (!abortArmed) {
      abortArmed = true;
      btAbort.classList.add('armed');
      btAbort.innerHTML = 'CONFIRM ABORT?<span class="mkey">Q</span>';
    } else {
      resetAbort();
      leaveToTitle();
    }
  });

  function pauseGame() {
    uiMode = 'paused';
    resetAbort();
    showScreen('pause');
    AudioSys.setEngine(0);
  }

  function resumeGame() {
    resetAbort();
    uiMode = 'playing';
    showScreen(null);
  }

  // Auto-pause a solo run when the tab is hidden — no cheap deaths while
  // you're on another tab, and web-game portals require this behavior.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && uiMode === 'playing' && Net.role === 'solo') pauseGame();
  });

  function enterLevelClear() {
    uiMode = 'levelclear';
    showClearStats();
    showScreen('clear');
    if (Net.role === 'host') {
      Net.broadcastState(game);
      Net.broadcastScreen({ s: 'clear', level: game.level, levelBonus: game.levelBonus, score: game.score });
    }
  }

  function doGameOver() {
    if (Net.role === 'host') {
      Net.broadcastState(game);
      Net.broadcastScreen({ s: 'over', score: game.score, level: game.level });
    }
    gameOver();
  }

  // ---- network callbacks -----------------------------------------------------
  Net.cb.onRoster = (roster) => { if (uiMode === 'lobby') renderRoster(roster); };
  Net.cb.onCode = (code) => {
    setRoomCode(code);
    if (uiMode === 'lobby') lobbyCodeEl.textContent = 'ROOM CODE  ' + code;
  };
  Net.cb.onError = (text) => {
    if (uiMode === 'join') { joinError.textContent = text; }
    else if (uiMode === 'lobby') { lobbyHintEl.textContent = text; lobbyCodeEl.textContent = 'CONNECTION FAILED'; }
    else {
      // mid-game error — if a client loses the host, bail out to the title
      hud.message(text, '#ff4a3c', 4);
      if (Net.role === 'client') leaveToTitle();
    }
  };
  // A teammate dropped: stop their now-frozen tank from driving/firing forever.
  Net.cb.onPeerLeft = (id) => {
    const p = game.players && game.players.find((pp) => pp.id === id);
    if (p && p.input) { p.input.turn = 0; p.input.drive = 0; p.input.fire = false; }
  };
  Net.cb.onStart = (defs, localId) => startClientRun(defs, localId);
  Net.cb.onLevel = (msg) => {
    Net.applyLevel(game, msg);
    uiMode = 'playing';
    showScreen(null);
    if (game.bossLevel) {
      hud.message('SECTOR ' + game.level + ' — WARLORD DETECTED', '#ff4a3c', 3.5);
      AudioSys.play('alarm');
    } else {
      hud.message('SECTOR ' + game.level, '#4fd6bb', 2.5);
    }
  };
  Net.cb.onState = (msg) => { if (Net.role === 'client') Net.applyState(game, msg); };
  Net.cb.onScreen = (msg) => {
    if (msg.s === 'clear') {
      game.level = msg.level; game.levelBonus = msg.levelBonus; game.score = msg.score;
      uiMode = 'levelclear';
      showClearStats();
      showScreen('clear');
    } else if (msg.s === 'over') {
      game.score = msg.score; game.level = msg.level;
      recordHighScore();
      document.getElementById('over-stats').innerHTML =
        `FINAL SCORE <span class="gold">${game.score}</span><br>SECTOR REACHED ${game.level}`;
      uiMode = 'gameover';
      configureOverButtons();
      showScreen('over');
    }
  };

  // ---- title demo scene -----------------------------------------------------
  const demoGame = new Game(new HUD(document.createElement('canvas')));
  demoGame.player = { x: 0, z: 0, alive: false };
  demoGame._genObstacles(30);
  demoGame._genFlags(8);
  let demoT = 0;

  // ---- camera ---------------------------------------------------------------
  const cam = { x: 0, y: 2.3, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 1.22 };

  function inMenu() {
    return uiMode === 'title' || uiMode === 'setup' || uiMode === 'lobby' || uiMode === 'join';
  }

  function updateCamera(dt) {
    if (inMenu()) {
      demoT += dt * 0.1;
      cam.x = Math.cos(demoT) * 95;
      cam.z = Math.sin(demoT) * 95;
      cam.y = 34;
      cam.yaw = angleTo(0 - cam.x, 0 - cam.z);
      cam.pitch = -0.30;
      cam.roll = 0;
      return;
    }
    const p = game.player;
    if (!p) return;
    // bank gently into turns for a hovertank feel
    const ax = Input.axis();
    const speed01 = p.maxSpeed ? Math.min(1, Math.abs(p.speed || 0) / p.maxSpeed) : 0;
    const rollTarget = (uiMode === 'playing' && p.alive) ? ax.turn * 0.045 * (0.3 + 0.7 * speed01) : 0;
    cam.roll += (rollTarget - cam.roll) * Math.min(1, dt * 8);
    const shake = game.shake;
    const sx = (Math.random() - 0.5) * shake * 0.6;
    const sy = (Math.random() - 0.5) * shake * 0.5;
    if (chaseCam || !p.alive) {
      const back = 11, up = 5.5;
      cam.x = p.x - fwdX(p.angle) * back + sx;
      cam.z = p.z - fwdZ(p.angle) * back + sx;
      cam.y = up + sy;
      cam.yaw = p.angle;
      cam.pitch = -0.24;
    } else {
      cam.x = p.x + sx;
      cam.z = p.z + sx;
      cam.y = 2.3 + sy + Math.abs(Math.sin(performance.now() / 240)) * Math.min(1, Math.abs(p.speed) / p.maxSpeed) * 0.1;
      cam.yaw = p.angle;
      cam.pitch = 0;
    }
  }

  // ---- scene rendering --------------------------------------------------------
  // The backdrop follows the camera (x/z only) so it never parallaxes closer:
  // ember horizon, black ridgelines, dead stars, and an eclipsed sun. The glow
  // breathes slowly and occasionally flares like distant sheet lightning.
  function drawSky() {
    const t = performance.now() / 1000;
    const n = Math.sin(t * 11.3) * Math.sin(t * 4.7) * Math.sin(t * 1.9);
    const flare = n > 0.9 ? (n - 0.9) * 5 : 0;
    const g = 0.85 + 0.15 * Math.sin(t * 0.43) + flare;
    const model = m4.translation(cam.x, 0, cam.z);
    renderer.draw(M.sky, model, { unlit: true, nofog: true, tint: [g, g * 0.85, g * 0.85] });
    renderer.draw(M.stars, model, { unlit: true, nofog: true, points: true });
    const rim = 0.8 + 0.2 * Math.sin(t * 0.9) + flare;
    renderer.draw(M.eclipse, model, { unlit: true, nofog: true, tint: [rim, rim, rim] });
    renderer.draw(M.mountains, model, { unlit: true, nofog: true, tint: [g, g, g] });
  }

  function drawArena(src) {
    drawSky();
    renderer.draw(M.ground, m4.identity());
    renderer.draw(M.grid, m4.identity(), { unlit: true });

    const step = 8, lim = ARENA_HALF + 1.5;
    for (let v = -ARENA_HALF; v <= ARENA_HALF; v += step) {
      renderer.draw(M.wall, m4.trs(v, 0, -lim, 0, step, 1, 3));
      renderer.draw(M.wall, m4.trs(v, 0, lim, 0, step, 1, 3));
      renderer.draw(M.wall, m4.trs(-lim, 0, v, 0, 3, 1, step));
      renderer.draw(M.wall, m4.trs(lim, 0, v, 0, 3, 1, step));
    }

    for (const o of src.obstacles) {
      if (o.dead) continue;   // crushed under the WARLORD
      const mesh = o.type === 'pyramid' ? M.pyramid : M.block;
      renderer.draw(mesh, m4.trs(o.x, 0, o.z, 0, o.w, o.h, o.d), { tint: o.color });
    }

    for (const f of src.flags) {
      if (f.taken) continue;
      renderer.draw(M.flag, m4.trs(f.x, 0, f.z, f.spin, 1, 1, 1));
    }

    // resupply pads pulse slowly in their supply color
    const t = performance.now() / 1000;
    for (const d of (src.depots || [])) {
      const pulse = 0.7 + 0.3 * Math.sin(t * 3 + (d.type === 'ammo' ? 0 : 2));
      const tint = d.type === 'ammo'
        ? [0.95 * pulse, 0.8 * pulse, 0.2 * pulse]
        : [0.25 * pulse, 1.0 * pulse, 0.55 * pulse];
      renderer.draw(M.depot, m4.trs(d.x, 0, d.z, 0, 1, 1, 1), { tint, unlit: true });
    }
  }

  function drawGame() {
    drawArena(game);

    const now = performance.now();

    // last flags get a pillar of light: no more hunting the final objective
    const fl = game.flagsLeft();
    if (fl > 0 && fl <= 2) {
      const pulse = 0.55 + 0.45 * Math.sin(now / 180);
      for (const f of game.flags) {
        if (f.taken) continue;
        renderer.draw(M.beacon, m4.trs(f.x, 0, f.z, 0, 1, 1, 1),
          { tint: [0.25 * pulse, 1.0 * pulse, 0.5 * pulse], unlit: true, nofog: true });
      }
    }

    // the WARLORD: hull, live turrets (own aim), and its core
    const b = game.boss;
    if (b && !b.dead) {
      let bodyTint = null;
      if (b.hitFlash > 0) {
        const f = 1 + b.hitFlash * 1.6;
        bodyTint = [f, f, f];
      } else if (b.state === 'telegraph') {
        // charge windup: the hull strobes hot
        const f = 0.75 + 0.65 * Math.sin(now / 45);
        bodyTint = [1 + f, 0.7 + f * 0.3, 0.7 + f * 0.3];
      }
      renderer.draw(M.bossBody, m4.trs(b.x, 0, b.z, b.angle, 1, 1, 1), { tint: bodyTint });
      for (const tu of b.turrets) {
        if (tu.hp <= 0) continue;
        const [wx, wz] = bossTurretWorld(b, tu);
        renderer.draw(M.bossTurret, m4.trs(wx, BOSS_TURRET_Y, wz, tu.aim, 1, 1, 1), { tint: bodyTint });
      }
      const ct = now / 1000;
      const coreTint = b.vulnerable
        ? [1.2 + 0.8 * Math.sin(ct * 9), 0.3, 0.55]                       // exposed: hot strobe
        : [0.22 + 0.08 * Math.sin(ct * 2), 0.45, 0.9 + 0.1 * Math.sin(ct * 2)]; // shielded: cold pulse
      renderer.draw(M.bossCore, m4.trs(b.x, 5.0, b.z, ct * 1.5, 1, 1, 1), { tint: coreTint, unlit: true });
    }

    // expanding shockwave rings
    for (const r of game.rings) {
      const fade = Math.max(0.25, 1 - r.r / 190);
      renderer.draw(M.ring, m4.trs(r.x, 0.5, r.z, 0, r.r, 1, r.r),
        { tint: [1 * fade + 0.3, 0.55 * fade, 0.2 * fade], unlit: true });
      renderer.draw(M.ring, m4.trs(r.x, 1.6, r.z, 0, r.r * 0.985, 1, r.r * 0.985),
        { tint: [0.8 * fade, 0.4 * fade, 0.15 * fade], unlit: true });
    }
    for (const e of game.enemies) {
      let tint = e.hitFlash > 0 ? [1 + e.hitFlash * 2, 1 + e.hitFlash * 2, 1 + e.hitFlash * 2] : null;
      // cloaked phantoms fade toward the void, with a faint shimmer
      const ck = e.cloak || 0;
      if (ck > 0.01 && e.hitFlash <= 0) {
        const v = Math.max(0.02, 1 - ck * (0.92 + 0.08 * Math.sin(now / 120)));
        tint = [v, v, v];
      }
      renderer.draw(TANK_MESH[e.type] || M.tankDrone, m4.trs(e.x, 0, e.z, e.angle, 1, 1, 1), { tint });
    }

    // all co-op tanks; own tank only shown in chase cam (it's the camera in 1st person)
    for (const pl of game.players) {
      if (!pl.alive) continue;
      const isLocal = pl.id === game.localId;
      if (isLocal && !chaseCam) continue;
      const tint = PLAYER_TINTS[pl.colorIdx] || PLAYER_TINTS[0];
      renderer.draw(M.tankPlayer, m4.trs(pl.x, 0, pl.z, pl.angle, 1, 1, 1), { tint });
    }

    for (const pr of game.projectiles) {
      const mesh = pr.kind === 'nade' ? M.shotNade : (pr.from === 'player' ? M.shotPlayer : M.shotEnemy);
      renderer.draw(mesh, m4.trs(pr.x, pr.y, pr.z, pr.angle, 1, 1, 1), { unlit: true });
    }

    // tumbling polygon shards from destroyed tanks
    for (const d of game.debris) {
      const model = m4.multiply(
        m4.trs(d.x, d.y, d.z, d.yaw, d.scale, d.scale, d.scale),
        m4.rotationX(d.tumble));
      renderer.draw(M.shard, model, { tint: d.c });
    }

    for (const u of game.powerups) {
      const spec = POWERUP_TYPES[u.type];
      const y = 1.6 + Math.sin(u.bob) * 0.35;
      renderer.draw(M.powerup, m4.trs(u.x, y, u.z, u.spin, 1, 1, 1), { tint: spec.tint, unlit: true });
    }

    renderer.drawParticles(game.particles);
  }

  // ---- input / screen flow ------------------------------------------------------
  function handleScreens() {
    if (Input.consume('KeyM')) {
      const muted = AudioSys.toggleMuted();
      hud.message(muted ? 'SOUND OFF' : 'SOUND ON', '#4fd6bb', 1);
    }

    switch (uiMode) {
      case 'title':
        if (Input.consume('KeyH')) { enterLobbyAsHost(); break; }
        if (Input.consume('KeyJ')) { enterJoin(); break; }
        menuKeys('title');
        break;

      case 'setup':
        if (Input.consume('Digit1')) selectLoadout(0);
        if (Input.consume('Digit2')) selectLoadout(1);
        if (Input.consume('Digit3')) selectLoadout(2);
        if (Input.consume('ArrowLeft') || Input.consume('KeyA')) selectLoadout((loadoutIndex + 2) % 3);
        if (Input.consume('ArrowRight') || Input.consume('KeyD')) selectLoadout((loadoutIndex + 1) % 3);
        menuKeys('setup');
        if (Input.consume('Escape')) { uiMode = 'title'; showScreen('title'); }
        break;

      case 'lobby':
        if (Input.consume('Digit1')) selectLobbyLoadout(0);
        if (Input.consume('Digit2')) selectLobbyLoadout(1);
        if (Input.consume('Digit3')) selectLobbyLoadout(2);
        if (Input.consume('ArrowLeft') || Input.consume('KeyA')) selectLobbyLoadout((lobbyLoadout + 2) % 3);
        if (Input.consume('ArrowRight') || Input.consume('KeyD')) selectLobbyLoadout((lobbyLoadout + 1) % 3);
        menuKeys('lobby');
        if (Input.consume('Escape')) leaveToTitle();
        break;

      case 'join':
        // while the field is focused its own listener handles keys; these only
        // fire if focus wandered off the input
        if (Input.consume('Enter')) submitJoin();
        if (Input.consume('Escape')) leaveToTitle();
        break;

      case 'playing':
        if (Input.consume('cam')) { chaseCam = !chaseCam; chaseCamUserSet = true; }
        if (Input.consume('pause') || Input.consume('Escape')) {
          if (Net.role === 'solo') pauseGame();
          else hud.message('PAUSE UNAVAILABLE IN CO-OP', '#ffd24a', 1.6);
        }
        break;

      case 'paused':
        if (Input.consume('pause') || Input.consume('Escape')) { resumeGame(); break; }
        if (Input.consume('KeyQ')) btAbort.click();
        menuKeys('pause');
        break;

      case 'levelclear':
        menuKeys('clear');
        break;

      case 'gameover':
        menuKeys('over');
        if (Input.consume('Escape')) leaveToTitle();
        break;
    }
  }

  // ---- menu button wiring ------------------------------------------------------
  bind('bt-deploy', goSetup);
  bind('bt-host', enterLobbyAsHost);
  bind('bt-join', enterJoin);
  bind('bt-setup-back', () => { uiMode = 'title'; showScreen('title'); });
  bind('bt-launch', startRun);
  bind('bt-join-back', leaveToTitle);
  bind('bt-join-connect', submitJoin);
  bind('bt-lobby-leave', leaveToTitle);
  bind('bt-lobby-launch', () => { if (Net.role === 'host') startHostRun(); });
  bind('bt-continue', advanceLevel);
  bind('bt-retry', startRun);
  bind('bt-again', () => { if (Net.role === 'host') startHostRun(); });
  bind('bt-loadout', goSetup);
  bind('bt-title', leaveToTitle);
  bind('bt-resume', resumeGame);

  menus.title.reset();   // title is visible on boot without a showScreen() call

  // Deep link: index.html?join=CODE goes straight into the co-op join flow, so
  // a host can just send the copied invite link.
  try {
    const codeParam = new URLSearchParams(location.search).get('join');
    if (codeParam && /^[a-z0-9]{4}$/i.test(codeParam)) {
      enterJoin();
      joinInput.value = codeParam.toUpperCase();
      submitJoin();
    }
  } catch (e) {}

  // ---- local input + engine audio --------------------------------------------
  function feedLocalInput() {
    const ax = Input.axis();
    const lp = game.player;
    if (lp && lp.input) {
      lp.input.turn = ax.turn; lp.input.drive = ax.drive;
      lp.input.fire = ax.fire; lp.input.nade = ax.nade; lp.input.boost = ax.boost;
    }
  }

  function updateEngine() {
    const lp = game.player;
    if (uiMode === 'playing' && lp && lp.alive && typeof lp.maxSpeed === 'number') {
      AudioSys.setEngine(Math.min(1, Math.abs(lp.speed || 0) / lp.maxSpeed));
    } else {
      AudioSys.setEngine(0);
    }
  }

  // client: advance purely cosmetic state between snapshots
  function clientCosmetics(dt) {
    game.shake = Math.max(0, game.shake - dt * 3);
    game._updateParticles(dt);
    game._updateDebris(dt);
    for (const f of game.flags) f.spin += dt * 2.2;
    for (const u of game.powerups) { u.spin += dt * 2.5; u.bob += dt * 3; }
  }

  // host: throttle snapshots to ~30 Hz, but never drop transient sounds/bursts
  const netState = { timer: 0, snd: [], bu: [], de: [] };
  function hostNetTick(dt) {
    if (game.frameSounds.length) for (const s of game.frameSounds) netState.snd.push(s);
    if (game.frameBursts.length) for (const b of game.frameBursts) netState.bu.push(b);
    if (game.frameDebris.length) for (const d of game.frameDebris) netState.de.push(d);
    netState.timer += dt;
    if (netState.timer >= 1 / 30) {
      netState.timer = 0;
      Net.broadcastState(game, netState.snd, netState.bu, netState.de);
      netState.snd = []; netState.bu = []; netState.de = [];
    }
  }

  // ---- main loop -------------------------------------------------------------------
  let lastT = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - lastT) / 1000;
    lastT = now;
    dt = Math.min(dt, 0.05);

    // gate matches the HUD's draw condition exactly: no invisible-but-live
    // controls during the death sequence or transitions
    Input.setPlayfieldActive(uiMode === 'playing' && game.mode === 'playing');
    handleScreens();

    if (uiMode === 'playing') {
      if (Net.role === 'client') {
        Net.sendInput(Input.axis());
        clientCosmetics(dt);
      } else {
        feedLocalInput();
        if (Net.role === 'host') Net.applyInputs(game);
        if (game.mode === 'playing') {
          game.update(dt);
          if (Net.role === 'host') hostNetTick(dt);
          if (game.mode === 'levelclear') enterLevelClear();
        } else if (game.mode === 'dying') {
          game.updateDying(dt);
          if (Net.role === 'host') Net.broadcastState(game);
          if (game.mode === 'gameover') doGameOver();
        }
      }
    }

    updateEngine();
    updateCamera(dt);
    renderer.beginFrame(cam);

    if (inMenu()) {
      drawArena(demoGame);
      for (const f of demoGame.flags) f.spin += dt * 2.2;
    } else {
      drawGame();
    }

    const showHud = (uiMode === 'playing' && game.mode === 'playing');
    hud.render(showHud ? game : null, dt);

    Input.clearFrame();
  }

  window.addEventListener('resize', () => { renderer.resize(); hud.resize(); });
  requestAnimationFrame(frame);

  // exposed for automated testing / tinkering
  window.__PA = { game, hud, net: Net, getMode: () => uiMode };
})();
