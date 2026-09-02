/* Every file the page loads must be in the service worker's precache list —
 * a new module that is not would silently break offline play and the PWA
 * install. Also checks the version stamp is shared. */
const fs = require('fs');
const path = require('path');
const { ROOT, check, assert } = require('./helpers');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const assets = [];
const m = /const ASSETS = \[([\s\S]*?)\];/.exec(sw);
if (m) for (const s of m[1].match(/'[^']+'/g) || []) assets.push(s.slice(1, -1));

check('sw.js precaches every script and stylesheet index.html loads', () => {
  const refs = [];
  for (const r of html.matchAll(/<script src="([^"]+)"/g)) refs.push(r[1]);
  for (const r of html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)) refs.push(r[1]);
  for (const r of html.matchAll(/<link rel="manifest" href="([^"]+)"/g)) refs.push(r[1]);
  assert(refs.length >= 12, 'found ' + refs.length + ' page references');
  for (const ref of refs) assert(assets.indexOf(ref) >= 0, ref + ' is not in the service worker ASSETS list');
});

check('sw.js reads GAME_VERSION from js/version.js, and the version file is precached', () => {
  assert(/importScripts\('js\/version\.js'\)/.test(sw), 'sw imports version.js');
  assert(assets.indexOf('js/version.js') >= 0, 'version.js precached');
  const v = /GAME_VERSION = '(v\d+)'/.exec(fs.readFileSync(path.join(ROOT, 'js/version.js'), 'utf8'));
  assert(v, 'GAME_VERSION has the vNN shape');
});

check('every precached asset exists on disk', () => {
  for (const a of assets) {
    if (a === './') continue;
    assert(fs.existsSync(path.join(ROOT, a)), 'missing ' + a);
  }
});
