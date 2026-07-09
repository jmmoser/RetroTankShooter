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

const Settings = (() => {
  // quality: 0 = LOW (no MSAA on the glow scene pass), 1 = HIGH
  // difficulty: 0 = RECRUIT, 1 = STANDARD, 2 = VETERAN (campaign pacing;
  // Daily Ops and versus always run STANDARD)
  const DEFAULTS = { volume: 7, music: 6, shake: 10, glow: true, quality: 1, crt: true, aimAssist: true, colorblind: false, fps: false, difficulty: 1 };
  const s = Object.assign({}, DEFAULTS);
  try {
    const raw = JSON.parse(localStorage.getItem('pa_settings') || '{}');
    for (const k in DEFAULTS) if (k in raw && typeof raw[k] === typeof DEFAULTS[k]) s[k] = raw[k];
  } catch (e) {}

  function save() {
    try { localStorage.setItem('pa_settings', JSON.stringify(s)); } catch (e) {}
  }

  const api = {
    get: (k) => s[k],
    set(k, v) {
      s[k] = v;
      save();
      if (api.onChange) api.onChange(k, v);
    },
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
];

const Progress = (() => {
  const ZERO = { games: 0, kills: 0, flags: 0, warlords: 0, bestSector: 1, bestCombo: 1, xp: 0 };
  const p = Object.assign({}, ZERO);
  try {
    const raw = JSON.parse(localStorage.getItem('pa_stats') || '{}');
    for (const k in ZERO) if (typeof raw[k] === 'number') p[k] = raw[k];
  } catch (e) {}

  function save() {
    try { localStorage.setItem('pa_stats', JSON.stringify(p)); } catch (e) {}
  }

  /* Fold a finished run into the career record and convert its score to XP.
   * rs: game.runStats, level: sector reached, score: final score.
   * Returns the XP gained (floor of 35 so even a doomed sortie advances). */
  function recordRun(rs, level, score) {
    p.games++;
    if (rs) {
      p.kills += rs.kills || 0;
      p.flags += rs.flags || 0;
      p.warlords += rs.warlords || 0;
      p.bestCombo = Math.max(p.bestCombo, rs.bestMult || 1);
    }
    p.bestSector = Math.max(p.bestSector, level || 1);
    const xpGained = Math.max(35, Math.round((score || 0) / 10) + 25);
    p.xp += xpGained;
    save();
    return xpGained;
  }

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

  /* The MARAUDER chassis is earned, not given: down a WARLORD to unlock. */
  function marauderUnlocked() { return p.warlords > 0; }

  /* Checkpoint starts: sector 1, plus the sector after each WARLORD you have
   * fought past (6, 11, ...) so veterans can skip straight to the deep end. */
  function checkpoints() {
    const list = [1];
    for (let sec = 6; sec <= p.bestSector; sec += 5) list.push(sec);
    return list;
  }

  // ---- daily challenge ------------------------------------------------
  // One shared arena per UTC day: the date string seeds the generator, so
  // everyone worldwide fights the same layout.

  function dayKey(d) {
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + mm + '-' + dd;
  }
  function todayKey() { return dayKey(new Date()); }
  function yesterdayKey() { return dayKey(new Date(Date.now() - 86400000)); }

  function dailyBest() {
    try {
      const raw = JSON.parse(localStorage.getItem('pa_daily') || 'null');
      if (raw && raw.date === todayKey()) return raw;
    } catch (e) {}
    return null;
  }

  /* Returns true if this beat today's previous best. */
  function recordDaily(score, sector) {
    const prev = dailyBest();
    if (prev && prev.score >= score) return false;
    try {
      localStorage.setItem('pa_daily', JSON.stringify({ date: todayKey(), score, sector }));
    } catch (e) {}
    return true;
  }

  // ---- daily streak ---------------------------------------------------
  // Wordle-style consecutive-day chain: finish a daily run to keep it alive.

  function loadStreak() {
    try {
      const raw = JSON.parse(localStorage.getItem('pa_streak') || 'null');
      if (raw && typeof raw.streak === 'number') return raw;
    } catch (e) {}
    return { last: '', streak: 0, best: 0 };
  }

  /* Call when a daily run finishes. Extends yesterday's chain or starts a
   * fresh one; counting is idempotent within a day. */
  function recordDailyPlayed() {
    const s = loadStreak();
    const today = todayKey();
    if (s.last === today) return s;
    s.streak = s.last === yesterdayKey() ? s.streak + 1 : 1;
    s.best = Math.max(s.best, s.streak);
    s.last = today;
    try { localStorage.setItem('pa_streak', JSON.stringify(s)); } catch (e) {}
    return s;
  }

  /* Live streak for display: still counts if yesterday's chain can be kept
   * alive today (that tension is the whole point). Dead chains read 0. */
  function dailyStreak() {
    const s = loadStreak();
    return (s.last === todayKey() || s.last === yesterdayKey()) ? s.streak : 0;
  }

  return {
    get: () => p, recordRun, rank, marauderUnlocked, checkpoints,
    todayKey, dailyBest, recordDaily, recordDailyPlayed, dailyStreak,
  };
})();

/* One-time medals: award() persists and reports first-time earns; recent
 * earns queue up so the game-over screen can celebrate them. */
const Medals = (() => {
  let earned = {};
  try {
    const raw = JSON.parse(localStorage.getItem('pa_medals') || '[]');
    if (Array.isArray(raw)) for (const id of raw) earned[id] = true;
  } catch (e) {}
  const recent = [];

  function save() {
    try { localStorage.setItem('pa_medals', JSON.stringify(Object.keys(earned))); } catch (e) {}
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
