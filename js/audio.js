/* Web Audio synthesized retro SFX — no sound files needed. */
const AudioSys = (() => {
  let ctx = null;
  let master = null;
  let engineOsc = null, engineGain = null, engineFilter = null;
  let muted = false;
  // 0..1 volume from the settings screen; 0.7 default maps to the old 0.5 gain
  let vol = 0.7;
  let musicVol = 0.6;
  try {
    if (typeof Settings !== 'undefined') {
      vol = Settings.get('volume') / 10;
      musicVol = Settings.get('music') / 10;
    }
  } catch (e) {}

  try { muted = localStorage.getItem('pa_muted') === '1'; } catch (e) {}

  function gainValue() { return muted ? 0 : vol * 0.72; }

  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = gainValue();
    master.connect(ctx.destination);
    return true;
  }

  function resume() {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    startMusicEngine();   // the first user gesture also boots the soundtrack
  }

  function setVolume(v01) {
    vol = Math.max(0, Math.min(1, v01));
    if (master) master.gain.value = gainValue();
  }

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem('pa_muted', m ? '1' : '0'); } catch (e) {}
    if (master) master.gain.value = gainValue();
    if (musicBus) musicBus.gain.value = musicGainValue();
  }
  function toggleMuted() { setMuted(!muted); return muted; }
  function isMuted() { return muted; }

  // -- helpers -------------------------------------------------------------
  function env(gainNode, t0, peak, attack, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  function tone(type, f0, f1, dur, vol, delay = 0) {
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    env(g, t0, vol, 0.005, dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  // one shared second of noise for all SFX — allocating and filling a fresh
  // AudioBuffer per shot/explosion was steady garbage in the hottest moments
  let sfxNoiseBuf = null;
  function noise(dur, vol, fStart, fEnd, delay = 0) {
    if (!ctx) return;
    if (!sfxNoiseBuf) {
      sfxNoiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d0 = sfxNoiseBuf.getChannelData(0);
      for (let i = 0; i < d0.length; i++) d0[i] = Math.random() * 2 - 1;
    }
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = sfxNoiseBuf;
    src.loop = true;                       // long booms wrap around the buffer
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(fStart, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(fEnd, 40), t0 + dur);
    const g = ctx.createGain();
    env(g, t0, vol, 0.005, dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0, Math.random() * 0.9);    // random slice so repeats don't phase
    src.stop(t0 + dur + 0.05);
  }

  // -- game sounds ---------------------------------------------------------
  const sfx = {
    fire()       { tone('square', 620, 140, 0.16, 0.35); noise(0.08, 0.18, 4000, 800); },
    enemyFire()  { tone('square', 380, 90, 0.18, 0.22); },
    hitEnemy()   { tone('square', 220, 60, 0.12, 0.3); noise(0.1, 0.2, 2500, 400); },
    hitPlayer()  { tone('sawtooth', 160, 40, 0.25, 0.45); noise(0.2, 0.35, 1800, 200); },
    hitWall()    { noise(0.07, 0.15, 3000, 600); },
    explosion()  {
      noise(0.6, 0.6, 1200, 60);
      tone('sawtooth', 110, 28, 0.55, 0.4);
      tone('square', 70, 24, 0.7, 0.3, 0.04);
    },
    bigExplosion() {
      noise(1.1, 0.7, 900, 40);
      tone('sawtooth', 90, 18, 1.0, 0.5);
      tone('square', 55, 16, 1.2, 0.4, 0.08);
    },
    flag() {
      tone('square', 660, 660, 0.08, 0.25);
      tone('square', 880, 880, 0.08, 0.25, 0.08);
      tone('square', 1320, 1320, 0.14, 0.25, 0.16);
    },
    powerup() {
      tone('triangle', 440, 880, 0.1, 0.3);
      tone('triangle', 660, 1320, 0.12, 0.3, 0.09);
    },
    powerdown() {
      tone('triangle', 880, 440, 0.1, 0.26);
      tone('triangle', 1320, 660, 0.12, 0.26, 0.09);
    },
    levelClear() {
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => tone('square', f, f, 0.14, 0.28, i * 0.12));
    },
    gameOver() {
      const notes = [392, 330, 262, 196];
      notes.forEach((f, i) => tone('sawtooth', f, f * 0.97, 0.3, 0.3, i * 0.22));
    },
    lowShield()  { tone('square', 880, 880, 0.06, 0.22); tone('square', 880, 880, 0.06, 0.22, 0.12); },
    bounce()     { tone('square', 90, 45, 0.14, 0.4); noise(0.1, 0.25, 900, 200); },
    nade()       { tone('triangle', 140, 60, 0.22, 0.4); noise(0.12, 0.2, 1200, 300); },
    mine()       { tone('square', 320, 900, 0.1, 0.22); tone('square', 1100, 1100, 0.05, 0.16, 0.12); },
    nadeBoom()   {
      noise(0.8, 0.65, 1000, 50);
      tone('sawtooth', 95, 22, 0.7, 0.45);
      tone('square', 60, 20, 0.9, 0.35, 0.05);
    },
    boost()      { noise(0.4, 0.22, 500, 4000); tone('sawtooth', 110, 320, 0.35, 0.15); },
    refuel()     { tone('square', 1040, 1240, 0.05, 0.14); },
    cloak()      {
      tone('triangle', 1600, 400, 0.5, 0.18);
      tone('triangle', 1900, 500, 0.5, 0.12, 0.06);
    },
    select()     { tone('square', 880, 880, 0.05, 0.2); },
    pause()      { tone('square', 660, 660, 0.06, 0.2); tone('square', 440, 440, 0.09, 0.2, 0.07); },
    sectorStart() {
      tone('square', 392, 392, 0.1, 0.24);
      tone('square', 523, 523, 0.1, 0.24, 0.1);
      tone('square', 659, 659, 0.16, 0.24, 0.2);
    },
    unlock() {
      const notes = [523, 659, 784, 1047, 1319];
      notes.forEach((f, i) => tone('square', f, f, 0.12, 0.26, i * 0.09));
      tone('triangle', 1319, 2637, 0.3, 0.18, 0.45);
    },
    deploy()     { tone('square', 220, 880, 0.35, 0.3); noise(0.3, 0.15, 600, 3000); },
    alarm() {
      tone('square', 470, 470, 0.16, 0.28);
      tone('square', 350, 350, 0.16, 0.28, 0.20);
      tone('square', 470, 470, 0.16, 0.28, 0.40);
    },
    warp()       { tone('triangle', 180, 1500, 0.3, 0.25); noise(0.25, 0.18, 700, 5000); },
    combo() {
      tone('square', 660, 990, 0.08, 0.24);
      tone('square', 990, 1480, 0.1, 0.24, 0.07);
    },
    comboBreak() { tone('sawtooth', 520, 110, 0.28, 0.28); },
    deflect()    { tone('triangle', 2400, 900, 0.08, 0.2); noise(0.05, 0.1, 7000, 2500); },
    charge() {
      tone('sawtooth', 55, 210, 0.9, 0.38);
      noise(0.7, 0.18, 300, 1600);
    },
    shock() {
      noise(0.55, 0.4, 500, 60);
      tone('sawtooth', 140, 32, 0.55, 0.32);
    },
    coreExposed() {
      tone('square', 523, 523, 0.12, 0.28);
      tone('square', 622, 622, 0.12, 0.28, 0.12);
      tone('square', 784, 784, 0.22, 0.28, 0.24);
    },
    bossDown() {
      const notes = [392, 523, 659, 784, 1047];
      notes.forEach((f, i) => tone('square', f, f, 0.16, 0.28, i * 0.11));
      noise(1.2, 0.5, 1000, 40, 0.1);
    },
  };

  // -- procedural soundtrack -------------------------------------------------
  // A tiny lookahead sequencer (the classic "tale of two clocks" pattern): a
  // JS interval walks 16th-note steps a beat ahead of the AudioContext clock
  // and schedules short-lived oscillators per voice. Three moods share the
  // engine — brooding menu pads, a driving combat groove, and a harder boss
  // variant — and the game's alert/combo state pumps an intensity knob that
  // opens filters and thickens the hats. All synthesized live: the game
  // still ships zero asset files.
  let musicBus = null, musicTimer = null, musicNoiseBuf = null;
  let musicMood = null, pendingMood = null;
  let musicStep = 0, musicNext = 0, musicIntensity = 0;

  const MUSIC_BPM = 112;
  const MSTEP = 60 / MUSIC_BPM / 4;                       // one 16th note
  const mf = (m) => 440 * Math.pow(2, (m - 69) / 12);     // midi note -> Hz

  // chord roots per bar (midi); combat rides an Am / F / G / Em loop while
  // the boss mix bends it phrygian for menace
  const MOODS = {
    menu:   { bars: [45, 41, 43, 40], drums: false, drive: 0 },
    combat: { bars: [45, 41, 43, 40], drums: true,  drive: 1 },
    boss:   { bars: [45, 46, 43, 44], drums: true,  drive: 2 },
  };
  const ARP = [0, 3, 7, 12, 7, 3];   // minor arpeggio, up and back

  function musicGainValue() { return muted ? 0 : musicVol * 0.5; }

  function setMusicVolume(v01) {
    musicVol = Math.max(0, Math.min(1, v01));
    if (musicBus) musicBus.gain.value = musicGainValue();
  }

  /* Switch the soundtrack mood; takes effect on the next bar so transitions
   * land on the grid. Safe to call every frame — repeats are no-ops. */
  function setMusicMood(mood) {
    if (!MOODS[mood]) return;
    if (mood === (pendingMood || musicMood)) return;
    if (!musicMood) musicMood = mood;   // engine not audible yet: cut straight over
    else pendingMood = mood;
  }

  /* 0..1 from the game (alert level / combo heat): opens the bass filter and
   * densifies the hats so escalation is audible, not just a HUD bar. */
  function setMusicIntensity(v) {
    musicIntensity = Math.max(0, Math.min(1, v || 0));
  }

  function startMusicEngine() {
    if (!ctx || musicTimer) return;
    musicBus = ctx.createGain();
    musicBus.gain.value = musicGainValue();
    musicBus.connect(ctx.destination);
    musicNext = ctx.currentTime + 0.06;
    musicStep = 0;
    musicTimer = setInterval(scheduleMusic, 90);
  }

  // top up the schedule the moment the tab hides: the last visible tick only
  // covered 0.28 s, and the first throttled hidden tick is >=1 s away — the
  // gap would go silent and then smear into a bunched catch-up burst
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) scheduleMusic();
    });
  }

  function scheduleMusic() {
    if (!ctx || !musicBus) return;
    // hidden tabs clamp setInterval to >=1s while the AudioContext keeps
    // running — schedule far enough ahead that the soundtrack doesn't gap
    const ahead = (typeof document !== 'undefined' && document.hidden) ? 1.6 : 0.28;
    while (musicNext < ctx.currentTime + ahead) {
      if ((musicStep & 15) === 0 && pendingMood) {
        musicMood = pendingMood;
        pendingMood = null;
      }
      if (musicMood && !muted && musicVol > 0) playMusicStep(musicStep, musicNext);
      musicStep = (musicStep + 1) & 63;   // 4 bars of 16 steps
      musicNext += MSTEP;
    }
  }

  // voice helpers — every node routes into musicBus, never into the SFX master
  function mOsc(type, freq, t, dur, peak, cutoff) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(musicBus);
    o.start(t); o.stop(t + dur + 0.03);
  }

  function mNoise(t, dur, peak, filterType, freq) {
    if (!musicNoiseBuf) {
      const len = ctx.sampleRate;   // one shared second of noise
      musicNoiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = musicNoiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = musicNoiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(musicBus);
    src.start(t, Math.random());
    src.stop(t + dur + 0.03);
  }

  function mKick(t) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g); g.connect(musicBus);
    o.start(t); o.stop(t + 0.18);
  }

  /* One dark pad chord per bar: root + fifth as detuned saws through a
   * closed lowpass, swelling under everything else. */
  function mPad(root, t, cutoff, peak) {
    const barDur = MSTEP * 16;
    for (const [note, det] of [[root + 12, -4], [root + 12, 4], [root + 19, 3]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(mf(note), t);
      o.detune.setValueAtTime(det, t);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(cutoff, t);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + barDur);
      o.connect(f); f.connect(g); g.connect(musicBus);
      o.start(t); o.stop(t + barDur + 0.05);
    }
  }

  function playMusicStep(step, t) {
    const mood = MOODS[musicMood];
    const bar = (step >> 4) & 3, pos = step & 15;
    const root = mood.bars[bar];
    const inten = musicIntensity;

    if (pos === 0) {
      mPad(root, t, mood.drive === 0 ? 520 : 700 + inten * 500,
        mood.drive === 0 ? 0.07 : 0.05);
    }

    // bass: slow pulses on the menu, driving 8ths with octave lifts in combat
    if (mood.drive === 0) {
      if (pos === 0 || pos === 10) mOsc('sawtooth', mf(root - 12), t, MSTEP * 5, 0.15, 300);
    } else if ((pos & 1) === 0) {
      const oct = (pos === 6 || pos === 14) ? 0 : -12;
      mOsc('sawtooth', mf(root + oct), t, MSTEP * 1.6,
        mood.drive === 2 && (pos & 3) === 2 ? 0.28 : 0.22,
        380 + inten * 450);
    }

    // arp: sparse chimes on the menu, a 16th-note pulse under fire
    if (mood.drive === 0) {
      if (pos === 4 || pos === 12) {
        mOsc('triangle', mf(root + 24 + ARP[(step >> 2) % ARP.length]), t, MSTEP * 3.2, 0.05, 2200);
      }
    } else if ((pos & 1) === 0 || inten > 0.55) {
      mOsc('square', mf(root + 12 + ARP[(step >> 1) % ARP.length]), t, MSTEP * 1.1,
        0.04 + inten * 0.03, 1400 + inten * 2600);
    }

    if (mood.drums) {
      if (pos === 0 || pos === 8 || (mood.drive === 2 && (pos === 4 || pos === 12))) mKick(t);
      if (pos === 4 || pos === 12) mNoise(t, 0.12, 0.16, 'bandpass', 1900);         // snare
      if ((pos & 1) === 1) mNoise(t, 0.03, 0.05 + inten * 0.05, 'highpass', 6500);  // hats
      else if (inten > 0.7 && (pos & 3) === 2) mNoise(t, 0.025, 0.04, 'highpass', 7500);
    }
  }

  // -- engine hum ----------------------------------------------------------
  function startEngine() {
    if (!ctx || engineOsc) return;
    engineOsc = ctx.createOscillator();
    engineOsc.type = 'sawtooth';
    engineOsc.frequency.value = 40;
    engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 220;
    engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    engineOsc.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(master);
    engineOsc.start();
  }

  function stopEngine() {
    if (!engineOsc) return;
    try { engineOsc.stop(); } catch (e) {}
    engineOsc.disconnect(); engineFilter.disconnect(); engineGain.disconnect();
    engineOsc = engineGain = engineFilter = null;
  }

  /* speed01: 0..1 of max speed. Zero really means silent — the old floor of
   * 0.05 (and the lazy startEngine here) left a permanent sawtooth hum under
   * every menu, since main.js silences the engine by calling setEngine(0). */
  function setEngine(speed01) {
    if (!ctx) return;
    if (!engineOsc) {
      if (speed01 <= 0) return;   // nothing to silence — don't boot the hum
      startEngine();
    }
    const t = ctx.currentTime;
    engineOsc.frequency.setTargetAtTime(38 + speed01 * 55, t, 0.08);
    engineFilter.frequency.setTargetAtTime(180 + speed01 * 500, t, 0.08);
    engineGain.gain.setTargetAtTime(speed01 <= 0 ? 0 : 0.05 + speed01 * 0.10, t, 0.1);
  }

  function play(name) {
    if (!ctx || muted) return;
    if (sfx[name]) sfx[name]();
  }

  return {
    resume, play, setEngine, stopEngine, toggleMuted, isMuted, setVolume,
    setMusicVolume, setMusicMood, setMusicIntensity,
  };
})();
