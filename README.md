# PHANTOM ARENA — Retro Tank Shooter

A browser-based homage to the flat-shaded 3D tank arena games of the early
1990s. Drive your hover-tank across a neon grid, secure every flag in the
sector, and survive the enemy patrols hunting you down.

Built with **zero dependencies** — plain WebGL, Canvas 2D and Web Audio.
No build step, no assets, no network requests. One folder, open and play.

## Play

Open `index.html` in any modern browser, or serve the folder statically:

```sh
npx http-server .        # or: python3 -m http.server
```

It also works hosted on GitHub Pages (Settings → Pages → deploy from branch).

## How to play

Secure **all flags** in the sector to advance. Enemy tanks guard the flags
and will hunt you on sight. Your hull is gone when shields hit zero.

| Control | Action |
| --- | --- |
| `W S` / `↑ ↓` | Drive forward / reverse |
| `A D` / `← →` | Steer |
| `Space` / click | Fire cannon |
| `C` | Toggle first-person / chase camera |
| `P` / `Esc` | Pause |
| `M` | Toggle sound |

Touch devices: left half of the screen steers and drives, right half fires.

### Vehicle configuration

Before deploying, allocate your tank's power — a classic trade-off:

- **SCOUT** — fast and agile, thin shields
- **VANGUARD** — balanced, extra ammo
- **JUGGERNAUT** — slow, heavily shielded

### Enemies

- **Drone** (red) — slow patroller, guards flags
- **Hunter** (orange, sector 3+) — fast, relentless pursuit
- **Sniper** (purple, sector 5+) — holds range, hits hard from far away

### Pickups

Destroyed enemies sometimes drop supplies; a few crates are scattered around
each sector: **ammo**, **shield repair**, **overdrive** (speed boost) and
**rapid fire**. Sector-clear bonus scales with remaining shields, ammo and
kills. High score is kept in your browser.

## Code layout

```
index.html      shell + menu screens
style.css       retro CRT styling
js/audio.js     synthesized SFX & engine hum (Web Audio)
js/input.js     keyboard / mouse / touch
js/geometry.js  procedural low-poly meshes
js/renderer.js  minimal WebGL flat-shaded renderer + mat4 helpers
js/hud.js       radar, shields/ammo bars, messages (Canvas 2D)
js/game.js      arena generation, player, enemy AI, projectiles, pickups
js/main.js      screen flow, camera, scene drawing, main loop
```

All code, art and sound are original. The gameplay is inspired by the
arena-tank classics of the era; no original assets or names are used.
