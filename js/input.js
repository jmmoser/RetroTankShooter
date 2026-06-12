/* Keyboard + mouse + basic touch input. */
const Input = (() => {
  const keys = {};
  const pressed = {}; // edge-triggered, cleared each frame by consume
  let fireHeld = false;

  const KEYMAP = {
    ArrowUp: 'forward', KeyW: 'forward',
    ArrowDown: 'back', KeyS: 'back',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    Space: 'fire',
    ShiftLeft: 'boost', ShiftRight: 'boost',
  };

  window.addEventListener('keydown', (e) => {
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
    const action = KEYMAP[e.code];
    if (action) { keys[action] = false; e.preventDefault(); }
  });

  window.addEventListener('mousedown', (e) => {
    AudioSys.resume();
    if (e.button === 0) { fireHeld = true; pressed['fire'] = true; }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) fireHeld = false;
  });

  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    fireHeld = false;
  });

  // -- minimal touch support: left half = steer/drive pad, right half = fire
  const touchState = { steerX: 0, driveY: 0, active: false };
  function handleTouches(e) {
    touchState.steerX = 0; touchState.driveY = 0; touchState.active = false;
    let firing = false;
    for (const t of e.touches) {
      const w = window.innerWidth, h = window.innerHeight;
      if (t.clientX < w * 0.5) {
        touchState.active = true;
        touchState.steerX = (t.clientX - w * 0.25) / (w * 0.2);
        touchState.driveY = (h * 0.6 - t.clientY) / (h * 0.25);
      } else {
        firing = true;
      }
    }
    if (firing && !fireHeld) pressed['fire'] = true;
    fireHeld = firing;
  }
  window.addEventListener('touchstart', (e) => { AudioSys.resume(); handleTouches(e); pressed['AnyTouch'] = true; }, { passive: true });
  window.addEventListener('touchmove', handleTouches, { passive: true });
  window.addEventListener('touchend', handleTouches, { passive: true });

  function axis() {
    let turn = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
    let drive = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
    if (touchState.active) {
      turn += -Math.max(-1, Math.min(1, touchState.steerX));
      drive += Math.max(-1, Math.min(1, touchState.driveY));
    }
    return {
      turn: Math.max(-1, Math.min(1, turn)),
      drive: Math.max(-1, Math.min(1, drive)),
      fire: keys.fire || fireHeld,
      boost: !!keys.boost,
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

  return { axis, consume, clearFrame };
})();
