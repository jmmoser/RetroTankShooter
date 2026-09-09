/* Optional distribution adapter. The ordinary game never loads an SDK.
 * scripts/package-portal.py enables this only in the CrazyGames upload build.
 * Keep platform policy out of the simulation and never award ad-based power.
 */
const GamePlatform = (() => {
  const enabled = window.PA_PLATFORM === 'crazygames';
  let sdk = null, busy = false, playing = false, reportedPlaying = false;
  let adMuted = false, portalMuted = false;
  let activeSeconds = 0, lastAdAt = 0;
  const api = { enabled, onBusy: null, onMute: null };

  function call(method) {
    try {
      const result = sdk && sdk.game[method]();
      if (result && result.catch) result.catch(() => {});
    } catch (e) { /* A platform error must never stop the game. */ }
  }

  function syncPlaying() {
    const next = playing && !busy;
    if (!sdk || next === reportedPlaying) return;
    reportedPlaying = next;
    call(next ? 'gameplayStart' : 'gameplayStop');
  }

  function setBusy(value) {
    busy = value;
    syncPlaying();
    if (api.onBusy) api.onBusy(value);
  }

  function syncMute() {
    if (api.onMute) api.onMute(adMuted || portalMuted);
  }

  function settingsChanged(settings) {
    portalMuted = !!(settings && settings.muteAudio);
    syncMute();
  }

  // Bound SDK loading/initialization, so blocked SDKs still reach the game.
  // A late load cannot attach itself to an already-running fallback session.
  function init() {
    if (!enabled) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (candidate) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (candidate && ['local', 'crazygames'].includes(candidate.environment)) {
          sdk = candidate;
          settingsChanged(sdk.game.settings);
          try { sdk.game.addSettingsChangeListener(settingsChanged); } catch (e) {}
          call('loadingStart');
          syncPlaying();
        }
        resolve();
      };
      const timer = setTimeout(() => finish(null), 4000);
      const script = document.createElement('script');
      script.src = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
      script.async = true;
      script.onerror = () => finish(null);
      script.onload = async () => {
        if (settled) return;
        try {
          const candidate = window.CrazyGames.SDK;
          await candidate.init();
          finish(candidate);
        } catch (e) { finish(null); }
      };
      document.head.appendChild(script);
    });
  }

  function tick(seconds, active) {
    if (!busy && active && Number.isFinite(seconds)) activeSeconds += Math.max(0, seconds);
    playing = !!active;
    syncPlaying();
  }

  // Call only after the player chooses the next solo sector or a retry.
  // First three active minutes and daily competition stay uninterrupted.
  // SDK applies its own frequency/fill policy on top of this local cap.
  function breakBefore(next, eligible) {
    if (busy) return;
    if (!eligible || !sdk || activeSeconds - lastAdAt < 180) { next(); return; }
    lastAdAt = activeSeconds;
    let finished = false;
    setBusy(true);
    const finish = () => {
      if (finished) return;
      finished = true;
      adMuted = false;
      syncMute();
      setBusy(false);
      next();
    };
    try {
      const result = sdk.ad.requestAd('midgame', {
        adStarted: () => {
          if (finished) return;
          adMuted = true;
          syncMute();
        },
        adFinished: finish,
        adError: finish,
      });
      if (result && result.catch) result.catch(finish);
    } catch (e) { finish(); }
    // Do not resume on a wall-clock timer: that could restart under a live ad.
    // The SDK owns the request and signals completion / no-fill / adblock.
  }

  function inviteParams() {
    try { return sdk && sdk.game.inviteParams || null; } catch (e) { return null; }
  }

  function shareURL(params) {
    if (enabled) {
      // The CDN iframe URL is not a playable public game page.
      try { return sdk ? sdk.game.inviteLink(params) : ''; } catch (e) { return ''; }
    }
    if (!/^https?:$/.test(location.protocol)) return '';
    const url = new URL(location.origin + location.pathname);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.href;
  }

  return Object.assign(api, {
    init, tick, breakBefore, shareURL, inviteParams,
    ready: () => { call('loadingStop'); syncMute(); },
    setPlaying: (active) => { playing = !!active; syncPlaying(); },
    isBusy: () => busy,
  });
})();
