/* FIELD COACH — the game's only teacher.
 *
 * PHANTOM ARENA stacks a dozen systems on each other: signature, sensor
 * cones, the two-stage detect meter, ambush damage, the heat/vent rhythm,
 * spiked uplinks, the at-risk pot, combo variety, tech drafts, extraction.
 * None of it is discoverable by mashing SPACE, and a README nobody opens is
 * not onboarding. This walks a new pilot through the loop *inside a live
 * sector* — no separate mode, no gated cage, nothing paused. It watches what
 * the player actually does and moves on when they've done it.
 *
 * Two rules keep it from being a nuisance:
 *   - it never blocks. Every step is advisory; the sector runs normally and
 *     a player who ignores the card entirely still finishes the mission.
 *   - it never lags behind. Each frame it jumps to the furthest step the
 *     player has NOT already satisfied, so doing things out of order (or
 *     already knowing the game) skips the lesson instead of teaching it late.
 *
 * Steps live sim-side so the headless suites can drive them; the HUD only
 * draws whatever `game.coach` is pointing at.
 */

/* The ordered walk is the MISSION: roll out, go cold, take a hull, spike the
 * grid, get out. Side systems (heat, the pot, the alarm) are not steps —
 * they are situational callouts below, because they become relevant on their
 * own schedule and an ordered step would either block the mission or get
 * skipped before the player ever met the system.
 *
 * Each step: what it teaches, the control that does it, and the state that
 * proves the player got it. */
const COACH_STEPS = [
  {
    id: 'move',
    title: 'ROLL OUT',
    hint: 'W S THROTTLE  ·  A D STEER  ·  SHIFT BOOST',
    touch: 'LEFT THUMB DRIVES AND STEERS',
    done: (g, p, s) => s.dist > 60,
  },
  {
    id: 'cold',
    title: 'RUN COLD',
    hint: 'SIGNATURE IS HOW FAR THEY SEE — EASE OFF AND WATCH THE CONES PULL BACK',
    touch: 'SIGNATURE IS HOW FAR THEY SEE — EASE OFF THE STICK',
    done: (g, p, s) => s.coldT > 1.5,
  },
  {
    id: 'ambush',
    title: 'STRIKE FIRST',
    hint: 'A SHELL ON A HULL THAT NEVER SAW YOU IS AN AMBUSH — TRIPLE DAMAGE. SPACE FIRES',
    touch: 'A SHELL ON A HULL THAT NEVER SAW YOU IS AN AMBUSH — HOLD THE RIGHT HALF TO FIRE',
    done: (g, p, s) => s.kills > 0,
  },
  {
    id: 'spike',
    title: 'SPIKE AN UPLINK',
    hint: 'CLIP A ZONE RING ONCE — THE HACK RUNS ITSELF FROM THERE. IT IS LOUD',
    touch: 'CLIP A ZONE RING ONCE — THE HACK RUNS ITSELF FROM THERE. IT IS LOUD',
    done: (g) => g.flags.some((f) => f.spiked),
  },
  {
    id: 'clear',
    title: 'SECURE THE SECTOR',
    hint: 'SPIKE EVERY UPLINK — THE LAST ONE WAKES THE GRID AND OPENS THE WAY OUT',
    touch: 'SPIKE EVERY UPLINK — THE LAST ONE OPENS THE WAY OUT',
    done: (g) => !!g.exit,
  },
  {
    id: 'extract',
    title: 'EXTRACT',
    hint: 'THE GATE IS OPEN AND THE SECTOR IS AWAKE — BOOST FOR IT',
    touch: 'THE GATE IS OPEN AND THE SECTOR IS AWAKE — BOOST FOR IT',
    done: () => false,   // the sector clear ends this one
  },
];

/* One-shot situational callouts. These are not part of the ordered walk —
 * they fire the first time a situation the player cannot otherwise read
 * happens to them, and each fires at most once per run. They stay on for
 * a few missions after the walk is finished, because "why did that happen"
 * is a different question from "what do I press". */
