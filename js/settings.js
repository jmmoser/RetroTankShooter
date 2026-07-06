/* Persistent local state, loaded before every other module.
 *
 *  - Settings: player preferences (pa_settings) — volume, screen shake,
 *    CRT overlay, aim assist, colorblind palette.
 *  - Progress: career stats & unlocks (pa_stats) plus the daily-challenge
 *    best (pa_daily). Everything is per-browser localStorage; the game
 *    stays a pile of static files with no accounts.
 */

const Settings = (() => {
  const DEFAULTS = { volume: 7, shake: 10, crt: true, aimAssist: true, colorblind: false };
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

const Progress = (() => {
  const ZERO = { games: 0, kills: 0, flags: 0, warlords: 0, bestSector: 1, bestCombo: 1 };
  const p = Object.assign({}, ZERO);
  try {
    const raw = JSON.parse(localStorage.getItem('pa_stats') || '{}');
    for (const k in ZERO) if (typeof raw[k] === 'number') p[k] = raw[k];
  } catch (e) {}

  function save() {
    try { localStorage.setItem('pa_stats', JSON.stringify(p)); } catch (e) {}
  }

  /* Fold a finished run into the career record.
   * rs: game.runStats, level: sector reached. */
  function recordRun(rs, level) {
    p.games++;
    if (rs) {
      p.kills += rs.kills || 0;
      p.flags += rs.flags || 0;
      p.warlords += rs.warlords || 0;
      p.bestCombo = Math.max(p.bestCombo, rs.bestMult || 1);
    }
    p.bestSector = Math.max(p.bestSector, level || 1);
    save();
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

  function todayKey() {
    const d = new Date();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + mm + '-' + dd;
  }

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

  return { get: () => p, recordRun, marauderUnlocked, checkpoints, todayKey, dailyBest, recordDaily };
})();
