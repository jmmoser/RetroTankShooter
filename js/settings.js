/* Persistent local state, loaded before every other module.
 *
 *  - Settings: player preferences (pa_settings) — volume, screen shake,
 *    CRT overlay, render quality, aim assist, colorblind palette,
 *    FPS counter.
 *  - Progress: career stats, XP/rank and unlocks (pa_stats), the
 *    daily-challenge best (pa_daily) and daily streak (pa_streak).
 *  - Medals: one-time feats (pa_medals) toasted in-run and displayed on
 *    the service record.
 *  Everything is per-browser localStorage; the game stays a pile of
 *  static files with no accounts.
 */

/* One choke point for every localStorage write. Safari private mode and a
 * full quota throw on setItem, and every module used to swallow that
 * silently — a whole career could evaporate without a word. The first failure
 * is reported once through onFail (main.js toasts it). */
const Store = (() => {
  let failed = false;
  const api = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) {
      try { localStorage.setItem(k, v); return true; } catch (e) {
        if (!failed) { failed = true; if (api.onFail) api.onFail(e); }
        return false;
      }
    },
    remove(k) { try { localStorage.removeItem(k); } catch (e) {} },
    failed: () => failed,
    onFail: null,
  };
  return api;
})();

const Settings = (() => {
  // quality: 0 = LOW (no MSAA on the glow scene pass), 1 = HIGH
  // difficulty: 0 = RECRUIT (default), 1 = STANDARD, 2 = VETERAN (campaign
  // pacing; Daily Ops and versus always run STANDARD)
  // coach: the first-run field coach that walks the loop in a live sector
  // chase: third-person camera. Default ON — the stealth read (sensor cone
  // boundaries, awareness rings, scorch, tread prints, beacon pillars) is all
  // drawn on the ground plane, and a hull-height first-person eye cannot see
  // any of it. `C` still flips to the cockpit view, and the choice sticks.
  // reducedMotion: zeroes the radial blur, aberration, grain and the blink
  //   animations and caps shake — defaults to the OS preference
  // renderScale: 5..10 = 50%..100% of device resolution for the 3D scene
  // fov: -2..+2 steps around the base field of view
  // hudScale: 6..14 = 60%..140% HUD size
  // rumble: gamepad vibration; deadzone: 0..4 = 10%..34% stick deadzone
  let prefersReduced = false;
  try { prefersReduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
  const DEFAULTS = {
    volume: 7, music: 6, shake: 10, glow: true, shadows: true, quality: 1, crt: true,
    aimAssist: true, colorblind: false, fps: false, difficulty: 0, coach: true, chase: true,
    reducedMotion: prefersReduced, renderScale: 10, fov: 0, hudScale: 10, rumble: true, deadzone: 1,
  };
  // numeric keys are clamped on load — a hand-edited `difficulty: 7` used to
  // render "undefined" in the menu and reach the sim
  const RANGES = {
    volume: [0, 10], music: [0, 10], shake: [0, 10], quality: [0, 1], difficulty: [0, 2],
    renderScale: [5, 10], fov: [-2, 2], hudScale: [6, 14], deadzone: [0, 4],
  };
  const VERSION = 2;   // bump when a key's meaning changes; migrate() upgrades
  const s = Object.assign({}, DEFAULTS);

  function migrate(raw) {
    const v = typeof raw.v === 'number' ? raw.v : 1;
    // v1 -> v2: nothing to rename yet; the version field itself is the change
    if (v < 2) raw.v = 2;
    return raw;
  }
  function clamp(k, v) {
    const r = RANGES[k];
    if (!r || typeof v !== 'number') return v;
    return Math.max(r[0], Math.min(r[1], Math.round(v)));
  }
  try {
    const raw = migrate(JSON.parse(Store.get('pa_settings') || '{}'));
    for (const k in DEFAULTS) if (k in raw && typeof raw[k] === typeof DEFAULTS[k]) s[k] = clamp(k, raw[k]);
  } catch (e) {}

  function save() {
    Store.set('pa_settings', JSON.stringify(Object.assign({ v: VERSION }, s)));
  }

  const api = {
    get: (k) => s[k],
    set(k, v) {
      s[k] = clamp(k, v);
      save();
      if (api.onChange) api.onChange(k, s[k]);
    },
    /* Back to factory defaults (the reduced-motion default re-reads the OS). */
    reset() {
      for (const k in DEFAULTS) s[k] = DEFAULTS[k];
      save();
      if (api.onChange) api.onChange(null, null);
    },
    range: (k) => RANGES[k] || null,
    onChange: null,   // (key, value) — main.js applies live effects here
  };
  return api;
})();

/* Career rank ladder: cumulative XP thresholds. Tuned so the first run is
 * almost always a promotion (hook set) and the top takes a career. */
const RANKS = [
  ['RECRUIT', 0], ['ENSIGN', 300], ['CORPORAL', 900], ['SERGEANT', 2000],
  ['LIEUTENANT', 4000], ['CAPTAIN', 7000], ['MAJOR', 12000],
  ['COMMANDER', 20000], ['COLONEL', 32000], ['GENERAL', 50000],
  ['WARMASTER', 75000], ['PHANTOM LEGEND', 110000],
];

/* One-time feats. In-run ones are awarded by game.js the moment they land;
 * career ones are checked when a run is recorded. */
const MEDALS = [
  { id: 'firstblood',  name: 'FIRST BLOOD',    how: 'DESTROY YOUR FIRST TANK' },
  { id: 'chain5',      name: 'CHAIN REACTION', how: 'REACH A ×5 COMBO' },
  { id: 'untouchable', name: 'UNTOUCHABLE',    how: 'CLEAR A SECTOR WITHOUT TAKING A HIT' },
  { id: 'ace',         name: 'ACE',            how: '25 KILLS IN ONE MISSION' },
  { id: 'demolition',  name: 'DEMOLITION MAN', how: '3 GRENADE KILLS IN ONE MISSION' },
  { id: 'trapper',     name: 'TRAPPER',        how: '3 MINE KILLS IN ONE MISSION' },
  { id: 'giantkiller', name: 'GIANT KILLER',   how: 'DESTROY A WARLORD' },
  { id: 'ghost',       name: 'GHOST',          how: 'EXTRACT WITHOUT EVER RAISING THE ALARM' },
  { id: 'assassin',    name: 'ASSASSIN',       how: '5 SILENT KILLS IN ONE MISSION' },
  { id: 'deepstrike',  name: 'DEEP STRIKE',    how: 'REACH SECTOR 8' },
  { id: 'streak3',     name: 'DAILY REGULAR',  how: '3-DAY DAILY OPS STREAK' },
  { id: 'veteran',     name: 'VETERAN',        how: 'FLY 25 MISSIONS' },
  { id: 'flagday',     name: 'ZONE CONTROL',   how: 'SECURE 100 CAREER ZONES' },
  { id: 'centurion',   name: 'CENTURION',      how: '500 CAREER KILLS' },
  { id: 'campaign',    name: 'PHANTOM',        how: 'CLEAR SECTOR 15 — COMPLETE THE CAMPAIGN' },
];

const Progress = (() => {
  // coachDone: the field coach has walked this pilot through the loop once
  // campaigns: sector-15 clears; chassisBest: deepest sector per loadout name
  const ZERO = { games: 0, kills: 0, flags: 0, warlords: 0, bestSector: 1, bestCombo: 1, xp: 0, coachDone: 0, campaigns: 0 };
  // sane ceilings: a hand-edited 1e12 used to brick the rank ladder display
  const CEIL = { games: 1e6, kills: 1e7, flags: 1e7, warlords: 1e6, bestSector: 999, bestCombo: 5, xp: 1e9, coachDone: 1, campaigns: 1e6 };
  const p = Object.assign({}, ZERO);
  let chassisBest = {};
  try {
    const raw = JSON.parse(Store.get('pa_stats') || '{}');
    for (const k in ZERO) {
      if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) p[k] = Math.max(0, Math.min(CEIL[k], raw[k]));
    }
    if (raw.chassisBest && typeof raw.chassisBest === 'object') {
      for (const k in raw.chassisBest) {
        const v = raw.chassisBest[k];
        if (typeof k === 'string' && k.length <= 16 && typeof v === 'number' && Number.isFinite(v)) {
          chassisBest[k] = Math.max(1, Math.min(999, v | 0));
        }
      }
    }
  } catch (e) {}

  function save() {
    Store.set('pa_stats', JSON.stringify(Object.assign({ v: 2, chassisBest }, p)));
  }

  /* Fold a finished run into the career record and convert its score to XP.
   * rs: game.runStats, level: sector reached, score: final score.
   * opts: { loadout, campaignWon } — per-chassis records and campaign clears.
   * Returns the XP gained (floor of 35 so even a doomed sortie advances). */
  function recordRun(rs, level, score, opts) {
    opts = opts || {};
    p.games++;
    if (rs) {
      p.kills += rs.kills || 0;
      p.flags += rs.flags || 0;
      p.warlords += rs.warlords || 0;
      p.bestCombo = Math.max(p.bestCombo, rs.bestMult || 1);
    }
    p.bestSector = Math.max(p.bestSector, level || 1);
    if (opts.campaignWon) p.campaigns++;
    if (typeof opts.loadout === 'string' && opts.loadout) {
      chassisBest[opts.loadout] = Math.max(chassisBest[opts.loadout] || 1, level || 1);
    }
    const xpGained = Math.max(35, Math.round((score || 0) / 10) + 25);
    p.xp += xpGained;
    save();
    return xpGained;
  }
  function chassisRecord(name) { return chassisBest[name] || 0; }

  // ---- export / import / reset ----------------------------------------
  // Everything the game remembers lives in a handful of localStorage keys.
  // A player who switches browsers, or clears site data, deserves to carry
  // their career with them — as a code they can paste, no accounts needed.
  const CAREER_KEYS = ['pa_stats', 'pa_daily', 'pa_streak', 'pa_medals', 'pa_high'];
  const ALL_KEYS = CAREER_KEYS.concat(['pa_settings', 'pa_muted', 'pa_binds']);
  const CODE_PREFIX = 'PA1.';

  function exportCode() {
    const o = {};
    for (const k of ALL_KEYS) { const v = Store.get(k); if (typeof v === 'string') o[k] = v; }
    let json = JSON.stringify(o);
    let b64 = '';
    try { b64 = btoa(unescape(encodeURIComponent(json))); } catch (e) { return ''; }
    return CODE_PREFIX + b64;
  }

  /* Returns true when the code was valid and written. The caller reloads —
   * every module reads storage once at boot. */
  function importCode(code) {
    if (typeof code !== 'string') return false;
    code = code.trim();
    if (code.indexOf(CODE_PREFIX) !== 0) return false;
    let o = null;
    try { o = JSON.parse(decodeURIComponent(escape(atob(code.slice(CODE_PREFIX.length))))); } catch (e) { return false; }
    if (!o || typeof o !== 'object') return false;
    let wrote = 0;
    for (const k of ALL_KEYS) {
      const v = o[k];
      if (typeof v !== 'string' || v.length > 20000) continue;
      // every value is JSON or a short literal; refuse anything that is not
      if (k !== 'pa_high' && k !== 'pa_muted') { try { JSON.parse(v); } catch (e) { continue; } }
      if (Store.set(k, v)) wrote++;
    }
    return wrote > 0;
  }

  function resetCareer() { for (const k of CAREER_KEYS) Store.remove(k); }

  /* Current rank plus everything the UI needs to draw the progress bar:
   * base/nextAt are the XP thresholds bracketing the current rank. */
  function rank() {
    let i = 0;
    while (i < RANKS.length - 1 && p.xp >= RANKS[i + 1][1]) i++;
    const next = i < RANKS.length - 1 ? RANKS[i + 1] : null;
    return {
      index: i, name: RANKS[i][0], xp: p.xp, base: RANKS[i][1],
      nextName: next ? next[0] : null, nextAt: next ? next[1] : null,
    };
  }

  /* The field coach is a one-time walk. The BRIEFING screen can re-arm it,
   * which is the only way it comes back. */
  function coachDone() { return !!p.coachDone; }
  function setCoachDone(v) { p.coachDone = v ? 1 : 0; save(); }

  /* The MARAUDER chassis is earned, not given: down a WARLORD to unlock. */
  function marauderUnlocked() { return p.warlords > 0; }

  /* Checkpoint starts. The first rung used to be sector 6 — the sector after
   * a WARLORD — so it needed five cleared sectors to reach, which is exactly
   * the stretch a pilot who is still learning cannot clear. That made the
   * whole career ladder cosmetic for as long as it mattered most: run 20 was
   * mechanically identical to run 1.
   *
   * Rungs every third sector, and always strictly below your deepest, so a
   * checkpoint is somewhere you have proven you can get to and still leaves a
   * sector between you and your record. Deep starts carry no upgrades and no
   * banked score, so they cost as much as they save. */
  function checkpoints() {
    const list = [1];
    for (let sec = 4; sec < p.bestSector; sec += 3) list.push(sec);
    return list;
  }

  /* FIELD PROMOTION: rank finally spends. Every run pays XP — the game says
   * so on every game-over screen — and until now that bought a word. From
   * ENSIGN on, a campaign sortie deploys with tech already banked, which
   * cashes out as a draft in the opening seconds: the build starts sooner and
   * a returning pilot's run is shaped differently from their first.
   *
   * Campaign only. Daily Ops is a shared leaderboard and stays a level field,
   * exactly like the difficulty preset. */
  const PROMOTION_TECH = [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6];
  function startingTech() { return PROMOTION_TECH[rank().index] || 0; }

  // ---- daily challenge ------------------------------------------------
  // One shared arena per UTC day: the date string seeds the generator, so
  // everyone worldwide fights the same layout.

  function dayKey(d) {
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + mm + '-' + dd;
  }
  function todayKey() { return dayKey(new Date()); }
  /* The calendar day before a YYYY-MM-DD key. */
  function dayBefore(key) {
    const d = new Date(key + 'T00:00:00Z');
    return isNaN(d) ? '' : dayKey(new Date(d.getTime() - 86400000));
  }

  /* Best stored run for `day` (defaults to today) — the game-over panel
   * passes the arena's seed date so a midnight-straddling run reads the
   * right day's record instead of a spurious 0. */
  function dailyBest(day) {
    try {
      const raw = JSON.parse(Store.get('pa_daily') || 'null');
      if (raw && raw.date === (day || todayKey())) return raw;
    } catch (e) {}
    return null;
  }

  /* Returns true if this beat that day's previous best. `day` is the arena's
   * seed date — a run launched at 23:55 UTC and finished at 00:05 played
   * YESTERDAY'S arena and must not be recorded as (or clobber) today's best. */
  function recordDaily(score, sector, day) {
    day = day || todayKey();
    let raw = null;
    try { raw = JSON.parse(Store.get('pa_daily') || 'null'); } catch (e) {}
    if (raw && raw.date === day && raw.score >= score) return false;
    if (raw && raw.date > day) return false;   // stale run from a previous day
    Store.set('pa_daily', JSON.stringify({ date: day, score, sector }));
    return true;
  }

  // ---- daily streak ---------------------------------------------------
  // Wordle-style consecutive-day chain: finish a daily run to keep it alive.

  function loadStreak() {
    try {
      const raw = JSON.parse(Store.get('pa_streak') || 'null');
      if (raw && typeof raw.streak === 'number') {
        // a malformed `last` would lexicographically outrank every real date
        // and permanently short-circuit recordDailyPlayed — sanitize it
        if (typeof raw.last !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.last)) raw.last = '';
        if (typeof raw.best !== 'number') raw.best = 0;
        return raw;
      }
    } catch (e) {}
    return { last: '', streak: 0, best: 0 };
  }

  /* Call when a daily run finishes. `day` is the arena's seed date, so a run
   * that straddles UTC midnight credits the day it was actually launched.
   * Extends the previous day's chain or starts a fresh one; idempotent within
   * a day (ISO keys compare chronologically as strings). */
  function recordDailyPlayed(day) {
    const s = loadStreak();
    day = day || todayKey();
    if (s.last >= day) return s;
    s.streak = s.last === dayBefore(day) ? s.streak + 1 : 1;
    s.best = Math.max(s.best, s.streak);
    s.last = day;
    Store.set('pa_streak', JSON.stringify(s));
    return s;
  }

  /* Live streak for display: still counts if yesterday's chain can be kept
   * alive today (that tension is the whole point). Dead chains read 0. */
  function dailyStreak() {
    const s = loadStreak();
    const today = todayKey();
    return (s.last === today || s.last === dayBefore(today)) ? s.streak : 0;
  }

  return {
    get: () => p, recordRun, rank, marauderUnlocked, checkpoints, chassisRecord,
    coachDone, setCoachDone, startingTech,
    todayKey, dailyBest, recordDaily, recordDailyPlayed, dailyStreak,
    exportCode, importCode, resetCareer,
  };
})();

/* One-time medals: award() persists and reports first-time earns; recent
 * earns queue up so the game-over screen can celebrate them. */
const Medals = (() => {
  let earned = {};
  try {
    const raw = JSON.parse(Store.get('pa_medals') || '[]');
    if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') earned[id] = true;
  } catch (e) {}
  const recent = [];

  function save() {
    Store.set('pa_medals', JSON.stringify(Object.keys(earned)));
  }

  return {
    has: (id) => !!earned[id],
    /* Returns true only the first time a medal is earned. */
    award(id) {
      if (earned[id] || !MEDALS.some((m) => m.id === id)) return false;
      earned[id] = true;
      recent.push(id);
      save();
      return true;
    },
    /* Medals earned since the last drain (shown on the game-over screen). */
    drainRecent: () => recent.splice(0),
    count: () => Object.keys(earned).length,
  };
})();
