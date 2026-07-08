# PHANTOM ARENA — Retro Tank Shooter

A browser-based homage to the flat-shaded 3D tank arena games of the early
1990s — rebuilt around a modern momentum-roguelite core. Drive (and drift)
a hover-tank across a near-black neon grid, ride a **heat cannon's
redline** and perfect-vent it mid-firefight, hold uplink zones while the
arena warps in wave after wave to stop you, and spend the tech you earn on
**3-choice upgrade drafts** that turn your cannon into something absurd by
mid-run. Between sectors you pick your route through **warp gates** —
mutated high-risk sectors pay signing bonuses. Speed is armor, grazing
enemy fire refunds boost, kill variety drives the score multiplier, and
everything you earn rides an unbanked **pot** until you cash it out at a
zone. Bouncy walls, boost-ram kills, kamikaze rushers, armored shellbacks,
shield-warden packs, cloaked phantoms and tanks that shatter into tumbling
polygon shards.

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

Secure **all uplink zones** in the sector to advance. A zone isn't a
touch-and-go flag: drive into its ring and **hold it** while the uplink
fills. Starting a capture trips the **zone alarm** — a converge wave warps
in around you while the bar climbs, so every objective is a set-piece fight.
Leave, and the progress drains away. Your hull is gone when shields hit zero.

The sector never goes quiet. Hostiles keep warping in on a **pressure
timer that tightens the longer you stay** — camping behind a slab is a
losing strategy, and most waves lead with rushers that come straight at you.
Sector 1 opens gently: three zones, a light garrison, a long breather
before the first pressure wave, and your first capture doesn't trip the
alarm. The screw turns from sector 2 on.

Getting overwhelmed? **SETTINGS → DIFFICULTY** has three campaign presets:
**RECRUIT** stretches the pressure timer, trims the alarm waves and softens
incoming fire while you learn the systems, **STANDARD** is the game as
designed, and **VETERAN** turns all of it up. Stay unhit for a few seconds
and your hull **self-repairs** — fully on RECRUIT, to about two-thirds on
STANDARD, never on VETERAN, where a depot is the only way back. Daily Ops
always runs STANDARD so the shared leaderboard seed stays a level playing
field.

### The heat cannon — ride the redline, nail the vent

There is no ammo. The cannon builds **heat** per shell — and past the
redline ticks it fires *faster and harder*, so skilled play lives near the
top of the bar. Redline past the max and the gun locks up for seconds you
don't have. Tap `R` to **vent** manually: a marker sweeps the bar, and a
second tap inside the highlighted band is a **perfect vent** — instant
clear plus a burst of supercharged shells. Coolant depots and pickups vent
for you; the COOLANT LOOP and VENT TUNING upgrades tune the whole system.

### Momentum is everything

The hull points where you steer; your **velocity** has its own ideas.
Boosting drops the tread grip so the tank **drifts** — swing the gun
through a slide while your momentum carries the line — and pulling reverse
*while steering* at speed is a **handbrake slide** (a straight back-pull
just brakes hard, then backs up). Above ~70% speed the hull sheds a
third of any hit (**speed is armor**), boost-rams scale with impact speed,
and an enemy shell that *nearly* clips you is a **graze**: it refunds
boost, pays a tick of tech and keeps your combo window alive. Experts
thread fire on purpose.

### Style pays, greed decides

The combo multiplier runs on **variety**: repeat the same kill method and
the chain cools; mix cannon, ram, grenade, mine and shockwave kills and it
climbs to ×5 — and the multiplier boosts your **tech income**, so stylish
play literally builds faster. Kill score doesn't bank directly: it rides
an at-risk **POT** that cashes out when you capture a zone (or down a boss
milestone). Take a hit and 30% of the pot spills. One more fight at ×5, or
cash out now? That question never goes away.

### Warp gates & bounties — plan the run

After each clear you choose the next sector through a **warp gate**:
STANDARD, or a mutated route that pays a **tech signing bonus** — SWARM
PROTOCOL (relentless thin-hull waves), BARREN GRID (no depots), ELITE
SURGE, VOLATILE HULLS (every kill detonates), or the all-elite GAUNTLET.
Every sector also posts an optional **bounty** (3 ram kills, graze 8
shots, reach ×4...) that pays the whole squad in tech. Daily Ops seeds the
gate offers too, so everyone plays the same map.

### Tech drafts — build your tank mid-run

Kills, captures and salvage pay **TECH**. Each tech level deals a
**3-choice upgrade draft**: twin cannons, ricochet rounds, piercing cores,
cluster grenades, shock discharges, ram plating, shield siphons and more —
sixteen stackable upgrades that compound into a build. Solo, the war waits
while you choose; in co-op the fight doesn't pause, so you pick under fire
(press `1 2 3`, tap, or click). By sector 5 no two runs fight alike.

**Movement is a weapon.** Slam into a hostile at boost speed and it
shatters — a boost-ram costs a scratch of shields (nothing with RAM
PLATING) and it's the flashiest way to deal with a rusher bearing down
on you.

