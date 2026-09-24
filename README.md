# Phantom Arena

A stealth tank game in the style of the flat-shaded 3D arena shooters of the
early 90s. Enemy patrols can't see you until they get a look at you. Sneak
up, kill them before they raise the alarm, hack the sector's uplinks and get
out through the extraction gate.

It runs in the browser with plain WebGL, Canvas 2D and Web Audio: no build
step, no asset files, and single-player makes no network requests. Online
co-op uses one bundled library (PeerJS, in `js/vendor/`).

## Play

Open `index.html`, or serve the folder:

```sh
npx http-server .        # or: python3 -m http.server
```

Served over http(s), a service worker caches everything, so the game installs
as a PWA and single-player works offline. It also runs from GitHub Pages.

A separate CrazyGames build is described in
[docs/commercial-launch.md](docs/commercial-launch.md) and packaged with
`python3 scripts/package-portal.py`.

## How to play

Your first sortie runs a field coach that walks you through the loop in a live
sector, one prompt at a time. **Briefing** on the title screen (`B`) is the
manual.

**Stealth.** Each patrol has a vision cone and a hearing ring, both drawn on
the ground. Inside them, with line of sight, its detection meter fills: halfway
it investigates, full and it alerts its pack and the sector alarm goes up.
Break line of sight and stay quiet and the alarm times out. An arc around the
crosshair shows when something is watching you, and from which direction.

**Signature.** How far enemy sensors reach depends on how loud you are:
speed, a hot cannon and boost all add to it. Slow down and the cones visibly
shrink.

**Killing.** A shell that hits a hull that hasn't seen you does triple damage
(an *ambush*). A kill that never alerted pays 1.5× score (a *silent kill*). A
boost-ram is the quietest kill. A hull that survives a hit alerts immediately.

**The cannon** has no ammo, only heat. Past the redline it fires faster and
harder; at the top it locks up. Tap `R` to vent; tap again inside the band for
a perfect vent (instant clear plus supercharged shells). Venting also drops
your signature.

**Objectives.** Drive through an uplink ring once to start its hack; it
finishes on its own, but its pulses draw patrols. When the last uplink falls,
the sector goes on full alert and an extraction gate opens. Hold the gate for
four seconds to leave. Reaching it without ever tripping the alarm pays a
ghost-extraction bonus.

**Between and during sectors.** Kills, captures and salvage earn tech; each
tech level offers a three-choice upgrade draft that floats over live play and
auto-picks if you ignore it. After a clear you choose the next sector through a
warp gate; mutated gates pay a tech bonus. Every fifth sector is a Warlord boss
fight; the third Warlord (sector 15) ends the campaign, and the run can
continue past it.

**Difficulty.** Settings → Difficulty: Recruit (default), Standard or
Veteran. Daily Ops always runs Standard.

### Controls

| Key | Action |
| --- | --- |
| `W S` / `↑ ↓` | Drive / reverse |
| `A D` / `← →` | Steer |
| `Space` / click | Fire |
| `R` | Vent heat |
| `X` / right-click | Grenade |
| `V` / middle-click | Drop a mine |
| `Shift` | Boost (low grip — the tank drifts) |
| `S` + steer at speed | Handbrake slide |
| `C` | Chase / first-person camera |
| `P` / `Esc` | Pause (single-player) |
| `M` | Sound on/off |

Keys can be rebound in Settings → Controls. Gamepads work everywhere: left
stick drives, `A`/`RT` fire, `B`/`RB` grenade, `X` vent, `LB` mine, `LT`
boost, `Y` camera. On touch screens the left half is a floating joystick and
the right half fires.

### Enemies

One new type is introduced per sector:

- **Drone** (red) — the baseline patroller.
- **Hunter** (amber, sector 2+) — flanks, and only fires during its lunge.
- **Rusher** (pink, sector 3+) — kamikaze; one shell or a ram defuses it.
- **Shellback** (gunmetal, sector 4+) — frontal plate deflects shells.
- **Sniper** (violet, sector 6+) — long range, relocates after each shot.
- **Warden** (gold, sector 7+) — shields nearby packmates from cannon fire.
- **Phantom** (ice, sector 8+) — cloaked; visible just before it fires.
- **Warlord** (every 5th sector) — boss with four turrets guarding its core.

Elite variants appear from sector 3.

### Other modes and progress

- **Daily Ops** — one seeded arena per UTC day, same for everyone, with a
  shareable result and a streak.
- **Career** — XP, ranks, medals and per-chassis bests, stored in the browser
  and exportable as a code. Some medals unlock upgrades; the first Warlord kill
  unlocks the Marauder chassis. Higher ranks start runs with some tech.

## Online co-op & versus

Up to four players, peer-to-peer over WebRTC with no game server. The host
presses `H` and shares the room code or invite link; others press `J` or open
the link. The host picks **co-op campaign** or **versus** (first to 10 kills).

The host runs the simulation and streams 30 Hz snapshots; clients send input
and interpolate between snapshots. Signaling uses PeerJS's public broker. A
deployment with a TURN server can pass it in via `window.PA_ICE_SERVERS`
before `js/net.js` loads.

## Tests

```sh
npm test          # headless suites on plain Node
npm run e2e       # Playwright end-to-end
```

CI runs both (`.github/workflows/ci.yml`). `test/README.md` lists what each
suite covers.

## Code layout

```
index.html      shell and menu screens
style.css       styling
sw.js           offline cache
js/settings.js  settings and career progress (localStorage)
js/audio.js     synthesized SFX and music (Web Audio)
js/input.js     keyboard / mouse / touch / gamepad
js/geometry.js  procedural low-poly meshes
js/renderer.js  WebGL renderer: flat-shaded pass, shadow map, point lights,
                bloom / tonemap / FXAA / vignette
js/hud.js       radar, bars, exposure arc, messages (Canvas 2D)
js/tutorial.js  the field coach
js/game.js      simulation: arena generation, enemy AI and detection,
                projectiles, uplinks, drafts, extraction, versus
js/net.js       co-op / versus networking
js/main.js      screen flow, camera, grade, scene drawing, main loop
js/vendor/      PeerJS (MIT)
```

All code, art and sound are original. The game is inspired by the arena-tank
games of the era; no original assets or names are used.
