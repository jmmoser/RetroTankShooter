/* Input: key bindings (defaults, rebinding, persistence shape), axis
 * composition, the radial gamepad deadzone, the pad-only draft edge, and
 * A-not-Enter while the playfield is live. Runs against stubbed DOM/gamepad. */
const { loadScripts, check, assert } = require('./helpers');

let pads = [];
const listeners = {};
global.window = global;
global.addEventListener = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
global.matchMedia = () => ({ matches: false });
global.innerWidth = 1280; global.innerHeight = 720;
global.document = {
  body: { classList: { add() {}, toggle() {}, remove() {} } },
  documentElement: {},
  addEventListener() {},
};
global.getComputedStyle = () => ({ getPropertyValue: () => '0' });
// Node 21+ ships a read-only `navigator` global: plain assignment is ignored
Object.defineProperty(global, 'navigator', {
  value: { getGamepads: () => pads, vibrate() {}, userAgent: 'node' }, configurable: true, writable: true,
});
const stored = {};
global.Store = { get: (k) => stored[k] || null, set: (k, v) => { stored[k] = v; return true; }, remove(k) { delete stored[k]; } };
global.Settings = { get: (k) => (k === 'deadzone' ? 1 : k === 'rumble' ? true : 1) };
global.AudioSys = { play() {}, resume() {} };

loadScripts(['input.js'], 'global.Input = Input;');

check('defaults: W drives, the arrow keys are the alternates', () => {
  const b = Input.binds();
  assert(b.forward[0] === 'KeyW' && b.forward[1] === 'ArrowUp', JSON.stringify(b.forward));
  Input._keydown('KeyW');
  assert(Input.axis().drive === 1, 'W drives forward');
  Input._keyup('KeyW');
  assert(Input.axis().drive === 0, 'released');
});

check('rebind: the new key drives, the old primary no longer does, and it persists', () => {
  assert(Input.rebind('forward', 'KeyI'), 'rebind accepted');
  Input._keydown('KeyW');
  const wDrives = Input.axis().drive;
  Input._keyup('KeyW');
  assert(wDrives === 0, 'W was replaced');
  Input._keydown('KeyI');
  assert(Input.axis().drive === 1, 'I drives now');
  Input._keyup('KeyI');
  Input._keydown('ArrowUp');
  assert(Input.axis().drive === 1, 'the alternate (arrow) survives a rebind');
  Input._keyup('ArrowUp');
  const saved = JSON.parse(stored.pa_binds);
  assert(saved.forward[0] === 'KeyI', 'persisted under pa_binds');
});

check('rebind steals a key from the action that had it; Escape is never bindable', () => {
  Input.rebind('fire', 'KeyI');
  const b = Input.binds();
  assert(b.fire[0] === 'KeyI', 'fire took I');
  assert(b.forward.indexOf('KeyI') < 0, 'forward lost it');
  assert(!Input.rebind('fire', 'Escape'), 'Escape refused');
  Input.resetBinds();
  assert(Input.binds().fire[0] === 'Space', 'defaults restored');
});

check('labelFor names keys for the controls screen', () => {
  assert(Input.labelFor('KeyW') === 'W');
  assert(Input.labelFor('Space') === 'SPACE');
  assert(Input.labelFor('ShiftLeft') === 'L SHIFT');
  assert(Input.labelFor('Digit3') === '3');
});

function padWith(axes, buttons) {
  const btn = [];
  for (let i = 0; i < 16; i++) btn.push({ pressed: !!(buttons && buttons[i]) });
  return { connected: true, axes, buttons: btn, mapping: 'standard' };
}

check('radial deadzone: a small diagonal reads as zero, a push rescales to full range', () => {
  pads = [padWith([0.1, 0.1])];
  Input.pollGamepad();
  let a = Input.axis();
  assert(a.turn === 0 && a.drive === 0, 'inside the dead disc = zero');
  pads = [padWith([0.0, -1.0])];
  Input.pollGamepad();
  a = Input.axis();
  assert(Math.abs(a.drive - 1) < 1e-9, 'full forward = 1, got ' + a.drive);
  pads = [padWith([0.59, 0.0])];
  Input.pollGamepad();
  a = Input.axis();
  // 0.18 deadzone: (0.59-0.18)/(0.82) = 0.5
  assert(Math.abs(a.turn + 0.5) < 0.02, 'halfway push rescales past the deadzone, got ' + a.turn);
});

check('the active pad wins over a dormant one in slot 0', () => {
  pads = [padWith([0, 0]), padWith([0, -1])];
  Input.pollGamepad();
  assert(Math.abs(Input.axis().drive - 1) < 1e-9, 'slot 1 is the one in someone\'s hands');
});

check('A confirms in menus but never while the playfield is live; d-pad ► is a pad-only edge', () => {
  Input.setPlayfieldActive(false);
  pads = [padWith([0, 0], { 0: true })];
  Input.pollGamepad();
  assert(Input.consume('Enter'), 'A = Enter in a menu');
  pads = [padWith([0, 0], {})];
  Input.pollGamepad(); Input.clearFrame();
  Input.setPlayfieldActive(true);
  pads = [padWith([0, 0], { 0: true })];
  Input.pollGamepad();
  assert(!Input.consume('Enter'), 'A is the cannon in play, not Enter');
  assert(Input.axis().fire, '...and it fires');
  pads = [padWith([0, 0], { 15: true })];
  Input.pollGamepad();
  assert(Input.consume('PadRight'), 'd-pad right raises the pad-only edge');
  Input.setPlayfieldActive(false);
  pads = [];
  Input.pollGamepad();
});
