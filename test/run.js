/* Runs every t-*.js suite in its own process (the game ships as classic
 * scripts with top-level consts, so suites can't share a context).
 *
 *   node test/run.js
 *
 * The browser end-to-end pass (boot, service worker, gameplay, WebGL and
 * console errors, offline reload) lives in test/e2e.mjs and needs Playwright
 * + a static server — see test/README.md.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const suites = fs.readdirSync(__dirname).filter((f) => /^t-.*\.js$/.test(f)).sort();
let failed = 0;
for (const s of suites) {
  process.stdout.write('\n== ' + s + ' ==\n');
  try {
    execFileSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  } catch (e) {
    failed++;
  }
}
console.log(failed ? '\n' + failed + ' suite(s) FAILED' : '\nall suites passed');
process.exit(failed ? 1 : 0);