Sector terrain comes in four flavors so no two runs blur together: the
classic **scatter** of slabs, long broken **wall corridors** that channel
firefights down lanes, a central **bastion** with a gate on each side, and
**cover rings** thrown around the zone sites so every objective is a small
breach-and-clear. Daily Ops layouts stay identical for everyone — the
generators all run off the day's seed.

Every zone you secure raises the sector **alert level**: survivors get
faster and more trigger-happy, and crossing a threshold warps
**reinforcements** in near the remaining zones — sectors end in a
crescendo, not a mop-up. When only a couple of zones remain they light up
with **beacon pillars** (and pin to the radar rim), so the last objective
is a fight, never a search.

Kills within a few seconds of each other chain into a **combo multiplier**
(up to ×5) that also boosts zone captures — but taking a single hit breaks
the chain. Boost into a cluster and grenade it for big numbers; play sloppy
and the score dries up.

Every **5th sector** has no zones at all. Instead, a **WARLORD** holds the
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
kills, zones secured, warlords downed, best combo and best sector — all in your
browser. Two things are earned:

- **MARAUDER chassis** — a fourth loadout (fast, armored, a small cooling
  plant, heavy on mines) unlocked by destroying your first WARLORD.
- **Checkpoint starts** — once you fight past a WARLORD, the loadout screen
  lets you start at the sector after it (6, 11, …) instead of replaying the
  early game.

### Settings

The **SETTINGS** screen has the campaign **DIFFICULTY** preset (RECRUIT /
STANDARD / VETERAN), SFX and music volume, screen-shake intensity,
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
| `Space` / click | Fire cannon (builds heat — watch the redline) |
| `R` | Vent heat — tap again in the band for a **perfect vent** |
| `X` / right-click | Lob a grenade (arcs over obstacles, splash damage) |
| `V` / middle-click | Drop a proximity mine behind you |
| `Shift` | Turbo boost (drains the gauge; low grip — the tank drifts) |
| `S` + steer at speed | Handbrake slide (keep momentum, swing the gun) |
| `C` | Toggle first-person / chase camera |
| `P` / `Esc` | Pause (single-player) |
| `M` | Toggle sound |
| `D` | Start today's Daily Ops |
| `H` | Host an online co-op / versus game |
| `J` | Join a game by room code |

### Gamepad

Plug in any standard controller and it just works, menus included:
left stick drives and steers, `A`/`RT` fires, `B`/`RB` lobs a grenade,
`X` vents, `LB` drops a mine, `LT` boosts, `Y` toggles the camera,
`Start` pauses, and the d-pad or stick navigates every menu.

### Touch controls

On phones and tablets the game switches to a full touch scheme:

- **Floating joystick** — touch anywhere on the left half and a stick spawns
  under your thumb. Push where you want to go: forward arcs drive and steer,
  sideways pivots in place, and the whole back half reverses — pull
  back-and-to-a-side and the tank backs toward your thumb, so reverse steers
  just like forward. The base stays anchored where you touched down;
  overshooting the rim just clamps at full deflection.
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
- **VANGUARD** — balanced, the best cooling plant
- **JUGGERNAUT** — slow, heavily shielded, extra mines
- **MARAUDER** — fast *and* armored but quick to overheat, packs the most mines —
  unlocked by destroying a WARLORD

### Enemies

Each hostile fights its own way, and all of them steer around cover and
scatter from a grenade in the air instead of sitting under it:

- **Drone** (red) — patroller, guards the zones; shot-up drones break off
  and fall back on the nearest packmate, so wounded stragglers regroup into
  clusters instead of trickling in
- **Rusher** (hot pink, sector 2+) — kamikaze hull that strobes like a lit
  fuse and beelines straight at you; it detonates on contact, dies to a
  single shell, chain-pops into anything beside it — and a boost-ram
  defuses it entirely
- **Shellback** (gunmetal, sector 3+) — slow siege hull whose frontal
  plate deflects shells; flank the arc, lob over it, or ram straight
  through it
- **Warden** (gold, sector 4+) — projects a cannon-proof umbrella over
  every packmate near it and shepherds the pack; grenades, mines, rams and
  shockwaves ignore the dome — or kill the warden and shoot what's left
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
each sector: **coolant**, **shield repair**, **grenades**, **mines**,
**overdrive** (speed boost) and **rapid fire**. Every sector also has a
glowing **coolant depot** and **shield depot** — park on the pad to vent
and repair. Sector-clear bonus scales with remaining shields, kills and
the pot you carried over the line. High score,
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
js/hud.js       radar, shield/heat/vent bars, pot & bounty, scoreboard (Canvas 2D)
js/game.js      arena generation (four terrain layouts), players, per-type
                enemy AI, projectiles, pickups, seeded daily arenas, versus
                rules, TECH upgrade drafts, uplink zones, spawn pressure
js/net.js       WebRTC co-op/versus networking (host-authoritative, PeerJS,
                client-side snapshot interpolation)
js/main.js      screen flow, camera, scene drawing, main loop
js/vendor/      bundled third-party code (PeerJS, MIT licensed)
```

All code, art and sound are original. The gameplay is inspired by the
arena-tank classics of the era; no original assets or names are used.