const COACH_TIPS = [
  {
    // the gun has no ammo counter, so a hot bar is the only warning a player
    // gets — say it while there is still room to act on it
    id: 'heat',
    when: (g, p) => p.heat > p.maxHeat * 0.55 && p.overheatT <= 0,
    text: 'NO AMMO — HEAT. TAP R TO VENT, TAP AGAIN IN THE BAND FOR SUPERCHARGED SHELLS',
    color: '#e8c75a',
    tier: 'info',
  },
  {
    id: 'alarm',
    when: (g) => (g.alarmT || 0) > 0 && !g.exit,
    text: 'ALARM UP — BREAK LINE OF SIGHT AND RUN COLD AND THE HUNT STANDS DOWN',
    color: '#ff4a3c',
    tier: 'alert',
  },
  {
    id: 'sus',
    when: (g) => g.suspicion && !g.everAlarmed,
    text: 'SOMETHING NOTICED YOU — A GLIMPSE IS NOT A LOCK. BREAK THE CONE NOW',
    color: '#ffd24a',
    tier: 'alert',
  },
  {
    id: 'overheat',
    when: (g, p) => p.overheatT > 0,
    text: 'THE GUN LOCKED — VENT BEFORE THE REDLINE, NOT AFTER',
    color: '#ff4a3c',
    tier: 'info',
  },
  {
    id: 'pot',
    when: (g, p) => (g.pot || 0) > 250,
    text: 'THAT POT IS UNBANKED — A HIT SPILLS IT. SECURE A ZONE TO CASH OUT',
    color: '#e8c75a',
    tier: 'info',
  },
];

class Coach {
  constructor() {
    this.step = 0;
    this.state = { dist: 0, coldT: 0, kills: 0, vents: 0 };
    this.card = null;        // {title, hint, touch} the HUD draws, or null
    this.doneFlash = 0;      // counts down after a step is satisfied
    this.finished = false;
    this.tipsFired = {};
    this._lx = null; this._lz = null;
    this._wasVenting = false;
    this._tipCd = 0;
  }

  /* Called from startLevel: per-sector counters reset, progress does not. */
  resetLevel() {
    this._lx = null; this._lz = null;
    this.tipsFired = {};
    this._tipCd = 0;
  }

  /* g: Game, dt: seconds. Returns nothing; writes this.card. */
  update(g, dt) {
    const p = g.player;
    if (!p || !p.alive || g.mode !== 'playing') { this.card = null; return; }
    const s = this.state;

    // ---- observations the steps read ------------------------------------
    if (this._lx !== null) s.dist += Math.hypot(p.x - this._lx, p.z - this._lz);
    this._lx = p.x; this._lz = p.z;
    if ((p.sig || 1) <= 0.32) s.coldT += dt; else s.coldT = 0;
    s.kills = g.runStats ? g.runStats.kills : 0;
    // a vent lands when the sweep ends — perfect or full-length, both count
    if (this._wasVenting && p.venting <= 0) s.vents++;
    this._wasVenting = p.venting > 0;

    // ---- situational callouts -------------------------------------------
    this._tipCd = Math.max(0, this._tipCd - dt);
    if (!this._tipCd) {
      for (const tip of COACH_TIPS) {
        if (this.tipsFired[tip.id] || !tip.when(g, p)) continue;
        this.tipsFired[tip.id] = true;
        this._tipCd = 3;   // never stack two callouts on top of each other
        g.hud.message(tip.text, tip.color, 3.2, tip.tier || 'info');
        break;
      }
    }

    if (this.finished) { this.card = null; return; }

    // ---- the walk --------------------------------------------------------
    // Jump to the first step the player has NOT satisfied. Scanning from the
    // front (rather than advancing one at a time) means a player who spikes a
    // zone on the way to their first kill never gets taught it afterwards.
    let next = COACH_STEPS.length;
    for (let i = 0; i < COACH_STEPS.length; i++) {
      if (!COACH_STEPS[i].done(g, p, s)) { next = i; break; }
    }
    if (next > this.step) {
      this.step = next;
      this.doneFlash = 1.1;
      if (next < COACH_STEPS.length) g._sfx('select');
    }
    this.doneFlash = Math.max(0, this.doneFlash - dt);
    if (this.step >= COACH_STEPS.length) { this.finish(g); return; }

    const st = COACH_STEPS[this.step];
    this.card = { id: st.id, title: st.title, hint: st.hint, touch: st.touch, flash: this.doneFlash };
  }

  /* The walk is over — stop drawing and remember it so it never runs again. */
  finish(g) {
    if (this.finished) return;
    this.finished = true;
    this.card = null;
    if (typeof Progress !== 'undefined' && Progress.setCoachDone) Progress.setCoachDone(true);
    if (g) g.hud.message('BRIEFING COMPLETE — THE REST IS YOURS', '#4fd6bb', 2.6);
  }
}

if (typeof window !== 'undefined') { window.Coach = Coach; window.COACH_STEPS = COACH_STEPS; }
