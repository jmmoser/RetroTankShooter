/* Shared loader for the headless test suites.
 *
 * The game ships as classic browser scripts (top-level consts, no modules),
 * so suites load them by concatenating source files into one vm script and
 * exporting the globals they need. Each suite runs in its own process (see
 * run.js), so scripts never collide.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* Minimal browser-ish globals the game scripts expect. */
function stubGlobals() {
  global.window = global;
  if (!global.AudioSys) global.AudioSys = { play() {} };
  if (!global.Settings) global.Settings = { get: () => 1 };
}

/* Load js source files (in order) plus an epilogue that exports globals. */
function loadScripts(files, epilogue) {
  stubGlobals();
  const src = files
    .map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'))
    .join('\n;\n');
  vm.runInThisContext(src + '\n;\n' + (epilogue || ''), { filename: files.join('+') });
}

/* Silent HUD stand-in for Game instances. */
function fakeHud() {
  return { message() {}, pickup() {}, scorePop() {}, damage() {} };
}

/* Tiny check runner: prints PASS/FAIL lines, sets process.exitCode. */
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    process.exitCode = 1;
    console.log('FAIL ' + name + ' — ' + (e && e.message));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

module.exports = { ROOT, loadScripts, fakeHud, check, assert, failCount: () => failures };
