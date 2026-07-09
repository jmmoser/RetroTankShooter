/* Keyboard + mouse + touch + gamepad input.
 *
 * Gamepad (standard layout): left stick drives and steers, A/RT fire,
 * B/RB grenade, X vent, LB mine, LT boost, Y camera, Start pause. The d-pad
 * and stick also navigate menus by synthesizing the same virtual key edges
 * the keyboard uses, so every screen works from the couch.
 *
 * Touch is a first-class scheme, not a fallback:
 *  - A floating joystick spawns wherever the left thumb lands and stays
 *    anchored there; overshoot past the rim just clamps, so the base never
 *    drifts across the screen mid-maneuver.
 *  - The stick is view-relative: push where you want to go. Forward arcs
 *    drive+steer, sideways pivots in place, and the whole back half
 *    reverses — steered so the tank backs toward the thumb.
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

  const KEYMAP = {
    ArrowUp: 'forward', KeyW: 'forward',
    ArrowDown: 'back', KeyS: 'back',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    Space: 'fire',
    KeyX: 'nade', ControlLeft: 'nade',
    KeyV: 'mine',
    KeyR: 'vent',
    ShiftLeft: 'boost', ShiftRight: 'boost',
    KeyC: 'cam', KeyP: 'pause',
  };

  function typingInField(e) {
    const el = e.target;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  window.addEventListener('keydown', (e) => {
    if (typingInField(e)) return; // let text fields (e.g. room code) receive keys
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
    if (typingInField(e)) return;
    const action = KEYMAP[e.code];
    if (action) { keys[action] = false; e.preventDefault(); }
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
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    fireHeld = false;
    nadeHeld = false;
    mineHeld = false;
    releaseAllTouch();
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

  function vibrate(ms) {
    if (touch.mode && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} }
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
    if (e.target && e.target.closest && e.target.closest('.screen')) return;
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

  const PAD_DEAD = 0.18;
  const pad = {
    connected: false,
    turn: 0, drive: 0,
    fire: false, nade: false, mine: false, boost: false, vent: false,
    prev: [],          // previous frame's button states, for edge detection
    prevStickX: 0, prevStickY: 0,
  };

  function padAxis(gp, i) {
    const v = gp.axes[i] || 0;
    if (Math.abs(v) < PAD_DEAD) return 0;
    return (v - Math.sign(v) * PAD_DEAD) / (1 - PAD_DEAD);
  }

  function pollGamepad() {
    let gp = null;
    try {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const g of pads) if (g && g.connected) { gp = g; break; }
    } catch (e) {}
    pad.connected = !!gp;
    if (!gp) {
      pad.turn = 0; pad.drive = 0;
      pad.fire = pad.nade = pad.mine = pad.boost = pad.vent = false;
      pad.prev.length = 0;
      return;
    }

    const held = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const edge = (i, code) => {
      const now = held(i);
      if (now && !pad.prev[i]) pressed[code] = true;
      pad.prev[i] = now;
    };

    // held actions: stick + face buttons/triggers
    const sx = padAxis(gp, 0), sy = padAxis(gp, 1);
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
    // A doubles as confirm; B backs out of menus but must never do so while
    // the playfield is live (there it's the grenade button).
    edge(0, 'Enter');
    if (!touch.enabled) { if (held(1) && !pad.prevB) pressed['Escape'] = true; }
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
   * measures deflection from straight-down with the sign flipped: the sim
   * rotates the hull the same way for a given turn in both drive
   * directions, so backing TOWARD the thumb needs the opposite hull
   * rotation from driving toward it. The tank always moves toward the
   * thumb, and reverse is steerable with no dead wedge between "pivot"
   * and "reverse". Both halves saturate past 0.7 rad. */
  function stickAxes() {
    const s = touch.stick;
    if (s.id === null || s.mag <= 0) return null;
    const rel = s.rel, a = Math.abs(rel);
    const steer = a <= Math.PI / 2 ? rel : -Math.sign(rel) * (Math.PI - a);
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

  return { axis, consume, clearFrame, setPlayfieldActive, touchUI, vibrate, pollGamepad, padConnected };
})();
