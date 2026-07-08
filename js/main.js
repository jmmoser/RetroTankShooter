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
    tankRusher: renderer.createMesh(Geometry.tankSolid([1.0, 0.28, 0.5])),
    tankPlayer: renderer.createMesh(Geometry.tankSolid(Geometry.C.hullPlayer)),
    shotPlayer: renderer.createMesh(Geometry.shot(Geometry.C.shotPlayer)),
    shotEnemy: renderer.createMesh(Geometry.shot(Geometry.C.shotEnemy)),
    shotNade: renderer.createMesh(Geometry.shot(Geometry.C.shotNade)),
    shard: renderer.createMesh(Geometry.shard()),
    depot: renderer.createMesh(Geometry.depot()),
    powerup: renderer.createMesh(Geometry.powerup()),
    mine: renderer.createMesh(Geometry.mine()),
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
  const TANK_MESH = { drone: M.tankDrone, hunter: M.tankHunter, sniper: M.tankSniper, phantom: M.tankPhantom, rusher: M.tankRusher };

  // deuteranopia-safe hull palette, baked as a second mesh set and swapped
  // live by the COLORBLIND HULLS setting
  const CB_HULLS = {
    drone: [1.0, 0.55, 0.10],
    hunter: [1.0, 0.93, 0.25],
    sniper: [0.30, 0.55, 1.0],
    phantom: [0.93, 0.97, 1.0],
    rusher: [1.0, 0.45, 0.85],
  };
  const TANK_MESH_CB = {};
  for (const k in CB_HULLS) TANK_MESH_CB[k] = renderer.createMesh(Geometry.tankSolid(CB_HULLS[k]));
  function tankMeshFor(type) {
    const set = Settings.get('colorblind') ? TANK_MESH_CB : TANK_MESH;
    return set[type] || TANK_MESH.drone;
  }

  // ---- live settings ---------------------------------------------------------
  function applySettings() {
    AudioSys.setVolume(Settings.get('volume') / 10);
    AudioSys.setMusicVolume(Settings.get('music') / 10);
    document.getElementById('crt').style.display = Settings.get('crt') ? '' : 'none';
    renderer.setGlow(Settings.get('glow'));
  }
  Settings.onChange = () => { applySettings(); renderSettingVals(); };
  applySettings();

  // ---- ui state -------------------------------------------------------------
  // title | setup | lobby | join | playing | levelclear | gameover | paused
  // | settings | records | versusover
  let uiMode = 'title';
  let loadoutIndex = 1;   // solo loadout
  let lobbyLoadout = 1;   // co-op loadout
  let startSector = 1;    // checkpoint start (setup screen)
  let chaseCam = false;
  let chaseCamUserSet = false;   // stop the touch default from fighting the C toggle
  let runRecorded = true; // guards Progress.recordRun against double counting
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
    settings: document.getElementById('screen-settings'),
    records: document.getElementById('screen-records'),
    vsover: document.getElementById('screen-vsover'),
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
    return { move, activate, reset, clear: () => setFocus(null, true), focusedId: () => (focused ? focused.id : null) };
  }

  const menus = {
    title: makeMenu(screens.title, 'bt-deploy'),
    setup: makeMenu(screens.setup, 'bt-launch'),
    lobby: makeMenu(screens.lobby, 'bt-lobby-launch'),
    join: makeMenu(screens.join, 'bt-join-connect'),
    clear: makeMenu(screens.clear, 'bt-continue'),
    over: makeMenu(screens.over, 'bt-retry'),
    pause: makeMenu(screens.pause, 'bt-resume'),
    settings: makeMenu(screens.settings, 'st-volume'),
    records: makeMenu(screens.records, 'bt-records-back'),
    vsover: makeMenu(screens.vsover, 'bt-vs-again'),
    // the TECH draft overlay lives outside the screens map: it can float
    // over live gameplay in co-op, so showScreen must never touch it
    draft: makeMenu(document.getElementById('screen-draft'), null),
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
    const daily = Progress.dailyBest();
    const streak = Progress.dailyStreak();
    const sep = ' · ';
    let txt = 'RANK ' + Progress.rank().name;
    if (highScore > 0) txt += sep + 'HIGH SCORE ' + String(highScore).padStart(7, '0');
    if (daily) txt += sep + 'DAILY BEST ' + String(daily.score).padStart(7, '0');
    if (streak > 0) txt += sep + 'STREAK ' + streak + ' DAY' + (streak > 1 ? 'S' : '');
    document.getElementById('title-high').textContent = txt;
    // the daily button doubles as the streak checkbox: tick it off every day
    document.getElementById('bt-daily').innerHTML =
      'DAILY OPS' + (daily ? ' ✓' : streak > 0 ? ' — KEEP THE STREAK' : '') +
      '<span class="mkey">D</span>';
  }
  updateTitleHigh();

  // ---- record chase ----------------------------------------------------------
  // The score you're chasing this run: today's best on a daily, the all-time
  // high otherwise. The HUD turns the score gold past it and the moment it
  // falls gets a one-time fanfare — beating your record should feel like an
  // event you witness, not a line you read after dying.
  let recordRef = 0, recordBeaten = false;

  function armRecordChase() {
    recordBeaten = false;
    const daily = game.dailySeed ? Progress.dailyBest() : null;
    recordRef = game.versus ? 0 : (game.dailySeed ? (daily ? daily.score : 0) : highScore);
    hud.recordScore = recordRef;
    if (typeof Medals !== 'undefined') Medals.drainRecent(); // stale earns from an aborted run
  }

  function checkRecordChase() {
    if (recordBeaten || recordRef <= 0 || game.versus) return;
    if (game.score > recordRef) {
      recordBeaten = true;
      hud.message(game.dailySeed ? '★ DAILY BEST BEATEN ★' : '★ RECORD BROKEN ★', '#ffd24a', 2.4);
      AudioSys.play('unlock');
    }
  }

  // ---- solo loadout select --------------------------------------------------
  function loadoutLocked(i) { return i === 3 && !Progress.marauderUnlocked(); }

  function selectLoadout(i) {
    if (loadoutLocked(i)) { AudioSys.play('comboBreak'); return; }
    loadoutIndex = i;
    document.querySelectorAll('.loadout').forEach((el) => {
      el.classList.toggle('selected', parseInt(el.dataset.i, 10) === i);
    });
    AudioSys.play('select');
  }

  /* Arrow-key cycling that hops over a locked MARAUDER. */
  function cycleLoadout(dir) {
    let i = loadoutIndex;
    for (let k = 0; k < LOADOUTS.length; k++) {
      i = (i + dir + LOADOUTS.length) % LOADOUTS.length;
      if (!loadoutLocked(i)) break;
    }
    selectLoadout(i);
  }

  document.querySelectorAll('.loadout').forEach((el) => {
    el.addEventListener('click', () => {
      selectLoadout(parseInt(el.dataset.i, 10));
      AudioSys.resume();
    });
    el.addEventListener('dblclick', () => startRun());
  });

  // ---- checkpoint starts ------------------------------------------------------
  const btCheckpoint = document.getElementById('bt-checkpoint');
  function refreshCheckpointRow() {
    const cps = Progress.checkpoints();
    if (cps.indexOf(startSector) < 0) startSector = 1;
    btCheckpoint.classList.toggle('hidden', cps.length < 2);
    btCheckpoint.textContent = 'START SECTOR ' + startSector +
      (cps.length > 1 ? ' ▸' : '');
  }
  btCheckpoint.addEventListener('click', () => {
    AudioSys.resume(); AudioSys.play('select');
    const cps = Progress.checkpoints();
    startSector = cps[(cps.indexOf(startSector) + 1) % cps.length];
    refreshCheckpointRow();
  });

  function goSetup() {
    uiMode = 'setup';
    document.getElementById('loadout-marauder').classList.toggle('locked', loadoutLocked(3));
    if (loadoutLocked(3) && loadoutIndex === 3) selectLoadout(1);
    refreshCheckpointRow();
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
    closeDraft();
    runRecorded = false;
    game.newRun(loadoutIndex, null, { startLevel: startSector });
    armRecordChase();
    uiMode = 'playing';
    showScreen(null);
    AudioSys.play('deploy');
    hud.message('SECTOR ' + game.level + ' — SECURE ALL ZONES',
      game.bossLevel ? '#ff4a3c' : '#4fd6bb', 3);
  }

  // Daily ops: one seeded arena per UTC day, standard-issue VANGUARD for a
  // level playing field, result shareable from the game-over screen.
  function startDaily() {
    mobileImmersive();
    closeDraft();
    runRecorded = false;
    game.newRun(1, null, { dailySeed: Progress.todayKey() });
    armRecordChase();
    uiMode = 'playing';
    showScreen(null);
    AudioSys.play('deploy');
    hud.message('DAILY OPS ' + Progress.todayKey() + ' — SECURE ALL ZONES', '#ffd24a', 3);
  }

  /* Career-stat medals: checked whenever the record advances. Awards are
   * idempotent, so re-checking is free. */
  function checkCareerMedals() {
    if (typeof Medals === 'undefined') return;
    const st = Progress.get();
    if (st.kills >= 1) Medals.award('firstblood');
    if (st.kills >= 500) Medals.award('centurion');
    if (st.flags >= 100) Medals.award('flagday');
    if (st.games >= 25) Medals.award('veteran');
    if (st.warlords >= 1) Medals.award('giantkiller');
    if (Progress.dailyStreak() >= 3) Medals.award('streak3');
  }

  /* Fold the finished (or abandoned) run into the career record, once.
   * Returns what the run just earned: { marauder, rankUp, xpGained }. */
  function recordRunEnd() {
    if (runRecorded) return { marauder: false, rankUp: null, xpGained: 0 };
    runRecorded = true;
    const rankBefore = Progress.rank().name;
    const before = Progress.marauderUnlocked();
    // clients don't run the sim, so no per-run stats — but the synced score
    // still pays out XP: everyone's career moves every run
    const xpGained = Progress.recordRun(Net.role === 'client' ? null : game.runStats,
      game.level, game.score);
    checkCareerMedals();
    const rankAfter = Progress.rank().name;
    return {
      marauder: !before && Progress.marauderUnlocked(),
      rankUp: rankAfter !== rankBefore ? rankAfter : null,
      xpGained,
    };
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

  /* The shared tail of the game-over panel: promotion banner, medals earned
   * this run, and the XP bar with the distance to the next rank spelled out —
   * every death ends on a reason to relaunch. */
  function buildOverExtras(res) {
    let html = '', earned = false;
    if (res.rankUp) {
      html += `<br><span class="gold">&#9733; PROMOTED — ${res.rankUp} &#9733;</span>`;
      earned = true;
    }
    if (typeof Medals !== 'undefined') {
      for (const id of Medals.drainRecent()) {
        const def = MEDALS.find((m) => m.id === id);
        if (!def) continue;
        html += `<br><span class="gold">MEDAL EARNED — ${def.name}</span>`;
        earned = true;
      }
    }
    const r = Progress.rank();
    const span = r.nextAt ? r.nextAt - r.base : 1;
    const into = r.nextAt ? Math.min(span, r.xp - r.base) : 1;
    const pct = Math.round((into / span) * 100);
    html += `<div class="xp-row"><span>RANK — ${r.name}</span>` +
      `<span class="gold">+${res.xpGained} XP</span></div>` +
      `<div class="xp-bar"><div class="xp-fill" style="width:${pct}%"></div></div>` +
      `<div class="xp-next">${r.nextAt
        ? (r.nextAt - r.xp) + ' XP TO ' + r.nextName
        : 'MAX RANK — PHANTOM LEGEND'}</div>`;
    return { html, earned };
  }

  function gameOver() {
    closeDraft();
    uiMode = 'gameover';
    const res = recordRunEnd();
    const isHigh = recordHighScore();
    let earned = res.marauder || isHigh;
    let html =
      `FINAL SCORE <span class="gold">${game.score}</span><br>` +
      `SECTOR REACHED ${game.level}<br>` +
      (isHigh ? '<span class="gold">&#9733; NEW HIGH SCORE &#9733;</span>'
              : `HIGH SCORE ${highScore}`);
    // near-miss: name the gap while the itch to close it is strongest
    if (!isHigh && !game.dailySeed && highScore > 0 && game.score >= highScore * 0.8) {
      html += `<br><span class="gold">ONLY ${highScore - game.score} FROM YOUR RECORD</span>`;
    }
    if (game.dailySeed) {
      const wasBest = Progress.recordDaily(game.score, game.level);
      const best = Progress.dailyBest();
      const streak = Progress.recordDailyPlayed();
      earned = earned || wasBest;
      html += '<br>' + (wasBest
        ? '<span class="gold">&#9733; BEST DAILY RUN TODAY &#9733;</span>'
        : `TODAY'S BEST ${best ? best.score : 0}`);
      if (!wasBest && best && best.score > 0 && game.score >= best.score * 0.8) {
        html += `<br><span class="gold">ONLY ${best.score - game.score} FROM TODAY'S BEST</span>`;
      }
      html += `<br>DAILY STREAK ${streak.streak} DAY${streak.streak > 1 ? 'S' : ''}` +
        (streak.streak >= 2 ? ' <span class="gold">— ALIVE</span>' : '');
      checkCareerMedals();   // the streak may have just hit a medal threshold
      updateTitleHigh();
    }
    if (res.marauder) html += '<br><span class="gold">MARAUDER CHASSIS UNLOCKED</span>';
    const extras = buildOverExtras(res);
    earned = earned || extras.earned;
    html += extras.html;
    // let the gameOver sting finish before celebrating the gold-text lines
    if (earned) setTimeout(() => AudioSys.play('unlock'), 1100);
    document.getElementById('over-stats').innerHTML = html;
    document.getElementById('bt-share').classList.toggle('hidden', !game.dailySeed);
    shareBtn.textContent = 'COPY RESULT';
    configureOverButtons();
    showScreen('over');
  }

  // Wordle-style share card for the daily run.
  const shareBtn = document.getElementById('bt-share');
  shareBtn.addEventListener('click', () => {
    AudioSys.resume();
    const lines = [
      'PHANTOM ARENA — DAILY OPS ' + (game.dailySeed || Progress.todayKey()),
      'SCORE ' + game.score + ' · SECTOR ' + game.level,
    ];
    const streak = Progress.dailyStreak();
    if (streak > 1) lines.push('STREAK ' + streak + ' DAYS');
    if (/^https?:$/.test(location.protocol)) lines.push(location.origin + location.pathname);
    const done = () => { shareBtn.textContent = 'COPIED — SEND IT'; AudioSys.play('select'); };
    const fail = () => { shareBtn.textContent = 'COPY FAILED'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lines.join('\n')).then(done, fail);
    } else fail();
  });

  // ---- multiplayer: lobby ----------------------------------------------------
  const lobbyCodeEl = document.getElementById('lobby-code');
  const lobbyRosterEl = document.getElementById('lobby-roster');
  const lobbyHintEl = document.getElementById('lobby-hint');
  const lobbyCopyHintEl = document.getElementById('lobby-copy-hint');
  const lobbyLaunchBtn = document.getElementById('bt-lobby-launch');
  const joinInput = document.getElementById('join-code');
  const joinError = document.getElementById('join-error');
  let roomCode = '';

  // Clicking the room code shares an invite — the native share sheet where the
  // browser supports Web Share, clipboard copy otherwise. The invite is a full
  // ?join= link when hosted over http(s), just the code when running from file://.
  const canWebShare = typeof navigator.share === 'function';
  const COPY_HINT_DEFAULT = canWebShare
    ? 'CLICK CODE TO SHARE INVITE'
    : 'CLICK CODE TO COPY INVITE LINK';
  lobbyCodeEl.addEventListener('click', () => {
    if (!roomCode) return;
    AudioSys.resume();
    const isHttp = /^https?:$/.test(location.protocol);
    const invite = isHttp
      ? location.origin + location.pathname + '?join=' + roomCode
      : roomCode;
    const done = (msg) => {
      lobbyCopyHintEl.textContent = msg;
      AudioSys.play('select');
      setTimeout(() => { lobbyCopyHintEl.textContent = COPY_HINT_DEFAULT; }, 2500);
    };
    const copy = () => {
      const fail = () => { lobbyCopyHintEl.textContent = 'COPY FAILED — CODE IS ' + roomCode; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(invite).then(() => done('INVITE COPIED — SEND IT TO YOUR SQUAD'), fail);
      } else fail();
    };
    if (canWebShare) {
      const payload = { title: 'PHANTOM ARENA', text: 'JOIN MY SQUAD — ROOM ' + roomCode };
      if (isHttp) payload.url = invite;
      // A rejected share means the user dismissed the sheet (AbortError — leave
      // quietly) or the payload was unsupported — fall back to clipboard.
      navigator.share(payload).then(
        () => done('INVITE SENT — SQUAD UP'),
        (err) => { if (!err || err.name !== 'AbortError') copy(); },
      );
    } else copy();
  });

  function setRoomCode(code) {
    roomCode = code || '';
    lobbyCopyHintEl.textContent = COPY_HINT_DEFAULT;
    lobbyCopyHintEl.classList.toggle('hidden', !roomCode);
  }

  function selectLobbyLoadout(i) {
    if (loadoutLocked(i)) { AudioSys.play('comboBreak'); return; }
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

  function cycleLobbyLoadout(dir) {
    let i = lobbyLoadout;
    for (let k = 0; k < LOADOUTS.length; k++) {
      i = (i + dir + LOADOUTS.length) % LOADOUTS.length;
      if (!loadoutLocked(i)) break;
    }
    selectLobbyLoadout(i);
  }

  function refreshLobbyLocks() {
    document.querySelectorAll('#lobby-loadouts .ll').forEach((el) => {
      el.classList.toggle('locked', loadoutLocked(parseInt(el.dataset.i, 10)));
    });
  }

  // ---- lobby game mode (host picks, everyone sees) ---------------------------
  function updateModeRow() {
    const mode = Net.state.mode || 'coop';
    document.querySelectorAll('#lobby-mode .ll').forEach((el) => {
      el.classList.toggle('selected', el.dataset.mode === mode);
    });
    document.getElementById('lobby-head').textContent =
      mode === 'versus' ? 'VERSUS LOBBY' : 'CO-OP LOBBY';
  }
  document.querySelectorAll('#lobby-mode .ll').forEach((el) => {
    el.addEventListener('click', () => {
      if (Net.role !== 'host') return;   // clients just see the host's pick
      AudioSys.resume(); AudioSys.play('select');
      Net.hostSetMode(el.dataset.mode);
      updateModeRow();
      renderRoster(Net.state.roster);
    });
  });

  function renderRoster(roster) {
    lobbyRosterEl.innerHTML = roster.map((r, i) => {
      const lo = LOADOUTS[r.loadoutIndex] || LOADOUTS[1];
      const you = (Net.role === 'host' && i === 0) || (Net.role === 'client' && r.id === Net.state.id);
      return `<div class="roster-row"><span class="roster-dot c${i}"></span>` +
        `${r.name}${you ? ' <span class="roster-you">(YOU)</span>' : ''}` +
        `<span class="roster-lo">${lo.name}</span></div>`;
    }).join('');
    const versus = Net.state.mode === 'versus';
    if (Net.role === 'host') {
      if (versus) {
        lobbyHintEl.textContent = roster.length > 1
          ? 'ENTER TO LAUNCH — FIRST TO 10 KILLS'
          : 'VERSUS NEEDS AT LEAST 2 TANKS';
      } else {
        lobbyHintEl.textContent = roster.length > 1
          ? 'ENTER TO LAUNCH — ' + roster.length + ' TANKS READY'
          : 'WAITING FOR PLAYERS — ENTER TO LAUNCH SOLO';
      }
    } else {
      lobbyHintEl.textContent = 'WAITING FOR HOST TO LAUNCH…';
    }
    updateModeRow();
  }

  function enterLobbyAsHost() {
    AudioSys.resume();
    lobbyLoadout = 1;
    lobbyCodeEl.textContent = 'CREATING ROOM…';
    setRoomCode('');
    lobbyLaunchBtn.classList.remove('hidden');
    uiMode = 'lobby';
    showScreen('lobby');
    Net.hostCreate('PLAYER 1', lobbyLoadout);
    selectLobbyLoadout(1);
    refreshLobbyLocks();
    renderRoster(Net.state.roster);
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
    refreshLobbyLocks();
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
    closeDraft();
    recordRunEnd();
    Net.leave();
    setRoomCode('');
    game.mode = 'idle';
    uiMode = 'title';
    showScreen('title');
    AudioSys.setEngine(0);
  }

  // ---- multiplayer: run start (host & client) --------------------------------
  function startHostRun() {
    const versus = Net.state.mode === 'versus';
    if (versus && Net.state.roster.length < 2) {
      lobbyHintEl.textContent = 'VERSUS NEEDS AT LEAST 2 TANKS';
      return;
    }
    mobileImmersive();
    closeDraft();
    const info = Net.hostStartGame();
    runRecorded = versus;                   // versus matches stay out of career stats
    game.newRun(info.defs, info.localId, { versus });   // host owns the arena generation
    armRecordChase();
    uiMode = 'playing';
    showScreen(null);
    AudioSys.play('deploy');
    hud.message(versus ? 'VERSUS — FIRST TO 10 KILLS' : 'SECTOR 1 — SECURE ALL ZONES',
      versus ? '#ffd24a' : '#4fd6bb', 3);
    Net.broadcastLevel(game);               // ship the arena to clients
    netState.timer = 0; netState.snd = []; netState.bu = []; netState.de = [];
  }

  function startClientRun(defs, localId, mode) {
    // Build players locally but DON'T generate an arena — the host owns it and
    // streams it via 'lv' + 's' messages.
    const versus = mode === 'versus';
    game.players = defs.map((d, i) => game._makePlayer(d, i));
    game.localId = localId;
    game.player = game.players.find((p) => p.id === localId) || game.players[0];
    game.level = 1; game.score = 0;
    game.obstacles = []; game.flags = []; game.enemies = [];
    game.projectiles = []; game.powerups = []; game.particles = [];
    game.flashes = []; game.debris = []; game.depots = []; game.mines = [];
    game.boss = null; game.rings = []; game.pendingSpawns = [];
    game.bossLevel = false; game.alert = 0;
    game.combo = 0; game.comboT = 0; game.mult = 1;
    game.versus = versus; game.killCounts = {}; game.killTarget = 10;
    game.winnerId = null; game.dailySeed = null;
    game.runStats = { kills: 0, flags: 0, warlords: 0, bestMult: 1, localKills: 0, nadeKills: 0, mineKills: 0 };
    game.mode = 'playing';
    game._prevSh = null; game._prevAlive = null;  // reset damage-feedback tracking
    closeDraft();
    runRecorded = versus;
    armRecordChase();
    uiMode = 'playing';
    showScreen(null);
    AudioSys.play('deploy');
    hud.message(versus ? 'VERSUS — FIRST TO 10 KILLS' : 'CO-OP DEPLOYED — SECURE ALL ZONES',
      versus ? '#ffd24a' : '#4fd6bb', 3);
  }

  // ---- versus: match over ------------------------------------------------------
  function fillVsStandings(rows, localWon) {
    const head = document.getElementById('vs-head');
    head.textContent = localWon ? 'VICTORY' : 'DEFEAT';
    head.classList.toggle('red', !localWon);
    document.getElementById('vs-standings').innerHTML = rows.map((r) =>
      `<div class="roster-row"><span class="roster-dot c${r.ci}"></span>` +
      `${r.name}<span class="roster-lo">${r.kills} KILLS</span></div>`).join('');
    document.getElementById('bt-vs-again').classList.toggle('hidden', Net.role !== 'host');
    document.getElementById('vs-wait').classList.toggle('hidden', Net.role !== 'client');
  }

  function doVersusOver() {
    closeDraft();
    uiMode = 'versusover';
    const rows = game.players
      .map((p) => ({ id: p.id, name: p.name, kills: game.killCounts[p.id] || 0, ci: p.colorIdx || 0 }))
      .sort((a, b) => b.kills - a.kills);
    fillVsStandings(rows, game.winnerId === game.localId);
    showScreen('vsover');
    if (Net.role === 'host') {
      Net.broadcastState(game);
      Net.broadcastScreen({ s: 'vswin', winnerId: game.winnerId, standings: rows });
    }
  }

  function showClearStats() {
    // tease what's next: a WARLORD sector ahead is a reason to press ENTER
    const next = game.level + 1;
    const bossNext = next % BOSS_EVERY === 0;
    document.getElementById('clear-stats').innerHTML =
      `SECTOR ${game.level} SECURE<br>` +
      `BONUS <span class="gold">+${game.levelBonus}</span><br>` +
      `SCORE ${game.score}` +
      (bossNext ? `<br><span class="red">WARLORD SIGNATURE IN SECTOR ${next}</span>` : '');
    document.getElementById('bt-continue').classList.toggle('hidden', Net.role === 'client');
    document.getElementById('clear-wait').classList.toggle('hidden', Net.role !== 'client');
  }

  function advanceLevel() {
    if (uiMode !== 'levelclear' || Net.role === 'client') return;
    game.nextLevel();
    uiMode = 'playing';
    showScreen(null);
    hud.message('SECTOR ' + game.level, game.bossLevel ? '#ff4a3c' : '#4fd6bb', 2.5);
    if (!game.bossLevel) AudioSys.play('sectorStart'); // boss sectors get the alarm instead
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
    AudioSys.play('pause');
  }

  function resumeGame() {
    resetAbort();
    uiMode = 'playing';
    showScreen(null);
    AudioSys.play('select');
  }

  // Auto-pause a solo run when the tab is hidden — no cheap deaths while
  // you're on another tab, and web-game portals require this behavior.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && uiMode === 'playing' && Net.role === 'solo') pauseGame();
  });

  // ---- TECH draft overlay ------------------------------------------------------
  // In-run upgrade picks. Solo: the sim pauses while you choose (uiMode
  // 'draft'). Co-op: the fight doesn't pause — the overlay floats over live
  // gameplay (nonmodal) and you pick under fire. Clients get their offers
  // relayed from the host and answer with a 'pick' message.
  const draftEl = document.getElementById('screen-draft');
  const draftChoicesEl = document.getElementById('draft-choices');
  let draftOpen = false;

  function draftPick(id) {
    if (!draftOpen) return;
    if (Net.role === 'client') {
      Net.sendPick(id);
      AudioSys.play('powerup');
      closeDraft();
      return;
    }
    game.applyUpgrade(game.localId, id);
    const p = game.player;
    if (p && p.pendingOffers) buildDraft(normalizeOffers(p.pendingOffers)); // banked level
    else closeDraft();
  }

  /* Offers arrive as plain ids (local) or {id, c: current stacks} (relayed). */
  function normalizeOffers(offers) {
    return offers.map((o) => {
      if (typeof o === 'string') {
        const cur = (game.player && game.player.up && game.player.up[o]) || 0;
        return { id: o, c: cur };
      }
      return o;
    });
  }

  function buildDraft(offers) {
    draftChoicesEl.innerHTML = '';
    offers.forEach((o, i) => {
      const def = UPGRADES.find((u) => u.id === o.id);
      if (!def) return;
      const el = document.createElement('div');
      el.className = 'mbtn draft-choice';
      el.innerHTML = `<span class="draft-key">${i + 1}</span>` +
        `<span class="draft-name">${def.name}${o.c > 0 ? ` <span class="draft-stack">LV ${o.c + 1}</span>` : ''}</span>` +
        `<span class="draft-desc">${def.desc}</span>`;
      el.addEventListener('click', () => { AudioSys.resume(); draftPick(o.id); });
      draftChoicesEl.appendChild(el);
    });
    menus.draft.reset();
  }

  function openDraft(offers) {
    draftOpen = true;
    buildDraft(normalizeOffers(offers));
    if (Net.role === 'solo') {
      uiMode = 'draft';               // the war waits while you fit the new part
      draftEl.classList.remove('nonmodal');
    } else {
      draftEl.classList.add('nonmodal');
    }
    draftEl.classList.remove('hidden');
  }

  function closeDraft() {
    if (!draftOpen && draftEl.classList.contains('hidden')) return;
    draftOpen = false;
    draftEl.classList.add('hidden');
    if (uiMode === 'draft') uiMode = 'playing';
  }

  /* modal = solo (sim paused): Space may confirm. In co-op Space is the fire
   * key, so only digits / arrows+Enter / click / tap pick there. */
  function draftKeys(modal) {
    const list = Array.from(draftChoicesEl.querySelectorAll('.draft-choice'));
    for (let i = 0; i < list.length; i++) {
      if (Input.consume('Digit' + (i + 1))) { list[i].click(); return; }
    }
    const m = menus.draft;
    if (Input.consume('ArrowUp')) m.move(-1);
    if (Input.consume('ArrowDown')) m.move(1);
    if (Input.consume('Enter') || Input.consume('NumpadEnter') || (modal && Input.consume('Space'))) m.activate();
  }

  /* Host/solo, after each sim step: surface the local player's waiting draft
   * and relay remote players' offers (once each). */
  function checkDrafts() {
    if (game.versus || game.mode !== 'playing') return;
    for (const p of game.players) {
      if (!p.pendingOffers) continue;
      if (p.id === game.localId) {
        if (!draftOpen) openDraft(p.pendingOffers);
      } else if (Net.role === 'host' && !p.offersSent) {
        p.offersSent = true;
        Net.sendDraft(p.id, p.pendingOffers.map((id) => ({ id, c: p.up[id] || 0 })));
      }
    }
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
  Net.cb.onStart = (defs, localId, mode) => startClientRun(defs, localId, mode);
  Net.cb.onLevel = (msg) => {
    Net.applyLevel(game, msg);
    uiMode = 'playing';
    showScreen(null);
    if (game.versus) {
      hud.message('VERSUS — FIRST TO ' + game.killTarget + ' KILLS', '#ffd24a', 3);
    } else if (game.bossLevel) {
      hud.message('SECTOR ' + game.level + ' — WARLORD DETECTED', '#ff4a3c', 3.5);
      AudioSys.play('alarm');
    } else {
      hud.message('SECTOR ' + game.level, '#4fd6bb', 2.5);
      AudioSys.play('sectorStart');
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
      closeDraft();
      game.score = msg.score; game.level = msg.level;
      const res = recordRunEnd();
      const isHigh = recordHighScore();
      let html = `FINAL SCORE <span class="gold">${game.score}</span><br>` +
        `SECTOR REACHED ${game.level}` +
        (isHigh ? '<br><span class="gold">&#9733; NEW HIGH SCORE &#9733;</span>' : '');
      const extras = buildOverExtras(res);
      html += extras.html;
      if (isHigh || extras.earned || res.marauder) {
        setTimeout(() => AudioSys.play('unlock'), 1100);
      }
      document.getElementById('over-stats').innerHTML = html;
      document.getElementById('bt-share').classList.add('hidden');
      uiMode = 'gameover';
      configureOverButtons();
      showScreen('over');
    } else if (msg.s === 'vswin') {
      closeDraft();
      game.winnerId = msg.winnerId;
      uiMode = 'versusover';
      fillVsStandings(msg.standings || [], msg.winnerId === Net.state.id);
      showScreen('vsover');
    }
  };
  // TECH drafts over the wire: clients get offers relayed from the host's
  // sim and answer with a pick; the host validates and applies it.
  Net.cb.onDraft = (offers) => {
    if (Net.role === 'client' && uiMode === 'playing') openDraft(offers);
  };
  Net.cb.onPick = (peerId, id) => { game.applyUpgrade(peerId, id); };

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
    const shake = game.shake * (Settings.get('shake') / 10);
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

  // ---- dynamic lights ---------------------------------------------------------
  // Everything hot in the arena throws real light onto the ground and walls:
  // explosion flashes, shot tracers, pickups and the WARLORD core. The
  // renderer caps how many it takes, so sort by how much each one matters
  // (big + close beats small + far) before handing the list over.
  function shotColor(pr) {
    if (pr.kind === 'nade') return Geometry.C.shotNade;
    return pr.from === 'player' ? Geometry.C.shotPlayer : Geometry.C.shotEnemy;
  }

  function collectLights(src) {
    const lights = [];
    for (const f of (src.flashes || [])) {
      const k = f.life / f.max;
      const s = k * (0.9 + f.p * 0.13);
      lights.push({ x: f.x, y: f.y, z: f.z, radius: 7 + f.p * 1.5,
        r: f.c[0] * s, g: f.c[1] * s, b: f.c[2] * s });
    }
    for (const pr of src.projectiles) {
      const c = shotColor(pr);
      lights.push({ x: pr.x, y: pr.y || 1.5, z: pr.z, radius: 11,
        r: c[0] * 0.85, g: c[1] * 0.85, b: c[2] * 0.85 });
    }
    for (const u of src.powerups) {
      const t = POWERUP_TYPES[u.type].tint;
      lights.push({ x: u.x, y: 2.2, z: u.z, radius: 9,
        r: t[0] * 0.55, g: t[1] * 0.55, b: t[2] * 0.55 });
    }
    const b = src.boss;
    if (b && !b.dead) {
      lights.push(b.vulnerable
        ? { x: b.x, y: 5, z: b.z, radius: 28, r: 1.3, g: 0.3, b: 0.5 }
        : { x: b.x, y: 5, z: b.z, radius: 24, r: 0.25, g: 0.5, b: 1.0 });
    }
    lights.sort((a, c) =>
      (Math.hypot(a.x - cam.x, a.z - cam.z) / a.radius) -
      (Math.hypot(c.x - cam.x, c.z - cam.z) / c.radius));
    return lights;
  }

  // ---- scene rendering --------------------------------------------------------
  // The backdrop follows the camera (x/z only) so it never parallaxes closer:
  // ember horizon, black ridgelines, dead stars, and an eclipsed sun. The glow
  // breathes slowly and occasionally flares like distant sheet lightning.
  // Drawn back-to-front with the depth buffer out of the loop (nodepth): at
  // these distances 16-bit depth can't tell the layers apart and the eclipse
  // z-fights the dome, smearing dark patches across the corona.
  function drawSky() {
    const t = performance.now() / 1000;
    const n = Math.sin(t * 11.3) * Math.sin(t * 4.7) * Math.sin(t * 1.9);
    const flare = n > 0.9 ? (n - 0.9) * 5 : 0;
    const g = 0.85 + 0.15 * Math.sin(t * 0.43) + flare;
    const model = m4.translation(cam.x, 0, cam.z);
    renderer.draw(M.sky, model, { unlit: true, nofog: true, nodepth: true, tint: [g, g * 0.85, g * 0.85] });
    renderer.draw(M.stars, model, { unlit: true, nofog: true, nodepth: true, points: true });
    const rim = 0.8 + 0.2 * Math.sin(t * 0.9) + flare;
    renderer.draw(M.eclipse, model, { unlit: true, nofog: true, nodepth: true, tint: [rim, rim, rim] });
    renderer.draw(M.mountains, model, { unlit: true, nofog: true, nodepth: true, tint: [g, g, g] });
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

    const zt = performance.now() / 1000;
    for (const f of src.flags) {
      if (f.taken) continue;
      renderer.draw(M.flag, m4.trs(f.x, 0, f.z, f.spin, 1, 1, 1));
      // uplink zone: boundary ring on the ground, plus a growing progress
      // ring while the capture is being held — amber pulse when contested
      const cap = f.cap || 0;
      const hot = !!f.contested;
      const pulse = hot ? 0.75 + 0.25 * Math.sin(zt * 9) : 0.35 + 0.12 * Math.sin(zt * 2.5 + f.x);
      const bc = hot
        ? [1.0 * pulse, 0.75 * pulse, 0.2 * pulse]
        : [0.2 * pulse, 0.9 * pulse, 0.45 * pulse];
      renderer.draw(M.ring, m4.trs(f.x, 0.35, f.z, 0, CAP_RADIUS, 1, CAP_RADIUS),
        { tint: bc, unlit: true, additive: true });
      if (cap > 0.02) {
        renderer.draw(M.ring, m4.trs(f.x, 0.6, f.z, 0, CAP_RADIUS * cap, 1, CAP_RADIUS * cap),
          { tint: [0.3, 1.0, 0.55], unlit: true, additive: true });
      }
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
    renderer.setLights(collectLights(game));   // before any lit geometry draws
    drawArena(game);

    const now = performance.now();

    // last flags get a pillar of light: no more hunting the final objective
    const fl = game.flagsLeft();
    if (fl > 0 && fl <= 2) {
      const pulse = 0.55 + 0.45 * Math.sin(now / 180);
      for (const f of game.flags) {
        if (f.taken) continue;
        renderer.draw(M.beacon, m4.trs(f.x, 0, f.z, 0, 1, 1, 1),
          { tint: [0.25 * pulse, 1.0 * pulse, 0.5 * pulse], unlit: true, nofog: true, additive: true });
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
      // additive energy halo wrapped around the core
      renderer.draw(M.bossCore, m4.trs(b.x, 5.0, b.z, -ct * 0.9, 1.45, 1.45, 1.45),
        { tint: [coreTint[0] * 0.30, coreTint[1] * 0.30, coreTint[2] * 0.30], unlit: true, additive: true });
    }

    // expanding shockwave rings — hostile orange, squad discharges teal
    for (const r of game.rings) {
      const fade = Math.max(0.25, 1 - r.r / 190);
      const ours = r.from === 'player';
      const c1 = ours ? [0.3 * fade + 0.15, 1.0 * fade, 0.8 * fade] : [1 * fade + 0.3, 0.55 * fade, 0.2 * fade];
      const c2 = ours ? [0.2 * fade, 0.8 * fade, 0.65 * fade] : [0.8 * fade, 0.4 * fade, 0.15 * fade];
      renderer.draw(M.ring, m4.trs(r.x, 0.5, r.z, 0, r.r, 1, r.r),
        { tint: c1, unlit: true, additive: true });
      renderer.draw(M.ring, m4.trs(r.x, 1.6, r.z, 0, r.r * 0.985, 1, r.r * 0.985),
        { tint: c2, unlit: true, additive: true });
    }
    for (const e of game.enemies) {
      let tint = e.hitFlash > 0 ? [1 + e.hitFlash * 2, 1 + e.hitFlash * 2, 1 + e.hitFlash * 2] : null;
      // cloaked phantoms fade toward the void, with a faint shimmer
      const ck = e.cloak || 0;
      if (ck > 0.01 && e.hitFlash <= 0) {
        const v = Math.max(0.02, 1 - ck * (0.92 + 0.08 * Math.sin(now / 120)));
        tint = [v, v, v];
      } else if (e.type === 'rusher' && !tint) {
        // rushers strobe hot and fast — a fuse you can read at a glance
        const pu = 1 + 0.5 * (0.5 + 0.5 * Math.sin(now / 70));
        tint = [pu, pu * 0.8, pu * 0.9];
      } else if (e.elite && !tint) {
        // elites strobe white-hot so they read across the arena
        const pu = 1 + 0.25 * (0.5 + 0.5 * Math.sin(now / 150));
        tint = [pu, pu, pu];
      }
      const sc = (e.elite ? 1.18 : 1) * (e.type === 'rusher' ? 0.82 : 1);
      renderer.draw(tankMeshFor(e.type), m4.trs(e.x, 0, e.z, e.angle, sc, sc, sc), { tint });
    }

    // proximity mines: dim while arming, blinking hot once live
    for (const m of game.mines) {
      const armed = (m.arm || 0) <= 0;
      const blink = armed && Math.sin(now / 110) > 0;
      const tint = armed
        ? (blink ? [1.7, 0.55, 0.85] : [0.85, 0.28, 0.45])
        : [0.5, 0.55, 0.6];
      renderer.draw(M.mine, m4.trs(m.x, 0, m.z, 0, 1, 1, 1), { tint, unlit: armed });
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
      // additive halo + a fading tracer tail strung out behind the shot
      renderer.draw(mesh, m4.trs(pr.x, pr.y, pr.z, pr.angle, 1.8, 1.8, 1.8),
        { unlit: true, additive: true, tint: [0.30, 0.30, 0.30] });
      const bx = fwdX(pr.angle), bz = fwdZ(pr.angle);
      for (let k = 1; k <= 3; k++) {
        const g = 0.42 / k, s = 1 - k * 0.2;
        renderer.draw(mesh,
          m4.trs(pr.x - bx * k * 1.1, pr.y, pr.z - bz * k * 1.1, pr.angle, s, s, s),
          { unlit: true, additive: true, tint: [g, g, g] });
      }
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
      renderer.draw(M.powerup, m4.trs(u.x, y, u.z, -u.spin * 0.7, 1.35, 1.35, 1.35),
        { tint: [spec.tint[0] * 0.25, spec.tint[1] * 0.25, spec.tint[2] * 0.25], unlit: true, additive: true });
    }

    renderer.drawParticles(game.particles);
  }

  // ---- settings screen -----------------------------------------------------
  const SETTING_DEFS = [
    { key: 'volume', max: 10 },
    { key: 'music', max: 10 },
    { key: 'shake', max: 10 },
    { key: 'glow', bool: true },
    { key: 'crt', bool: true },
    { key: 'aimAssist', bool: true },
    { key: 'colorblind', bool: true },
  ];

  function renderSettingVals() {
    for (const d of SETTING_DEFS) {
      const el = document.getElementById('stv-' + d.key);
      if (!el) continue;
      const v = Settings.get(d.key);
      el.textContent = d.bool ? (v ? 'ON' : 'OFF') : v + '/' + d.max;
    }
  }
  renderSettingVals();

  function adjustSetting(key, dir, wrap) {
    const d = SETTING_DEFS.find((x) => x.key === key);
    if (!d) return;
    if (d.bool) {
      Settings.set(key, !Settings.get(key));
    } else {
      let v = Settings.get(key) + dir;
      if (wrap && v > d.max) v = 0;
      Settings.set(key, Math.max(0, Math.min(d.max, v)));
    }
    AudioSys.play('select');
    if (key === 'volume') AudioSys.play('fire');   // audible volume preview
  }

  for (const d of SETTING_DEFS) {
    const row = document.getElementById('st-' + d.key);
    row.addEventListener('click', () => { AudioSys.resume(); adjustSetting(d.key, 1, true); });
  }

  function adjustFocusedSetting(dir) {
    const id = menus.settings.focusedId();
    if (!id || id.indexOf('st-') !== 0) return;
    adjustSetting(id.slice(3), dir, false);
  }

  // ---- service record screen -------------------------------------------------
  function fillRecords() {
    const st = Progress.get();
    const daily = Progress.dailyBest();
    const cps = Progress.checkpoints();
    const r = Progress.rank();
    const streak = Progress.dailyStreak();
    const rows = [
      ['RANK', r.name],
      ['CAREER XP', r.xp + (r.nextAt ? ' / ' + r.nextAt : '')],
      ['MISSIONS FLOWN', st.games],
      ['HIGH SCORE', highScore],
      ['BEST SECTOR', st.bestSector],
      ['TANKS DESTROYED', st.kills],
      ['FLAGS SECURED', st.flags],
      ['WARLORDS DOWN', st.warlords],
      ['BEST COMBO', '×' + st.bestCombo],
      ['DAILY BEST TODAY', daily ? daily.score : '—'],
      ['DAILY STREAK', streak > 0 ? streak + ' DAY' + (streak > 1 ? 'S' : '') : '—'],
    ];
    const unlocks = [
      ['MARAUDER CHASSIS', Progress.marauderUnlocked() ? 'UNLOCKED' : 'DESTROY A WARLORD', Progress.marauderUnlocked()],
      ['CHECKPOINT STARTS', cps.length > 1 ? 'SECTOR ' + cps[cps.length - 1] : 'REACH SECTOR 6', cps.length > 1],
    ];
    const medalWall =
      `<div class="medal-head">MEDALS ${Medals.count()}/${MEDALS.length}</div>` +
      '<div class="medal-grid">' +
      MEDALS.map((m) =>
        `<div class="medal${Medals.has(m.id) ? ' earned' : ''}">` +
        `<div class="m-name">${m.name}</div><div class="m-how">${m.how}</div></div>`).join('') +
      '</div>';
    document.getElementById('records-list').innerHTML =
      rows.map(([k, v]) => `<div class="rec-row">${k}<span class="rec-val">${v}</span></div>`).join('') +
      unlocks.map(([k, v, done]) =>
        `<div class="rec-row rec-unlock">${k}<span class="rec-val${done ? ' done' : ''}">${v}</span></div>`).join('') +
      medalWall;
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
        if (Input.consume('KeyD')) { startDaily(); break; }
        menuKeys('title');
        break;

      case 'setup':
        if (Input.consume('Digit1')) selectLoadout(0);
        if (Input.consume('Digit2')) selectLoadout(1);
        if (Input.consume('Digit3')) selectLoadout(2);
        if (Input.consume('Digit4')) selectLoadout(3);
        if (Input.consume('ArrowLeft') || Input.consume('KeyA')) cycleLoadout(-1);
        if (Input.consume('ArrowRight') || Input.consume('KeyD')) cycleLoadout(1);
        menuKeys('setup');
        if (Input.consume('Escape')) { uiMode = 'title'; showScreen('title'); }
        break;

      case 'lobby':
        if (Input.consume('Digit1')) selectLobbyLoadout(0);
        if (Input.consume('Digit2')) selectLobbyLoadout(1);
        if (Input.consume('Digit3')) selectLobbyLoadout(2);
        if (Input.consume('Digit4')) selectLobbyLoadout(3);
        if (Input.consume('ArrowLeft') || Input.consume('KeyA')) cycleLobbyLoadout(-1);
        if (Input.consume('ArrowRight') || Input.consume('KeyD')) cycleLobbyLoadout(1);
        menuKeys('lobby');
        if (Input.consume('Escape')) leaveToTitle();
        break;

      case 'settings':
        if (Input.consume('ArrowLeft') || Input.consume('KeyA')) adjustFocusedSetting(-1);
        if (Input.consume('ArrowRight') || Input.consume('KeyD')) adjustFocusedSetting(1);
        menuKeys('settings');
        if (Input.consume('Escape')) { uiMode = 'title'; showScreen('title'); }
        break;

      case 'records':
        menuKeys('records');
        if (Input.consume('Escape')) { uiMode = 'title'; showScreen('title'); }
        break;

      case 'versusover':
        menuKeys('vsover');
        if (Input.consume('Escape')) leaveToTitle();
        break;

      case 'join':
        // while the field is focused its own listener handles keys; these only
        // fire if focus wandered off the input
        if (Input.consume('Enter')) submitJoin();
        if (Input.consume('Escape')) leaveToTitle();
        break;

      case 'playing':
        if (draftOpen) draftKeys(false);   // co-op: pick under fire
        if (Input.consume('cam')) { chaseCam = !chaseCam; chaseCamUserSet = true; }
        if (Input.consume('pause') || Input.consume('Escape')) {
          if (Net.role === 'solo') pauseGame();
          else hud.message('PAUSE UNAVAILABLE IN CO-OP', '#ffd24a', 1.6);
        }
        break;

      case 'draft':
        draftKeys(true);   // solo: the sim is paused while you choose
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
  bind('bt-daily', startDaily);
  bind('bt-host', enterLobbyAsHost);
  bind('bt-join', enterJoin);
  bind('bt-settings', () => { uiMode = 'settings'; renderSettingVals(); showScreen('settings'); });
  bind('bt-records', () => { uiMode = 'records'; fillRecords(); showScreen('records'); });
  bind('bt-settings-back', () => { uiMode = 'title'; showScreen('title'); });
  bind('bt-records-back', () => { uiMode = 'title'; showScreen('title'); });
  bind('bt-setup-back', () => { uiMode = 'title'; showScreen('title'); });
  bind('bt-launch', startRun);
  bind('bt-join-back', leaveToTitle);
  bind('bt-join-connect', submitJoin);
  bind('bt-lobby-leave', leaveToTitle);
  bind('bt-lobby-launch', () => { if (Net.role === 'host') startHostRun(); });
  bind('bt-continue', advanceLevel);
  bind('bt-retry', () => { if (game.dailySeed) startDaily(); else startRun(); });
  bind('bt-again', () => { if (Net.role === 'host') startHostRun(); });
  bind('bt-vs-again', () => { if (Net.role === 'host') startHostRun(); });
  bind('bt-vs-leave', leaveToTitle);
  bind('bt-loadout', goSetup);
  bind('bt-title', leaveToTitle);
  bind('bt-resume', resumeGame);

  // surface controller hotplug so players know the pad took
  window.addEventListener('gamepadconnected', () => hud.message('GAMEPAD CONNECTED', '#4fd6bb', 2));
  window.addEventListener('gamepaddisconnected', () => hud.message('GAMEPAD DISCONNECTED', '#ffd24a', 2));

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
      lp.input.mine = ax.mine;
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

  // soundtrack mood follows the screen: brooding loop under the menus, the
  // combat groove in the arena, the boss mix while a WARLORD is alive. The
  // intensity knob rides the alert level and combo heat.
  function updateMusic() {
    let mood = 'menu';
    // a solo TECH draft pauses the sim but shouldn't drop the combat groove
    if ((uiMode === 'playing' || uiMode === 'draft') && (game.mode === 'playing' || game.mode === 'dying')) {
      if (game.bossLevel && game.boss && !game.boss.dead) {
        mood = 'boss';
        AudioSys.setMusicIntensity(1);
      } else {
        mood = 'combat';
        AudioSys.setMusicIntensity(Math.max(game.alert || 0, Math.min(1, (game.combo || 0) / 6)));
      }
    }
    AudioSys.setMusicMood(mood);
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

    Input.pollGamepad();
    // gate matches the HUD's draw condition exactly: no invisible-but-live
    // controls during the death sequence or transitions
    Input.setPlayfieldActive(uiMode === 'playing' && game.mode === 'playing');
    handleScreens();

    if (uiMode === 'playing') {
      if (Net.role === 'client') {
        Net.sendInput(Input.axis());
        clientCosmetics(dt);
        // smooth remote motion between the host's 30 Hz snapshots
        if (game.mode === 'playing' || game.mode === 'dying') Net.clientInterpolate(game);
      } else {
        feedLocalInput();
        if (Net.role === 'host') Net.applyInputs(game);
        if (game.mode === 'playing') {
          game.update(dt);
          if (Net.role === 'host') hostNetTick(dt);
          if (game.mode === 'levelclear') enterLevelClear();
          else if (game.mode === 'versusover') doVersusOver();
          else checkDrafts();
        } else if (game.mode === 'dying') {
          game.updateDying(dt);
          if (Net.role === 'host') Net.broadcastState(game);
          if (game.mode === 'gameover') doGameOver();
        }
      }
    }

    if (uiMode === 'playing' && game.mode === 'playing') checkRecordChase();

    updateEngine();
    updateMusic();
    updateCamera(dt);
    renderer.beginFrame(cam);

    if (inMenu()) {
      renderer.setLights([]);   // no stale battle lights under the menus
      drawArena(demoGame);
      for (const f of demoGame.flags) f.spin += dt * 2.2;
    } else {
      drawGame();
    }
    renderer.endFrame();

    const showHud = (uiMode === 'playing' && game.mode === 'playing');
    hud.render(showHud ? game : null, dt);

    Input.clearFrame();
  }

  window.addEventListener('resize', () => { renderer.resize(); hud.resize(); });
  requestAnimationFrame(frame);

  // Offline PWA: cache-first service worker (no-op on file://)
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // exposed for automated testing / tinkering
  window.__PA = { game, hud, net: Net, getMode: () => uiMode };
})();
