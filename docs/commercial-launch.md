# Phantom Arena: first commercial launch

Prepared September 9, 2026. This is an execution plan, not a revenue forecast.
No player counts, retention data, earnings, publisher agreement, or developer
account were available for this review. Code changes alone cannot establish demand.

## Commercial direction

Lead with **a tank game where staying unseen is your strongest weapon**.
The distinctive moment is an ambush followed by an alarm and a narrow escape.
The first trailer should demonstrate that loop immediately. The existing daily
arenas, drafts, career unlocks, and campaign already offer reasons to return;
measure whether players discover and enjoy them before adding another progression system.

The first distribution experiment is the solo browser edition on CrazyGames.
This fits the existing small, dependency-light WebGL game and gives us a way to
measure discovery and retention. CrazyGames has a Basic Launch evaluation before
selection for Full Launch; Basic Launch does **not** pay ad revenue. Acceptance
and Full Launch selection are not guaranteed. See the [launch requirements](https://docs.crazygames.com/requirements/intro/).

## What this change delivers

- A separate CrazyGames package with SDK v3 initialization, gameplay events,
  platform audio settings, and midgame ad callbacks.
- Direct entry into solo gameplay in that edition. Campaign difficulty and the
  existing field coach remain in effect. The ordinary game still opens its menu.
- Ad opportunities only when choosing the next campaign sector or retrying a
  finished campaign run, after three active gameplay minutes since the previous
  request. No ads in Daily Ops, co-op, or live combat; no purchased power.
- A frozen game and blocked game UI throughout the ad request. Muting starts on
  `adStarted`; completion, no-fill, adblock errors, thrown errors, and rejected
  requests restore play. The user's audio preference is preserved, including
  when the portal independently requires muting.
- SDK loading failure falls back to gameplay after at most four seconds. An
  already-started ad is never timed out into live gameplay underneath it.
- Daily invitations containing the UTC day, build, and self-reported score.
  Mobile native sharing, clipboard fallback, and selectable text when both fail.
  The recipient sees a clear invitation and launches the daily arena in one click.
  Old dates point players to today's arena. Targets from different builds are
  discarded. Invitation scores never become stored scores or authoritative ranks.
- Portal sharing uses SDK public invite links, not CDN iframe addresses.
- Campaign score sharing in the ordinary build; existing co-op sharing remains.
- The normal game retains its offline service worker and makes no SDK requests.
  The portal edition does not register the worker or expose co-op/versus menus;
  portal multiplayer needs its own room and invite integration before release.

The integration follows the [SDK initialization](https://docs.crazygames.com/sdk/intro/),
[game events](https://docs.crazygames.com/sdk/game/),
[video callback](https://docs.crazygames.com/sdk/video-ads/), and
[advertising requirements](https://docs.crazygames.com/requirements/ads/) documentation.
Real ad fill and approval must be verified in the publisher preview; a mocked
SDK test cannot establish either.

## Build and submission

```sh
node test/run.js
node test/e2e.mjs
python3 scripts/package-portal.py
```

Upload `dist/phantom-arena-crazygames.zip` with `index.html` at its root.
The script also writes an unpacked `dist/crazygames/` for local preview.
CI attaches the ZIP as the `phantom-arena-crazygames` workflow artifact.
The package copies an explicit set of runtime assets and licenses; it excludes
repository history, tests, docs, and the service worker. Do not deploy this
edition over the ordinary PWA on the same origin/path.

The publisher-account steps remain to be completed by the owner:

1. Open the [CrazyGames developer portal](https://developer.crazygames.com/),
   establish the publishing account, and review the actual commercial terms.
2. Upload the ZIP to Preview. Test real SDK init, no-fill, ads disabled, audio
   mute, invitation parameters, touch controls, and uninterrupted Daily Ops.
3. Provide gameplay covers and video meeting the current
   [cover specifications](https://docs.crazygames.com/requirements/game-covers/).
   Capture actual gameplay; the repo's tiny app icon is not a store cover.
4. Submit the solo edition for Basic Launch. Do not claim multiplayer for this
   package. Complete payout onboarding when the platform requires it.
5. Address QA feedback and any remaining applicable Full Launch requirements
   before enabling a commercial release. Cloud account progress and platform
   multiplayer are not implemented in this change.

No account has been created, game submitted, paid campaign purchased, or live
monetization activated by this PR.

## Listing copy and capture brief

**Name:** Phantom Arena

**Short description:** Hunt unseen. Strike hard. Escape the alarm. A 3D tank
stealth roguelite with daily challenges and a heat cannon that gives you away.

**Description:** Slip between patrols and take the shot before they see you.
Every cannon blast raises your signature. Hack the uplinks, draft upgrades,
and escape as the entire sector wakes up. Push through fifteen campaign
sectors and three warlords, or challenge a friend on the same Daily Ops arena.
Play with keyboard, gamepad, or touch controls.

**Controls:** W/S or arrows drive; A/D or arrows steer; Space fires; Shift
boosts; R vents; X throws a grenade; V lays a mine; C changes camera; Escape
pauses. Touch controls appear on mobile. Gamepad supported.

**Capture three hooks:** (1) silent ambush → alarm → escape, (2) drifting
boost-ram → upgrade draft → larger enemy, (3) Daily Ops score → friend
challenge. Show the action in the first two seconds. Record a clean 15–20
second clip for each. Only feature mechanics visible in that capture, and
keep text legible on a phone. Prepare drafts before requesting creator outreach
or posting to communities; no messages have been sent.

## First month: decisions from player data

Basic Launch normally evaluates at least seven days and 500 plays, ending at
21 days if the play threshold is not reached. The platform automatically tracks
playtime, next-day retention, and one-minute conversion. Its published reference
points are 10+ minutes average playtime, 10–15% Day 1 retention, and 80%+
one-minute conversion for strong performers; these are reference points, not
promised acceptance gates. [Basic Launch metrics](https://docs.crazygames.com/resources/basic-launch-metrics/)

| Window | Work | Decision |
| --- | --- | --- |
| Days 1–3 | Finish publisher preview and listing assets; watch five first-time players reach an uplink and extract | Fix the first repeated point of confusion |
| Days 4–10 | Run Basic Launch; record daily cohorts, device mix, conversion, playtime, D1 retention, and QA issues | Establish a baseline before changing several things |
| Days 11–17 | Change the largest demonstrated drop-off: controls/onboarding for low conversion, pacing for short sessions, return motivation for weak D1 | Compare cohorts at similar device/source mix; small samples remain uncertain |
| Days 18–30 | Reassess publisher feedback and selection; if monetized, measure filled ads, revenue per play, and retained-player revenue | Expand only when the evidence supports it |

Use the publisher dashboard as the initial measurement source. This change does
not send custom analytics to a new endpoint or pretend that local browser stats
measure a population. Add event instrumentation only when a real analytics
destination and its data handling are selected.

If conversion is weak, inspect a real first session before buying traffic. If
retention is weak, test the daily invitation and the first meaningful unlock.
If players stay but earnings are weak, inspect eligible breaks, actual fill,
geography, and publisher revenue terms. Do not equate an ad request with an
impression or an impression with a payout.

## What “a lot of money” requires

Illustrative ad-only sensitivity, assuming **two filled impressions per active
player per day**. The eCPM below means **developer revenue per 1,000 filled
impressions after the platform's share**, before your expenses and taxes.
These are chosen scenario inputs, not reported CrazyGames rates or a promise
that this game's eligible breaks will produce two impressions.

`monthly developer revenue = DAU × 30 × filled ads per DAU × developer eCPM / 1000`

| Daily active players | $3 developer eCPM | $6 developer eCPM | $10 developer eCPM |
| ---: | ---: | ---: | ---: |
| 1,000 | $180 | $360 | $600 |
| 10,000 | $1,800 | $3,600 | $6,000 |
| 100,000 | $18,000 | $36,000 | $60,000 |

At the middle assumptions, $10,000/month requires about **27,778 DAU** and
$100,000/month about **277,778 DAU**. At one filled impression per day, required
DAU doubles. This makes distribution and return visits the critical commercial
questions. A monetization button alone cannot deliver that audience.

Keep paid acquisition spend at $0 during this first test. Before a budget is
approved, obtain actual retained-cohort revenue per acquired player, account for
all variable costs, and set an explicit loss cap. Consider a separate premium
edition only after players demonstrate demand for more content; choose its price
and platform from that evidence. This PR adds no checkout, invented entitlement,
subscription, purchase commitment, or paid acquisition campaign.
