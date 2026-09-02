/* Keyboard + mouse + touch + gamepad input.
 *
 * Gamepad (standard layout): left stick drives and steers, A/RT fire,
 * B/RB grenade, X vent, LB mine, LT boost, Y camera, Start pause. The d-pad
 * and stick also navigate menus by synthesizing the same virtual key edges
 * the keyboard uses, so every screen works from the couch.
 *
 * Keys are REBINDABLE: the defaults below seed a table that the CONTROLS
 * screen edits (captureNext / rebind / resetBinds) and that persists under
 * pa_binds. Menu hotkeys stay fixed — they are labelled on the buttons.
 *
 * Touch is a first-class scheme, not a fallback:
 *  - A floating joystick spawns wherever the left thumb lands and stays
 *    anchored there; overshoot past the rim just clamps, so the base never
 *    drifts across the screen mid-maneuver.
 *  - The stick is view-relative: push where you want to go. Forward arcs
 *    drive+steer, sideways pivots in place, and the whole back half
 *    reverses — the stick's side always sets the hull's turn direction.
 *  - The right side of the screen is hold-to-fire; on-screen buttons cover
 *    grenade, boost, camera and pause.
 *  - Pointer Events with per-pointer ownership: each control is owned by the
 *    pointer that pressed it, so multi-touch never glitches.
 */
