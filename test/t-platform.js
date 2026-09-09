const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert/strict');

function fixture({ enabled = true, environment = 'local', initError = false, blocked = false } = {}) {
  const events = [], timers = new Map();
  let callbacks, settingsListener, script;
  const sdk = {
    environment,
    init: async () => { if (initError) throw Error('init failed'); },
    game: {
      settings: { muteAudio: false },
      addSettingsChangeListener: (listener) => { settingsListener = listener; },
      gameplayStart: () => events.push('start'), gameplayStop: () => events.push('stop'),
      loadingStart: () => events.push('loading'), loadingStop: () => events.push('loaded'),
      inviteLink: (params) => 'https://www.crazygames.com/game/test?' + new URLSearchParams(params),
    },
    ad: { requestAd: (kind, cb) => { events.push(kind); callbacks = cb; } },
  };
  const ctx = vm.createContext({
    window: { PA_PLATFORM: enabled ? 'crazygames' : undefined, CrazyGames: { SDK: sdk } },
    document: {
      createElement: () => ({}),
      head: { appendChild: (s) => { script = s; if (!blocked) queueMicrotask(() => s.onload()); } },
    },
    location: new URL('https://example.com/tank/index.html?join=PRIVATE#old'), URL,
    setTimeout: (fn) => { const id = {}; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/platform.js'), 'utf8') + '\nthis.api = GamePlatform;', ctx);
  return { api: ctx.api, sdk, events, timers, ad: () => callbacks,
    settings: (v) => settingsListener(v), script: () => script };
}

(async () => {
  const tests = [
    ['ordinary build makes no SDK request and preserves only share parameters', async () => {
      const f = fixture({ enabled: false }); await f.api.init();
      assert.equal(f.script(), undefined);
      let next = 0; f.api.breakBefore(() => next++, true); assert.equal(next, 1);
      assert.equal(f.api.shareURL({ daily: '2026-09-09' }), 'https://example.com/tank/index.html?daily=2026-09-09');
    }],
    ['SDK initialization failure / disabled environment fail open', async () => {
      for (const options of [{ initError: true }, { environment: 'disabled' }]) {
        const f = fixture(options); await f.api.init(); f.api.tick(200, true);
        let next = 0; f.api.breakBefore(() => next++, true);
        assert.equal(next, 1); assert.deepEqual(f.events, []);
        assert.equal(f.api.shareURL({}), '');
      }
    }],
    ['blocked SDK times out and a late load stays detached', async () => {
      const f = fixture({ blocked: true }); const init = f.api.init();
      [...f.timers.values()][0](); await init; await f.script().onload();
      f.api.tick(200, true); assert.deepEqual(f.events, []);
    }],
    ['gameplay events report transitions once, not every frame', async () => {
      const f = fixture(); await f.api.init(); f.api.ready();
      f.api.tick(1, true); f.api.tick(1, true); f.api.setPlaying(false); f.api.setPlaying(false);
      f.api.tick(1, true);
      assert.deepEqual(f.events, ['loading', 'loaded', 'start', 'stop', 'start']);
    }],
    ['first three active minutes and ineligible modes never request ads', async () => {
      const f = fixture(); await f.api.init(); let next = 0;
      f.api.tick(1000, false); f.api.tick(179, true);
      f.api.breakBefore(() => next++, true); f.api.tick(2, true);
      f.api.breakBefore(() => next++, false);
      assert.equal(next, 2); assert(!f.events.includes('midgame'));
    }],
    ['ad blocks duplicate actions, mutes only on start, and continues once', async () => {
      const f = fixture(); await f.api.init(); f.api.tick(181, true);
      const busy = [], mute = []; let next = 0;
      f.api.onBusy = (v) => busy.push(v); f.api.onMute = (v) => mute.push(v);
      f.api.breakBefore(() => next++, true); f.api.breakBefore(() => next++, true);
      assert(f.api.isBusy()); assert.equal(next, 0); assert.deepEqual(mute, []);
      assert.equal(f.events.filter(e => e === 'midgame').length, 1);
      f.ad().adStarted(); assert.deepEqual(mute, [true]);
      f.ad().adFinished(); f.ad().adError(); f.ad().adStarted();
      assert.deepEqual(busy, [true, false]); assert.deepEqual(mute, [true, false]); assert.equal(next, 1);
      assert.equal(f.api.isBusy(), false);
      f.api.breakBefore(() => next++, true); assert.equal(next, 2);
      assert.equal(f.events.filter(e => e === 'midgame').length, 1);
    }],
    ['no-fill, thrown SDK error, and rejected request all continue', async () => {
      for (const kind of ['callback', 'throw', 'reject']) {
        const f = fixture(); await f.api.init(); f.api.tick(181, true); let next = 0;
        if (kind === 'throw') f.sdk.ad.requestAd = () => { throw Error('blocked'); };
        if (kind === 'reject') f.sdk.ad.requestAd = () => Promise.reject(Error('blocked'));
        f.api.breakBefore(() => next++, true);
        if (kind === 'callback') f.ad().adError({ code: 'unfilled' });
        await Promise.resolve();
        assert.equal(next, 1); assert.equal(f.api.isBusy(), false);
      }
    }],
    ['portal mute remains enforced after an ad ends', async () => {
      const f = fixture(); await f.api.init(); const muted = [];
      f.api.onMute = (v) => muted.push(v); f.settings({ muteAudio: true });
      f.api.tick(181, true); f.api.breakBefore(() => {}, true);
      f.ad().adStarted(); f.ad().adFinished(); assert(muted.every(Boolean));
      f.settings({ muteAudio: false }); assert.equal(muted.at(-1), false);
    }],
    ['portal shares use the public SDK invitation URL', async () => {
      const f = fixture(); await f.api.init();
      assert.equal(f.api.shareURL({ daily: '2026-09-09' }), 'https://www.crazygames.com/game/test?daily=2026-09-09');
    }],
  ];
  for (const [name, test] of tests) {
    try { await test(); console.log('PASS ' + name); }
    catch (e) { console.log('FAIL ' + name + ' — ' + e.message); process.exitCode = 1; }
  }
})();
