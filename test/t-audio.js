/* AudioSys against a fake AudioContext: the Safari 'interrupted' resume, the
 * per-key voice cap, per-hull fire voices, stingers and the heartbeat. */
const { loadScripts, check, assert } = require('./helpers');

let created = 0;
const connections = [];
function param(v) {
  return {
    value: v || 0,
    setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {},
    setTargetAtTime() {}, cancelScheduledValues() {}, cancelAndHoldAtTime() {},
  };
}
function node(extra) {
  created++;
  return Object.assign({ connect(to) { connections.push([this, to]); }, disconnect() {}, start() {}, stop() {} }, extra || {});
}
class FakeAC {
  constructor() {
    this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 8000;
    this.destination = node(); this.resumed = 0; FakeAC.last = this;
  }
  resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); }
  createGain() { return node({ gain: param(1) }); }
  createOscillator() { return node({ type: 'sine', frequency: param(440), detune: param(0) }); }
  createBiquadFilter() { return node({ type: 'lowpass', frequency: param(1000), Q: param(1) }); }
  createDynamicsCompressor() { return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }); }
  createConvolver() { return node({ buffer: null }); }
  createStereoPanner() { return node({ pan: param(0) }); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  createBufferSource() { return node({ buffer: null, loop: false }); }
}
global.window = global;
global.AudioContext = FakeAC;
Object.defineProperty(global, 'navigator', { value: { userAgent: 'node' }, configurable: true, writable: true });
global.Settings = { get: () => 7 };

loadScripts(['audio.js'], 'global.AudioSys = AudioSys;');

check('resume() boots the context with platform mute already enforced', () => {
  AudioSys.setPlatformMuted(true);
  AudioSys.resume();
  const ctx = FakeAC.last;
  assert(ctx && ctx.state === 'running', 'context running after the first gesture');
  const finalGate = connections.find(([, to]) => to === ctx.destination)[0];
  assert(finalGate.gain.value === 0, 'all audio passes through the muted final gate');
  AudioSys.setPlatformMuted(false);
});

check('platform mute cannot be overridden by user settings or resume', () => {
  const finalGate = connections.find(([, to]) => to === FakeAC.last.destination)[0];
  const userMuted = AudioSys.isMuted();
  AudioSys.setPlatformMuted(true);
  AudioSys.toggleMuted(); AudioSys.setVolume(1); AudioSys.setMusicVolume(1); AudioSys.resume();
  assert(finalGate.gain.value === 0, 'user controls cannot bypass the platform gate');
  AudioSys.toggleMuted(); AudioSys.setPlatformMuted(false);
  assert(finalGate.gain.value === 1, 'audio gate restored');
  assert(AudioSys.isMuted() === userMuted, 'player mute preference is preserved');
});

check('Safari: an interrupted context is resumed on the next gesture', () => {
  const ctx = FakeAC.last;
  ctx.state = 'interrupted';
  const n = ctx.resumed;
  AudioSys.resume();
  assert(ctx.resumed === n + 1 && ctx.state === 'running', 'interrupted must resume too');
});

check('voice cap: a burst of identical explosions folds into a few voices', () => {
  const ctx = FakeAC.last;
  const before = AudioSys._voicesDropped();
  for (let i = 0; i < 12; i++) AudioSys.play('explosion', { x: i * 30, z: 0 });
  assert(AudioSys._voicesDropped() - before >= 6, 'most of twelve simultaneous explosions are dropped');
  ctx.currentTime += 2;   // the pool drains with time
  const c0 = created;
  AudioSys.play('explosion', { x: 500, z: 0 });
  assert(created > c0, 'after the voices end, a new one is admitted');
});

check('every hull type has its own fire voice, plus the distinct overheat and UI family', () => {
  for (const k of ['fireDrone', 'fireHunter', 'fireSniper', 'firePhantom', 'fireShellback', 'fireWarden',
                   'overheat', 'hover', 'back', 'toggleOn', 'toggleOff', 'tick', 'confirm']) {
    assert(AudioSys._hasSfx(k), 'missing sfx ' + k);
  }
});

check('stingers and the heartbeat schedule voices without throwing', () => {
  const c0 = created;
  AudioSys.setMusicMood('combat');
  AudioSys.stinger('alarm');
  AudioSys.stinger('nosuch');
  AudioSys.setHeartbeat(0.8);
  assert(created > c0, 'nodes were built for the stinger and the beat');
  const c1 = created;
  AudioSys.setHeartbeat(0.8);   // same instant: the next beat is not due yet
  assert(created === c1, 'the heartbeat is paced, not spammed');
  AudioSys.setHeartbeat(0);
});

// the sequencer's setInterval would otherwise keep this process alive forever
process.exit(process.exitCode || 0);
