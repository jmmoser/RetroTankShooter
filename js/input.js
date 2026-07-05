/* Keyboard + mouse + touch input.
 *
 * Touch is a first-class scheme, not a fallback:
 *  - A floating joystick spawns wherever the left thumb lands and leashes
 *    (the base drags along) when the thumb overshoots, so steering is always
 *    relative to the thumb — never to a fixed screen spot.
 *  - The stick is view-relative: push where you want to go. Forward arcs
 *    drive+steer, sideways pivots in place, straight back reverses.
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

  const KEYMAP = {
    ArrowUp: 'forward', KeyW: 'forward',
    ArrowDown: 'back', KeyS: 'back',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    Space: 'fire',
    KeyX: 'nade', ControlLeft: 'nade',
    ShiftLeft: 'boost', ShiftRight: 'boost',
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

  // Touch taps make browsers synthesize compatibility mouse events; ignore
  // mouse input for a beat after any touch so taps never double-fire.
  let lastTouchT = -1e9;
  window.addEventListener('mousedown', (e) => {
    if (performance.now() - lastTouchT < 1200) return;
    AudioSys.resume();
    if (e.button === 0) { fireHeld = true; pressed['fire'] = true; }
    if (e.button === 2) { nadeHeld = true; pressed['nade'] = true; }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) fireHeld = false;
    if (e.button === 2) nadeHeld = false;
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    fireHeld = false;
    nadeHeld = false;
    releaseAllTouch();
  });

  // ---- touch state ----------------------------------------------------------

  const STICK_MAX = 64;   // stick travel / leash radius, CSS px
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
    touch.buttons.length = 0;
    touch.buttons.push(
      { key: 'fire',  label: 'FIRE',  x: right - 84 * u,  y: bottom - 100 * u, r: 48 * u, id: null },
      { key: 'nade',  label: 'NADE',  x: right - 180 * u, y: bottom - 54 * u,  r: 32 * u, id: null },
      { key: 'boost', label: 'BOOST', x: right - 60 * u,  y: bottom - 210 * u, r: 32 * u, id: null },
      { key: 'cam',   label: 'CAM',   x: right - 100 * u, y: safe.t + 32 * u,  r: 24 * u, id: null },
      { key: 'pause', label: 'II',    x: right - 40 * u,  y: safe.t + 32 * u,  r: 24 * u, id: null },
    );
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

  function enableTouchMode() {
    touch.mode = true;
    ui.mode = true;
    document.body.classList.add('touch-ui');
  }
  if (touch.mode) enableTouchMode();

  function releasePointer(id) {
    if (touch.stick.id === id) {
      const s = touch.stick;
      s.id = null; s.dx = 0; s.dy = 0; s.mag = 0; s.rel = 0;
    }
    touch.fireIds.delete(id);
    for (const b of touch.buttons) if (b.id === id) b.id = null;
  }

  function releaseAllTouch() {
    const s = touch.stick;
    s.id = null; s.dx = 0; s.dy = 0; s.mag = 0; s.rel = 0;
    touch.fireIds.clear();
    for (const b of touch.buttons) b.id = null;
  }

  function moveStick(x, y) {
    const s = touch.stick;
    let dx = x - s.baseX, dy = y - s.baseY;
    let d = Math.hypot(dx, dy);
    if (d > STICK_MAX) {
      // leash: the base follows the thumb, so reversing direction is instant
      const k = (d - STICK_MAX) / d;
      s.baseX += dx * k;
      s.baseY += dy * k;
      dx -= dx * k;
      dy -= dy * k;
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
    if (e.pointerType === 'mouse') return;
    lastTouchT = performance.now();
    enableTouchMode();
    AudioSys.resume();
    if (!touch.enabled) return;                                  // menus: DOM handles it
    if (e.target && e.target.closest && e.target.closest('.screen')) return;
    e.preventDefault();
    const x = e.clientX, y = e.clientY;

    const btn = buttonAt(x, y);
    if (btn && btn.id === null) {
      btn.id = e.pointerId;
      vibrate(10);
      if (btn.key === 'fire') { touch.fireIds.add(e.pointerId); pressed['fire'] = true; }
      else if (btn.key === 'nade') pressed['nade'] = true;
      else if (btn.key === 'cam') pressed['KeyC'] = true;
      else if (btn.key === 'pause') pressed['KeyP'] = true;
      return;
    }

    if (x < window.innerWidth * 0.55 && touch.stick.id === null) {
      const s = touch.stick;
      s.id = e.pointerId;
      s.baseX = Math.max(safe.l + 24, Math.min(window.innerWidth * 0.55, x));
      s.baseY = Math.max(safe.t + 70, Math.min(window.innerHeight - safe.b - 24, y));
      moveStick(x, y);
    } else {
      // anywhere else on the right half is hold-to-fire
      touch.fireIds.add(e.pointerId);
      pressed['fire'] = true;
    }
  }

  function onPointerMove(e) {
    if (e.pointerType === 'mouse') return;
    if (touch.stick.id === e.pointerId) moveStick(e.clientX, e.clientY);
  }

  function onPointerUp(e) {
    if (e.pointerType === 'mouse') return;
    lastTouchT = performance.now();
    releasePointer(e.pointerId);
  }

  window.addEventListener('pointerdown', onPointerDown, { passive: false });
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });
  window.addEventListener('pointercancel', onPointerUp, { passive: true });

  /* Translate the view-relative stick into the game's turn/drive axes.
   * The camera yaw always equals the hull yaw, so "up" on the stick is the
   * tank's forward: forward arcs drive and steer toward the thumb, sideways
   * pivots in place, and an almost-straight-back pull reverses. */
  function stickAxes() {
    const s = touch.stick;
    if (s.id === null || s.mag <= 0) return null;
    const rel = s.rel, a = Math.abs(rel);
    const rev = a > 2.35 ? Math.min(1, (a - 2.35) / 0.4) : 0; // blend into reverse wedge
    const turn = -Math.max(-1, Math.min(1, rel / 0.7)) * (1 - rev) * (0.45 + 0.55 * s.mag);
    const c = Math.cos(rel);
    const drive = s.mag * (c > 0 ? c : c * rev);
    return { turn, drive };
  }

  function axis() {
    let turn = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
    let drive = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
    const st = stickAxes();
    if (st) { turn += st.turn; drive += st.drive; }
    return {
      turn: Math.max(-1, Math.min(1, turn)),
      drive: Math.max(-1, Math.min(1, drive)),
      fire: keys.fire || fireHeld || touch.fireIds.size > 0,
      nade: keys.nade || nadeHeld || buttonHeld('nade'),
      boost: !!keys.boost || buttonHeld('boost'),
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

  return { axis, consume, clearFrame, setPlayfieldActive, touchUI, vibrate };
})();
