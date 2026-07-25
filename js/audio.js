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
  // engine — a solemn anthem under the menus, a full-tilt march in combat,
  // and a phrygian war-drum mix for bosses — and the game's alert/combo
  // state pumps an intensity knob that opens filters, thickens the snare
  // work and fades in a tremolo dread layer. All synthesized live: the game
  // still ships zero asset files.
  let musicBus = null, musicTimer = null, musicNoiseBuf = null;
  let musicMood = null, pendingMood = null;
  let musicStep = 0, musicNext = 0, musicIntensity = 0;
  let mstep = 60 / 132 / 4;                               // one 16th note; per-mood
  const mf = (m) => 440 * Math.pow(2, (m - 69) / 12);     // midi note -> Hz

  // Everything lives around Bb major — parade-ground brass territory. Each
  // mood is an 8-bar phrase: bars are [rootMidi, isMinor] chords, lead is a
  // sparse [step, midi, lengthIn16ths] fanfare line. The anthem borrows the
  // minor iv (bar 6) so the pride carries a knot of worry; the boss phrase
  // hangs Ab over a G home — phrygian b2, the classic dread interval.
  const MOODS = {
    menu: {
      bpm: 76, drums: 0, drive: 0,
      bars: [[46, 0], [43, 1], [39, 0], [41, 0], [46, 0], [43, 1], [39, 1], [41, 0]],
      // taps-style bugle: unhurried triads, one long note per breath
      lead: [
        [0, 65, 3], [4, 65, 2], [6, 70, 8],
        [16, 65, 2], [18, 70, 2], [20, 74, 10],
        [32, 74, 4], [36, 72, 2], [38, 70, 4], [44, 67, 4],
        [48, 69, 4], [52, 72, 4], [56, 65, 8],
        [64, 65, 3], [68, 70, 2], [70, 74, 8],
        [80, 74, 3], [84, 79, 2], [86, 77, 8],
        [96, 75, 4], [100, 70, 4], [104, 66, 6],
        [112, 72, 4], [118, 69, 2], [120, 70, 8],
      ],
    },
    combat: {
      bpm: 132, drums: 1, drive: 1,
      bars: [[46, 0], [46, 0], [39, 0], [41, 0], [43, 1], [39, 0], [41, 0], [41, 0]],
      // the hook: a bugle-call fanfare that climbs, turns minor for a bar of
      // doubt, then runs a rising pickup back into the top of the loop
      lead: [
        [0, 65, 2], [2, 70, 2], [4, 74, 3], [8, 70, 2], [10, 74, 2], [12, 77, 4],
        [16, 77, 3], [20, 74, 2], [22, 70, 2], [24, 72, 2], [26, 74, 2], [28, 72, 2], [30, 70, 2],
        [32, 70, 2], [34, 75, 2], [36, 79, 4], [40, 77, 2], [42, 75, 2], [44, 70, 4],
        [48, 72, 2], [50, 77, 2], [52, 81, 3], [56, 79, 2], [58, 77, 2], [60, 76, 2], [62, 72, 2],
        [64, 74, 2], [66, 79, 2], [68, 82, 4], [72, 81, 2], [74, 79, 2], [76, 74, 4],
        [80, 72, 2], [82, 75, 2], [84, 79, 4], [88, 82, 4], [92, 79, 4],
        [96, 81, 3], [100, 79, 2], [102, 77, 2], [104, 79, 2], [106, 81, 2], [108, 84, 4],
        [120, 72, 2], [122, 74, 2], [124, 76, 2], [126, 77, 2],
      ],
    },
    boss: {
      bpm: 144, drums: 2, drive: 2,
      bars: [[43, 1], [44, 0], [43, 1], [41, 1], [43, 1], [44, 0], [46, 1], [44, 0]],
      // clipped stabs circling the half-step, ending on a chromatic slither
      lead: [
        [0, 67, 1], [2, 67, 1], [4, 70, 2], [8, 67, 1], [10, 68, 1], [12, 67, 4],
        [16, 68, 2], [20, 72, 2], [24, 68, 1], [26, 68, 1], [28, 75, 4],
        [32, 74, 2], [36, 70, 2], [40, 67, 1], [42, 68, 1], [44, 67, 2], [46, 62, 2],
        [48, 65, 2], [52, 68, 2], [56, 72, 4], [60, 68, 2], [62, 65, 2],
        [64, 79, 2], [66, 79, 1], [68, 74, 2], [72, 75, 2], [76, 74, 4],
        [80, 80, 4], [84, 75, 2], [88, 72, 2], [92, 68, 4],
        [96, 77, 2], [100, 74, 2], [104, 70, 2], [108, 74, 2], [110, 77, 2],
        [112, 80, 2], [116, 79, 2], [120, 74, 1], [122, 75, 1], [124, 74, 1], [126, 73, 1],
      ],
    },
  };
  // dense per-step lookup so the hot path never scans the sparse tables
  for (const k in MOODS) {
    const m = MOODS[k];
    m.leadMap = new Array(128).fill(null);
    for (const n of m.lead) m.leadMap[n[0]] = n;
  }

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

  /* 0..1 from the game (alert level / combo heat): opens the bass filter,
   * densifies the snare work and fades in the dread tremolo so escalation
   * is audible, not just a HUD bar. */
  function setMusicIntensity(v) {
    musicIntensity = Math.max(0, Math.min(1, v || 0));
  }

  function startMusicEngine() {
    if (!ctx || musicTimer) return;
    musicBus = ctx.createGain();
    musicBus.gain.value = musicGainValue();
    // a compressor glues the march — kick and snare pump the brass slightly,
    // and a dozen simultaneous voices can't clip the output
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    musicBus.connect(comp);
    comp.connect(ctx.destination);
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
      if ((musicStep & 15) === 0) {
        if (pendingMood) {
          musicMood = pendingMood;
          pendingMood = null;
          musicStep = 0;   // new mood always enters at the top of its hook
        }
        if (musicMood) mstep = 60 / MOODS[musicMood].bpm / 4;
      }
      if (musicMood && !muted && musicVol > 0) playMusicStep(musicStep, musicNext);
      musicStep = (musicStep + 1) & 127;   // 8 bars of 16 steps
      musicNext += mstep;
    }
  }

  // voice helpers — every node routes into musicBus, never into the SFX master
  function mOsc(type, freq, t, dur, peak, cutoff, attack) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + (attack || 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(musicBus);
    o.start(t); o.stop(t + dur + 0.03);
  }

  /* Fanfare brass: two saws detuned against each other, pitch scooping up
   * into the note and the filter blooming open just behind the attack —
   * the cheap-synth cartoon of a trumpet section leaning into a phrase. */
  function mBrass(midi, t, dur, peak, cutoff) {
    const hz = mf(midi);
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(hz * 0.982, t);
      o.frequency.exponentialRampToValueAtTime(hz, t + 0.045);
      o.detune.setValueAtTime(det, t);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(cutoff * 0.45, t);
      f.frequency.exponentialRampToValueAtTime(cutoff, t + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + 0.025);
      g.gain.setValueAtTime(Math.max(peak, 0.0002), t + Math.max(0.03, dur * 0.55));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(f); f.connect(g); g.connect(musicBus);
      o.start(t); o.stop(t + dur + 0.03);
    }
  }

  /* Military snare: bandpassed crack + highpass sizzle + a short skin thump.
   * peak scales all three, so the same voice does accents and ghost notes. */
  function mSnare(t, peak) {
    mNoise(t, 0.11, peak, 'bandpass', 1900);
    mNoise(t, 0.05, peak * 0.55, 'highpass', 5200);
    mOsc('triangle', 196, t, 0.06, peak * 0.5, 900, 0.004);
  }

  /* Buzz roll: a crescendo of 32nd-note ghost hits, the parade-snare build
   * that yanks every phrase back to its downbeat. */
  function mRoll(t, count, spacing, peakEnd) {
    for (let i = 0; i < count; i++) {
      mNoise(t + i * spacing, 0.035, peakEnd * (0.25 + 0.75 * (i / count)), 'bandpass', 2000);
    }
  }

  /* Noise sweep rising into a downbeat — the held-breath before the loop
   * slams back around. */
  function mRiser(t, dur, peak) {
    const src = ctx.createBufferSource();
    src.buffer = mNoiseBuf();
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(320, t);
    f.frequency.exponentialRampToValueAtTime(3800, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + dur * 0.92);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(musicBus);
    src.start(t, Math.random());
    src.stop(t + dur + 0.03);
  }

  /* Timpani boom for the anthem: a kick stretched into a hall. */
  function mTimp(t, midi, peak) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(mf(midi) * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(mf(midi), t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(g); g.connect(musicBus);
    o.start(t); o.stop(t + 1.2);
  }

  function mNoiseBuf() {
    if (!musicNoiseBuf) {
      const len = ctx.sampleRate;   // one shared second of noise
      musicNoiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = musicNoiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return musicNoiseBuf;
  }

  function mNoise(t, dur, peak, filterType, freq) {
    const src = ctx.createBufferSource();
    src.buffer = mNoiseBuf();
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

  /* One pad chord per bar: root + third + fifth as detuned saws through a
   * closed lowpass, swelling under everything else. The third makes the
   * major/minor character of each bar land; the boss mix stacks a b9 on
   * top so even the sustain feels wrong. */
  function mPad(root, minor, t, cutoff, peak, b9) {
    const barDur = mstep * 16;
    const tones = [
      [root + 12, -5], [root + 12 + (minor ? 3 : 4), 4], [root + 19, 2],
    ];
    if (b9) tones.push([root + 25, 6]);
    for (const [note, det] of tones) {
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
    const bar = (step >> 4) & 7, pos = step & 15;
    const chord = mood.bars[bar];
    const root = chord[0], minor = chord[1];
    const inten = musicIntensity;

    if (pos === 0) {
      mPad(root, minor, t,
        mood.drive === 0 ? 560 : 720 + inten * 520,
        mood.drive === 0 ? 0.075 : 0.05,
        mood.drive === 2 && inten > 0.4);
      // sub drone under the war footing — felt more than heard
      if (mood.drive === 2 || inten > 0.5) {
        mOsc('sine', mf(root - 12), t, mstep * 16, 0.1, 220, 0.3);
      }
    }

    // lead: bugle on the anthem, massed brass over the marches, with a faint
    // octave-up shimmer so the hook glints like parade chrome
    const note = mood.leadMap[step];
    if (note) {
      const dur = note[2] * mstep;
      if (mood.drive === 0) {
        mOsc('triangle', mf(note[1]), t, dur, 0.06, 2400, 0.05);
      } else {
        mBrass(note[1], t, dur, 0.05 + inten * 0.022, 1700 + inten * 2100);
        mOsc('triangle', mf(note[1] + 12), t, dur * 0.8, 0.02, 5200);
      }
    }

    // bass: long hymn tones on the menu; sousaphone oom-pah (root, fifth
    // below) in combat that picks up marching 8ths as the alert climbs; the
    // boss just pounds relentless 8ths with octave kicks
    if (mood.drive === 0) {
      if (pos === 0) mOsc('triangle', mf(root - 12), t, mstep * 9, 0.17, 320, 0.08);
      else if (pos === 10) mOsc('triangle', mf(root - 5), t, mstep * 5, 0.12, 300, 0.06);
    } else if (mood.drive === 1) {
      if (pos === 0 || pos === 8) {
        mOsc('sawtooth', mf(root - 12), t, mstep * 3.4, 0.26, 420 + inten * 480);
      } else if (pos === 4 || pos === 12) {
        mOsc('sawtooth', mf(root - 17), t, mstep * 3.4, 0.22, 420 + inten * 480);
      } else if (inten > 0.35 && (pos & 1) === 0) {
        mOsc('sawtooth', mf(root), t, mstep * 1.4, 0.13, 520 + inten * 560);
      }
    } else if ((pos & 1) === 0) {
      const oct = (pos === 6 || pos === 14) ? 0 : -12;
      mOsc('sawtooth', mf(root + oct), t, mstep * 1.7,
        (pos & 3) === 0 ? 0.27 : 0.22, 400 + inten * 520);
    }

    // dread layer: high tremolo strings sawing on the off-16ths, creeping up
    // a half-step in the boss mix — the horror-score shiver over the anthem
    if (inten > 0.55 && mood.drive > 0 && (pos & 1) === 1) {
      const creep = mood.drive === 2 && ((step >> 1) & 1) ? 1 : 0;
      mOsc('sawtooth', mf(root + 36 + creep), t, mstep * 0.9,
        0.008 + (inten - 0.55) * 0.03, 3200, 0.006);
    }

    // drums
    if (mood.drums === 0) {
      // parade ground heard from a bunker: timpani on the phrase pillars and
      // a distant snare roll every fourth bar — the war is close, even here
      if (pos === 0 && (bar === 0 || bar === 4)) mTimp(t, root - 12, 0.16);
      if (pos === 8 && (bar & 3) === 3) mRoll(t, 12, mstep / 2, 0.028);
      return;
    }
    if (pos === 0 && bar === 0) mNoise(t, 0.55, 0.08, 'highpass', 5600);   // crash
    if (mood.drums === 1) {
      if (pos === 0 || pos === 8 || (inten > 0.5 && pos === 6)) mKick(t);
      if (pos === 4 || pos === 12) mSnare(t, 0.2);
      else if (pos === 2 || pos === 7 || pos === 10) {
        mSnare(t, 0.04 + inten * 0.035);                                   // ghosts
      }
      if (pos === 12 && (bar === 3 || bar === 7 || inten > 0.7)) {
        mRoll(t + mstep, 6, mstep / 2, 0.12);
      }
    } else {
      if ((pos & 3) === 0) mKick(t);
      if (pos === 4 || pos === 12) mSnare(t, 0.22);
      else if ((pos & 3) === 2) mSnare(t, 0.05 + inten * 0.04);
      if (bar === 7 && pos === 8) mRoll(t, 16, mstep / 2, 0.14);
    }
    if ((pos & 1) === 1) mNoise(t, 0.03, 0.045 + inten * 0.05, 'highpass', 6800);   // hats
    else if (inten > 0.65 && (pos & 3) === 2) mNoise(t, 0.025, 0.04, 'highpass', 7500);
    // held breath into the loop point
    if (pos === 0 && bar === 7 && (mood.drive === 2 || inten > 0.35)) {
      mRiser(t, mstep * 16, 0.05 + inten * 0.04);
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
  let engineStopTimer = null;
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
    // once the fade-out ramp has landed, tear the oscillator down entirely —
    // an inaudible sawtooth+filter otherwise keeps processing for the rest of
    // the session. startEngine() lazily reboots it on the next drive.
    if (speed01 <= 0) {
      if (!engineStopTimer) {
        engineStopTimer = setTimeout(() => { engineStopTimer = null; stopEngine(); }, 500);
      }
    } else if (engineStopTimer) {
      clearTimeout(engineStopTimer);
      engineStopTimer = null;
    }
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
