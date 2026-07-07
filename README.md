# PHANTOM ARENA — Retro Tank Shooter

A browser-based homage to the flat-shaded 3D tank arena games of the early
1990s. Drive your hover-tank across a vast, near-black neon grid, secure
every flag in the sector, and survive the faceted hunters that emerge from
the dark. Bouncy walls, turbo boost, lobbed grenades, resupply depots,
cloaked phantoms and tanks that shatter into tumbling polygon shards.

Built with **plain WebGL, Canvas 2D and Web Audio** — no build step, no
assets, no CDNs. Even the **synthwave soundtrack is synthesized live** by a
tiny sequencer: a brooding loop under the menus, a driving groove in combat
that opens up as the sector alert and your combo climb, and a harder mix
while a WARLORD is on the field. Single-player makes no network requests at
all. Optional
**online co-op** uses one small bundled library (PeerJS, in `js/vendor/`)
for peer-to-peer connections; nothing else needs to be hosted.

## Play

Open `index.html` in any modern browser, or serve the folder statically:

```sh
npx http-server .        # or: python3 -m http.server
```

It also works hosted on GitHub Pages (Settings → Pages → deploy from branch).
When served over http(s) a small service worker caches everything, so the
game is **installable as a PWA and fully playable offline** (co-op excepted).

## How to play

Secure **all flags** in the sector to advance. Enemy tanks guard the flags
and will hunt you on sight. Your hull is gone when shields hit zero.

Sector terrain comes in four flavors so no two runs blur together: the
classic **scatter** of slabs, long broken **wall corridors** that channel
firefights down lanes, a central **bastion** with a gate on each side, and
**cover rings** thrown around the flag sites so every objective is a small
breach-and-clear. Daily Ops layouts stay identical for everyone — the
generators all run off the day's seed.

Every flag you take raises the sector **alert level**: survivors get faster
and more trigger-happy, and crossing a threshold warps **reinforcements** in
near the remaining flags — sectors end in a crescendo, not a mop-up. When
only a couple of flags remain they light up with **beacon pillars** (and pin
to the radar rim), so the last objective is a fight, never a search.

Kills within a few seconds of each other chain into a **combo multiplier**
(up to ×5) that also boosts flag captures — but taking a single hit breaks
the chain. Boost into a cluster and grenade it for big numbers; play sloppy
and the score dries up.

Every **5th sector** has no flags at all. Instead, a **WARLORD** holds the
arena: a huge hovercruiser that crushes the very slabs you'd hide behind,
telegraphs a ramming charge, and shields its core behind four destroyable
turrets. Strip the turrets, then hammer the exposed core — while outrunning
(boost!) or blocking (cover!) the shockwave rings it slams out.

From **sector 3** on, some hostiles warp in as **ELITE** variants — bigger,
faster, harder-hitting hulls that strobe white-hot and wear a ring on the
radar. They're worth half again the score.

Alongside grenades you carry **proximity mines** (`V`): dropped off the tail,
they arm after a beat and detonate on anything hostile that rolls over them —
the perfect parting gift when you boost out of a furball, and they work on
the WARLORD too.

While you fight, the HUD races your own past self: pass your record and the
score turns gold with a **RECORD PACE** tag (dailies chase today's best,
campaign runs chase the all-time high). Fall just short and the game-over
screen tells you exactly how far — *"ONLY 340 FROM YOUR RECORD"*.

### Daily Ops

**DAILY OPS** on the title screen deals one seeded arena per UTC day — the
same layout for every player in the world, fought in a standard-issue
VANGUARD. Your best result for the day is kept, and the game-over screen has
a **COPY RESULT** button that puts a shareable score card on your clipboard.
No accounts, no server: the date itself is the seed.

Finishing a daily keeps your **streak** alive: consecutive days stack up on
the title screen and the share card, and the DAILY OPS button reminds you
when today's run would keep the chain going.

### Rank, medals, career & checkpoints

