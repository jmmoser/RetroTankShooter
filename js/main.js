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
    tankDrone: renderer.createMesh(Geometry.tankWire(Geometry.C.hullEnemy), renderer.gl.LINES),
    tankHunter: renderer.createMesh(Geometry.tankWire(Geometry.C.hullHunter), renderer.gl.LINES),
    tankSniper: renderer.createMesh(Geometry.tankWire(Geometry.C.hullSniper), renderer.gl.LINES),
    tankPlayer: renderer.createMesh(Geometry.tankWire(Geometry.C.hullPlayer), renderer.gl.LINES),
    shotPlayer: renderer.createMesh(Geometry.shot(Geometry.C.shotPlayer)),
    shotEnemy: renderer.createMesh(Geometry.shot(Geometry.C.shotEnemy)),
    powerup: renderer.createMesh(Geometry.powerup()),
  };
  const TANK_MESH = { drone: M.tankDrone, hunter: M.tankHunter, sniper: M.tankSniper };

  // ---- ui state -------------------------------------------------------------
  // title | setup | lobby | join | playing | levelclear | gameover | paused
  let uiMode = 'title';
  let loadoutIndex = 1;   // solo loadout
  let lobbyLoadout = 1;   // co-op loadout
  let chaseCam = false;
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

  function startRun() {
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

  function gameOver() {
    uiMode = 'gameover';
    const isHigh = recordHighScore();
    document.getElementById('over-stats').innerHTML =
      `FINAL SCORE <span class="gold">${game.score}</span><br>` +
      `SECTOR REACHED ${game.level}<br>` +
      (isHigh ? '<span class="gold">&#9733; NEW HIGH SCORE &#9733;</span>'
              : `HIGH SCORE ${highScore}`);
    showScreen('over');
  }

  // ---- multiplayer: lobby ----------------------------------------------------
  const lobbyCodeEl = document.getElementById('lobby-code');
  const lobbyRosterEl = document.getElementById('lobby-roster');
  const lobbyHintEl = document.getElementById('lobby-hint');
  const joinInput = document.getElementById('join-code');
  const joinError = document.getElementById('join-error');

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
    joinError.textContent = 'CONNECTING…';
    joinInput.blur();
    lobbyLoadout = 1;
    uiMode = 'lobby';
    showScreen('lobby');
    lobbyCodeEl.textContent = 'ROOM ' + code;
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

  function leaveToTitle() {
    Net.leave();
    game.mode = 'idle';
    uiMode = 'title';
    showScreen('title');
    AudioSys.setEngine(0);
  }

  // ---- multiplayer: run start (host & client) --------------------------------
  function startHostRun() {
    const info = Net.hostStartGame();
    game.newRun(info.defs, info.localId);   // host owns the arena generation
    uiMode = 'playing';
    showScreen(null);
    AudioSys.play('deploy');
    hud.message('SECTOR 1 — SECURE ALL FLAGS', '#4fd6bb', 3);
    Net.broadcastLevel(game);               // ship the arena to clients
    netState.timer = 0; netState.snd = []; netState.bu = [];
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
    const advance = document.querySelector('#screen-clear .press-start');
    if (advance) advance.textContent = Net.role === 'client' ? 'WAITING FOR HOST…' : 'ENTER TO ADVANCE';
  }

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
  Net.cb.onCode = (code) => { if (uiMode === 'lobby') lobbyCodeEl.textContent = 'ROOM CODE  ' + code; };
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
    hud.message('SECTOR ' + game.level, '#4fd6bb', 2.5);
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
  const cam = { x: 0, y: 2.3, z: 0, yaw: 0, pitch: 0, fov: 1.22 };

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
      return;
    }
    const p = game.player;
    if (!p) return;
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
  function drawArena(src) {
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
      const mesh = o.type === 'pyramid' ? M.pyramid : M.block;
      renderer.draw(mesh, m4.trs(o.x, 0, o.z, 0, o.w, o.h, o.d), { tint: o.color });
    }

    for (const f of src.flags) {
      if (f.taken) continue;
      renderer.draw(M.flag, m4.trs(f.x, 0, f.z, f.spin, 1, 1, 1));
    }
  }

  function drawGame() {
    drawArena(game);

    for (const e of game.enemies) {
      const tint = e.hitFlash > 0 ? [1 + e.hitFlash * 2, 1 + e.hitFlash * 2, 1 + e.hitFlash * 2] : null;
      renderer.draw(TANK_MESH[e.type], m4.trs(e.x, 0, e.z, e.angle, 1, 1, 1), { unlit: true, tint });
    }

    // all co-op tanks; own tank only shown in chase cam (it's the camera in 1st person)
    for (const pl of game.players) {
      if (!pl.alive) continue;
      const isLocal = pl.id === game.localId;
      if (isLocal && !chaseCam) continue;
      const tint = PLAYER_TINTS[pl.colorIdx] || PLAYER_TINTS[0];
      renderer.draw(M.tankPlayer, m4.trs(pl.x, 0, pl.z, pl.angle, 1, 1, 1), { unlit: true, tint });
    }

    for (const pr of game.projectiles) {
      const mesh = pr.from === 'player' ? M.shotPlayer : M.shotEnemy;
      renderer.draw(mesh, m4.trs(pr.x, pr.y, pr.z, pr.angle, 1, 1, 1), { unlit: true });
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
        if (Input.consume('Enter') || Input.consume('Space') || Input.consume('AnyTouch')) {
          uiMode = 'setup';
          showScreen('setup');
          AudioSys.play('select');
        }
        break;

      case 'setup':
        if (Input.consume('Digit1')) selectLoadout(0);
        if (Input.consume('Digit2')) selectLoadout(1);
        if (Input.consume('Digit3')) selectLoadout(2);
        if (Input.consume('Enter')) startRun();
        if (Input.consume('Escape')) { uiMode = 'title'; showScreen('title'); }
        break;

      case 'lobby':
        if (Input.consume('Digit1')) selectLobbyLoadout(0);
        if (Input.consume('Digit2')) selectLobbyLoadout(1);
        if (Input.consume('Digit3')) selectLobbyLoadout(2);
        if (Net.role === 'host' && Input.consume('Enter')) startHostRun();
        if (Input.consume('Escape')) leaveToTitle();
        break;

      case 'join':
        // handled by the input field's own key listener; nothing here
        break;

      case 'playing':
        if (Input.consume('KeyC')) chaseCam = !chaseCam;
        if (Net.role === 'solo' && (Input.consume('KeyP') || Input.consume('Escape'))) {
          uiMode = 'paused';
          showScreen('pause');
          AudioSys.setEngine(0);
        }
        break;

      case 'paused':
        if (Input.consume('KeyP') || Input.consume('Escape')) {
          uiMode = 'playing';
          showScreen(null);
        }
        if (Input.consume('KeyQ')) leaveToTitle();
        break;

      case 'levelclear':
        if (Net.role !== 'client' &&
            (Input.consume('Enter') || Input.consume('Space') || Input.consume('AnyTouch'))) {
          game.nextLevel();
          uiMode = 'playing';
          showScreen(null);
          hud.message('SECTOR ' + game.level, '#4fd6bb', 2.5);
          if (Net.role === 'host') { Net.broadcastLevel(game); netState.timer = 0; netState.snd = []; netState.bu = []; }
        }
        break;

      case 'gameover':
        if (Input.consume('Enter') || Input.consume('Space') || Input.consume('AnyTouch')) {
          leaveToTitle();
        }
        break;
    }
  }

  // ---- local input + engine audio --------------------------------------------
  function feedLocalInput() {
    const ax = Input.axis();
    const lp = game.player;
    if (lp && lp.input) { lp.input.turn = ax.turn; lp.input.drive = ax.drive; lp.input.fire = ax.fire; }
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
    for (const f of game.flags) f.spin += dt * 2.2;
    for (const u of game.powerups) { u.spin += dt * 2.5; u.bob += dt * 3; }
  }

  // host: throttle snapshots to ~30 Hz, but never drop transient sounds/bursts
  const netState = { timer: 0, snd: [], bu: [] };
  function hostNetTick(dt) {
    if (game.frameSounds.length) for (const s of game.frameSounds) netState.snd.push(s);
    if (game.frameBursts.length) for (const b of game.frameBursts) netState.bu.push(b);
    netState.timer += dt;
    if (netState.timer >= 1 / 30) {
      netState.timer = 0;
      Net.broadcastState(game, netState.snd, netState.bu);
      netState.snd = []; netState.bu = [];
    }
  }

  // ---- main loop -------------------------------------------------------------------
  let lastT = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - lastT) / 1000;
    lastT = now;
    dt = Math.min(dt, 0.05);

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
