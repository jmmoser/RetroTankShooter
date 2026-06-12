/* Web Audio synthesized retro SFX — no sound files needed. */
const AudioSys = (() => {
  let ctx = null;
  let master = null;
  let engineOsc = null, engineGain = null, engineFilter = null;
  let muted = false;

  try { muted = localStorage.getItem('pa_muted') === '1'; } catch (e) {}

  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    return true;
  }

  function resume() {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
  }

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem('pa_muted', m ? '1' : '0'); } catch (e) {}
    if (master) master.gain.value = m ? 0 : 0.5;
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

  function noise(dur, vol, fStart, fEnd, delay = 0) {
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(fStart, t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(fEnd, 40), t0 + dur);
    const g = ctx.createGain();
    env(g, t0, vol, 0.005, dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.05);
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
    levelClear() {
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => tone('square', f, f, 0.14, 0.28, i * 0.12));
    },
    gameOver() {
      const notes = [392, 330, 262, 196];
      notes.forEach((f, i) => tone('sawtooth', f, f * 0.97, 0.3, 0.3, i * 0.22));
    },
    lowShield()  { tone('square', 880, 880, 0.06, 0.22); tone('square', 880, 880, 0.06, 0.22, 0.12); },
    select()     { tone('square', 880, 880, 0.05, 0.2); },
    deploy()     { tone('square', 220, 880, 0.35, 0.3); noise(0.3, 0.15, 600, 3000); },
  };

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

  /* speed01: 0..1 of max speed */
  function setEngine(speed01) {
    if (!ctx) return;
    if (!engineOsc) startEngine();
    const t = ctx.currentTime;
    engineOsc.frequency.setTargetAtTime(38 + speed01 * 55, t, 0.08);
    engineFilter.frequency.setTargetAtTime(180 + speed01 * 500, t, 0.08);
    engineGain.gain.setTargetAtTime(0.05 + speed01 * 0.10, t, 0.1);
  }

  function play(name) {
    if (!ctx || muted) return;
    if (sfx[name]) sfx[name]();
  }

  return { resume, play, setEngine, stopEngine, toggleMuted, isMuted };
})();