Every run — campaign, daily, even a doomed one — pays **XP** into a
12-step career ladder, RECRUIT through PHANTOM LEGEND. The game-over screen
shows the XP bar filling and exactly how much is left to the next
promotion.

Twelve **medals** mark one-time feats: a ×5 combo, a sector cleared without
taking a hit, three mine kills in one mission, a 3-day daily streak, and
more. They pop mid-run with a toast and a jingle, and hang on the medal
wall in the service record.

The **SERVICE RECORD** screen tracks the rest of your career: missions,
kills, flags, warlords downed, best combo and best sector — all in your
browser. Two things are earned:

- **MARAUDER chassis** — a fourth loadout (fast, armored, light on ammo,
  heavy on mines) unlocked by destroying your first WARLORD.
- **Checkpoint starts** — once you fight past a WARLORD, the loadout screen
  lets you start at the sector after it (6, 11, …) instead of replaying the
  early game.

### Settings

The **SETTINGS** screen has SFX and music volume, screen-shake intensity,
the **GLOW FX** post-processing pipeline (bloom, dynamic explosion lighting
and FXAA — turn it off on weak GPUs), the CRT
scanline overlay, aim assist, and a **colorblind hull palette**
(deuteranopia-safe enemy colors; the radar also gives every enemy type its
own blip shape regardless).

All menus work with keyboard (arrows + Enter, Esc to go back), mouse, touch
and **gamepad** alike — pick whatever is closest to hand.

| Control | Action |
| --- | --- |
| `W S` / `↑ ↓` | Drive forward / reverse |
| `A D` / `← →` | Steer |
| `Space` / click | Fire cannon |
| `X` / right-click | Lob a grenade (arcs over obstacles, splash damage) |
| `V` / middle-click | Drop a proximity mine behind you |
| `Shift` | Turbo boost (drains the boost gauge; recharges when idle) |
| `C` | Toggle first-person / chase camera |
| `P` / `Esc` | Pause (single-player) |
| `M` | Toggle sound |
| `D` | Start today's Daily Ops |
| `H` | Host an online co-op / versus game |
| `J` | Join a game by room code |

### Gamepad

Plug in any standard controller and it just works, menus included:
left stick drives and steers, `A`/`RT` fires, `B`/`RB` lobs a grenade,
`X`/`LB` drops a mine, `LT` boosts, `Y` toggles the camera, `Start` pauses,
and the d-pad or stick navigates every menu.

### Touch controls

On phones and tablets the game switches to a full touch scheme:

- **Floating joystick** — touch anywhere on the left half and a stick spawns
  under your thumb. Push where you want to go: forward arcs drive and steer,
  sideways pivots in place, straight back reverses. The base stays anchored
  where you touched down; overshooting the rim just clamps at full deflection.
- **Hold to fire** — anywhere on the right half, or the big FIRE button.
  A touch-friendly hint of aim assist snaps shots onto targets that are
  almost lined up (it applies to all players equally, so co-op stays fair).
- **On-screen buttons** — NADE (grenade, shows your count), BOOST (shows the
  gauge around its rim), CAM and pause in the top corner.
- Launching a run goes fullscreen in landscape where the browser allows it,
  and the chase camera becomes the default (toggle back with CAM).

## Online co-op & versus

Up to **four players** can play together over the internet — and it
still works on plain static hosting like GitHub Pages, because there is no
game server to run.

- One player picks **HOST CO-OP / VERSUS** (or presses `H`) and is given a
  4-character **room code** — click the code to copy an **invite link**.
- Everyone else picks **JOIN GAME** (or presses `J`) and types that code, or
  simply opens the invite link (`index.html?join=CODE`) to jump straight into
  the lobby.
- In the lobby the host picks the mode — **CO-OP CAMPAIGN** or
  **VERSUS — FIRST TO 10** — then hits **LAUNCH**.

