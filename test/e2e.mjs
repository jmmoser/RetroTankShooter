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
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8931;
const VERSION = /GAME_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(path.join(ROOT, 'js/version.js'), 'utf8'))[1];

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
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
};

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

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

const fatal = errors.filter((e) => !e.includes('favicon'));
ok('no page/console errors', fatal.length === 0, fatal.slice(0, 5).join(' | '));

console.log(results.join('\n'));
await browser.close();
server.close();
