# PHANTOM ARENA — Retro Tank Shooter

A browser-based homage to the flat-shaded 3D tank arena games of the early
1990s. Drive your hover-tank across a vast, near-black neon grid, secure
every flag in the sector, and survive the faceted hunters that emerge from
the dark. Bouncy walls, turbo boost, lobbed grenades, resupply depots,
cloaked phantoms and tanks that shatter into tumbling polygon shards.

Built with **plain WebGL, Canvas 2D and Web Audio** — no build step and no
assets. Single-player runs with zero dependencies and makes no network
requests. Optional **online co-op** adds one small library (PeerJS, loaded
from a CDN) for peer-to-peer connections; nothing else needs to be hosted.

## Play

Open `index.html` in any modern browser, or serve the folder statically:

```sh
npx http-server .        # or: python3 -m http.server
```

It also works hosted on GitHub Pages (Settings → Pages → deploy from branch).

## How to play

Secure **all flags** in the sector to advance. Enemy tanks guard the flags
and will hunt you on sight. Your hull is gone when shields hit zero.

All menus work with keyboard (arrows + Enter, Esc to go back), mouse and
touch alike — pick whatever is closest to hand.

| Control | Action |
| --- | --- |
| `W S` / `↑ ↓` | Drive forward / reverse |
| `A D` / `← →` | Steer |
| `Space` / click | Fire cannon |
| `X` / right-click | Lob a grenade (arcs over obstacles, splash damage) |
| `Shift` | Turbo boost (drains the boost gauge; recharges when idle) |
| `C` | Toggle first-person / chase camera |
| `P` / `Esc` | Pause (single-player) |
| `M` | Toggle sound |
| `H` | Host an online co-op game |
| `J` | Join a co-op game by room code |

Touch devices: left half of the screen steers and drives, right half fires.

## Online co-op

Up to **four players** can clear sectors together over the internet — and it
still works on plain static hosting like GitHub Pages, because there is no
game server to run.

- One player picks **HOST CO-OP** (or presses `H`) and is given a 4-character
  **room code** — click the code to copy an **invite link**.
- Everyone else picks **JOIN CO-OP** (or presses `J`) and types that code, or
  simply opens the invite link (`index.html?join=CODE`) to jump straight into
  the lobby.
- The host hits **LAUNCH**; teammates spawn alongside each other.

Fallen tanks respawn after a few seconds as long as a teammate is still
fighting; if everyone is destroyed at once, the run ends. Each sector restores
the whole squad.

**How it works.** It's **host-authoritative peer-to-peer over WebRTC**
([PeerJS](https://peerjs.com/)). The host's browser runs the authoritative
simulation and streams snapshots to the others, who send their input back up.
Signaling uses PeerJS's free public broker, so the game stays a pile of static
files — perfect for GitHub Pages. Best for 2–4 players on reasonable
connections; the host has zero latency, and joiners feel a little network lag
on their own tank. (Want dedicated rooms, matchmaking or reconnects? Swap the
`js/net.js` transport for a hosted realtime backend such as Firebase, Supabase,
PartyKit or Ably — the rest of the game is unchanged.)

### Vehicle configuration

Before deploying, allocate your tank's power — a classic trade-off:

- **SCOUT** — fast and agile, thin shields
- **VANGUARD** — balanced, extra ammo
- **JUGGERNAUT** — slow, heavily shielded

### Enemies

- **Drone** (red) — patroller, guards flags
- **Hunter** (amber, sector 2+) — fast, relentless pursuit, leads your movement
- **Sniper** (violet, sector 4+) — holds range, hits hard from far away
- **Phantom** (ice, sector 5+) — cloaked stalker; shimmers into view a moment
  before it fires, and vanishes from radar while cloaked

### Pickups & depots

Destroyed enemies sometimes drop supplies; a few crates are scattered around
each sector: **ammo**, **shield repair**, **grenades**, **overdrive** (speed
boost) and **rapid fire**. Every sector also has a glowing **ammo depot** and
**shield depot** — park on the pad to resupply. Sector-clear bonus scales
with remaining shields, ammo and kills. High score is kept in your browser.

Watch your speed near the arena's slabs: slam into one fast enough and your
tank rebounds off it.

## Code layout

```
index.html      shell + menu screens
style.css       retro CRT styling
js/audio.js     synthesized SFX & engine hum (Web Audio)
js/input.js     keyboard / mouse / touch
js/geometry.js  procedural low-poly meshes
js/renderer.js  minimal WebGL flat-shaded renderer + mat4 helpers
js/hud.js       radar, shields/ammo bars, messages (Canvas 2D)
js/game.js      arena generation, players, enemy AI, projectiles, pickups
js/net.js       WebRTC co-op networking (host-authoritative, PeerJS)
js/main.js      screen flow, camera, scene drawing, main loop
```

All code, art and sound are original. The gameplay is inspired by the
arena-tank classics of the era; no original assets or names are used.
