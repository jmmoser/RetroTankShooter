/* Shareable Daily Ops invitations. URL values are untrusted, self-reported
 * score targets, never scores to write into career / leaderboard storage.
 */
const Challenge = (() => {
  function parse(params, today, version) {
    const day = params.get('daily');
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const date = new Date(day + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day || day > today) return null;
    const raw = params.get('score');
    const score = /^\d{1,9}$/.test(raw || '') ? Number(raw) : 0;
    const sameVersion = params.get('v') === version;
    return { day, score: sameVersion ? score : 0, sameVersion, current: day === today };
  }

  function params(day, score, version) {
    return { daily: day, score: String(Math.max(0, Math.min(999999999, Math.floor(score) || 0))), v: version };
  }

  function payload(run, url) {
    const lines = [
      'PHANTOM ARENA' + (run.day ? ' — DAILY OPS ' + run.day : ''),
      'SCORE ' + run.score + ' · SECTOR ' + run.sector,
    ];
    if (run.streak > 1) lines.push('STREAK ' + run.streak + ' DAYS');
    if (run.day) lines.push('Can you beat my run? Same arena. Same tank.');
    return { title: 'PHANTOM ARENA', text: lines.join('\n'), ...(url ? { url } : {}) };
  }

  // Call directly from the gesture, before any await (iOS Web Share).
  async function share(payload, nav) {
    if (typeof nav.share === 'function') {
      try { await nav.share(payload); return 'shared'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    }
    if (nav.clipboard && nav.clipboard.writeText) {
      try {
        await nav.clipboard.writeText(payload.text + (payload.url ? '\n' + payload.url : ''));
        return 'copied';
      } catch (e) {}
    }
    return 'failed';
  }

  return { parse, params, payload, share };
})();
