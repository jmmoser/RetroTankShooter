/* Boot, screen flow, camera, scene rendering, main loop. */
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
    tankDrone: renderer.createMesh(Geometry.tank(Geometry.C.hullEnemy)),
    tankHunter: renderer.createMesh(Geometry.tank(Geometry.C.hullHunter)),
    tankSniper: renderer.createMesh(Geometry.tank(Geometry.C.hullSniper)),
    tankPlayer: renderer.createMesh(Geometry.tank(Geometry.C.hullPlayer)),
    shotPlayer: renderer.createMesh(Geometry.shot(Geometry.C.shotPlayer)),
    shotEnemy: renderer.createMesh(Geometry.shot(Geometry.C.shotEnemy)),
    powerup: renderer.createMesh(Geometry.powerup()),
  };
  const TANK_MESH = { drone: M.tankDrone, hunter: M.tankHunter, sniper: M.tankSniper };

  // ---- ui state -------------------------------------------------------------
  let uiMode = 'title'; // title | setup | playing | levelclear | gameover | paused
  let loadoutIndex = 1;
  let chaseCam = false;
  let highScore = 0;
  try { highScore = parseInt(localStorage.getItem('pa_high') || '0', 10) || 0; } catch (e) {}

  const screens = {
    title: document.getElementById('screen-title'),
    setup: document.getElementById('screen-setup'),
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

  function gameOver() {
    uiMode = 'gameover';
    const isHigh = game.score > highScore;
    if (isHigh) {
      highScore = game.score;
      try { localStorage.setItem('pa_high', String(highScore)); } catch (e) {}
      updateTitleHigh();
    }
    document.getElementById('over-stats').innerHTML =
      `FINAL SCORE <span class="gold">${game.score}</span><br>` +
      `SECTOR REACHED ${game.level}<br>` +
      (isHigh ? '<span class="gold">&#9733; NEW HIGH SCORE &#9733;</span>'
              : `HIGH SCORE ${highScore}`);
    showScreen('over');
  }

  // ---- title demo scene -----------------------------------------------------
  // generate a backdrop arena for the title/setup screens
  const demoGame = new Game(new HUD(document.createElement('canvas')));
  demoGame.player = { x: 0, z: 0, alive: false };
  demoGame._genObstacles(30);
  demoGame._genFlags(8);
  let demoT = 0;

  // ---- camera ---------------------------------------------------------------
  const cam = { x: 0, y: 2.3, z: 0, yaw: 0, pitch: 0, fov: 1.22 };

  function updateCamera(dt) {
    if (uiMode === 'title' || uiMode === 'setup') {
      demoT += dt * 0.12;
      cam.x = Math.cos(demoT) * 70;
      cam.z = Math.sin(demoT) * 70;
      cam.y = 26;
      cam.yaw = angleTo(0 - cam.x, 0 - cam.z); // look at origin
      cam.pitch = -0.32;
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

    // perimeter wall
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
      renderer.draw(TANK_MESH[e.type], m4.trs(e.x, 0, e.z, e.angle, 1, 1, 1), tint ? { tint } : undefined);
    }

    const p = game.player;
    if (p && p.alive && chaseCam) {
      renderer.draw(M.tankPlayer, m4.trs(p.x, 0, p.z, p.angle, 1, 1, 1));
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

      case 'playing':
        if (Input.consume('KeyC')) chaseCam = !chaseCam;
        if (Input.consume('KeyP') || Input.consume('Escape')) {
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
        if (Input.consume('KeyQ')) {
          uiMode = 'title';
          game.mode = 'idle';
          showScreen('title');
          AudioSys.setEngine(0);
        }
        break;

      case 'levelclear':
        if (Input.consume('Enter') || Input.consume('Space') || Input.consume('AnyTouch')) {
          game.nextLevel();
          uiMode = 'playing';
          showScreen(null);
          hud.message('SECTOR ' + game.level, '#4fd6bb', 2.5);
        }
        break;

      case 'gameover':
        if (Input.consume('Enter') || Input.consume('Space') || Input.consume('AnyTouch')) {
          uiMode = 'title';
          showScreen('title');
        }
        break;
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
      if (game.mode === 'playing') {
        game.update(dt);
        if (game.mode === 'levelclear') {
          uiMode = 'levelclear';
          document.getElementById('clear-stats').innerHTML =
            `SECTOR ${game.level} SECURE<br>` +
            `BONUS <span class="gold">+${game.levelBonus}</span><br>` +
            `SCORE ${game.score}`;
          showScreen('clear');
        }
      } else if (game.mode === 'dying') {
        game.updateDying(dt);
        if (game.mode === 'gameover') gameOver();
      }
    }

    updateCamera(dt);
    renderer.beginFrame(cam);

    if (uiMode === 'title' || uiMode === 'setup') {
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
  window.__PA = { game, hud, getMode: () => uiMode };
})();
