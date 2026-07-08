---
name: verify
description: Build/launch/drive recipe for verifying changes to Phantom Arena (static WebGL game with a cache-first service worker).
---

# Verifying Phantom Arena

No build step. Serve the folder statically and drive it with Playwright
(preinstalled: global `playwright` package + Chromium under
`/opt/pw-browsers`; symlink the global modules dir as `node_modules`
next to your script so ESM imports resolve).

```sh
# serve a MUTABLE COPY (not the repo) so you can fake a deploy between loads
cp -r index.html style.css sw.js manifest.webmanifest icon.svg js $WORK/serve/
cd $WORK/serve && npx http-server -p 8931 -c-1 --silent &
```

Serve over `http://127.0.0.1` — the service worker only registers on
http(s), never on `file://`.

## Flows worth driving

- **Boot**: `#build-tag` shows `BUILD <GAME_VERSION>` (from `js/version.js`);
  `caches.keys()` gains `phantom-arena-<version>` once the SW installs.
- **Update flow**: bump `GAME_VERSION` in the *served* copy's
  `js/version.js`, then fake a tab refocus:
  `Object.defineProperty(document,'visibilityState',{value:'visible',configurable:true});
  document.dispatchEvent(new Event('visibilitychange'))` →
  `#update-toast` unhides; clicking it reloads onto the new version and
  the old cache is deleted.
- **Offline**: `context.setOffline(true)` + reload must still render the
  title menu (cache-first regression check).
- **Gameplay smoke**: click `#bt-deploy` → `#bt-launch`, then wait for
  `window.__PA.getMode() === 'playing'` (`window.__PA` is the exposed
  test handle: `{ game, hud, net, getMode }`).

## Gotchas

- The SW registers with `updateViaCache: 'none'`, so changes to
  `js/version.js` alone are picked up on update checks even though
  `sw.js` bytes don't change.
- First-ever SW install fires `controllerchange` (via `clients.claim()`)
  but must NOT show the toast — check that a plain reload stays quiet.
- The old cache is deleted the moment the new SW activates, while the
  old page is still on screen — expected, not a bug.
