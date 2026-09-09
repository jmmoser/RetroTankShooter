/* Browser end-to-end smoke: boot, service-worker install, gameplay, WebGL
 * and console errors, the stuck-key regression, and offline reload.
 *
 * Needs Playwright with Chromium available:
 *   node test/e2e.mjs
 * Serves the repo itself on 127.0.0.1:8931 for the duration of the run.
 */
import http from 'http';
import { createReadStream, existsSync, statSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8931;
const VERSION = /GAME_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(path.join(ROOT, 'js/version.js'), 'utf8'))[1];
execFileSync('python3', [path.join(ROOT, 'scripts/package-portal.py')]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '') p = '/index.html';
  const f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const results = [];
const ok = (name, cond, extra) => {
  const result = `${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`;
  results.push(result);
  console.log(result);
  if (!cond) process.exitCode = 1;
};

// PA_BROWSER=chromium|firefox|webkit picks the engine (the CI matrix runs all three)
const engine = { chromium, firefox, webkit }[process.env.PA_BROWSER || 'chromium'] || chromium;
const browser = await engine.launch({ headless: !process.env.CI });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('PAGE ERROR: ' + e.message); });
page.on('console', (m) => { if (m.type() === 'error') {
  const message = 'console: ' + m.text() + ' [' + m.location().url + ']';
  errors.push(message); console.log(message);
} });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(1500);

const build = await page.textContent('#build-tag');
ok(`build tag shows ${VERSION}`, build && build.includes(VERSION), build);

await page.waitForFunction(
  (v) => caches.keys().then((k) => k.includes('phantom-arena-' + v)), VERSION, { timeout: 10000 },
).catch(() => {});
const cacheKeys = await page.evaluate(() => caches.keys());
ok(`SW cache phantom-arena-${VERSION} present`, cacheKeys.includes('phantom-arena-' + VERSION), JSON.stringify(cacheKeys));

// gameplay: deploy -> launch, then drive and fire for a while
await page.click('#bt-deploy');
await page.click('#bt-launch');
await page.waitForFunction(() => window.__PA && window.__PA.getMode() === 'playing', null, { timeout: 5000 });
ok('gameplay mode reached', true);
await page.keyboard.down('KeyW');
await page.keyboard.down('Space');
await page.waitForTimeout(4000);
await page.keyboard.up('Space');
await page.keyboard.up('KeyW');
const mode = await page.evaluate(() => window.__PA.game.mode);
ok('sim still running after combat', ['playing', 'dying', 'gameover'].includes(mode), mode);

await page.keyboard.press('KeyX');   // grenade
await page.keyboard.press('KeyV');   // mine
await page.waitForTimeout(1500);
const glErr = await page.evaluate(() => window.__PA.renderer.gl.getError());
ok('no WebGL errors', glErr === 0, 'gl error ' + glErr);

// stuck-key regression: release a held key while a text field has focus
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(800);
await page.keyboard.down('KeyW');
await page.click('#bt-join');
await page.waitForTimeout(300);
await page.focus('#join-code');
await page.keyboard.up('KeyW');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const drive = await page.evaluate(() => Input.axis().drive);
ok('keyup inside text field clears held key', drive === 0, 'drive=' + drive);

// offline reload must still boot from the SW cache
await context.setOffline(true);
await page.reload({ waitUntil: 'load' }).catch(() => {});
await page.waitForTimeout(1200);
const titleVisible = await page.evaluate(() => {
  const el = document.getElementById('screen-title');
  return !!el && !el.classList.contains('hidden');
});
ok('offline reload still renders title', titleVisible);
await context.setOffline(false);

// Challenge links preserve the current UTC arena and explain old builds.
const today = new Date().toISOString().slice(0, 10);
await page.goto(`http://127.0.0.1:${PORT}/?daily=${today}&score=1234&v=${VERSION}`);
await page.waitForSelector('#bt-challenge:not(.hidden)');
ok('shared score is visible on arrival', (await page.textContent('#challenge-note')).includes('1234'));
await page.click('#bt-challenge');
await page.waitForFunction(() => window.__PA.getMode() === 'playing');
ok('challenge launches same daily arena with fixed loadout', await page.evaluate(
  (day) => window.__PA.game.dailySeed === day && window.__PA.game.player.loadout === 'VANGUARD', today));