const Input = (() => {
  const keys = {};
  const pressed = {}; // edge-triggered, cleared each frame by consume
  let fireHeld = false;
  let nadeHeld = false;
  let mineHeld = false;

  // ---- bindings ----------------------------------------------------------
  // action -> [primary code, alternate code]. Rebinding replaces the primary
  // and steals the code from whichever action held it.
  const DEFAULT_BINDS = {
    forward: ['KeyW', 'ArrowUp'],
    back:    ['KeyS', 'ArrowDown'],
    left:    ['KeyA', 'ArrowLeft'],
    right:   ['KeyD', 'ArrowRight'],
    fire:    ['Space'],
    nade:    ['KeyX', 'ControlLeft'],
    mine:    ['KeyV'],
    vent:    ['KeyR'],
    boost:   ['ShiftLeft', 'ShiftRight'],
    cam:     ['KeyC'],
    pause:   ['KeyP'],
  };
  const ACTIONS = Object.keys(DEFAULT_BINDS);
  const ACTION_LABELS = {
    forward: 'DRIVE FORWARD', back: 'REVERSE / BRAKE', left: 'STEER LEFT', right: 'STEER RIGHT',
    fire: 'FIRE CANNON', nade: 'GRENADE', mine: 'DROP MINE', vent: 'VENT HEAT',
    boost: 'BOOST', cam: 'CAMERA', pause: 'PAUSE',
  };
  let binds = {};
  let KEYMAP = {};   // code -> action, rebuilt from binds

  function cloneDefaults() {
    const o = {};
    for (const a of ACTIONS) o[a] = DEFAULT_BINDS[a].slice();
    return o;
  }
  function rebuildMap() {
    KEYMAP = {};
    for (const a of ACTIONS) for (const c of binds[a]) if (c) KEYMAP[c] = a;
  }
  function loadBinds() {
    binds = cloneDefaults();
    try {
      const raw = JSON.parse((typeof Store !== 'undefined' ? Store.get('pa_binds') : localStorage.getItem('pa_binds')) || 'null');
      if (raw && typeof raw === 'object') {
        for (const a of ACTIONS) {
          if (!Array.isArray(raw[a])) continue;
          const list = raw[a].filter((c) => typeof c === 'string' && /^[A-Za-z0-9]{1,24}$/.test(c)).slice(0, 2);
          if (list.length) binds[a] = list;
        }
      }
    } catch (e) {}
    rebuildMap();
  }
  function saveBinds() {
    const json = JSON.stringify(binds);
    if (typeof Store !== 'undefined') Store.set('pa_binds', json);
    else { try { localStorage.setItem('pa_binds', json); } catch (e) {} }
  }
  loadBinds();

  /* Bind `code` as the primary key for `action`, keeping its alternate; the
   * code is taken away from any other action that had it (that action's
   * alternate moves up, or it is left unbound). Escape is never bindable. */
  function rebind(action, code) {
    if (!binds[action] || typeof code !== 'string' || code === 'Escape') return false;
    for (const a of ACTIONS) binds[a] = binds[a].filter((c) => c !== code);
    const list = binds[action];
    binds[action] = [code].concat(list.slice(1, 2));
    rebuildMap();
    saveBinds();
    return true;
  }
  function resetBinds() { binds = cloneDefaults(); rebuildMap(); saveBinds(); }
  function getBinds() { const o = {}; for (const a of ACTIONS) o[a] = binds[a].slice(); return o; }

  /* Human name for a KeyboardEvent.code. */
  function labelFor(code) {
    if (!code) return '—';
    const SPECIAL = {
      Space: 'SPACE', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
      ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT', ControlLeft: 'L CTRL', ControlRight: 'R CTRL',
      AltLeft: 'L ALT', AltRight: 'R ALT', Enter: 'ENTER', Tab: 'TAB', Backspace: 'BKSP',
      CapsLock: 'CAPS', Escape: 'ESC',
    };
    if (SPECIAL[code]) return SPECIAL[code];
    let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
    m = /^Digit(\d)$/.exec(code); if (m) return m[1];
    m = /^Numpad(.+)$/.exec(code); if (m) return 'NUM ' + m[1].toUpperCase();
    return code.toUpperCase();
  }

  // capture mode: the next keydown is handed to `cb` instead of the game
  let captureCb = null;
  function captureNext(cb) { captureCb = typeof cb === 'function' ? cb : null; }
  function capturing() { return !!captureCb; }

  function typingInField(e) {
    const el = e.target;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  window.addEventListener('keydown', (e) => {
    if (typingInField(e)) return; // let text fields (e.g. room code) receive keys
    if (captureCb) {
      // a rebind capture eats everything except Escape (which cancels)
      e.preventDefault();
      if (e.repeat) return;
      const cb = captureCb;
      captureCb = null;
      cb(e.code === 'Escape' ? null : e.code);
      return;
    }
    if (e.repeat) {
      if (KEYMAP[e.code]) e.preventDefault();
      return;
    }
    AudioSys.resume();
    const action = KEYMAP[e.code];
    if (action) {
      keys[action] = true;
      pressed[action] = true;
      e.preventDefault();
    }
    pressed[e.code] = true;
  });

  window.addEventListener('keyup', (e) => {
    // always clear held state — swallowing keyup while a text field had focus
    // (e.g. releasing W inside the join-code input) left the key stuck held
    const action = KEYMAP[e.code];
    if (action) {
      keys[action] = false;
      if (!typingInField(e)) e.preventDefault();
    }
  });

  // Mouse buttons ride the Pointer Events stream (pointerType 'mouse'), so
  // the compatibility mouse events browsers synthesize after taps are simply
  // never listened to — no double-fire, no timing heuristics. Tracking the
  // buttons bitmask (rather than pointerdown/up alone) keeps chorded input
  // correct: pressing right while left is held arrives as a pointermove.
  function mouseButtons(e) {
    const b = e.buttons | 0;
    fireHeld = !!(b & 1);
    nadeHeld = !!(b & 2);
    mineHeld = !!(b & 4);   // middle button drops a mine
  }
  // text fields keep their menu (right-click -> Paste is how room codes arrive)
  window.addEventListener('contextmenu', (e) => { if (!typingInField(e)) e.preventDefault(); });

  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    fireHeld = false;
    nadeHeld = false;
    mineHeld = false;
    releaseAllTouch();
    // gamepad state is only refreshed by rAF polling, which stops while the
    // tab is hidden — without this a held stick/trigger stays "on" for the
    // whole background stretch (the co-op host keeps simulating it)
    pad.turn = 0;
    pad.drive = 0;
    pad.fire = pad.nade = pad.mine = pad.boost = pad.vent = false;
  });

  // ---- touch state ----------------------------------------------------------

  const STICK_MAX = 64;   // stick travel radius, CSS px
  const STICK_DEAD = 0.14;

  const touch = {
    mode: !!(window.matchMedia && matchMedia('(pointer: coarse)').matches),
    enabled: false,       // true only while the playfield has control (set by main.js)
    stick: { id: null, baseX: 0, baseY: 0, dx: 0, dy: 0, mag: 0, rel: 0 },
    fireIds: new Set(),   // pointers holding fire (right-zone or FIRE button)
    buttons: [],
  };

  // env(safe-area-inset-*) isn't readable from JS directly; style.css copies
  // it into custom properties we can read here.
  let safe = { t: 0, r: 0, b: 0, l: 0 };
  function readSafeArea() {
    try {
      const cs = getComputedStyle(document.documentElement);
      safe = {
        t: parseFloat(cs.getPropertyValue('--sa-t')) || 0,
        r: parseFloat(cs.getPropertyValue('--sa-r')) || 0,
        b: parseFloat(cs.getPropertyValue('--sa-b')) || 0,
        l: parseFloat(cs.getPropertyValue('--sa-l')) || 0,
      };
    } catch (e) {}
  }

  // Stable object handed to the HUD every frame for drawing the controls.
  const ui = {
    mode: touch.mode,
    enabled: false,
    stick: touch.stick,
    stickMax: STICK_MAX,
    buttons: touch.buttons,
    restX: 0, restY: 0,   // ghost position for the idle stick hint
  };

  function layoutButtons() {
    readSafeArea();
    const w = window.innerWidth, h = window.innerHeight;
    const u = Math.max(0.75, Math.min(1.25, Math.min(w, h) / 400));
    const right = w - safe.r, bottom = h - safe.b;
    // resizes (rotation, browser chrome collapse) must not drop a held button
    const heldByKey = {};
    for (const b of touch.buttons) if (b.id !== null) heldByKey[b.key] = b.id;
    touch.buttons.length = 0;
    touch.buttons.push(
      { key: 'fire',  label: 'FIRE',  x: right - 84 * u,  y: bottom - 100 * u, r: 48 * u },
      { key: 'nade',  label: 'NADE',  x: right - 180 * u, y: bottom - 54 * u,  r: 32 * u },
      { key: 'mine',  label: 'MINE',  x: right - 262 * u, y: bottom - 40 * u,  r: 26 * u },
      { key: 'vent',  label: 'VENT',  x: right - 172 * u, y: bottom - 128 * u, r: 27 * u },
      { key: 'boost', label: 'BOOST', x: right - 60 * u,  y: bottom - 210 * u, r: 32 * u },
      { key: 'cam',   label: 'CAM',   x: right - 100 * u, y: safe.t + 32 * u,  r: 24 * u },
      { key: 'pause', label: 'II',    x: right - 40 * u,  y: safe.t + 32 * u,  r: 24 * u },
    );
    for (const b of touch.buttons) b.id = b.key in heldByKey ? heldByKey[b.key] : null;
    ui.restX = safe.l + 110 * u;
    ui.restY = bottom - 120 * u;
  }
  layoutButtons();
  window.addEventListener('resize', layoutButtons);

  function buttonAt(x, y) {
    for (const b of touch.buttons) {
      if (Math.hypot(x - b.x, y - b.y) <= b.r + 14) return b; // generous hit slop
    }
    return null;
  }

  function buttonHeld(key) {
    for (const b of touch.buttons) if (b.key === key && b.id !== null) return true;
    return false;
  }

  function rumbleAllowed() {
    try { return typeof Settings === 'undefined' || Settings.get('rumble') !== false; } catch (e) { return true; }
  }

  /* Phone haptics (touch mode only) — and, when a pad is connected, the same
   * call rumbles it. Both honour the RUMBLE setting. */
  function vibrate(ms) {
    if (!rumbleAllowed()) return;
    if (touch.mode && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} }
    if (pad.connected) rumble(0.5, 0.8, ms);
  }

  /* Gamepad rumble via the (still-prefixed-in-spirit) vibrationActuator:
   * strong/weak 0..1, duration in ms. Silently a no-op where unsupported. */
  let rumbleUntil = 0;
  function rumble(strong, weak, ms) {
    if (!rumbleAllowed()) return;
    const act = pad.actuator;
    if (!act || typeof act.playEffect !== 'function') return;
    const now = performance.now();
    // don't let a weak buzz cut a big one short
    if (now < rumbleUntil && strong < pad.rumbleStrong) return;
    pad.rumbleStrong = strong;
    rumbleUntil = now + ms;
    try {
      const p = act.playEffect('dual-rumble', {
        startDelay: 0, duration: Math.max(10, Math.min(1000, ms | 0)),
        strongMagnitude: Math.max(0, Math.min(1, strong)), weakMagnitude: Math.max(0, Math.min(1, weak)),
      });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  // Last input wins: a touch turns the touch UI on, a mouse press on a
  // fine-pointer machine turns it back off — so one stray tap on a
  // touchscreen laptop can't hijack a keyboard/mouse session for good.
  const COARSE_PRIMARY = touch.mode;
  function setTouchMode(on) {
    if (touch.mode === on) return;
    touch.mode = on;
    ui.mode = on;
    document.body.classList.toggle('touch-ui', on);
    if (!on) releaseAllTouch();
  }
  if (touch.mode) document.body.classList.add('touch-ui');

  function resetStick() {
    const s = touch.stick;
    s.id = null; s.dx = 0; s.dy = 0; s.mag = 0; s.rel = 0;
  }

  function releasePointer(id) {
    if (touch.stick.id === id) resetStick();
    touch.fireIds.delete(id);
    for (const b of touch.buttons) if (b.id === id) b.id = null;
  }

  function releaseAllTouch() {
    resetStick();
    touch.fireIds.clear();
    for (const b of touch.buttons) b.id = null;
  }

  function moveStick(x, y) {
    const s = touch.stick;
    let dx = x - s.baseX, dy = y - s.baseY;
    let d = Math.hypot(dx, dy);
    if (d > STICK_MAX) {
      // clamp at the rim — the base stays where the thumb landed
      const k = STICK_MAX / d;
      dx *= k;
      dy *= k;
      d = STICK_MAX;
    }
    s.dx = dx;
    s.dy = dy;
    const raw = d / STICK_MAX;
    const m = raw <= STICK_DEAD ? 0 : (raw - STICK_DEAD) / (1 - STICK_DEAD);
    s.mag = Math.pow(m, 1.4);                       // ease-in response curve
    s.rel = d > 0.001 ? Math.atan2(dx, -dy) : 0;    // 0 = up/forward, + = right
  }

  function onPointerDown(e) {
    AudioSys.resume();
    if (e.pointerType === 'mouse') {
      if (!COARSE_PRIMARY) setTouchMode(false);
      mouseButtons(e);
      return;
    }
    setTouchMode(true);
    if (!touch.enabled) return;                                  // menus: DOM handles it
    // overlays keep their DOM taps: screens, and the update toast (which can
    // appear mid-run — swallowing its pointerdown made it untappable exactly
    // when "tap to restart" matters)
    if (e.target && e.target.closest && e.target.closest('.screen, .update-toast, .sim-toast')) return;
    e.preventDefault();
    const x = e.clientX, y = e.clientY;

    const btn = buttonAt(x, y);
    if (btn) {
      if (btn.id !== null) return;   // already held by another finger
      btn.id = e.pointerId;
      vibrate(10);
      if (btn.key === 'fire') touch.fireIds.add(e.pointerId);
      else if (btn.key === 'cam') pressed['cam'] = true;
      else if (btn.key === 'pause') pressed['pause'] = true;
      return;
    }

    if (x < window.innerWidth * 0.55) {
      // spawn the stick exactly under the thumb — never pre-deflected. A
      // second left-half touch while the stick is owned is a palm brush or
      // regrip, not a command: ignore it rather than let it fall to fire.
      if (touch.stick.id === null) {
        const s = touch.stick;
        s.id = e.pointerId;
        s.baseX = x;
        s.baseY = y;
        s.dx = 0; s.dy = 0; s.mag = 0; s.rel = 0;
      }
    } else {
      // anywhere else on the right half is hold-to-fire
      touch.fireIds.add(e.pointerId);
    }
  }

  function onPointerMove(e) {
    if (e.pointerType === 'mouse') { mouseButtons(e); return; }
    if (touch.stick.id === e.pointerId) moveStick(e.clientX, e.clientY);
  }

  function onPointerUp(e) {
    if (e.pointerType === 'mouse') { mouseButtons(e); return; }
    releasePointer(e.pointerId);
  }

  window.addEventListener('pointerdown', onPointerDown, { passive: false });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });
  window.addEventListener('pointercancel', onPointerUp, { passive: true });

  // ---- gamepad ---------------------------------------------------------------
  // Polled once per frame by main.js (the Gamepad API has no hold events).
  // Held actions feed axis(); momentary ones synthesize the same virtual key
  // edges the keyboard produces, so menus and screen flow need no new code.

  const DEADZONES = [0.10, 0.18, 0.26, 0.34, 0.42];   // the DEADZONE setting indexes this
  const pad = {
    connected: false,
    index: -1,         // which slot we read; the last pad that moved wins
    actuator: null,
    rumbleStrong: 0,
    turn: 0, drive: 0,
    fire: false, nade: false, mine: false, boost: false, vent: false,
    prev: [],          // previous frame's button states, for edge detection
    prevB: false,
    prevStickX: 0, prevStickY: 0,
  };

  function padDead() {
    try {
      if (typeof Settings !== 'undefined') {
        const i = Settings.get('deadzone');
        if (typeof i === 'number' && DEADZONES[i] != null) return DEADZONES[i];
      }
    } catch (e) {}
    return DEADZONES[1];
  }

  /* Radial deadzone: the dead region is a disc, not a square — a per-axis
   * deadzone made diagonals notch and a slight forward push while steering
   * hard read as zero throttle. Returns [x, y] rescaled to the live range. */
  function padStick(gp, ix, iy) {
    const x = gp.axes[ix] || 0, y = gp.axes[iy] || 0;
    const dead = padDead();
    const m = Math.hypot(x, y);
    if (m < dead) return [0, 0];
    const k = Math.min(1, (m - dead) / (1 - dead)) / m;
    return [x * k, y * k];
  }

  function padActive(gp) {
    if (!gp || !gp.connected) return false;
    for (const b of gp.buttons) if (b && b.pressed) return true;
    for (let i = 0; i < Math.min(4, gp.axes.length); i++) if (Math.abs(gp.axes[i]) > 0.5) return true;
    return false;
  }

  function pollGamepad() {
    let gp = null;
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      // the pad that was last touched is the one in someone's hands — a
      // dormant wheel in slot 0 must not shadow the controller in slot 1
      let first = null;
      for (let i = 0; i < pads.length; i++) {
        const g = pads[i];
        if (!g || !g.connected) continue;
        if (!first) first = g;
        if (padActive(g)) { pad.index = i; gp = g; break; }
      }
      if (!gp) gp = (pad.index >= 0 && pads[pad.index] && pads[pad.index].connected) ? pads[pad.index] : first;
    } catch (e) {}
    pad.connected = !!gp;
    if (!gp) {
      pad.turn = 0; pad.drive = 0;
      pad.fire = pad.nade = pad.mine = pad.boost = pad.vent = false;
      pad.prev.length = 0;
      pad.actuator = null;
      return;
    }
    pad.actuator = gp.vibrationActuator || null;

    const held = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const edge = (i, code) => {
      const now = held(i);
      if (now && !pad.prev[i]) pressed[code] = true;
      pad.prev[i] = now;
    };

    // held actions: stick + face buttons/triggers
    const [sx, sy] = padStick(gp, 0, 1);
    pad.turn = -sx;
    pad.drive = -sy;
    pad.fire = held(0) || held(7);    // A / RT
    pad.nade = held(1) || held(5);    // B / RB
    pad.vent = held(2);               // X — the vent tap
    pad.mine = held(4);               // LB
    pad.boost = held(6);              // LT

    // momentary edges
    edge(3, 'cam');                   // Y
    edge(9, 'pause');                 // Start
    edge(8, 'Escape');                // Select backs out
    edge(12, 'ArrowUp'); edge(13, 'ArrowDown');
    edge(14, 'ArrowLeft'); edge(15, 'ArrowRight');
    // a pad-only edge: the in-play TECH card confirms on d-pad right, and a
    // keyboard ArrowRight (steering) must never do that
    { const now = held(15); if (now && !pad.prevR) pressed['PadRight'] = true; pad.prevR = now; }
    // A doubles as confirm, B backs out — but neither while the playfield is
    // live: there A is the cannon and B the grenade, and an A that also
    // committed the focused TECH card mid-firefight picked upgrades by
    // accident. In play the d-pad steers the card and ► installs it.
    if (!touch.enabled) {
      edge(0, 'Enter');
      if (held(1) && !pad.prevB) pressed['Escape'] = true;
    } else {
      pad.prev[0] = held(0);
    }
    pad.prevB = held(1);

    // stick flicks navigate menus: fire an edge on each threshold crossing
    const T = 0.55;
    if (sy < -T && pad.prevStickY >= -T) pressed['ArrowUp'] = true;
    if (sy > T && pad.prevStickY <= T) pressed['ArrowDown'] = true;
    if (sx < -T && pad.prevStickX >= -T) pressed['ArrowLeft'] = true;
    if (sx > T && pad.prevStickX <= T) pressed['ArrowRight'] = true;
    pad.prevStickX = sx; pad.prevStickY = sy;
  }

  function padConnected() { return pad.connected; }

  /* Translate the view-relative stick into the game's turn/drive axes.
   * The camera yaw always equals the hull yaw, so "up" on the stick is the
   * tank's forward: forward arcs drive and steer toward the thumb, sideways
   * pivots in place, and the whole back half reverses. Reverse steering
   * measures deflection from straight-down (mirroring the forward arc) and
   * keeps the stick's side: left deflection always rotates the hull left,
   * forward or reverse — matching the keys, and the camera never swings
   * against the thumb. Both halves saturate past 0.7 rad, so turn is
   * continuous through the sideways pivot. */
  function stickAxes() {
    const s = touch.stick;
    if (s.id === null || s.mag <= 0) return null;
    const rel = s.rel, a = Math.abs(rel);
    const steer = a <= Math.PI / 2 ? rel : Math.sign(rel) * (Math.PI - a);
    const turn = -Math.max(-1, Math.min(1, steer / 0.7)) * (0.45 + 0.55 * s.mag);
    const drive = s.mag * Math.cos(rel);   // >0 forward, 0 sideways, <0 reverse
    return { turn, drive };
  }

  function axis() {
    let turn = (keys.left ? 1 : 0) - (keys.right ? 1 : 0) + pad.turn;
    let drive = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0) + pad.drive;
    const st = stickAxes();
    if (st) { turn += st.turn; drive += st.drive; }
    return {
      turn: Math.max(-1, Math.min(1, turn)),
      drive: Math.max(-1, Math.min(1, drive)),
      fire: keys.fire || fireHeld || pad.fire || touch.fireIds.size > 0,
      nade: keys.nade || nadeHeld || pad.nade || buttonHeld('nade'),
      mine: keys.mine || mineHeld || pad.mine || buttonHeld('mine'),
      vent: !!keys.vent || pad.vent || buttonHeld('vent'),
      boost: !!keys.boost || pad.boost || buttonHeld('boost'),
    };
  }

  /* Edge-triggered key check; true once per physical press. */
  function consume(code) {
    if (pressed[code]) { pressed[code] = false; return true; }
    return false;
  }

  function clearFrame() {
    for (const k in pressed) pressed[k] = false;
  }

  /* main.js flips this each frame: touches only drive the tank while the
   * playfield is live, and letting go of everything on a mode change means
   * no stuck inputs when a menu opens mid-hold. */
  function setPlayfieldActive(active) {
    if (touch.enabled && !active) releaseAllTouch();
    touch.enabled = active;
    ui.enabled = active;
  }

  function touchUI() { return ui; }

  return {
    axis, consume, clearFrame, setPlayfieldActive, touchUI, vibrate, rumble, pollGamepad, padConnected,
    // bindings
    actions: ACTIONS, actionLabel: (a) => ACTION_LABELS[a] || a, binds: getBinds, rebind, resetBinds,
    labelFor, captureNext, capturing,
    // test seams
    _keydown: (code) => { const a = KEYMAP[code]; if (a) { keys[a] = true; pressed[a] = true; } pressed[code] = true; },
    _keyup: (code) => { const a = KEYMAP[code]; if (a) keys[a] = false; },
    _setPad: (o) => Object.assign(pad, o),
  };
})();
