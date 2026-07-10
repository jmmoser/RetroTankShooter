# Tests

The game has no build step and no dependencies; the headless suites run on
plain Node (≥18):

```sh
node test/run.js
```

`run.js` executes every `t-*.js` suite in its own process (the game ships as
classic browser scripts with top-level `const`s, so suites can't share one
context — `helpers.js` loads the needed `js/` files into a vm per process).

| Suite | Covers |
| --- | --- |
| `t-game-combat.js` | splash/chain-kill array safety, line-of-sight (segment-vs-AABB), piercing shells, combat soak |
| `t-game-modes.js` | boss sectors, versus rules (tie-break, self-damage), warp gates, daily determinism, extraction, mutators, upgrade stacking, warden hold AI |
| `t-geometry.js` | outward face winding (octahedron/box/pyramid), grid edge coverage, arena-wall perimeter/no-overlap, wireframe edge sanity |
| `t-m4.js` | matrix composition and the out-parameter scratch-matrix contract |
| `t-net.js` | lobby full-rejection (host and client sides), mid-game roster pruning, snapshot serialize→apply round-trip, snapshot interpolation |
| `t-settings-daily.js` | daily best/streak persistence incl. UTC-midnight straddles and corrupted-storage hardening |

## Browser end-to-end

`e2e.mjs` drives the real game in headless Chromium: boot + build tag,
service-worker install and cache naming, gameplay (deploy → drive → fire →
grenades/mines), zero WebGL/console errors, the keyup-in-text-field stuck-key
regression, and an offline reload against the SW cache. It serves the repo
itself on `127.0.0.1:8931` for the duration of the run.

Requires Playwright with a Chromium browser installed:

```sh
node test/e2e.mjs
```

Not covered headlessly (browser-API bound, exercised only by `e2e.mjs` or by
hand): `audio.js` (Web Audio), `input.js` touch/gamepad paths, `hud.js`
canvas drawing, `main.js` screen flow/DOM, and actual GPU rendering output.