await page.goto(`http://127.0.0.1:${PORT}/?daily=2020-01-01&score=1234&v=${VERSION}`);
await page.waitForSelector('#bt-challenge:not(.hidden)');
ok('expired challenge explains that today is a new arena', (await page.textContent('#challenge-note')).includes('ENDED'));

// Test the real packaged edition. Only the external SDK is replaced; all
// game code, screen transitions, audio, and input run in the actual browser.
const portal = await browser.newContext();
await portal.route('https://sdk.crazygames.com/crazygames-sdk-v3.js', (route) => route.fulfill({
  contentType: 'application/javascript', body: `
    window.sdkEvents = [];
    window.CrazyGames = { SDK: {
      environment: 'local', init: async () => {},
      game: {
        settings: { muteAudio: false }, addSettingsChangeListener: () => {},
        gameplayStart: () => sdkEvents.push('start'), gameplayStop: () => sdkEvents.push('stop'),
        loadingStart: () => {}, loadingStop: () => {},
        inviteLink: () => 'https://www.crazygames.com/game/phantom-arena'
      },
      ad: { requestAd: (kind, callbacks) => { sdkEvents.push(kind); window.adCallbacks = callbacks; } }
    }};
  `,
}));
const portalPage = await portal.newPage();
portalPage.on('pageerror', (e) => { errors.push('portal: ' + e.message); console.log('PORTAL ERROR: ' + e.message); });
await portalPage.goto(`http://127.0.0.1:${PORT}/dist/crazygames/index.html`);
await portalPage.waitForFunction(() => window.__PA && window.__PA.getMode() === 'playing');
ok('portal edition starts directly in gameplay', true);
ok('portal edition does not register a service worker', await portalPage.evaluate(
  () => navigator.serviceWorker.getRegistrations().then((r) => r.length === 0)));
await portalPage.evaluate(() => {
  GamePlatform.tick(181, true);
  window.__PA.game.mode = 'dying'; window.__PA.game.deathTimer = 0;
});
await portalPage.waitForFunction(() => window.__PA.getMode() === 'gameover');
await portalPage.click('#bt-retry');
ok('retry waits for the ad callback and blocks game interaction', await portalPage.evaluate(
  () => GamePlatform.isBusy() && document.getElementById('game-wrap').inert && window.__PA.getMode() === 'gameover'));
await portalPage.keyboard.press('Escape');
ok('keyboard cannot bypass ad break', await portalPage.evaluate(() => window.__PA.getMode() === 'gameover'));
await portalPage.evaluate(() => { window.adCallbacks.adStarted(); window.adCallbacks.adFinished(); });
await portalPage.waitForFunction(() => window.__PA.getMode() === 'playing');
ok('ad completion resumes one new run', await portalPage.evaluate(
  () => !GamePlatform.isBusy() && !document.getElementById('game-wrap').inert && sdkEvents.filter(e => e === 'midgame').length === 1));
// Exercise no-fill through the DOM path as well, after another eligible interval.
await portalPage.evaluate(() => {
  GamePlatform.tick(181, true); window.__PA.game.mode = 'dying'; window.__PA.game.deathTimer = 0;
});
await portalPage.waitForFunction(() => window.__PA.getMode() === 'gameover');
await portalPage.click('#bt-retry');
await portalPage.evaluate(() => window.adCallbacks.adError({ code: 'unfilled' }));
await portalPage.waitForFunction(() => window.__PA.getMode() === 'playing');
ok('no-fill ad still restarts game', true);
await portal.close();

const fatal = errors.filter((e) => !e.includes('favicon'));
ok('no page/console errors', fatal.length === 0, fatal.slice(0, 5).join(' | '));

await browser.close();
server.close();