**Co-op:** teammates spawn side by side. Fallen tanks respawn after a few
seconds as long as a teammate is still fighting; if everyone is destroyed at
once, the run ends. Each sector restores the whole squad.

**Versus:** the squad turns on itself in a single deathmatch arena — corner
spawns, contested powerups and depots, mines that only trip on your rivals,
and a live scoreboard under the radar. Everyone always respawns; the first
tank to **10 kills** takes the arena, and the host can call an instant
rematch.

**How it works.** It's **host-authoritative peer-to-peer over WebRTC**
([PeerJS](https://peerjs.com/)). The host's browser runs the authoritative
simulation and streams 30 Hz snapshots to the others, who send their input
back up. Joiners **interpolate between snapshots** — remote tanks, shots and
the WARLORD are rendered ~100 ms in the past and blended between the two
snapshots that bracket the render time, so everything glides at full display
framerate instead of stepping at the snapshot rate; your own tank rides the
freshest snapshot, dead-reckoned forward to hide the quantization.
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
- **JUGGERNAUT** — slow, heavily shielded, extra mines
- **MARAUDER** — fast *and* armored but light on ammo, packs the most mines —
  unlocked by destroying a WARLORD

### Enemies

Each hostile fights its own way, and all of them steer around cover and
scatter from a grenade in the air instead of sitting under it:

- **Drone** (red) — patroller, guards flags; shot-up drones break off and
  fall back on the nearest packmate, so wounded stragglers regroup into
  clusters instead of trickling in
- **Hunter** (amber, sector 2+) — weaves between wide flanking arcs and
  straight lunges; it can only line up a shot during the lunge, so the
  rhythm is readable — and punishable
- **Sniper** (violet, sector 4+) — holds range, hits hard from far away,
  and **relocates after every shot**: return fire arrives where the sniper
  was, not where it is
- **Phantom** (ice, sector 5+) — cloaked stalker; shimmers into view a moment
  before it fires, and vanishes from radar while cloaked
- **Warlord** (crimson, every 5th sector) — boss hovercruiser; four turrets
  shield its core, it crushes cover, rams, and emits shockwave rings

### Pickups & depots

Destroyed enemies sometimes drop supplies; a few crates are scattered around
each sector: **ammo**, **shield repair**, **grenades**, **mines**,
**overdrive** (speed boost) and **rapid fire**. Every sector also has a
glowing **ammo depot** and **shield depot** — park on the pad to resupply.
Sector-clear bonus scales with remaining shields, ammo and kills. High score,
daily bests, settings and your service record are all kept in your browser.

Watch your speed near the arena's slabs: slam into one fast enough and your
tank rebounds off it.

## Code layout

```
index.html      shell + menu screens
style.css       retro CRT styling
sw.js           offline cache (installable PWA; single-player works offline)
js/settings.js  persistent settings + career progress, XP/ranks, medals,
                daily streak (localStorage)
js/audio.js     synthesized SFX, engine hum & the procedural synthwave
                soundtrack (Web Audio lookahead sequencer, no sound files)
js/input.js     keyboard / mouse / touch / gamepad
js/geometry.js  procedural low-poly meshes
js/renderer.js  WebGL renderer + mat4 helpers: flat-shaded forward pass,
                dynamic point lights, additive glow draws, and the bloom /
                FXAA / vignette post-processing chain
js/hud.js       radar, shields/ammo bars, scoreboard, messages (Canvas 2D)
js/game.js      arena generation (four terrain layouts), players, per-type
                enemy AI, projectiles, pickups, seeded daily arenas, versus
                rules
js/net.js       WebRTC co-op/versus networking (host-authoritative, PeerJS,
                client-side snapshot interpolation)
js/main.js      screen flow, camera, scene drawing, main loop
js/vendor/      bundled third-party code (PeerJS, MIT licensed)
```

All code, art and sound are original. The gameplay is inspired by the
arena-tank classics of the era; no original assets or names are used.
