/* Core game state: arena generation, player, enemy AI, projectiles, pickups.
 *
 * Spectre Challenger-style systems live here: bouncy walls, a turbo boost
 * gauge, lobbed grenades with splash, resupply depots, cloaking phantom
 * tanks, and tanks that shatter into tumbling polygon shards.
 *
 * On top of that: a sector ALERT level that escalates as flags fall
 * (reinforcements warp in, survivors get faster), a kill-chain COMBO
 * multiplier broken by taking damage, and a WARLORD boss every 5 sectors.
 *
 * Two more layers:
 *  - ELITE variants (sector 3+) — hardened, faster, worth more.
 *  - Proximity MINES — a droppable second secondary that rewards boost-kiting.
 * Plus two run modes beyond the campaign: seeded DAILY OPS arenas (the UTC
 * date drives arena generation, so everyone fights the same layout) and a
 * VERSUS deathmatch where the co-op squad turns on itself.
 *
 * The engagement core — YOU are the phantom:
 *  - STEALTH — enemies patrol unaware; each hull fills a detection meter
 *    when it sees or hears you. Firing, boosting and a hot cannon raise
 *    your SIGNATURE; slow and cold you're near-invisible.
 *  - ALARM — get spotted and the grid hunts you: converge waves warp in
 *    until you break contact and the alarm decays. Quiet is the default,
 *    the old everything-hunts-you game is the punishment for sloppy play.
 *  - EXTRACTION — the last uplink wakes the whole sector; the run ends at
 *    a far-side extraction gate, not on a mop-up.
 *  - TECH drafts — kills/captures pay tech; each level deals a 3-choice
 *    stacking upgrade draft (UPGRADES) that builds the run's weapon.
 *  - RUSHERS — kamikaze hulls that force movement, and BOOST RAMS that
 *    double as the silent assassination tool.
 */

const ARENA_HALF = 175;          // arena is a square, +/- ARENA_HALF
const WALL_PAD = 3;              // keep tanks this far from the wall
const COMBO_WINDOW = 4;          // seconds between kills to keep the chain
const BOSS_EVERY = 5;            // a WARLORD guards every Nth sector
const CAP_RADIUS = 8.5;          // uplink zone radius — stand inside to capture
const CAP_TIME = 3.2;            // seconds of uncontested holding per zone

// Heat cannon: no ammo — the gun rides a heat gauge. Hotter = faster and
// harder (redline), overheat = locked out. A manual vent with a perfect-tap
// window (Gears-style) is the rhythm skill at the center of every fight.
const SHOT_HEAT = 7;             // heat per shell
const VENT_TIME = 1.1;           // full manual vent duration (seconds)
const VENT_WIN = [0.38, 0.58];   // perfect-tap window inside the vent sweep
const OVERHEAT_LOCK = 2.6;       // forced cooldown after redlining past max
const GRAZE_R = 4.2;             // enemy shots passing this close (but not
                                 // hitting) refund boost and pay tech

/* Stealth model — the player is the phantom. Patrols fill a detection
 * meter (e.sense) when they see or hear a tank; at SENSE_SUS they break
 * off to investigate, at 1 they alert and the sector alarm rises. Loud
 * actions register NOISE events that pull patrols to the spot. */
const SENSE_SUS = 0.4;     // detection meter: patrol -> investigating
const SIGHT_CONE = 1.05;   // half-angle of a patrolling hull's vision cone
const NOISE_SHOT = 60;     // cannon report radius
const NOISE_BOOM = 70;     // grenade / mine / rusher blast radius
const NOISE_WRECK = 45;    // a packmate shattering nearby is a tell
const NOISE_RAM = 22;      // boost-ram kill: the assassin's quiet tool
const ALERT_RADIUS = 45;   // an alerted hull radios packmates this close
const EXIT_RADIUS = 10;    // extraction gate: park inside to warp out

/* Campaign difficulty presets (SETTINGS → DIFFICULTY). dmg scales what
 * enemies do to the squad, pressure stretches/shrinks the spawn-pressure
 * timer, potSpill is the pot fraction KEPT after a hit, waves trims the
 * alarm/alert reinforcement counts (never below 1). regen is the
 * out-of-combat shield trickle (per second, after REGEN_DELAY unhit) and
 * regenTo the fraction of max it can restore — chip damage stops being a
 * death spiral, while depots and pickups still own the full top-up.
 * detect scales how fast enemy sensors fill; alarm is how many seconds the
 * grid keeps hunting after it loses contact with you. */
const DIFFICULTY = [
  { dmg: 0.5,  pressure: 1.8,  potSpill: 0.9,  waves: -1, regen: 8, regenTo: 1,    detect: 0.6,  alarm: 9  },  // RECRUIT — learn the systems
  { dmg: 1,    pressure: 1,    potSpill: 0.7,  waves: 0,  regen: 5, regenTo: 0.65, detect: 1,    alarm: 14 },  // STANDARD — as designed
  { dmg: 1.2,  pressure: 0.85, potSpill: 0.6,  waves: 0,  regen: 0, regenTo: 0,    detect: 1.35, alarm: 20 },  // VETERAN — the arena bites back
];
const REGEN_DELAY = 5;   // seconds without taking a hit before the trickle starts

/* Sector gate mutators: after a clear you pick the NEXT sector's ruleset.
 * Riskier gates pay a tech signing bonus the moment you deploy. */
const MUTATORS = [
  { id: 'swarm',    name: 'SWARM PROTOCOL', desc: 'relentless light waves, thin hulls',  tech: 40 },
  { id: 'barren',   name: 'BARREN GRID',    desc: 'no depots — live off salvage',        tech: 40 },
  { id: 'elite',    name: 'ELITE SURGE',    desc: 'hardened hulls everywhere',           tech: 50 },
  { id: 'volatile', name: 'VOLATILE HULLS', desc: 'every kill detonates',                tech: 40 },
  { id: 'gauntlet', name: 'ELITE GAUNTLET', desc: 'all elites, no mercy',                tech: 95 },
];

/* Per-sector optional bounties: auto-tracked, pay tech to the whole squad. */
const BOUNTIES = [
  { id: 'ram',    name: '3 RAM KILLS',      n: 3 },
  { id: 'nade',   name: '3 GRENADE KILLS',  n: 3 },
  { id: 'mine',   name: '2 MINE KILLS',     n: 2 },
  { id: 'graze',  name: 'GRAZE 8 SHOTS',    n: 8 },
  { id: 'mult',   name: 'REACH COMBO ×4',   n: 1 },
  { id: 'silent', name: '3 SILENT KILLS',   n: 3 },
];

// Boss turret mounts in hull-local space (model faces -Z). Shared with the
// renderer and net code so clients can rebuild turret positions by index.
const BOSS_TURRET_OFFSETS = [[-4.2, -2.6], [4.2, -2.6], [-3.4, 4.4], [3.4, 4.4]];
const BOSS_TURRET_Y = 3.4;

/* World position of a boss turret (hull-local offset rotated by hull yaw). */
function bossTurretWorld(b, tu) {
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  return [b.x + tu.dx * c + tu.dz * s, b.z - tu.dx * s + tu.dz * c];
}

const LOADOUTS = [
  { name: 'SCOUT',      speed: 5, armor: 2, ammo: 3, nades: 4, mines: 1 },
  { name: 'VANGUARD',   speed: 3, armor: 3, ammo: 4, nades: 3, mines: 1 },
  { name: 'JUGGERNAUT', speed: 2, armor: 5, ammo: 3, nades: 2, mines: 2 },
  // earned, not given: unlocked by destroying a WARLORD (Progress.marauderUnlocked)
  { name: 'MARAUDER',   speed: 4, armor: 4, ammo: 2, nades: 4, mines: 3 },
];

// sight: how far the hull can spot a FULL-signature tank inside its vision
// cone; a slow, cold tank shrinks that to ~a third. Snipers are the
// long-range eyes of the grid — cross their lane hot and the map knows.
const ENEMY_TYPES = {
  drone:     { hp: 60,  speed: 14, turn: 1.6, fireRange: 95,  fireCd: 2.2, aggro: 999, score: 150, shotSpeed: 50, dmg: 14, lead: 0,   sight: 55 },
  rusher:    { hp: 22,  speed: 26, turn: 3.4, fireRange: 0,   fireCd: 9,   aggro: 999, score: 100, shotSpeed: 0,  dmg: 30, lead: 0,   sight: 45 },
  hunter:    { hp: 85,  speed: 22, turn: 2.4, fireRange: 70,  fireCd: 1.5, aggro: 999, score: 300, shotSpeed: 58, dmg: 18, lead: 0.8, sight: 70 },
  sniper:    { hp: 75,  speed: 7,  turn: 1.2, fireRange: 160, fireCd: 3.2, aggro: 999, score: 400, shotSpeed: 85, dmg: 26, lead: 0.9, sight: 150 },
  phantom:   { hp: 110, speed: 19, turn: 2.2, fireRange: 100, fireCd: 2.3, aggro: 999, score: 600, shotSpeed: 66, dmg: 22, lead: 0.8, sight: 85, cloaks: true },
  // counterplay hulls: reading the fight matters more than holding fire
  shellback: { hp: 150, speed: 9,  turn: 1.1, fireRange: 75,  fireCd: 2.6, aggro: 999, score: 350, shotSpeed: 48, dmg: 20, lead: 0.4, sight: 50, frontArmor: true },
  warden:    { hp: 90,  speed: 8,  turn: 1.4, fireRange: 70,  fireCd: 3.0, aggro: 999, score: 500, shotSpeed: 46, dmg: 12, lead: 0.3, sight: 55, aura: 16 },
};

/* In-run TECH upgrade pool: kills and zone captures pay tech, each tech level
 * deals a 3-choice draft. Stackable up to `max`; effects are applied by
 * applyUpgrade (instant stats) or read live from p.up (weapon behavior).
 * This is the run's build system — by mid-game no two tanks fight alike. */
const UPGRADES = [
  { id: 'twin',       name: 'TWIN CANNON',      desc: '+1 barrel per trigger pull',            max: 2 },
  { id: 'ricochet',   name: 'RICOCHET ROUNDS',  desc: 'shells bounce off walls (+1 bounce)',   max: 2 },
  { id: 'pierce',     name: 'PIERCING CORE',    desc: 'shells punch through +1 tank',          max: 2 },
  { id: 'rapid',      name: 'AUTOLOADER',       desc: 'fire rate +18%',                        max: 3 },
  { id: 'hipower',    name: 'HOT SHELLS',       desc: 'cannon damage +30%',                    max: 3 },
  { id: 'cluster',    name: 'CLUSTER CHARGES',  desc: 'grenades split into bomblets',          max: 1 },
  { id: 'shockwave',  name: 'SHOCK DISCHARGE',  desc: 'ending a boost slams out a shockwave',  max: 1 },
  { id: 'ram',        name: 'RAM PLATING',      desc: 'boost-rams hit harder, cost no shields', max: 2 },
  { id: 'siphon',     name: 'SHIELD SIPHON',    desc: 'kills restore 4 shields',               max: 3 },
  { id: 'coolhead',   name: 'COMBO REGULATOR',  desc: 'combo window +1.5s',                    max: 2 },
  { id: 'bandolier',  name: 'BANDOLIER',        desc: '+2 max grenades, +1 max mine (restocked)', max: 2 },
  { id: 'plating',    name: 'REACTIVE PLATING', desc: 'max shields +25 (repaired)',            max: 3 },
  { id: 'cache',      name: 'COOLANT LOOP',     desc: 'heat capacity +25, faster dissipation', max: 3 },
  { id: 'vent',       name: 'VENT TUNING',      desc: 'wider perfect-vent window, +2 supercharged shells', max: 2 },
  { id: 'razor',      name: 'RAZOR EDGE',       desc: 'grazes refund more boost and pay tech', max: 2 },
  { id: 'uplink',     name: 'UPLINK SPIKE',     desc: 'capture zones 30% faster',              max: 2 },
  { id: 'magnet',     name: 'SALVAGE MAGNET',   desc: 'pickups are drawn to you',              max: 1 },
  { id: 'overcharge', name: 'BOOST OVERCHARGE', desc: '+35 boost capacity, faster regen',      max: 2 },
  { id: 'ghost',      name: 'GHOST PLATING',    desc: 'enemy sensors fill 20% slower',         max: 2 },
];

// Spectre-style solid slabs: saturated flat-shaded colors that pop
// against the void, dimming into the fog with distance.
const OBSTACLE_PALETTE = [
  [0.72, 0.20, 0.20], [0.20, 0.42, 0.78], [0.20, 0.62, 0.32],
  [0.62, 0.62, 0.62], [0.72, 0.54, 0.18], [0.46, 0.28, 0.72],
];

// Hull colors used for the shard debris a destroyed tank breaks into.
const DEBRIS_COLORS = {
  drone:     [1.0, 0.30, 0.24],
  rusher:    [1.0, 0.30, 0.55],
  hunter:    [1.0, 0.62, 0.14],
  sniper:    [0.78, 0.44, 1.0],
  phantom:   [0.62, 0.92, 0.95],
  shellback: [0.62, 0.68, 0.74],
  warden:    [0.95, 0.76, 0.28],
  player:    [0.25, 1.0, 0.82],
};

const POWERUP_TYPES = {
  coolant:   { tint: [0.95, 0.8, 0.25], label: '+COOLANT' },
  shield:    { tint: [0.3, 0.95, 0.6],  label: '+SHIELDS' },
  nade:      { tint: [0.55, 1.0, 0.35], label: '+GRENADES' },
  mine:      { tint: [1.0, 0.35, 0.6],  label: '+MINES' },
  overdrive: { tint: [0.3, 0.7, 1.0],   label: 'OVERDRIVE' },
  rapid:     { tint: [1.0, 0.45, 0.2],  label: 'RAPID FIRE' },
};

function fwdX(a) { return -Math.sin(a); }
function fwdZ(a) { return -Math.cos(a); }
function angleTo(dx, dz) { return Math.atan2(-dx, -dz); }
function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function dist2(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}
/* All in-sim randomness flows through RNG so a daily run can swap in a
 * seeded generator during arena generation (and back out for combat). */
let RNG = Math.random;
function rand(a, b) { return a + RNG() * (b - a); }

/* Deterministic PRNG + string hash for the seeded daily arenas. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

// Tints used to tell co-op tanks apart (multiply over the player hull color).
const PLAYER_TINTS = [
  [1.0, 1.0, 1.0],   // P1 — stock teal
  [1.2, 0.7, 1.4],   // P2 — violet
  [1.4, 1.1, 0.5],   // P3 — amber
  [0.6, 1.2, 1.4],   // P4 — ice
];

class Game {
  constructor(hud) {
    this.hud = hud;
    this.mode = 'idle';
    this.level = 1;
    this.score = 0;
    this.shake = 0;
    this.obstacles = [];
    this.flags = [];
    this.enemies = [];
    this.projectiles = [];
    this.powerups = [];
    this.particles = [];
    this.flashes = [];     // short-lived point lights from bursts (cosmetic)
    this.debris = [];      // tumbling polygon shards from destroyed tanks
    this.depots = [];      // resupply pads: { x, z, type: 'coolant'|'shield' }
    this.players = [];     // all tanks in the run (co-op); player[0..n]
    this.player = null;    // alias to the LOCAL player (for HUD / camera)
    this.localId = null;
    this.frameSounds = []; // sfx triggered this update — drained by the net layer
    this.frameBursts = []; // particle bursts this update — drained by the net layer
    this.frameDebris = []; // shard spawns this update — drained by the net layer
    this.levelBonus = 0;
    this.killsThisLevel = 0;
    this.combo = 0;        // style points in the current chain (float)
    this.comboT = 0;       // time left before the chain expires
    this.comboWin = COMBO_WINDOW; // window length (stretched by COMBO REGULATOR)
    this.mult = 1;         // score multiplier from the chain
    this.lastKillVia = null; // style engine: repeat kills are worth less
    this.pot = 0;          // unbanked kill score — banks on zone capture,
                           // spills 30% every time the squad takes a hit
    this.levelTime = 0;    // seconds into the current sector (spawn pressure)
    this.pressureT = 7;    // countdown to the next pressure wave
    this.mutator = null;   // active sector mutator id (chosen at the gate)
    this.gates = null;     // gate options offered on the level-clear screen
    this.bounty = null;    // this sector's optional bounty { id, name, n, prog, paid }
    this.alert = 0;        // 0..1 — fraction of flags secured this sector
    this.alertTier = 0;    // reinforcement waves already triggered
    this.noises = [];      // one-frame noise events: { x, z, r, mag }
    this.alarmT = 0;       // >0: the grid is hunting (seconds of hunt left)
    this.suspicion = false; // any patrol currently investigating (HUD tell)
    this.everAlarmed = false; // the alarm went off at least once this sector
    this.ghostRun = false; // extraction reached with the alarm never raised
    this.exit = null;      // extraction gate { x, z } once the uplinks fall
    this.lastKnownX = 0;   // where the grid last had contact with the squad
    this.lastKnownZ = 0;
    this.pendingSpawns = []; // warp-in telegraphs: { x, z, type, t, tick }
    this.boss = null;      // WARLORD state on boss sectors
    this.bossLevel = false;
    this.rings = [];       // expanding shockwaves: { x, z, r, speed, dmg, hit }
    this.mines = [];       // proximity mines: { x, z, owner, arm, life }
    this.dailySeed = null; // 'YYYY-MM-DD' on daily runs — seeds arena generation
    this.versus = false;   // deathmatch: players hunt each other, no enemies
    this.killTarget = 10;  // versus win condition
    this.killCounts = {};  // versus: playerId -> kills
    this.winnerId = null;
    this.puTimer = 0;      // versus: contested powerup respawn timer
    this.runStats = { kills: 0, flags: 0, warlords: 0, bestMult: 1, localKills: 0, nadeKills: 0, mineKills: 0 };
    this.levelUntouched = true; // local player unhit this sector (medal)
  }

  /* Queue a sound: plays locally and is mirrored to clients by the host. */
  _sfx(key) {
    this.frameSounds.push(key);
    AudioSys.play(key);
  }

  /* Award a one-time medal to the LOCAL player: toast + jingle on first
   * earn, silent no-op forever after. Local-only on purpose — the sound is
   * played directly (not _sfx) so co-op clients don't hear the host's. */
  _medal(id) {
    if (this.versus || typeof Medals === 'undefined' || !Medals.award(id)) return;
    const def = MEDALS.find((m) => m.id === id);
    this.hud.message('★ MEDAL — ' + (def ? def.name : id) + ' ★', '#ffd24a', 2.6);
    AudioSys.play('unlock');
  }

  _makePlayer(def, idx) {
    const lo = LOADOUTS[def.loadoutIndex] || LOADOUTS[1];
    const p = {
      id: def.id,
      name: def.name || ('PLAYER ' + (idx + 1)),
      colorIdx: idx % PLAYER_TINTS.length,
      input: { turn: 0, drive: 0, fire: false, nade: false, boost: false },
      x: 0, z: 0, angle: 0,
      speed: 0,            // throttle scalar (hull-axis intent)
      vx: 0, vz: 0,        // true velocity — drifts decouple it from facing
      maxSpeed: 14 + lo.speed * 3.2,
      accel: 26 + lo.speed * 5,
      turnRate: 1.7 + lo.speed * 0.14,
      maxShields: 50 + lo.armor * 22,
      shields: 0,
      // heat cannon: the loadout's old ammo stat is now its cooling plant
      heat: 0,
      maxHeat: 100,
      heatDiss: 5 + lo.ammo * 1.2,
      venting: 0,          // >0: manual vent in progress (elapsed seconds)
      overheatT: 0,        // >0: locked out after redlining past maxHeat
      superShots: 0,       // perfect-vent reward: free +50% shells
      ventHeld: false,     // previous frame's vent input, for edge detection
      maxBoost: 100,
      boost: 100,
      boosting: false,
      maxNades: 6,
      nades: lo.nades,
      nadeCd: 0,
      maxMines: 4,
      mines: lo.mines || 0,
      mineCd: 0,
      initNades: lo.nades,
      initMines: lo.mines || 0,
      fireCd: 0,
      fireDelay: 0.38,
      fx: { overdrive: 0, rapid: 0 },
      alive: true,
      respawnT: 0,
      lowWarned: false,
      bounceCd: 0,
      depotAcc: 0,
      onDepot: false,
      loadout: lo.name,
      // in-run TECH build: kills/captures pay tech, levels deal upgrade drafts
      up: {},              // upgradeId -> stacks owned
      tech: 0,             // points toward the next level
      techNext: 50,        // points needed for the next level
      techLvl: 0,
      tech01: 0,           // progress fraction, mirrored to HUD/net
      pendingOffers: null, // [upgradeId x3] while a draft is waiting on a pick
      pendingLevels: 0,    // levels banked while a draft is already open
      offersSent: false,   // host: draft message delivered to a remote player
      ramCd: 0,            // per-ram cooldown so one pass = one hit
      boostHeld: 0,        // seconds the current boost has been engaged
      sinceHit: 0,         // seconds since last damage, for shield recovery
      sig: 0.15,           // SIGNATURE 0..1 — how loud this hull reads on sensors
    };
    p.shields = p.maxShields;
    return p;
  }

  /* defs: [{ id, name, loadoutIndex }]; localId names the local tank.
   * opts: { startLevel, dailySeed, versus, killTarget } */
  newRun(defs, localId, opts) {
    opts = opts || {};
    if (!Array.isArray(defs)) defs = [{ id: 'solo', loadoutIndex: defs }]; // solo back-compat
    this.level = opts.startLevel || 1;
    this.dailySeed = opts.dailySeed || null;
    this.versus = !!opts.versus;
    this.killTarget = opts.killTarget || 10;
    this.killCounts = {};
    this.winnerId = null;
    this.score = 0;
    this.pot = 0;
    this.mutator = null;
    this.gates = null;
    this.runStats = { kills: 0, flags: 0, warlords: 0, bestMult: 1, localKills: 0, nadeKills: 0, mineKills: 0, silentKills: 0 };
    // one-shot coaching lines: zones are HELD, not touched — say so the
    // first time the local tank starts (and abandons) a capture this run
    this._hintHold = false;
    this._hintDrain = false;
    this._hintSpotted = false;
    this.players = defs.map((d, i) => this._makePlayer(d, i));
    for (const p of this.players) this.killCounts[p.id] = 0;
    this.localId = localId != null ? localId : this.players[0].id;
    this.player = this.players.find((p) => p.id === this.localId) || this.players[0];
    this.startLevel();
  }

  _anyAlive() {
    for (const p of this.players) if (p.alive) return true;
    return false;
  }

  _nearestPlayer(x, z) {
    let best = null, bd = Infinity;
    for (const p of this.players) {
      if (!p.alive) continue;
      const d = dist2(x, z, p.x, p.z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  startLevel() {
    const L = this.level;
    this.obstacles = [];
    this.flags = [];
    this.enemies = [];
    this.projectiles = [];
    this.powerups = [];
    this.particles = [];
    this.flashes = [];
    this.debris = [];
    this.depots = [];
    this.mines = [];
    this._flagSites = null;
    this.shake = 0;
    this.killsThisLevel = 0;
    this.combo = 0; this.comboT = 0; this.mult = 1;
    this.alert = 0; this.alertTier = 0;
    this.pendingSpawns = [];
    this.rings = [];
    this.boss = null;
    this.bossLevel = !this.versus && L >= BOSS_EVERY && L % BOSS_EVERY === 0;
    this.levelUntouched = true;
    this.levelTime = 0;
    this.noises.length = 0;
    this.suspicion = false;
    this.exit = null;
    this.ghostRun = false;
    // boss sectors are set-piece fights: the WARLORD's grid is already
    // awake, there is no sneaking up on a hovercruiser
    this.alarmT = this.bossLevel ? 1e9 : 0;
    this.everAlarmed = this.bossLevel;
    this.pressureT = 4;      // converge-wave cadence once the alarm is up
    if (!this.versus && L >= 8) this._medal('deepstrike');

    // daily runs: the date + sector seeds generation, so every player in the
    // world fights the same layout. Combat randomness reverts to Math.random
    // at the end of this function.
    if (this.dailySeed) RNG = mulberry32(hashStr(this.dailySeed + '#' + L));

    const n = this.players.length;
    const spawns = this._spawnPoints();
    this.players.forEach((p, i) => {
      if (this.versus) {
        const s = spawns[i % spawns.length];
        p.x = s[0]; p.z = s[1];
        p.angle = angleTo(-p.x, -p.z);   // face the arena center
      } else {
        p.x = (i - (n - 1) / 2) * 8;
        p.z = ARENA_HALF - 22;
        p.angle = 0;
      }
      p.speed = 0; p.vx = 0; p.vz = 0;
      p.fx.overdrive = 0; p.fx.rapid = 0;
      p.boost = p.maxBoost;
      p.heat = 0; p.venting = 0; p.overheatT = 0;
      p.alive = true; p.respawnT = 0; p.lowWarned = false;
      p.input.fire = false; p.input.nade = false; p.input.mine = false;
      p.depotAcc = 0; p.onDepot = false;
    });

    // per-sector bounty: an optional objective, auto-tracked, paid in tech
    this.bounty = null;
    if (!this.versus && !this.bossLevel) {
      const b = BOUNTIES[(RNG() * BOUNTIES.length) | 0];
      this.bounty = { id: b.id, name: b.name, n: b.n, prog: 0, paid: false };
    }
    this.lastKillVia = null;

    if (this.versus) {
      // deathmatch arena: cover and contested resupply, no AI
      this._genObstacles(34, RNG() < 0.5 ? 'scatter' : 'corridors');
      this._genDepots();
      this.puTimer = 6;
    } else if (this.bossLevel) {
      // boss arena: no flags, more open ground, a small escort — the WARLORD
      // itself is the objective.
      this._genObstacles(30);
      this._genDepots();
      this._spawnBoss();
      const escorts = Math.min(2 + Math.floor(L / BOSS_EVERY), 5);
      for (let i = 0; i < escorts; i++) {
        const pos = this._findSpot(4, 65);
        if (pos) this._spawnEnemy(i % 2 === 0 ? 'hunter' : 'drone', pos[0], pos[1]);
      }
      this._sfx('alarm');
      this.hud.message('WARLORD DETECTED — DESTROY IT', '#ff4a3c', 3.5);
    } else {
      // fewer, harder objectives: each zone is a held fight, not a waypoint.
      // The count ramps from 3 so the first sectors are short campaigns,
      // not marathons.
      this._genObstacles(40 + Math.min(L * 3, 28), this._pickLayout());
      this._genFlags(Math.min(2 + L, 10));
      this._genEnemies();
      this._genDepots();
    }
    // a couple of starter pickups scattered on the field
    for (let i = 0; i < 2; i++) {
      const pos = this._findSpot(4, 40);
      if (pos) this._spawnPowerup(pos[0], pos[1], RNG() < 0.5 ? 'coolant' : 'shield');
    }
    RNG = Math.random;   // seeded window ends with generation
    this.mode = 'playing';
    // first sector of a fresh campaign: spell out the two rules that changed
    // everything — you are invisible until seen, and zones are held
    if (!this.versus && !this.bossLevel && L === 1) {
      this.hud.message('YOU ARE THE PHANTOM — STAY SLOW AND COLD, STRIKE FIRST', '#4fd6bb', 4);
      this.hud.message('DRIVE INTO A ZONE RING AND HOLD IT TO CAPTURE', '#8ecbff', 3.4);
    }
    if (this.mutator) {
      const m = MUTATORS.find((x) => x.id === this.mutator);
      if (m) this.hud.message(m.name + ' — ' + m.desc.toUpperCase(), '#ffd24a', 3);
    }
    if (this.bounty) {
      this.hud.message('BOUNTY: ' + this.bounty.name, '#e8c75a', 2.4);
    }
  }

  /* Where tanks deploy: the home corridor in the campaign, spread corners in
   * versus. Also used to keep obstacle generation clear of deploy zones. */
  _spawnPoints() {
    if (!this.versus) return [[0, ARENA_HALF - 22]];
    const d = ARENA_HALF - 26;
    return [[-d, -d], [d, d], [-d, d], [d, -d]];
  }

  flagsLeft() {
    let n = 0;
    for (const f of this.flags) if (!f.taken) n++;
    return n;
  }

  /* Active difficulty preset. Daily Ops always runs STANDARD so the shared
   * seed stays a level playing field, and versus is player-vs-player. In
   * co-op the host simulates, so the host's setting is the squad's. */
  _diff() {
    if (this.versus || this.dailySeed) return DIFFICULTY[1];
    const d = typeof Settings !== 'undefined' ? Settings.get('difficulty') : 1;
    return DIFFICULTY[d] || DIFFICULTY[1];
  }

  // ---- generation ---------------------------------------------------------

  _collidesObstacle(x, z, r) {
    for (const o of this.obstacles) {
      if (o.dead) continue;   // crushed by the boss
      const hx = o.w / 2 + r, hz = o.d / 2 + r;
      if (Math.abs(x - o.x) < hx && Math.abs(z - o.z) < hz) return o;
    }
    return null;
  }

  /* Find a clear spot in a ring around (cx, cz), keeping distance from all
   * players — used to warp reinforcements in near the objective. */
  _findSpotNear(cx, cz, rMin, rMax, clearR, minPlayerDist) {
    for (let tries = 0; tries < 40; tries++) {
      const a = rand(0, Math.PI * 2);
      const r = rand(rMin, rMax);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (Math.abs(x) > ARENA_HALF - 12 || Math.abs(z) > ARENA_HALF - 12) continue;
      if (this._collidesObstacle(x, z, clearR)) continue;
      let nearPlayer = false;
      for (const p of this.players) {
        if (p.alive && Math.hypot(x - p.x, z - p.z) < minPlayerDist) { nearPlayer = true; break; }
      }
      if (nearPlayer) continue;
      return [x, z];
    }
    return this._findSpot(clearR, minPlayerDist);
  }

  _findSpot(clearR, minPlayerDist) {
    for (let tries = 0; tries < 60; tries++) {
      const x = rand(-ARENA_HALF + 12, ARENA_HALF - 12);
      const z = rand(-ARENA_HALF + 12, ARENA_HALF - 12);
      if (Math.hypot(x - this.player.x, z - this.player.z) < minPlayerDist) continue;
      if (this._collidesObstacle(x, z, clearR)) continue;
      return [x, z];
    }
    return null;
  }

  /* Try to place one slab. Rejects out-of-bounds spots, deploy zones and
   * overlaps (pad = extra clearance against existing obstacles). */
  _addSlab(x, z, w, d, h, type, pad) {
    if (Math.abs(x) > ARENA_HALF - 8 || Math.abs(z) > ARENA_HALF - 8) return false;
    for (const sp of this._spawnPoints()) {
      if (Math.hypot(x - sp[0], z - sp[1]) < 18) return false;
    }
    if (this._collidesObstacle(x, z, Math.max(w, d) / 2 + (pad != null ? pad : 2))) return false;
    this.obstacles.push({
      x, z, w, d, h, type,
      color: OBSTACLE_PALETTE[(RNG() * OBSTACLE_PALETTE.length) | 0],
    });
    return true;
  }

  /* Sector terrain comes in four flavors so the mid-game doesn't blur into
   * one arena: the classic scatter, wall corridors, a central bastion, and
   * cover rings thrown around the flag sites. Dailies stay deterministic —
   * everything routes through RNG, which is seeded during generation. */
  _pickLayout() {
    if (this.level <= 1) return 'scatter';   // sector 1 teaches the basics
    const r = RNG();
    if (r < 0.34) return 'scatter';
    if (r < 0.57) return 'corridors';
    if (r < 0.80) return 'rings';
    return 'bastion';
  }

  _genObstacles(count, layout) {
    if (layout === 'corridors') return this._genCorridors(count);
    if (layout === 'bastion') return this._genBastion(count);
    if (layout === 'rings') return this._genRings(count);
    this._genScatter(count);
  }

  _genScatter(count) {
    for (let i = 0; i < count; i++) {
      for (let tries = 0; tries < 40; tries++) {
        const x = rand(-ARENA_HALF + 10, ARENA_HALF - 10);
        const z = rand(-ARENA_HALF + 10, ARENA_HALF - 10);
        const pyramid = RNG() < 0.4;
        const w = pyramid ? rand(5, 9) : rand(4, 11);
        const d = pyramid ? w : rand(4, 11);
        const h = pyramid ? rand(5, 11) : rand(3, 9);
        if (this._addSlab(x, z, w, d, h, pyramid ? 'pyramid' : 'block', 5)) break;
      }
    }
  }

  /* Long broken walls form firing lanes; the gaps between segments are the
   * doors. Fights channel down the lanes instead of opening up everywhere. */
  _genCorridors(count) {
    const vertical = RNG() < 0.5;
    const lanes = 3 + ((RNG() * 3) | 0);
    const span = (ARENA_HALF - 45) * 2;
    for (let i = 0; i < lanes; i++) {
      const off = -ARENA_HALF + 45 + (i + 0.5) * (span / lanes) + rand(-8, 8);
      let run = -ARENA_HALF + 20 + rand(0, 14);
      while (run < ARENA_HALF - 34) {
        const len = rand(16, 30);
        const cx = run + len / 2;
        const h = rand(4, 7), thick = rand(4, 6);
        if (vertical) this._addSlab(off, cx, thick, len, h, 'block', 1);
        else this._addSlab(cx, off, len, thick, h, 'block', 1);
        run += len + rand(12, 20);
      }
    }
    this._genScatter(Math.floor(count / 4));
  }

  /* A walled keep in the middle of the arena with a gate on each side and
   * watchtower pyramids at the corners — whatever spawns inside has to be
   * dug out through the gates. */
  _genBastion(count) {
    const r = rand(38, 50);
    const h = rand(5, 8);
    const gate = 16;
    const seg = r - gate / 2;
    const mid = gate / 2 + seg / 2;
    for (const s of [-1, 1]) {
      this._addSlab(s * mid, -r, seg, 5, h, 'block', 0);
      this._addSlab(s * mid, r, seg, 5, h, 'block', 0);
      this._addSlab(-r, s * mid, 5, seg, h, 'block', 0);
      this._addSlab(r, s * mid, 5, seg, h, 'block', 0);
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        this._addSlab(sx * (r + 10), sz * (r + 10), 7, 7, rand(8, 12), 'pyramid', 1);
      }
    }
    this._genScatter(Math.floor(count / 2));
  }

  /* Broken circles of cover scattered across the field; flags spawn inside
   * them (via _flagSites), so every objective is a small breach-and-clear. */
  _genRings(count) {
    const sites = [];
    const nSites = 3 + ((RNG() * 3) | 0);
    for (let i = 0; i < nSites; i++) {
      const pos = this._findSpot(24, 60);
      if (!pos) continue;
      const [cx, cz] = pos;
      const rad = rand(14, 19);
      const n = 5 + ((RNG() * 3) | 0);
      const a0 = rand(0, Math.PI * 2);
      for (let k = 0; k < n; k++) {
        if (RNG() < 0.25) continue;   // breached sections = ways in
        const a = a0 + (k / n) * Math.PI * 2;
        this._addSlab(cx + Math.cos(a) * rad, cz + Math.sin(a) * rad,
          rand(6, 10), rand(4, 6), rand(4, 7),
          RNG() < 0.25 ? 'pyramid' : 'block', 0);
      }
      sites.push([cx, cz]);
    }
    this._flagSites = sites;
    this._genScatter(Math.floor(count / 3));
  }

  _genFlags(count) {
    const sites = this._flagSites || [];
    for (let i = 0; i < count; i++) {
      let pos = null;
      if (i < sites.length) pos = this._findSpotNear(sites[i][0], sites[i][1], 1, 7, 3.5, 25);
      if (!pos) pos = this._findSpot(3.5, 25);
      if (pos) {
        this.flags.push({
          x: pos[0], z: pos[1], taken: false, spin: rand(0, Math.PI * 2),
          cap: 0, contested: false, pulseT: 0,   // uplink zone state
        });
      }
    }
  }

  _genDepots() {
    if (this.mutator === 'barren') return;   // BARREN GRID: live off salvage
    // one coolant pad and one shield pad per sector — drive on to resupply
    for (const type of ['coolant', 'shield']) {
      const pos = this._findSpot(6, 45);
      if (pos) this.depots.push({ x: pos[0], z: pos[1], type });
    }
  }

  /* alerted: warp in already hunting (alarm converge waves, boss escorts). */
  _spawnEnemy(type, x, z, alerted) {
    const L = this.level;
    const spec = ENEMY_TYPES[type];
    const diff = 1 + (L - 1) * 0.085;
    // elites: hardened variants that show up from sector 3 — tougher, faster,
    // meaner and worth half again the score. They strobe white-hot in the
    // arena and wear a ring on the radar. ELITE SURGE triples the odds;
    // the GAUNTLET is nothing but.
    let eliteP = !this.bossLevel && L >= 3 ? Math.min(0.06 + L * 0.02, 0.3) : 0;
    if (this.mutator === 'elite') eliteP = Math.min(eliteP * 3, 0.75);
    const elite = this.mutator === 'gauntlet' || RNG() < eliteP;
    const hpMul = (elite ? 1.6 : 1) * (this.mutator === 'swarm' ? 0.7 : 1);
    this.enemies.push({
      type,
      elite,
      x, z,
      angle: rand(0, Math.PI * 2),
      hp: spec.hp * hpMul,
      maxHp: spec.hp * hpMul,
      speed: spec.speed * diff * (elite ? 1.15 : 1),
      turn: spec.turn * diff,
      fireRange: spec.fireRange,
      fireCd: rand(1, spec.fireCd),
      fireDelay: spec.fireCd / diff / (elite ? 1.2 : 1),
      aggro: spec.aggro,
      score: elite ? Math.round(spec.score * 1.5) : spec.score,
      shotSpeed: spec.shotSpeed,
      // fewer hulls on the field now, so each one hits harder — being
      // caught is supposed to be scary
      dmg: spec.dmg * 1.3 * (elite ? 1.25 : 1),
      lead: spec.lead || 0,
      cloak: spec.cloaks ? 1 : 0,
      decloakT: 0,
      wanderX: x, wanderZ: z,
      wanderT: 0,
      hitFlash: 0,
      // stealth: patrols start blind; sense fills as they see/hear you
      sense: alerted || this.bossLevel ? 1 : 0,
      alerted: !!alerted || this.bossLevel,
      seenT: 999,                 // seconds since this hull last had contact
      invX: x, invZ: z, invT: 0,  // investigation point + time left searching
      // per-type maneuver state: hunters weave between flanking arcs and
      // lunges, snipers relocate after every shot, drones regroup when hurt
      orbitDir: RNG() < 0.5 ? 1 : -1,
      phase: 'lunge',
      phaseT: rand(0.4, 1.6),
      relocT: 0, relocX: x, relocZ: z,
    });
  }

  _genEnemies() {
    // a handful of patrols, not a swarm: every hull is a stalk-and-kill
    // problem, and alarm converge waves feed the field if you get loud
    const L = this.level;
    let total = Math.min(3 + Math.floor(L * 0.9), 9);
    if (this.mutator === 'swarm') total += 3;        // thin hulls, more of them
    if (this.mutator === 'gauntlet') total -= 2;     // all elites — fewer, harder
    for (let i = 0; i < total; i++) {
      let type = 'drone';
      if (L >= 2 && i % 3 === 1) type = 'hunter';
      if (L >= 4 && i % 4 === 2) type = 'sniper';
      if (L >= 5 && i % 5 === 3) type = 'phantom';
      if (L >= 2 && i % 5 === 4) type = 'rusher';
      if (L >= 3 && i % 6 === 5) type = 'shellback';
      if (L >= 4 && i % 7 === 3) type = 'warden';
      const pos = this._findSpot(4, 65);
      if (!pos) continue;
      this._spawnEnemy(type, pos[0], pos[1]);
    }
  }

  _spawnPowerup(x, z, type) {
    this.powerups.push({ x, z, type, spin: rand(0, Math.PI * 2), bob: rand(0, Math.PI * 2) });
  }

  // ---- update -------------------------------------------------------------

  update(dt) {
    this.frameSounds.length = 0;
    this.frameBursts.length = 0;
    this.frameDebris.length = 0;
    if (this.mode !== 'playing') return;
    this.shake = Math.max(0, this.shake - dt * 3);

    // kill-chain combo: expires quietly when the window runs out
    let cool = 0;
    for (const p of this.players) cool = Math.max(cool, p.up ? (p.up.coolhead || 0) : 0);
    this.comboWin = COMBO_WINDOW + cool * 1.5;
    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) { this.comboT = 0; this.combo = 0; this.mult = 1; }
    }

    for (const p of this.players) this._updatePlayer(p, dt);
    if (!this.versus) {
      this.levelTime += dt;
      this._updatePressure(dt);
      this._updateZones(dt);
      this._updateEnemies(dt);
      this._updateBoss(dt);
      this._updateSpawns(dt);
    }
    this._updateRings(dt);
    this._updateMines(dt);
    this._updateProjectiles(dt);
    this._updatePickups(dt);
    this._updateDepots(dt);
    this._updateParticles(dt);
    this._updateDebris(dt);

    for (const f of this.flags) f.spin += dt * 2.2;

    if (this.versus) {
      this._updateVersus(dt);
      return;
    }

    const objectiveDone = this.bossLevel
      ? (this.boss && this.boss.dead && this.boss.deathT <= 0)
      : (this.exit && this._allAtExit());
    if (this._anyAlive() && objectiveDone) {
      this._levelClear();
    } else if (!this._anyAlive()) {
      this._beginDeath();
    }
  }

  // ---- versus deathmatch ------------------------------------------------------
  // The co-op plumbing already handles multiple tanks; versus just points the
  // guns inward. Fallen tanks always respawn, first to killTarget wins.

  _updateVersus(dt) {
    // keep a few contested powerups cycling onto the field
    this.puTimer -= dt;
    if (this.puTimer <= 0) {
      this.puTimer = rand(7, 12);
      if (this.powerups.length < 6) {
        const keys = Object.keys(POWERUP_TYPES);
        const pos = this._findSpot(4, 30);
        if (pos) this._spawnPowerup(pos[0], pos[1], keys[(RNG() * keys.length) | 0]);
      }
    }
    for (const p of this.players) {
      if ((this.killCounts[p.id] || 0) >= this.killTarget) {
        this.winnerId = p.id;
        this.mode = 'versusover';
        this._sfx('levelClear');
        break;
      }
    }
  }

  // ---- alarm pressure ---------------------------------------------------------
  // The inversion at the heart of the pivot: the sector is QUIET by default.
  // Converge waves only warp in while the alarm is up — get spotted and the
  // grid hunts you until you break contact and go cold. Rushers lead most
  // waves; during the extraction getaway the cadence never lets up.

  _updatePressure(dt) {
    if (this.bossLevel) {
      // boss sectors get a slow escort trickle so the arena stays hot
      if (!this.boss || this.boss.dead) return;
      this.pressureT -= dt;
      if (this.pressureT <= 0) {
        this.pressureT = 13;
        if (this.enemies.length + this.pendingSpawns.length < 5) {
          const p = this._nearestPlayer(this.boss.x, this.boss.z) || this.player;
          const pos = this._findSpotNear(p.x, p.z, 45, 80, 4, 40);
          if (pos) this.pendingSpawns.push({ x: pos[0], z: pos[1], type: RNG() < 0.6 ? 'rusher' : 'hunter', t: 1.8, tick: 0, al: 1 });
        }
      }
      return;
    }
    if (this.alarmT <= 0) { this.pressureT = Math.min(this.pressureT, 4); return; }
    this.pressureT -= dt;
    if (this.pressureT > 0) return;
    this.pressureT = Math.max(4, 10 - this.level * 0.5) *
      (this.mutator === 'swarm' ? 0.55 : 1) * this._diff().pressure *
      (this.exit ? 0.7 : 1);   // the getaway keeps the screws on
    const cap = Math.min(6 + this.level, 13);
    if (this.enemies.length + this.pendingSpawns.length >= cap) return;
    const n = 1 + (this.level > 3 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      // waves converge on the grid's last contact with the squad
      const pos = this._findSpotNear(this.lastKnownX, this.lastKnownZ, 40, 75, 4, 38);
      if (pos) this.pendingSpawns.push({ x: pos[0], z: pos[1], type: this._pressureType(), t: 1.8, tick: 0, al: 1 });
    }
  }

  _pressureType() {
    // rusher-heavy: pressure waves should force movement, not add snipers
    if (this.level >= 2 && RNG() < 0.4) return 'rusher';
    return this._reinforcementType();
  }

  // ---- uplink zones -------------------------------------------------------------
  // Objectives are held, not touched: stand in the zone while its uplink
  // fills. Hacking an uplink is NOISY — it pulses and nearby patrols come
  // looking. The stealth play is clearing the local patrol first; the loud
  // play is holding the ring against whatever the pulses drag in.

  _updateZones(dt) {
    for (const f of this.flags) {
      if (f.taken) continue;
      const holders = [];
      for (const p of this.players) {
        if (p.alive && dist2(p.x, p.z, f.x, f.z) < CAP_RADIUS * CAP_RADIUS) holders.push(p);
      }
      const localIn = holders.some((h) => h.id === this.localId);
      if (!holders.length) {
        f.contested = false;
        // coach the drain the first time the local tank walks away mid-capture
        if (!this._hintDrain && f.localWas && f.cap > 0.08) {
          this._hintDrain = true;
          this.hud.message('UPLINK DRAINING — GET BACK IN THE RING', '#ffd24a', 2.6);
        }
        f.localWas = false;
        f.cap = Math.max(0, (f.cap || 0) - dt / 6);   // uplink decays if abandoned
        continue;
      }
      if (!this._hintHold && localIn) {
        this._hintHold = true;
        this.hud.message('HOLD THE RING UNTIL THE UPLINK FILLS', '#4fd6bb', 3);
      }
      f.localWas = localIn;
      f.contested = true;
      let spike = 0;
      for (const h of holders) spike = Math.max(spike, h.up ? (h.up.uplink || 0) : 0);
      const rate = (1 + 0.35 * (holders.length - 1)) * (1 + 0.3 * spike);
      f.cap = (f.cap || 0) + (dt / CAP_TIME) * rate;
      // the hack pulses: every beat, patrols in earshot turn to investigate
      f.pulseT = (f.pulseT || 0) - dt;
      if (f.pulseT <= 0) {
        f.pulseT = 1.6;
        this._noise(f.x, f.z, 55, 0.55);
      }
      if (f.cap >= 1) {
        f.cap = 1;
        f.taken = true;
        this.runStats.flags++;
        const pts = 100 * this.level * this.mult;
        this.score += pts;
        this._bankPot();   // the capture is the cash-out
        this._burst(f.x, 2.5, f.z, 18, [0.3, 1, 0.5], 8);
        this._sfx('flag');
        for (const h of holders) this._awardTech(h, 40);
        const isLocal = holders.some((h) => h.id === this.localId);
        if (isLocal) {
          this.hud.pickup();
          this.hud.scorePop('+' + pts + (this.mult > 1 ? ' ×' + this.mult : ''));
        }
        const left = this.flagsLeft();
        this.hud.message(left > 0 ? `ZONE SECURED — ${left} LEFT` : 'ALL ZONES SECURED', '#3cff78', 1.6);
        this._onFlagSecured();
      }
    }
  }

  // ---- stealth core -------------------------------------------------------------
  // Noise events, per-hull detection, the sector alarm and the stand-down.
  // The grid is deaf and blind until you give it something to work with.

  /* Register a one-frame noise event: patrols inside r turn to investigate.
   * mag is how far it pushes their detection meter (capped below alert —
   * noise makes them LOOK, only eyes-on makes them SHOOT). */
  _noise(x, z, r, mag) {
    if (this.versus) return;
    this.noises.push({ x, z, r, mag });
  }

  /* A hull got eyes on the squad: it opens fire, radios its packmates, and
   * the sector alarm goes up. */
  _alertEnemy(e, x, z) {
    if (e.alerted) return;
    e.alerted = true;
    e.sense = 1;
    e.seenT = 0;
    this._burst(e.x, 3.4, e.z, 8, [1, 0.25, 0.2], 6);
    for (const o of this.enemies) {
      if (o === e || o.alerted) continue;
      if (dist2(e.x, e.z, o.x, o.z) < ALERT_RADIUS * ALERT_RADIUS) {
        o.alerted = true; o.sense = 1; o.seenT = 0;
      }
    }
    this._raiseAlarm(x, z);
  }

  _raiseAlarm(x, z) {
    this.lastKnownX = x; this.lastKnownZ = z;
    const was = this.alarmT > 0;
    this.alarmT = Math.max(this.alarmT, this._diff().alarm);
    if (was) return;
    this.everAlarmed = true;
    this.pressureT = Math.min(this.pressureT, 2.5);
    this._sfx('alarm');
    this.hud.message('SPOTTED — THE GRID IS HUNTING', '#ff4a3c', 2.4);
    if (!this._hintSpotted) {
      this._hintSpotted = true;
      this.hud.message('BREAK LINE OF SIGHT AND RUN COLD TO SHAKE THEM', '#ffd24a', 3.2);
    }
  }

  /* The alarm ran out: hunters fall back to searching the last known
   * position, and the sector goes quiet again. */
  _standDown() {
    this.alarmT = 0;
    let any = false;
    for (const e of this.enemies) {
      if (!e.alerted) continue;
      any = true;
      e.alerted = false;
      e.sense = SENSE_SUS + 0.2;
      e.invX = this.lastKnownX + rand(-14, 14);
      e.invZ = this.lastKnownZ + rand(-14, 14);
      e.invT = rand(6, 10);
    }
    if (any) {
      this._sfx('cloak');
      this.hud.message('CONTACT LOST — YOU ARE A GHOST AGAIN', '#4fd6bb', 2.4);
    }
  }

  // ---- in-run TECH drafts ---------------------------------------------------------
  // Kills and captures pay tech; each level deals a 3-choice upgrade draft.
  // The pick is applied here (host-authoritative in co-op).

  _playerById(id) {
    for (const p of this.players) if (p.id === id) return p;
    return null;
  }

  _awardTech(p, pts) {
    if (this.versus || !p || !p.up) return;
    p.tech += pts;
    while (p.tech >= p.techNext) {
      p.tech -= p.techNext;
      p.techLvl++;
      p.techNext = 50 + p.techLvl * 45;
      if (p.pendingOffers) p.pendingLevels++;
      else this._rollOffers(p);
      if (p.id === this.localId && p.pendingOffers) {
        this.hud.message('TECH LEVEL ' + p.techLvl + ' — CHOOSE UPGRADE', '#ffd24a', 2.2);
        AudioSys.play('unlock');
      }
    }
    p.tech01 = Math.min(1, p.tech / p.techNext);
  }

  _rollOffers(p) {
    const pool = UPGRADES.filter((u) => (p.up[u.id] || 0) < u.max);
    if (!pool.length) { this.score += 500; return; }   // full build: cash it in
    for (let i = pool.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    p.pendingOffers = pool.slice(0, Math.min(3, pool.length)).map((u) => u.id);
    p.offersSent = false;
  }

  /* Validate and apply a draft pick. Instant stats mutate the player here;
   * behavioral upgrades are read from p.up at their point of use. */
  applyUpgrade(playerId, upgradeId) {
    const p = this._playerById(playerId);
    if (!p || !p.pendingOffers || p.pendingOffers.indexOf(upgradeId) < 0) return false;
    p.up[upgradeId] = (p.up[upgradeId] || 0) + 1;
    switch (upgradeId) {
      case 'rapid':      p.fireDelay *= 0.82; break;
      case 'bandolier':  p.maxNades += 2; p.nades = Math.min(p.maxNades, p.nades + 2);
                         p.maxMines += 1; p.mines = Math.min(p.maxMines, p.mines + 1); break;
      case 'plating':    p.maxShields += 25; p.shields = Math.min(p.maxShields, p.shields + 25); break;
      case 'cache':      p.maxHeat += 25; p.heatDiss *= 1.25; p.heat = 0; break;
      case 'overcharge': p.maxBoost += 35; p.boost = p.maxBoost; break;
    }
    p.pendingOffers = null;
    p.offersSent = false;
    if (p.pendingLevels > 0) {
      p.pendingLevels--;
      this._rollOffers(p);
    }
    const def = UPGRADES.find((u) => u.id === upgradeId);
    if (p.id === this.localId && def) {
      this.hud.message(def.name + ' ONLINE', '#ffd24a', 1.8);
      AudioSys.play('powerup');
    }
    return true;
  }

  // ---- alert escalation -----------------------------------------------------
  // Securing uplinks makes the grid suspicious: survivors get faster, and
  // crossing a threshold warps FRESH PATROLS in near the remaining zones.
  // They arrive blind — thicker patrol coverage, not a converge wave (unless
  // the alarm is already up, in which case they warp in hunting). The last
  // uplink opens the extraction gate and wakes the whole sector.

  _onFlagSecured() {
    const total = this.flags.length;
    if (!total) return;
    let taken = 0;
    for (const f of this.flags) if (f.taken) taken++;
    this.alert = taken / total;

    if (this.flagsLeft() === 0) { this._openExtraction(); return; }

    const thresholds = [0.45, 0.75, 0.92];
    while (this.alertTier < thresholds.length && this.alert >= thresholds[this.alertTier]) {
      this.alertTier++;
      const wave = Math.max(1, Math.min(3, 1 + Math.floor((this.level + this.alertTier) / 4)) + this._diff().waves);
      let queued = 0;
      for (let i = 0; i < wave; i++) {
        if (this.enemies.length + this.pendingSpawns.length >= 14) break;
        const live = this.flags.filter((f) => !f.taken);
        const f = live[(RNG() * live.length) | 0];
        const pos = this._findSpotNear(f.x, f.z, 12, 30, 4, 45);
        if (!pos) continue;
        this.pendingSpawns.push({ x: pos[0], z: pos[1], type: this._reinforcementType(), t: 1.8, tick: 0, al: this.alarmT > 0 ? 1 : 0 });
        queued++;
      }
      if (queued > 0) {
        this._sfx('warp');
        this.hud.message('GRID SUSPICION RISING — FRESH PATROLS INBOUND', '#ffd24a', 2.2);
      }
    }
  }

  /* The last uplink fell: the grid knows, and knows WHERE. An extraction
   * gate opens across the arena — the run ends there, through a sector
   * that is wide awake. The getaway is the finale, not a mop-up. */
  _openExtraction() {
    let best = null, bd = -1;
    for (let i = 0; i < 14; i++) {
      const pos = this._findSpot(6, 30);
      if (!pos) continue;
      const d = dist2(pos[0], pos[1], this.player.x, this.player.z);
      if (d > bd) { bd = d; best = pos; }
    }
    if (!best) best = [0, -ARENA_HALF + 30];
    this.exit = { x: best[0], z: best[1] };
    this.ghostRun = !this.everAlarmed;   // the sneak is judged before the getaway
    this.everAlarmed = true;
    this.alarmT = 1e9;                   // no going dark on the way out
    this.lastKnownX = this.player.x; this.lastKnownZ = this.player.z;
    this.pressureT = Math.min(this.pressureT, 2);
    for (const e of this.enemies) { e.alerted = true; e.sense = 1; e.seenT = 0; }
    this._sfx('alarm');
    this.hud.message('UPLINK COMPLETE — REACH THE EXTRACTION GATE', '#4fd6bb', 3.2);
  }

  /* Sector clear condition: every living tank inside the gate ring. */
  _allAtExit() {
    let n = 0;
    for (const p of this.players) {
      if (!p.alive) continue;
      if (dist2(p.x, p.z, this.exit.x, this.exit.z) > EXIT_RADIUS * EXIT_RADIUS) return false;
      n++;
    }
    return n > 0;
  }

  _reinforcementType() {
    const L = this.level, r = RNG();
    if (this.mutator === 'swarm') return r < 0.6 ? 'rusher' : 'drone';
    if (L >= 5 && r < 0.15) return 'phantom';
    if (L >= 4 && r < 0.28) return 'sniper';
    if (L >= 4 && r < 0.38) return 'warden';
    if (L >= 3 && r < 0.52) return 'shellback';
    if (L >= 2 && r < 0.72) return 'hunter';
    if (L >= 2 && r < 0.86) return 'rusher';
    return 'drone';
  }

  /* Warp-in telegraphs: crackle for a beat, then the reinforcement appears. */
  _updateSpawns(dt) {
    for (let i = this.pendingSpawns.length - 1; i >= 0; i--) {
      const s = this.pendingSpawns[i];
      s.t -= dt;
      s.tick -= dt;
      if (s.tick <= 0) {
        s.tick = 0.16;
        this._burst(s.x, 0.6, s.z, 3, [1, 0.25, 0.55], 7);
      }
      if (s.t <= 0) {
        this.pendingSpawns.splice(i, 1);
        this._spawnEnemy(s.type, s.x, s.z, !!s.al);
        this._burst(s.x, 1.5, s.z, 22, [1, 0.3, 0.6], 11);
        this._sfx('warp');
      }
    }
  }

  // ---- combo multiplier -------------------------------------------------------
  // Kills chain into a score multiplier; taking any damage breaks it.

  _awardKill(baseScore, ownerId, via) {
    // STYLE ENGINE: variety keeps the chain white-hot. Repeating the same
    // kill method pays less and less; mixing cannon → ram → nade → mine →
    // shock is what climbs the multiplier.
    const inc = via && via === this.lastKillVia ? 0.4 : 1;
    if (via) this.lastKillVia = via;
    this.combo += inc;
    this.comboT = this.comboWin;
    const c = this.combo;
    const mult = c >= 8 ? 5 : c >= 5 ? 4 : c >= 3 ? 3 : c >= 2 ? 2 : 1;
    if (mult > this.mult) {
      this._sfx('combo');
      this.hud.message('COMBO ×' + mult, '#ffd24a', 1.4);
    }
    if (mult >= 4) this._bountyTick('mult');
    if (mult >= 5 && ownerId === this.localId) this._medal('chain5');
    this.mult = mult;
    this.runStats.kills++;
    this.runStats.bestMult = Math.max(this.runStats.bestMult, mult);
    const pts = baseScore * mult;
    // kill score rides in the POT until you bank it at a zone — greed is a
    // live decision, not a stat
    if (this.versus) this.score += pts;
    else this.pot += pts;
    // stylish play also builds faster: tech income scales with the chain
    this._awardTech(this._playerById(ownerId), Math.round((baseScore / 10) * (1 + (mult - 1) * 0.5)));
    if (ownerId === this.localId) {
      this.hud.scorePop('+' + pts + (mult > 1 ? ' ×' + mult : ''));
    }
    return pts;
  }

  _breakCombo() {
    if (this.mult > 1) {
      this._sfx('comboBreak');
      this.hud.message('COMBO BROKEN', '#ff4a3c', 1.5);
    }
    this.combo = 0;
    this.comboT = 0;
    this.mult = 1;
    this.lastKillVia = null;
  }

  /* Bank the unbanked pot into the score — called on zone captures, boss
   * milestones and sector clear. */
  _bankPot() {
    if (this.versus || this.pot <= 0) return;
    this.score += this.pot;
    this.hud.scorePop('BANKED +' + this.pot);
    this._sfx('flag');
    this.pot = 0;
  }

  /* Advance this sector's bounty; pays the whole squad in tech on completion. */
  _bountyTick(id, n) {
    const b = this.bounty;
    if (!b || b.paid || b.id !== id) return;
    b.prog = Math.min(b.n, b.prog + (n || 1));
    if (b.prog >= b.n) {
      b.paid = true;
      for (const p of this.players) this._awardTech(p, 40);
      this._sfx('unlock');
      this.hud.message('BOUNTY COMPLETE — +40 TECH', '#ffd24a', 2.2);
    }
  }

  _respawn(p) {
    if (this.versus) {
      // deathmatch: always come back, fresh loadout, away from the fight
      const pos = this._findSpotNear(0, 0, 80, ARENA_HALF - 30, 4, 55) || [0, 0];
      p.x = pos[0]; p.z = pos[1];
      p.angle = angleTo(-p.x, -p.z);
      p.speed = 0; p.vx = 0; p.vz = 0;
      p.alive = true;
      p.shields = p.maxShields;
      p.heat = 0; p.venting = 0; p.overheatT = 0;
      p.nades = p.initNades;
      p.mines = p.initMines;
      p.boost = p.maxBoost;
      p.lowWarned = false;
      this._burst(p.x, 1.5, p.z, 24, [0.4, 0.8, 1.0], 10);
      this._sfx('deploy');
      return;
    }
    // only revive if a teammate is still fighting (otherwise the run is over)
    if (!this.players.some((o) => o !== p && o.alive)) { p.respawnT = 0; return; }
    p.x = 0; p.z = ARENA_HALF - 22; p.angle = 0; p.speed = 0;
    p.vx = 0; p.vz = 0;
    p.alive = true;
    p.shields = p.maxShields * 0.6;
    p.heat = 0; p.venting = 0; p.overheatT = 0;
    p.boost = p.maxBoost;
    p.lowWarned = false;
    this._burst(p.x, 1.5, p.z, 24, [0.4, 0.8, 1.0], 10);
    this._sfx('deploy');
  }

  _updatePlayer(p, dt) {
    if (!p.alive) {
      if (p.respawnT > 0) {
        p.respawnT -= dt;
        if (p.respawnT <= 0) this._respawn(p);
      }
      return;
    }

    for (const fx of ['overdrive', 'rapid']) {
      if (p.fx[fx] <= 0) continue;
      p.fx[fx] = Math.max(0, p.fx[fx] - dt);
      if (p.fx[fx] === 0) {
        this._sfx('powerdown');
        if (p.id === this.localId) {
          this.hud.message(POWERUP_TYPES[fx].label + ' EXPIRED', '#4fd6bb', 1.4);
        }
      }
    }
    p.bounceCd = Math.max(0, p.bounceCd - dt);
    p.nadeCd = Math.max(0, p.nadeCd - dt);
    p.mineCd = Math.max(0, p.mineCd - dt);
    p.ramCd = Math.max(0, (p.ramCd || 0) - dt);

    // out-of-combat shield recovery: stay unhit for a few seconds and the
    // hull patches itself back toward the preset's floor. Versus stays raw —
    // respawns are free there — and VETERAN hulls only mend at a depot.
    p.sinceHit = (p.sinceHit || 0) + dt;
    const dr = this._diff();
    if (!this.versus && dr.regen > 0 && p.sinceHit >= REGEN_DELAY) {
      const cap = p.maxShields * dr.regenTo;
      if (p.shields < cap) p.shields = Math.min(cap, p.shields + dr.regen * dt);
    }

    // ---- SIGNATURE: how loud this hull reads on enemy sensors -----------
    // Speed is noise, heat is a beacon, boost is a flare. Slow and cold a
    // patrol has to nearly drive into you; redlining at full boost the
    // whole grid sees you coming. The vent isn't just a DPS trick anymore —
    // it's how you go dark.
    {
      const spd01 = Math.min(1, Math.hypot(p.vx || 0, p.vz || 0) / p.maxSpeed);
      p.sig = Math.min(1, 0.15 + spd01 * 0.45 +
        ((p.heat || 0) / (p.maxHeat || 100)) * 0.4 + (p.boosting ? 0.3 : 0));
    }

    const input = p.input;
    const isLocal = p.id === this.localId;

    // turbo boost: hold SHIFT while driving forward; the gauge drains fast
    // and trickles back when idle — Spectre's classic hit-and-run tool.
    // Hysteresis: a drained gauge must recover before boost re-engages.
    const wantBoost = !!input.boost && input.drive > 0.1 &&
      (p.boosting ? p.boost > 0 : p.boost > 15);
    if (wantBoost && !p.boosting) this._sfx('boost');
    // SHOCK DISCHARGE: ending a committed boost slams out a shockwave
    if (!wantBoost && p.boosting && p.boostHeld > 0.45 && p.up && p.up.shockwave) {
      this._spawnRing(p.x, p.z, 35, { from: 'player', owner: p.id, speed: 34, max: 55 });
    }
    p.boostHeld = wantBoost ? (p.boostHeld || 0) + dt : 0;
    p.boosting = wantBoost;
    const regen = 13 * (1 + 0.25 * ((p.up && p.up.overcharge) || 0));
    if (p.boosting) p.boost = Math.max(0, p.boost - dt * 34);
    else p.boost = Math.min(p.maxBoost, p.boost + dt * regen);

    // ---- movement: velocity-vector physics with drift ----------------------
    // The hull points where you steer; VELOCITY chases the hull's intent at
    // a grip rate. Boosting — or pulling the handbrake (reverse + steer at
    // speed) — drops the grip so the tank slides: swing the gun through a
    // drift while your momentum carries the line. The slide is the skill;
    // stopping isn't: a straight back-pull keeps full grip and brakes hard.
    // Forward-projected velocity gates both, so full reverse (or a boostMult
    // pushing reverse past 55% of rated speed) can't re-trip the brake.
    const fwdVel = p.vx * fwdX(p.angle) + p.vz * fwdZ(p.angle);
    const braking = input.drive < -0.35 && fwdVel > p.maxSpeed * 0.55;
    const handbrake = braking && Math.abs(input.turn) > 0.25;

    const boostMult = (p.fx.overdrive > 0 ? 1.5 : 1) * (p.boosting ? 1.65 : 1);
    const maxSpd = p.maxSpeed * boostMult;

    // throttle intent (hull axis). Braking doesn't reverse — it bleeds
    // throttle while you're still rolling forward; true reverse engages
    // once you've slowed below the gate.
    const driveIn = braking ? 0 : input.drive;
    const target = driveIn >= 0 ? driveIn * maxSpd : driveIn * maxSpd * 0.55;
    const rate = p.accel * (Math.abs(target) > Math.abs(p.speed) ? 1 : 2.2) * (p.boosting ? 1.5 : 1);
    if (p.speed < target) p.speed = Math.min(target, p.speed + rate * dt);
    else if (p.speed > target) p.speed = Math.max(target, p.speed - rate * dt);

    // steering scales down slightly at top speed for weight
    const steerScale = 1 - 0.25 * Math.min(1, Math.abs(p.speed) / maxSpd);
    p.angle += input.turn * p.turnRate * steerScale * dt * (p.speed < -0.5 ? -1 : 1);

    const grip = (p.boosting || handbrake) ? 2.1 : 9;
    const gk = Math.min(1, grip * dt);
    p.vx += (fwdX(p.angle) * p.speed - p.vx) * gk;
    p.vz += (fwdZ(p.angle) * p.speed - p.vz) * gk;
    p.x += p.vx * dt;
    p.z += p.vz * dt;

    // bouncy walls: slam into a slab or the perimeter and you rebound
    const hit = this._collideTank(p, 1.9);
    if (hit && Math.hypot(p.vx, p.vz) > p.maxSpeed * 0.45 && p.bounceCd <= 0) {
      p.bounceCd = 0.35;
      p.speed *= -0.45;
      p.vx = fwdX(p.angle) * p.speed;
      p.vz = fwdZ(p.angle) * p.speed;
      p.boosting = false;
      this._sfx('bounce');
      this._noise(p.x, p.z, 26, 0.35);   // slamming a slab rings out
      this._burst(p.x + fwdX(p.angle) * 2.5, 1.2, p.z + fwdZ(p.angle) * 2.5, 8, [0.9, 0.9, 0.7], 6);
      if (isLocal) this.shake = Math.min(this.shake + 0.45, 1.2);
    } else if (hit) {
      p.speed *= 0.5;
      p.vx *= 0.5; p.vz *= 0.5;
    }

    // BOOST RAM: movement is a weapon — hammering a hostile at boost speed
    // shatters it, and the damage scales with how fast you arrive. Costs a
    // scratch of shields (none with RAM PLATING); never lethal to the rammer.
    const vmag = Math.hypot(p.vx, p.vz);
    if (!this.versus && p.boosting && p.ramCd <= 0 && vmag > p.maxSpeed * 1.15) {
      for (let j = this.enemies.length - 1; j >= 0; j--) {
        const e = this.enemies[j];
        if (dist2(p.x, p.z, e.x, e.z) > 3.4 * 3.4) continue;
        p.ramCd = 0.5;
        const rdmg = 60 + vmag * 2 + ((p.up && p.up.ram) || 0) * 70;
        this._hurtEnemy(j, rdmg, p.id, 'ram');
        p.speed *= 0.5;
        if (!(p.up && p.up.ram > 0)) p.shields = Math.max(1, p.shields - 8);
        this._sfx('bounce');
        if (isLocal) this.shake = Math.min(this.shake + 0.5, 1.2);
        break;
      }
    }

    // ---- manual vent: the rhythm skill ------------------------------------
    // Tap VENT to start the sweep; tap again inside the perfect window for an
    // instant clear plus supercharged shells. Miss it and the vent runs long.
    p.overheatT = Math.max(0, p.overheatT - dt);
    const ventEdge = !!input.vent && !p.ventHeld;
    p.ventHeld = !!input.vent;
    if (p.venting > 0) {
      const winHi = VENT_WIN[1] + ((p.up && p.up.vent) || 0) * 0.1;
      p.venting += dt;
      if (ventEdge && p.venting >= VENT_WIN[0] && p.venting <= winHi) {
        p.venting = 0;
        p.heat = 0;
        p.superShots = 3 + ((p.up && p.up.vent) || 0) * 2;
        this._sfx('combo');
        this._burst(p.x, 1.8, p.z, 14, [0.4, 1.0, 0.9], 8);
        if (isLocal) this.hud.message('PERFECT VENT', '#4fd6bb', 1);
      } else if (p.venting >= VENT_TIME) {
        p.venting = 0;
        p.heat = 0;
        this._sfx('refuel');
      }
    } else if (ventEdge && p.overheatT <= 0 && p.heat > 12) {
      p.venting = 0.0001;
      this._sfx('select');
    }
    if (p.venting <= 0) {
      // passive dissipation; the overheat lockout purges much faster
      p.heat = Math.max(0, p.heat - p.heatDiss * (p.overheatT > 0 ? 3.2 : 1) * dt);
    }

    // main cannon: HEAT replaces ammo. The hotter the gun the faster and
    // harder it fires — ride the redline for output, redline past the top
    // and the cannon locks. Perfect-vent shells are free and supercharged.
    p.fireCd -= dt;
    const hot1 = p.heat >= 55, hot2 = p.heat >= 85;
    const delay = p.fireDelay * (p.fx.rapid > 0 ? 0.45 : 1) * (hot2 ? 0.72 : hot1 ? 0.85 : 1);
    if (input.fire && p.fireCd <= 0) {
      if (p.overheatT <= 0 && p.venting <= 0) {
        p.fireCd = delay;
        const superShot = p.superShots > 0;
        if (superShot) {
          p.superShots--;
        } else {
          p.heat += SHOT_HEAT;
          if (p.heat >= p.maxHeat) {
            p.heat = p.maxHeat;
            p.overheatT = OVERHEAT_LOCK;
            this._sfx('lowShield');
            if (isLocal) this.hud.message('OVERHEAT — COOLING', '#ff4a3c', 1.6);
          }
        }
        const shotAngle = this._aimAssist(p);
        // TECH build shapes the shot: TWIN CANNON adds barrels, HOT SHELLS
        // adds damage, RICOCHET/PIERCING ride along on the projectile.
        const shots = 1 + ((p.up && p.up.twin) || 0);
        const dmg = 25 * (1 + 0.3 * ((p.up && p.up.hipower) || 0)) *
          (hot2 ? 1.3 : hot1 ? 1.15 : 1) * (superShot ? 1.5 : 1);
        for (let si = 0; si < shots; si++) {
          const a = shotAngle + (si - (shots - 1) / 2) * 0.1;
          this.projectiles.push({
            x: p.x + fwdX(a) * 3.2, z: p.z + fwdZ(a) * 3.2, y: 1.6, angle: a,
            speed: 72, from: 'player', owner: p.id, dmg, life: 2.2,
            bounce: (p.up && p.up.ricochet) || 0,
            pierce: (p.up && p.up.pierce) || 0,
          });
        }
        const bx = p.x + fwdX(shotAngle) * 3.2;
        const bz = p.z + fwdZ(shotAngle) * 3.2;
        this._burst(bx, 1.6, bz, superShot ? 8 : 4, superShot ? [0.5, 1, 0.9] : [1, 0.9, 0.5], 5);
        this._sfx('fire');
        this._noise(p.x, p.z, NOISE_SHOT, 0.55);   // the report carries
        if (isLocal) this.shake = Math.min(this.shake + 0.12, 0.5);
      } else {
        p.fireCd = 0.25;
        this._sfx('select'); // thermal-lock click
      }
    }

    // grenade launcher: lobbed shell that arcs over the slabs
    if (input.nade && p.nadeCd <= 0) {
      if (p.nades > 0) {
        p.nades--;
        p.nadeCd = 0.8;
        const bx = p.x + fwdX(p.angle) * 3.0;
        const bz = p.z + fwdZ(p.angle) * 3.0;
        this.projectiles.push({
          x: bx, z: bz, y: 1.8, angle: p.angle, kind: 'nade',
          speed: 34 + Math.max(0, p.speed) * 0.5, vy: 14,
          from: 'player', owner: p.id, dmg: 60, life: 6,
        });
        this._sfx('nade');
        if (isLocal) this.shake = Math.min(this.shake + 0.2, 0.6);
      } else {
        p.nadeCd = 0.4;
        this._sfx('select');
        if (isLocal) this.hud.message('NO GRENADES', '#ff4a3c', 1.2);
      }
    }

    // proximity mine dropped off the tail — arms after a beat, then trips on
    // anything hostile that rolls over it. Rewards boost-and-run play.
    if (input.mine && p.mineCd <= 0) {
      if (p.mines > 0) {
        p.mines--;
        p.mineCd = 0.7;
        this.mines.push({
          x: p.x - fwdX(p.angle) * 3.8,
          z: p.z - fwdZ(p.angle) * 3.8,
          owner: p.id, arm: 0.8, life: 60,
        });
        this._sfx('mine');
      } else {
        p.mineCd = 0.4;
        this._sfx('select');
        if (isLocal) this.hud.message('NO MINES', '#ff4a3c', 1.2);
      }
    }

    if (isLocal) {
      if (p.shields <= p.maxShields * 0.25 && !p.lowWarned) {
        p.lowWarned = true;
        this.hud.message('SHIELDS CRITICAL', '#ff4a3c', 2.5);
        this._sfx('lowShield');
      }
      if (p.shields > p.maxShields * 0.35) p.lowWarned = false;
    }
  }

  /* Target magnetism: snap a shot onto the closest-to-crosshair target
   * within a narrow cone in front of the hull. Touch aiming is inherently a
   * few degrees sloppy; the cone is tight enough that keyboard and gamepad
   * players just feel accurate rather than assisted. Applies uniformly so
   * every input scheme stays on equal footing in co-op. */
  _aimAssist(p) {
    // togglable in settings; the host's sim applies it for everyone in co-op.
    // Touch aiming is inherently sloppy and keeps the wide cone; precise
    // inputs get a sliver — aim is a skill again on keyboard and pad.
    if (typeof Settings !== 'undefined' && !Settings.get('aimAssist')) return p.angle;
    const touch = typeof Input !== 'undefined' && Input.touchUI && Input.touchUI().mode;
    const CONE = touch ? 0.2 : 0.07, RANGE = 150;
    let best = p.angle, bestErr = CONE;
    const consider = (x, z) => {
      if (dist2(p.x, p.z, x, z) > RANGE * RANGE) return;
      const bearing = angleTo(x - p.x, z - p.z);
      const err = Math.abs(wrapAngle(bearing - p.angle));
      if (err < bestErr && this._losClear(p.x, p.z, x, z)) { bestErr = err; best = bearing; }
    };
    if (this.versus) {
      for (const pl of this.players) {
        if (pl.alive && pl.id !== p.id) consider(pl.x, pl.z);
      }
    }
    for (const e of this.enemies) {
      if (e.cloak > 0.6) continue;   // can't lock what the radar can't see
      consider(e.x, e.z);
    }
    const b = this.boss;
    if (b && !b.dead) {
      for (const tu of b.turrets) {
        if (tu.hp <= 0) continue;
        const [wx, wz] = bossTurretWorld(b, tu);
        consider(wx, wz);
      }
      if (b.vulnerable) consider(b.x, b.z);
    }
    return best;
  }

  /* Clamp a tank inside the arena and outside obstacles. Returns true if a
   * correction was applied (used for the player bounce). */
  _collideTank(t, radius) {
    let hit = false;
    const lim = ARENA_HALF - WALL_PAD;
    if (t.x < -lim || t.x > lim) { t.x = Math.max(-lim, Math.min(lim, t.x)); hit = true; }
    if (t.z < -lim || t.z > lim) { t.z = Math.max(-lim, Math.min(lim, t.z)); hit = true; }
    for (const o of this.obstacles) {
      if (o.dead) continue;
      const hx = o.w / 2 + radius, hz = o.d / 2 + radius;
      const dx = t.x - o.x, dz = t.z - o.z;
      if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
        const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
        if (px < pz) t.x = o.x + Math.sign(dx || 1) * hx;
        else t.z = o.z + Math.sign(dz || 1) * hz;
        hit = true;
      }
    }
    // the WARLORD's hull is solid too
    const b = this.boss;
    if (b && !b.dead) {
      const dx = t.x - b.x, dz = t.z - b.z;
      const d = Math.hypot(dx, dz), min = b.radius + radius;
      if (d < min) {
        const f = (min - d) / (d || 1);
        t.x += dx * f;
        t.z += dz * f;
        hit = true;
      }
    }
    return hit;
  }

  _losClear(x0, z0, x1, z1) {
    const dx = x1 - x0, dz = z1 - z0;
    const d = Math.hypot(dx, dz);
    const steps = Math.ceil(d / 2.5);
    for (let i = 1; i < steps; i++) {
      const x = x0 + (dx * i) / steps, z = z0 + (dz * i) / steps;
      for (const o of this.obstacles) {
        if (o.dead) continue;
        if (Math.abs(x - o.x) < o.w / 2 && Math.abs(z - o.z) < o.d / 2) return false;
      }
    }
    return true;
  }

  /* Nearest live grenade shell that threatens (x, z) — enemies scatter from
   * incoming splash instead of sitting under it. Mines are deliberately NOT
   * dodged: they're hidden traps, and prescient AI would gut the mechanic. */
  _nearestThreat(x, z) {
    let best = null, bd = 18 * 18;
    for (const pr of this.projectiles) {
      if (pr.kind !== 'nade' || pr.from !== 'player') continue;
      const d = dist2(x, z, pr.x, pr.z);
      if (d < bd) { bd = d; best = pr; }
    }
    return best;
  }

  /* Whisker steering: probe the desired heading, then fan out to either side
   * and take the first open bearing. Enemies path around slabs toward their
   * target instead of grinding along the first face they touch. */
  _steerClear(e, desired) {
    const probe = 8;
    const open = (a) => {
      const x = e.x + fwdX(a) * probe, z = e.z + fwdZ(a) * probe;
      return !this._collidesObstacle(x, z, 2.2) &&
        Math.abs(x) < ARENA_HALF - 4 && Math.abs(z) < ARENA_HALF - 4;
    };
    if (open(desired)) return desired;
    for (const off of [0.55, -0.55, 1.1, -1.1, 1.7, -1.7]) {
      if (open(desired + off)) return desired + off;
    }
    return desired + Math.PI * 0.8;   // boxed in: swing around and back out
  }

  /* Per-hull stealth senses. Unaware hulls fill e.sense from SIGHT (vision
   * cone + line of sight, range scaled by the target's signature) and
   * HEARING (close range, any direction); noise events yank them toward
   * the source but never fully alert them — noise makes a patrol LOOK,
   * only eyes-on makes it SHOOT. Alerted hulls track contact so the sector
   * alarm can decay once everyone has lost you. */
  _senseUpdate(e, dt) {
    const spec = ENEMY_TYPES[e.type];
    if (e.alerted) {
      let seen = false;
      for (const pl of this.players) {
        if (!pl.alive) continue;
        const r = spec.sight * 1.3;
        if (dist2(e.x, e.z, pl.x, pl.z) < r * r && this._losClear(e.x, e.z, pl.x, pl.z)) {
          seen = true;
          this.lastKnownX = pl.x; this.lastKnownZ = pl.z;
          break;
        }
      }
      if (seen) {
        e.seenT = 0;
        this.alarmT = Math.max(this.alarmT, this._diff().alarm);   // fresh contact
      } else {
        e.seenT += dt;
      }
      return;
    }
    for (const n of this.noises) {
      if (dist2(e.x, e.z, n.x, n.z) < n.r * n.r) {
        e.sense = Math.min(0.99, e.sense + n.mag);
        e.invX = n.x; e.invZ = n.z; e.invT = rand(5, 9);
      }
    }
    let fill = 0, sx = 0, sz = 0;
    for (const pl of this.players) {
      if (!pl.alive) continue;
      const d = Math.hypot(pl.x - e.x, pl.z - e.z);
      const sig = pl.sig != null ? pl.sig : 1;
      const sightR = spec.sight * (0.35 + 0.65 * sig);
      if (d > sightR) continue;
      const bearing = Math.abs(wrapAngle(angleTo(pl.x - e.x, pl.z - e.z) - e.angle));
      if (bearing > SIGHT_CONE && d > 9 + sig * 16) continue;   // behind it, and too far to hear
      if (!this._losClear(e.x, e.z, pl.x, pl.z)) continue;
      const f = (0.7 + 2.4 * (1 - d / sightR)) * this._diff().detect *
        (1 - 0.2 * ((pl.up && pl.up.ghost) || 0));
      if (f > fill) { fill = f; sx = pl.x; sz = pl.z; }
    }
    if (fill > 0) {
      e.sense += fill * dt;
      e.invX = sx; e.invZ = sz; e.invT = 6;
      if (e.sense >= 1) { this._alertEnemy(e, sx, sz); return; }
    } else {
      e.sense = Math.max(0, e.sense - dt * 0.22);
    }
    if (e.sense >= SENSE_SUS) this.suspicion = true;
  }

  _updateEnemies(dt) {
    // sector alert makes survivors faster and more trigger-happy
    const alertMul = 1 + this.alert * 0.4;
    this.suspicion = false;
    for (const e of this.enemies) {
      e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
      const p = this._nearestPlayer(e.x, e.z);
      const distP = p ? Math.hypot(p.x - e.x, p.z - e.z) : Infinity;
      // a patrol only fights what its sensors actually found
      if (!this.bossLevel) this._senseUpdate(e, dt);
      const hunting = !!p && e.alerted && distP < e.aggro;
      // unaware patrols roll slow; an investigating hull picks up the pace
      let moveMul = e.alerted ? 1 : (e.invT > 0 ? 0.8 : 0.55);

      // phantoms shimmer out of visibility once the hunt is on, decloak to fire
      if (ENEMY_TYPES[e.type].cloaks) {
        e.decloakT = Math.max(0, e.decloakT - dt);
        const target = (!e.alerted || e.decloakT > 0 || e.hitFlash > 0) ? 0 : 1;
        e.cloak += (target - e.cloak) * Math.min(1, dt * 2.5);
      }

      // rushers are living grenades: once alerted they beeline and detonate
      // on contact. A boost-speed target flips the exchange — the rusher is
      // ram-killed instead (score, no blast). Booms resolve after the loop.
      if (e.type === 'rusher' && e.alerted && p && distP < 4.6) {
        const ramming = p.boosting && Math.hypot(p.vx || 0, p.vz || 0) > p.maxSpeed * 1.15;
        e._boom = ramming ? 'ram' : 'det';
        e._boomBy = p.id;
        continue;
      }

      // pick a destination; forceMove keeps a maneuvering tank rolling even
      // when its hull isn't pointed at the player
      let tx, tz, forceMove = false;
      const threat = e.type === 'rusher' ? null : this._nearestThreat(e.x, e.z);
      if (threat) {
        // grenade inbound — scatter straight away from the shell
        const d = Math.hypot(e.x - threat.x, e.z - threat.z) || 1;
        tx = e.x + ((e.x - threat.x) / d) * 24;
        tz = e.z + ((e.z - threat.z) / d) * 24;
        forceMove = true;
        moveMul = 1;
      } else if (!e.alerted && e.invT > 0) {
        // suspicious: roll to the investigation point, then sweep on station —
        // chasing an offset that circles the hull keeps it turning in place
        e.invT -= dt;
        if (dist2(e.x, e.z, e.invX, e.invZ) > 49) {
          tx = e.invX; tz = e.invZ;
          forceMove = true;
        } else {
          tx = e.x + fwdX(e.angle + 1.3) * 12;
          tz = e.z + fwdZ(e.angle + 1.3) * 12;
        }
      } else if (hunting && e.type === 'rusher') {
        // suicidal commitment: straight at the target, no maneuvering
        tx = p.x; tz = p.z;
        forceMove = true;
      } else if (e.type === 'warden') {
        // wardens shepherd the pack: hug the nearest packmate and keep the
        // cannon-proof umbrella over it
        let ally = null, ad = Infinity;
        for (const o of this.enemies) {
          if (o === e || o.type === 'warden') continue;
          const d2 = dist2(e.x, e.z, o.x, o.z);
          if (d2 < ad) { ad = d2; ally = o; }
        }
        if (ally && ad > 10 * 10) {
          tx = ally.x; tz = ally.z;
          forceMove = true;
        } else if (ally) {
          tx = e.x; tz = e.z;      // umbrella in place
        } else if (hunting) {
          tx = p.x; tz = p.z;
        } else {
          tx = e.wanderX; tz = e.wanderZ;
        }
      } else if (hunting && e.type === 'hunter') {
        // hunters weave: wheel around the target on a flanking arc, then
        // commit to a straight lunge (the lunge is when they can fire)
        e.phaseT -= dt;
        if (e.phaseT <= 0) {
          e.phase = e.phase === 'lunge' ? 'flank' : 'lunge';
          e.phaseT = e.phase === 'lunge' ? rand(1.1, 2.0) : rand(1.5, 2.6);
          if (e.phase === 'flank' && RNG() < 0.4) e.orbitDir *= -1;
        }
        if (e.phase === 'flank' && distP < 60 && distP > 12) {
          const a = angleTo(p.x - e.x, p.z - e.z) + e.orbitDir;
          tx = e.x + fwdX(a) * 24;
          tz = e.z + fwdZ(a) * 24;
          forceMove = true;
        } else {
          tx = p.x; tz = p.z;
        }
      } else if (hunting && e.type === 'drone' && e.hp < e.maxHp * 0.45) {
        // shot-up drones break off and fall back on the nearest packmate;
        // a lone survivor has nowhere to run and fights on
        let ally = null, ad = Infinity;
        for (const o of this.enemies) {
          if (o === e) continue;
          const d2 = dist2(e.x, e.z, o.x, o.z);
          if (d2 < ad) { ad = d2; ally = o; }
        }
        if (ally && ad > 12 * 12) {
          tx = ally.x; tz = ally.z;
          forceMove = true;
        } else {
          tx = p.x; tz = p.z;
        }
      } else if (hunting && e.type === 'sniper' && e.relocT > 0) {
        // displaced after firing — slide to the new perch before settling
        e.relocT -= dt;
        tx = e.relocX; tz = e.relocZ;
        forceMove = true;
        if (dist2(e.x, e.z, tx, tz) < 25) e.relocT = 0;
      } else if (hunting) {
        tx = p.x; tz = p.z;
      } else {
        e.wanderT -= dt;
        if (e.wanderT <= 0 || Math.hypot(e.wanderX - e.x, e.wanderZ - e.z) < 6) {
          // wander toward a random surviving flag area (guards the objective)
          const live = this.flags.filter(f => !f.taken);
          if (live.length && RNG() < 0.6) {
            const f = live[(RNG() * live.length) | 0];
            e.wanderX = f.x + rand(-12, 12);
            e.wanderZ = f.z + rand(-12, 12);
          } else {
            e.wanderX = rand(-ARENA_HALF + 15, ARENA_HALF - 15);
            e.wanderZ = rand(-ARENA_HALF + 15, ARENA_HALF - 15);
          }
          e.wanderT = rand(4, 9);
        }
        tx = e.wanderX; tz = e.wanderZ;
      }

      const desired = this._steerClear(e, angleTo(tx - e.x, tz - e.z));

      const diff = wrapAngle(desired - e.angle);
      const maxTurn = e.turn * alertMul * dt;
      e.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));

      // snipers hold still at range (unless relocating); others close in
      const wantStop = e.type === 'sniper' && hunting && !forceMove &&
        e.relocT <= 0 && distP < e.fireRange * 0.8;
      if (!wantStop && (forceMove || (Math.abs(diff) < 1.2 && !(hunting && distP < 9)))) {
        e.x += fwdX(e.angle) * e.speed * alertMul * moveMul * dt;
        e.z += fwdZ(e.angle) * e.speed * alertMul * moveMul * dt;
      }
      this._collideTank(e, 1.9);

      // separate overlapping enemies
      for (const o of this.enemies) {
        if (o === e) continue;
        const d2 = dist2(e.x, e.z, o.x, o.z);
        if (d2 < 16 && d2 > 0.001) {
          const d = Math.sqrt(d2);
          const push = (4 - d) / d * 0.5;
          e.x += (e.x - o.x) * push;
          e.z += (e.z - o.z) * push;
        }
      }

      // fire at player — smarter types lead a moving target
      e.fireCd -= dt;
      if (hunting && distP < e.fireRange && e.fireCd <= 0) {
        let aimX = p.x, aimZ = p.z;
        // lead the target's TRUE velocity — a drifting hull's facing lies
        if (e.lead > 0 && Math.hypot(p.vx || 0, p.vz || 0) > 1) {
          const tFly = distP / e.shotSpeed;
          aimX += (p.vx || 0) * tFly * e.lead;
          aimZ += (p.vz || 0) * tFly * e.lead;
        }
        const aimDiff = Math.abs(wrapAngle(angleTo(aimX - e.x, aimZ - e.z) - e.angle));
        // phantoms telegraph: decloak a beat before the shot lands
        if (ENEMY_TYPES[e.type].cloaks && aimDiff < 0.5 && e.decloakT <= 0 && e.cloak > 0.5) {
          e.decloakT = 1.6;
          this._sfx('cloak');
        }
        const canFire = !ENEMY_TYPES[e.type].cloaks || e.cloak < 0.35;
        if (aimDiff < 0.12 && canFire && this._losClear(e.x, e.z, p.x, p.z)) {
          e.fireCd = e.fireDelay / (1 + this.alert * 0.3);
          this.projectiles.push({
            x: e.x + fwdX(e.angle) * 3.2,
            z: e.z + fwdZ(e.angle) * 3.2,
            y: 1.6, angle: e.angle,
            speed: e.shotSpeed, from: 'enemy', dmg: e.dmg, life: 4,
          });
          this._sfx('enemyFire');
          if (e.type === 'sniper') {
            // shoot-and-scoot: slide to a flanking perch so return fire
            // arrives where the sniper was, not where it is
            const a = angleTo(p.x - e.x, p.z - e.z) +
              (RNG() < 0.5 ? 1 : -1) * (Math.PI / 2 + rand(-0.4, 0.4));
            const hop = rand(22, 38);
            e.relocX = Math.max(-ARENA_HALF + 14, Math.min(ARENA_HALF - 14, e.x + fwdX(a) * hop));
            e.relocZ = Math.max(-ARENA_HALF + 14, Math.min(ARENA_HALF - 14, e.z + fwdZ(a) * hop));
            e.relocT = rand(2.5, 4);
          }
        }
      }
    }

    // resolve rusher contacts queued during the loop
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e._boom) continue;
      if (e._boom === 'ram') {
        this._killEnemy(i, e._boomBy, 'ram');
      } else {
        this.enemies.splice(i, 1);
        this._rusherBoom(e);
      }
    }

    this.noises.length = 0;   // every patrol has had its chance to hear
    // alarm decay: contact refreshes it in _senseUpdate, so once every
    // hunter has lost you this counts down to the stand-down. Extraction
    // (and boss sectors) pin it high — there's no going dark on the way out.
    if (!this.bossLevel && this.alarmT > 0 && this.alarmT < 1e8) {
      this.alarmT -= dt;
      if (this.alarmT <= 0) this._standDown();
    }
  }

  /* A rusher reached its target: splash damage to anyone near the blast. */
  _rusherBoom(e) {
    const R = 8;
    this._burst(e.x, 1.2, e.z, 30, [1, 0.35, 0.5], 13);
    this._burst(e.x, 2.0, e.z, 12, [1, 0.85, 0.6], 8);
    this._spawnShards(e.x, e.z, DEBRIS_COLORS.rusher);
    this._sfx('nadeBoom');
    this._noise(e.x, e.z, NOISE_BOOM, 0.7);
    this.shake = Math.min(this.shake + 0.4, 1.2);
    for (const pl of this.players) {
      if (!pl.alive) continue;
      const d = Math.hypot(e.x - pl.x, e.z - pl.z);
      if (d < R) this._damagePlayer(pl, e.dmg * (d < 2.5 ? 1 : 1 - ((d - 2.5) / (R - 2.5)) * 0.6));
    }
  }

  _updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      pr.x += fwdX(pr.angle) * pr.speed * dt;
      pr.z += fwdZ(pr.angle) * pr.speed * dt;

      // grenades fly a ballistic arc and burst on the ground
      if (pr.kind === 'nade') {
        pr.vy -= 26 * dt;
        pr.y += pr.vy * dt;
        if (pr.y <= 0.5) {
          this._nadeBoom(pr);
          this.projectiles.splice(i, 1);
          continue;
        }
        const o = this._collidesObstacle(pr.x, pr.z, 0.4);
        if (o && pr.y < o.h) {
          this._nadeBoom(pr);
          this.projectiles.splice(i, 1);
          continue;
        }
        if (pr.life <= 0 || Math.abs(pr.x) > ARENA_HALF || Math.abs(pr.z) > ARENA_HALF) {
          this.projectiles.splice(i, 1);
        }
        continue;
      }

      let dead = pr.life <= 0;

      // arena walls: RICOCHET rounds reflect off them, everything else dies
      if (!dead && (Math.abs(pr.x) > ARENA_HALF || Math.abs(pr.z) > ARENA_HALF)) {
        if (pr.bounce > 0) {
          pr.bounce--;
          if (Math.abs(pr.x) > ARENA_HALF) { pr.angle = -pr.angle; pr.x = Math.sign(pr.x) * ARENA_HALF; }
          if (Math.abs(pr.z) > ARENA_HALF) { pr.angle = Math.PI - pr.angle; pr.z = Math.sign(pr.z) * ARENA_HALF; }
          this._burst(pr.x, pr.y, pr.z, 5, [1, 0.9, 0.5], 5);
        } else {
          dead = true;
        }
      }

      if (!dead) {
        const o = this._collidesObstacle(pr.x, pr.z, 0.4);
        if (o) {
          if (pr.bounce > 0) {
            // reflect off the shallower face and step back outside the slab
            pr.bounce--;
            const px = o.w / 2 + 0.4 - Math.abs(pr.x - o.x);
            const pz = o.d / 2 + 0.4 - Math.abs(pr.z - o.z);
            if (px < pz) { pr.angle = -pr.angle; pr.x = o.x + Math.sign(pr.x - o.x) * (o.w / 2 + 0.5); }
            else { pr.angle = Math.PI - pr.angle; pr.z = o.z + Math.sign(pr.z - o.z) * (o.d / 2 + 0.5); }
            this._burst(pr.x, pr.y, pr.z, 5, [1, 0.9, 0.5], 5);
          } else {
            dead = true;
            this._burst(pr.x, 1.6, pr.z, 8, [1, 0.8, 0.4], 6);
            this._sfx('hitWall');
          }
        }
      }

      if (!dead && pr.from === 'player') {
        // versus: your cannon rounds hit the other tanks
        if (this.versus) {
          for (const pl of this.players) {
            if (!pl.alive || pl.id === pr.owner) continue;
            if (dist2(pr.x, pr.z, pl.x, pl.z) < 2.4 * 2.4) {
              dead = true;
              this._damagePlayer(pl, pr.dmg, pr.owner);
              break;
            }
          }
        }
        if (!dead) for (let j = this.enemies.length - 1; j >= 0; j--) {
          const e = this.enemies[j];
          if (pr.hitList && pr.hitList.indexOf(e) >= 0) continue;   // already pierced
          if (dist2(pr.x, pr.z, e.x, e.z) < 2.4 * 2.4) {
            // SHELLBACK: the frontal plate deflects shells — flank the arc,
            // lob over it, or ram straight through it
            if (e.type === 'shellback' &&
                Math.abs(wrapAngle(angleTo(pr.x - e.x, pr.z - e.z) - e.angle)) < 1.05) {
              dead = true;
              this._burst(pr.x, 1.6, pr.z, 6, [0.7, 0.8, 1.0], 5);
              this._sfx('deflect');
              // a shell just rang off its faceplate — it knows
              const a = this._playerById(pr.owner);
              this._alertEnemy(e, a ? a.x : pr.x, a ? a.z : pr.z);
              break;
            }
            this._hurtEnemy(j, pr.dmg, pr.owner, 'cannon');
            if (pr.pierce > 0) {
              // PIERCING CORE: punch through and keep flying
              pr.pierce--;
              (pr.hitList || (pr.hitList = [])).push(e);
            } else {
              dead = true;
              break;
            }
          }
        }
        const b = this.boss;
        if (!dead && b && !b.dead) {
          // turrets are soft targets; the hull deflects shots until the
          // last turret falls and the core is exposed
          for (const tu of b.turrets) {
            if (tu.hp <= 0) continue;
            const [wx, wz] = bossTurretWorld(b, tu);
            if (dist2(pr.x, pr.z, wx, wz) < 2.6 * 2.6) {
              dead = true;
              this._hurtBossTurret(tu, pr.dmg, pr.owner);
              break;
            }
          }
          if (!dead && dist2(pr.x, pr.z, b.x, b.z) < b.radius * b.radius) {
            dead = true;
            if (b.vulnerable) {
              this._hurtBossCore(pr.dmg, pr.owner);
            } else {
              this._burst(pr.x, 2.2, pr.z, 6, [0.5, 0.7, 1.0], 6);
              this._sfx('deflect');
            }
          }
        }
      } else if (!dead && pr.from === 'enemy') {
        for (const pl of this.players) {
          if (!pl.alive) continue;
          if (dist2(pr.x, pr.z, pl.x, pl.z) < 2.4 * 2.4) {
            dead = true;
            this._damagePlayer(pl, pr.dmg);
            break;
          }
        }
        if (!dead) {
          // GRAZE: a shot that nearly clips you refunds boost, pays a tick
          // of tech and keeps the style chain warm — threading enemy fire
          // on purpose is expert play
          for (const pl of this.players) {
            if (!pl.alive || (pr.grz && pr.grz[pl.id])) continue;
            if (dist2(pr.x, pr.z, pl.x, pl.z) < GRAZE_R * GRAZE_R) {
              (pr.grz || (pr.grz = {}))[pl.id] = 1;
              const razor = (pl.up && pl.up.razor) || 0;
              pl.boost = Math.min(pl.maxBoost, pl.boost + 5 + razor * 3);
              this._awardTech(pl, 1 + razor * 2);
              if (this.comboT > 0) this.comboT = Math.min(this.comboWin, this.comboT + 0.4);
              this._burst(pr.x, 1.4, pr.z, 3, [0.5, 1.0, 0.9], 4);
              this._bountyTick('graze');
            }
          }
        }
      }

      if (dead) this.projectiles.splice(i, 1);
    }
  }

  _nadeBoom(pr) {
    const R = pr.child ? 7 : 10;
    this._burst(pr.x, 1.2, pr.z, pr.child ? 24 : 40, [1, 0.7, 0.25], pr.child ? 11 : 16);
    this._burst(pr.x, 2.2, pr.z, pr.child ? 10 : 18, [1, 0.95, 0.7], pr.child ? 7 : 10);
    this._sfx('nadeBoom');
    this._noise(pr.x, pr.z, NOISE_BOOM, 0.7);
    this.shake = Math.min(this.shake + 0.5, 1.2);
    // CLUSTER CHARGES: the shell splits into three arcing bomblets
    if (!pr.child) {
      const owner = this._playerById(pr.owner);
      if (owner && owner.up && owner.up.cluster) {
        for (const off of [-0.8, 0, 0.8]) {
          this.projectiles.push({
            x: pr.x, z: pr.z, y: 1.2, angle: pr.angle + off + rand(-0.2, 0.2), kind: 'nade',
            speed: rand(10, 16), vy: rand(8, 12), child: true,
            from: 'player', owner: pr.owner, dmg: 30, life: 3,
          });
        }
      }
    }
    if (this.versus) {
      for (const pl of this.players) {
        if (!pl.alive || pl.id === pr.owner) continue;
        const d = Math.hypot(pr.x - pl.x, pr.z - pl.z);
        if (d < R) {
          const dmg = pr.dmg * (d < 3 ? 1 : 1 - (d - 3) / (R - 3) * 0.75);
          this._damagePlayer(pl, dmg, pr.owner);
        }
      }
    }
    for (let j = this.enemies.length - 1; j >= 0; j--) {
      const e = this.enemies[j];
      const d = Math.hypot(pr.x - e.x, pr.z - e.z);
      if (d < R) {
        const dmg = pr.dmg * (d < 3 ? 1 : 1 - (d - 3) / (R - 3) * 0.75);
        this._hurtEnemy(j, dmg, pr.owner, 'nade');
      }
    }
    const b = this.boss;
    if (b && !b.dead) {
      for (const tu of b.turrets) {
        if (tu.hp <= 0) continue;
        const [wx, wz] = bossTurretWorld(b, tu);
        if (Math.hypot(pr.x - wx, pr.z - wz) < R) this._hurtBossTurret(tu, pr.dmg * 0.8, pr.owner);
      }
      if (b.vulnerable && Math.hypot(pr.x - b.x, pr.z - b.z) < R + b.radius * 0.5) {
        this._hurtBossCore(pr.dmg * 0.8, pr.owner);
      }
    }
  }

  // ---- proximity mines --------------------------------------------------------

  _updateMines(dt) {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      m.arm = Math.max(0, m.arm - dt);
      m.life -= dt;
      if (m.life <= 0) { this.mines.splice(i, 1); continue; }
      if (m.arm > 0) continue;
      let trip = false;
      if (this.versus) {
        for (const pl of this.players) {
          if (!pl.alive || pl.id === m.owner) continue;
          if (dist2(m.x, m.z, pl.x, pl.z) < 4.2 * 4.2) { trip = true; break; }
        }
      } else {
        for (const e of this.enemies) {
          if (dist2(m.x, m.z, e.x, e.z) < 4.2 * 4.2) { trip = true; break; }
        }
        const b = this.boss;
        if (!trip && b && !b.dead) {
          const r = b.radius + 2.5;
          if (dist2(m.x, m.z, b.x, b.z) < r * r) trip = true;
        }
      }
      if (trip) {
        this.mines.splice(i, 1);
        this._mineBoom(m);
      }
    }
  }

  _mineBoom(m) {
    const R = 9, DMG = 70;
    this._burst(m.x, 1.0, m.z, 34, [1, 0.45, 0.6], 15);
    this._burst(m.x, 2.0, m.z, 14, [1, 0.9, 0.7], 9);
    this._sfx('nadeBoom');
    this._noise(m.x, m.z, NOISE_BOOM, 0.7);
    this.shake = Math.min(this.shake + 0.4, 1.2);
    const falloff = (d) => DMG * (d < 3 ? 1 : 1 - (d - 3) / (R - 3) * 0.75);
    if (this.versus) {
      for (const pl of this.players) {
        if (!pl.alive || pl.id === m.owner) continue;
        const d = Math.hypot(m.x - pl.x, m.z - pl.z);
        if (d < R) this._damagePlayer(pl, falloff(d), m.owner);
      }
    }
    for (let j = this.enemies.length - 1; j >= 0; j--) {
      const e = this.enemies[j];
      const d = Math.hypot(m.x - e.x, m.z - e.z);
      if (d < R) this._hurtEnemy(j, falloff(d), m.owner, 'mine');
    }
    const b = this.boss;
    if (b && !b.dead) {
      for (const tu of b.turrets) {
        if (tu.hp <= 0) continue;
        const [wx, wz] = bossTurretWorld(b, tu);
        if (Math.hypot(m.x - wx, m.z - wz) < R) this._hurtBossTurret(tu, DMG * 0.8, m.owner);
      }
      if (b.vulnerable && Math.hypot(m.x - b.x, m.z - b.z) < R + b.radius * 0.5) {
        this._hurtBossCore(DMG * 0.8, m.owner);
      }
    }
  }

  /* via: 'cannon' | 'nade' | 'mine' — which weapon landed the hit, for the
   * weapon-specific medals. */
  _hurtEnemy(index, dmg, ownerId, via) {
    const e = this.enemies[index];
    // WARDEN umbrella: hostiles under it shrug off cannon fire — lob over
    // it, mine it, ram through it, or kill the warden first
    if (via === 'cannon' && e.type !== 'warden') {
      for (const w of this.enemies) {
        if (w.type !== 'warden') continue;
        if (dist2(w.x, w.z, e.x, e.z) < 16 * 16) {
          this._burst(e.x, 1.8, e.z, 6, [1, 0.85, 0.3], 5);
          this._sfx('deflect');
          // the umbrella flared: the pack knows it's under fire
          if (!this.versus) {
            const a = this._playerById(ownerId);
            this._alertEnemy(e, a ? a.x : e.x, a ? a.z : e.z);
          }
          return;
        }
      }
    }
    e.hp -= dmg;
    e.hitFlash = 1;
    if (ENEMY_TYPES[e.type].cloaks) e.decloakT = Math.max(e.decloakT, 1.2);
    this._burst(e.x, 1.5, e.z, 10, [1, 0.6, 0.3], 8);
    if (e.hp > 0 && !e.alerted && !this.versus) {
      // a hull that survives a hit is instantly hostile — commit to kills
      const a = this._playerById(ownerId);
      this._alertEnemy(e, a ? a.x : e.x, a ? a.z : e.z);
    }
    if (e.hp <= 0) this._killEnemy(index, ownerId, via);
    else this._sfx('hitEnemy');
  }

  _killEnemy(index, ownerId, via) {
    const e = this.enemies[index];
    this.enemies.splice(index, 1);
    this.killsThisLevel++;
    // SILENT KILL: it never saw you coming — half again the score, and a
    // boost-ram execution is quiet enough that only close packmates notice
    const silent = !this.versus && !e.alerted;
    this._awardKill(silent ? Math.round(e.score * 1.5) : e.score, ownerId, via);
    this._noise(e.x, e.z, via === 'ram' ? NOISE_RAM : NOISE_WRECK, 0.6);
    if (silent) {
      this.runStats.silentKills++;
      this._bountyTick('silent');
      if (ownerId === this.localId) {
        this.hud.message('SILENT KILL', '#4fd6bb', 1.1);
        if (this.runStats.silentKills >= 5) this._medal('assassin');
      }
    }
    if (via === 'ram' || via === 'nade' || via === 'mine') this._bountyTick(via);
    if (!this.versus && ownerId === this.localId) {
      const rs = this.runStats;
      rs.localKills++;
      if (via === 'nade') rs.nadeKills++;
      if (via === 'mine') rs.mineKills++;
      this._medal('firstblood');
      if (rs.localKills >= 25) this._medal('ace');
      if (rs.nadeKills >= 3) this._medal('demolition');
      if (rs.mineKills >= 3) this._medal('trapper');
    }
    this._burst(e.x, 1.5, e.z, 34, [1, 0.55, 0.15], 14);
    this._burst(e.x, 1.5, e.z, 16, [0.9, 0.9, 0.9], 9);
    this._spawnShards(e.x, e.z, DEBRIS_COLORS[e.type] || DEBRIS_COLORS.drone);
    this._sfx('explosion');
    this.shake = Math.min(this.shake + 0.4, 1);
    // SHIELD SIPHON: kills feed the killer's shields
    const owner = this._playerById(ownerId);
    if (owner && owner.up && owner.up.siphon) {
      owner.shields = Math.min(owner.maxShields, owner.shields + 4 * owner.up.siphon);
    }
    // a shot-down rusher still pops — the blast chains into nearby hostiles
    if (e.type === 'rusher') {
      this._burst(e.x, 1.2, e.z, 20, [1, 0.35, 0.5], 11);
      for (let j = this.enemies.length - 1; j >= 0; j--) {
        const o = this.enemies[j];
        if (dist2(e.x, e.z, o.x, o.z) < 36) this._hurtEnemy(j, 40, ownerId, via);
      }
    }
    // VOLATILE HULLS: every kill detonates — dangerous up close, devastating
    // when you chain a pack. Forces range discipline for the reward
    if (this.mutator === 'volatile' && e.type !== 'rusher') {
      this._burst(e.x, 1.2, e.z, 18, [1, 0.6, 0.2], 10);
      for (const pl of this.players) {
        if (!pl.alive) continue;
        if (dist2(e.x, e.z, pl.x, pl.z) < 36) this._damagePlayer(pl, 16);
      }
      for (let j = this.enemies.length - 1; j >= 0; j--) {
        const o = this.enemies[j];
        if (dist2(e.x, e.z, o.x, o.z) < 36) this._hurtEnemy(j, 30, ownerId, via);
      }
    }
    // chance to drop a pickup
    if (RNG() < 0.35) {
      const keys = Object.keys(POWERUP_TYPES);
      this._spawnPowerup(e.x, e.z, keys[(RNG() * keys.length) | 0]);
    }
  }

  _damagePlayer(p, dmg, attackerId) {
    const isLocal = p.id === this.localId;
    dmg *= this._diff().dmg;   // versus stays 1:1 — _diff() is STANDARD there
    // SPEED IS ARMOR: above 70% of rated speed the hull sheds a third of the
    // hit — momentum play is defense, sitting still is not
    if (Math.hypot(p.vx || 0, p.vz || 0) > p.maxSpeed * 0.7) dmg *= 0.65;
    p.shields -= dmg;
    p.sinceHit = 0;
    this._breakCombo();   // any hit on the squad snaps the kill chain
    if (!this.versus && this.pot > 0) {
      this.pot = Math.round(this.pot * this._diff().potSpill);   // ...and spills part of the pot
    }
    if (isLocal) this.levelUntouched = false;
    if (isLocal) {
      this.hud.damage(Math.min(0.8, dmg / 30));
      this.shake = Math.min(this.shake + 0.5, 1.2);
    }
    this._sfx('hitPlayer');
    this._burst(p.x, 1.5, p.z, 12, [1, 0.4, 0.2], 8);
    if (p.shields <= 0) {
      p.shields = 0;
      p.alive = false;
      p.respawnT = this.versus ? 3 : 4;
      this._burst(p.x, 1.5, p.z, 60, [1, 0.5, 0.1], 18);
      this._burst(p.x, 2.5, p.z, 30, [1, 0.9, 0.6], 12);
      this._spawnShards(p.x, p.z, DEBRIS_COLORS.player);
      this._sfx('bigExplosion');
      if (isLocal) this.shake = 2;
      // versus: credit the killer
      if (this.versus && attackerId && attackerId !== p.id) {
        this.killCounts[attackerId] = (this.killCounts[attackerId] || 0) + 1;
        const killer = this.players.find((k) => k.id === attackerId);
        this.hud.message((killer ? killer.name : 'ENEMY') + ' DESTROYED ' + p.name, '#ffd24a', 2);
        if (attackerId === this.localId) {
          this.hud.scorePop('KILL ' + this.killCounts[attackerId] + '/' + this.killTarget);
        }
      }
    }
  }

  _updatePickups(dt) {
    // SALVAGE MAGNET: drops drift toward the nearest magnet-equipped tank
    for (const u of this.powerups) {
      let best = null, bd = 34 * 34;
      for (const p of this.players) {
        if (!p.alive || !p.up || !p.up.magnet) continue;
        const d = dist2(p.x, p.z, u.x, u.z);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) {
        const d = Math.sqrt(bd) || 1;
        u.x += ((best.x - u.x) / d) * 26 * dt;
        u.z += ((best.z - u.z) / d) * 26 * dt;
      }
    }
    for (const p of this.players) {
      if (!p.alive) continue;
      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const u = this.powerups[i];
        if (dist2(p.x, p.z, u.x, u.z) < 3.2 * 3.2) {
          this.powerups.splice(i, 1);
          this._applyPowerup(p, u.type);
        }
      }
    }
    for (const u of this.powerups) {
      u.spin += dt * 2.5;
      u.bob += dt * 3;
    }
  }

  _updateDepots(dt) {
    for (const p of this.players) {
      if (!p.alive) { p.onDepot = false; continue; }
      let on = null;
      for (const d of this.depots) {
        if (dist2(p.x, p.z, d.x, d.z) < 4.5 * 4.5) { on = d; break; }
      }
      const isLocal = p.id === this.localId;
      if (on && !p.onDepot && isLocal) {
        this.hud.message(on.type === 'coolant' ? 'COOLANT DEPOT — VENTING HEAT' : 'SHIELD DEPOT — RECHARGING', '#4fd6bb', 1.6);
      }
      p.onDepot = !!on;
      if (!on) { p.depotAcc = 0; continue; }
      if (on.type === 'shield') {
        if (p.shields < p.maxShields) {
          p.shields = Math.min(p.maxShields, p.shields + dt * 9);
          p.depotAcc += dt;
          if (p.depotAcc >= 0.5) { p.depotAcc -= 0.5; this._sfx('refuel'); }
        }
      } else if (p.heat > 0 || p.overheatT > 0) {
        // coolant pad: rapid vent, and it burns off an overheat lock early
        p.heat = Math.max(0, p.heat - dt * 30);
        p.overheatT = Math.max(0, p.overheatT - dt * 2);
        p.depotAcc += dt;
        if (p.depotAcc >= 0.5) { p.depotAcc -= 0.5; this._sfx('refuel'); }
      }
    }
  }

  _applyPowerup(p, type) {
    const spec = POWERUP_TYPES[type];
    switch (type) {
      case 'coolant': p.heat = 0; p.overheatT = 0;
                      p.superShots = Math.min(6, p.superShots + 2); break;
      case 'shield': p.shields = Math.min(p.maxShields, p.shields + 35); break;
      case 'nade':   p.nades = Math.min(p.maxNades, p.nades + 2); break;
      case 'mine':   p.mines = Math.min(p.maxMines, p.mines + 2); break;
      case 'overdrive': p.fx.overdrive = 10; break;
      case 'rapid':     p.fx.rapid = 10; break;
    }
    this._awardTech(p, 5);
    this.score += 50;
    this._sfx('powerup');
    if (p.id === this.localId) {
      this.hud.pickup();
      this.hud.message(spec.label, '#ffd24a', 1.4);
    }
  }

  // ---- WARLORD boss -----------------------------------------------------------
  // Every BOSS_EVERY sectors the flags are gone and a WARLORD holds the arena:
  // a huge hovercruiser with four destroyable turrets shielding its core. It
  // crushes cover as it drives, telegraphs a ramming charge, and once the core
  // is exposed it slams out shockwave rings you outrun with boost or block
  // with the surviving slabs.

  _spawnBoss() {
    const n = Math.floor(this.level / BOSS_EVERY);   // boss number: 1, 2, ...
    const pos = this._findSpot(12, 140) || [0, -ARENA_HALF + 50];
    const turretHp = 90 + n * 30;
    const coreMax = 400 + (n - 1) * 220;
    this.boss = {
      x: pos[0], z: pos[1],
      angle: rand(0, Math.PI * 2),
      radius: 7,
      speed: 7 + n * 1.5,
      turn: 0.9,
      coreHp: coreMax, coreMax,
      turrets: BOSS_TURRET_OFFSETS.map(([dx, dz]) => ({
        dx, dz, hp: turretHp, maxHp: turretHp,
        aim: rand(0, Math.PI * 2), fireCd: rand(1.5, 3.5),
      })),
      vulnerable: false,
      state: 'roam',        // roam | telegraph | charge | recover
      stateT: 0,
      chargeCd: 7,
      chargeHits: {},
      shockCd: 0,
      hitFlash: 0,
      dead: false, deathT: 0,
      dmg: 15 + n * 3,
      fireDelay: Math.max(1.2, 2.4 - n * 0.2),
      score: 2500 * n,
      ringSpeed: 26 + n * 2,
    };
  }

  _updateBoss(dt) {
    const b = this.boss;
    if (!b) return;
    if (b.dead) {
      // death throes: keep sparking until the sector-clear check fires
      b.deathT -= dt;
      if (RNG() < 0.3) {
        this._burst(b.x + rand(-5, 5), rand(1, 4), b.z + rand(-5, 5), 10, [1, 0.5, 0.15], 10);
      }
      return;
    }
    b.hitFlash = Math.max(0, b.hitFlash - dt * 4);
    const p = this._nearestPlayer(b.x, b.z);

    // the hull crushes any slab it touches — cover is temporary
    for (const o of this.obstacles) {
      if (o.dead) continue;
      if (Math.abs(b.x - o.x) < o.w / 2 + b.radius * 0.8 &&
          Math.abs(b.z - o.z) < o.d / 2 + b.radius * 0.8) {
        o.dead = true;
        this._burst(o.x, o.h * 0.5, o.z, 26, o.color, 13);
        this._sfx('hitWall');
        this.shake = Math.min(this.shake + 0.25, 1);
      }
    }

    if (b.state === 'roam') {
      b.chargeCd -= dt;
      if (p) {
        const desired = angleTo(p.x - b.x, p.z - b.z);
        const diff = wrapAngle(desired - b.angle);
        const maxTurn = b.turn * dt;
        b.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));
        const distP = Math.hypot(p.x - b.x, p.z - b.z);
        if (Math.abs(diff) < 1.0 && distP > 18) {
          b.x += fwdX(b.angle) * b.speed * dt;
          b.z += fwdZ(b.angle) * b.speed * dt;
        }
        if (b.chargeCd <= 0 && distP > 35 && distP < 160) {
          b.state = 'telegraph';
          b.stateT = 1.15;
          this._sfx('charge');
        }
      }
    } else if (b.state === 'telegraph') {
      // tracks the target while spinning up, then commits
      if (p) {
        const desired = angleTo(p.x - b.x, p.z - b.z);
        const diff = wrapAngle(desired - b.angle);
        const maxTurn = 2.4 * dt;
        b.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));
      }
      b.stateT -= dt;
      if (b.stateT <= 0) {
        b.state = 'charge';
        b.stateT = 2.1;
        b.chargeHits = {};
        this.shake = Math.min(this.shake + 0.4, 1.2);
      }
    } else if (b.state === 'charge') {
      b.stateT -= dt;
      const spd = b.speed * 5.5;
      b.x += fwdX(b.angle) * spd * dt;
      b.z += fwdZ(b.angle) * spd * dt;
      // anyone caught under the hull takes one heavy hit and is shoved aside
      for (const pl of this.players) {
        if (!pl.alive || b.chargeHits[pl.id]) continue;
        if (dist2(pl.x, pl.z, b.x, b.z) < (b.radius + 2.5) * (b.radius + 2.5)) {
          b.chargeHits[pl.id] = true;
          this._damagePlayer(pl, 30);
          const dx = pl.x - b.x, dz = pl.z - b.z;
          const d = Math.hypot(dx, dz) || 1;
          pl.x += (dx / d) * 6;
          pl.z += (dz / d) * 6;
          pl.speed *= -0.5;
          pl.vx *= -0.5; pl.vz *= -0.5;
        }
      }
      const lim = ARENA_HALF - WALL_PAD - b.radius;
      const slammed = Math.abs(b.x) > lim || Math.abs(b.z) > lim;
      if (slammed) {
        b.x = Math.max(-lim, Math.min(lim, b.x));
        b.z = Math.max(-lim, Math.min(lim, b.z));
        this._spawnRing(b.x, b.z, 22);
        this.shake = Math.min(this.shake + 0.8, 1.6);
        this._sfx('bounce');
      }
      if (slammed || b.stateT <= 0) {
        b.state = 'recover';
        b.stateT = 1.5;
      }
    } else if (b.state === 'recover') {
      b.stateT -= dt;
      if (b.stateT <= 0) {
        b.state = 'roam';
        b.chargeCd = b.vulnerable ? rand(4, 6) : rand(6, 9);
      }
    }

    const lim = ARENA_HALF - WALL_PAD - b.radius;
    b.x = Math.max(-lim, Math.min(lim, b.x));
    b.z = Math.max(-lim, Math.min(lim, b.z));

    // the exposed core periodically slams out a shockwave
    if (b.vulnerable && b.state !== 'charge') {
      b.shockCd -= dt;
      if (b.shockCd <= 0) {
        b.shockCd = rand(5, 7);
        this._spawnRing(b.x, b.z, 22);
      }
    }

    // turrets track and fire independently of the hull
    for (const tu of b.turrets) {
      if (tu.hp <= 0) continue;
      const [wx, wz] = bossTurretWorld(b, tu);
      const t = this._nearestPlayer(wx, wz);
      if (!t) continue;
      const dist = Math.hypot(t.x - wx, t.z - wz);
      let aimX = t.x, aimZ = t.z;
      if (Math.hypot(t.vx || 0, t.vz || 0) > 1) {
        const tFly = dist / 55;
        aimX += (t.vx || 0) * tFly * 0.7;
        aimZ += (t.vz || 0) * tFly * 0.7;
      }
      const want = angleTo(aimX - wx, aimZ - wz);
      const diff = wrapAngle(want - tu.aim);
      const maxTurn = 2.2 * dt;
      tu.aim += Math.max(-maxTurn, Math.min(maxTurn, diff));
      tu.fireCd -= dt;
      if (tu.fireCd <= 0 && dist < 130 && Math.abs(diff) < 0.15 && this._losClear(wx, wz, t.x, t.z)) {
        tu.fireCd = b.fireDelay + rand(0, 0.6);
        this.projectiles.push({
          x: wx + fwdX(tu.aim) * 2.8, z: wz + fwdZ(tu.aim) * 2.8,
          y: 1.6, angle: tu.aim,
          speed: 55, from: 'enemy', dmg: b.dmg, life: 4,
        });
        this._sfx('enemyFire');
      }
    }
  }

  _hurtBossTurret(tu, dmg, ownerId) {
    const b = this.boss;
    tu.hp -= dmg;
    b.hitFlash = 1;
    const [wx, wz] = bossTurretWorld(b, tu);
    this._burst(wx, 3.2, wz, 10, [1, 0.6, 0.3], 8);
    if (tu.hp <= 0) {
      tu.hp = 0;
      this.killsThisLevel++;
      this._awardKill(400, ownerId, 'turret');
      this._bankPot();   // boss milestones are cash-outs too
      this._burst(wx, 3.4, wz, 30, [1, 0.55, 0.15], 13);
      this._spawnShards(wx, wz, [1.0, 0.5, 0.2]);
      this._sfx('explosion');
      this.shake = Math.min(this.shake + 0.4, 1);
      if (!b.turrets.some((t) => t.hp > 0)) {
        b.vulnerable = true;
        b.speed *= 1.35;   // enraged
        b.shockCd = 2.5;
        this._sfx('coreExposed');
        this.hud.message('CORE EXPOSED — ATTACK', '#ffd24a', 3);
      }
    } else {
      this._sfx('hitEnemy');
    }
  }

  _hurtBossCore(dmg, ownerId) {
    const b = this.boss;
    b.coreHp -= dmg;
    b.hitFlash = 1;
    this._burst(b.x, 4.6, b.z, 12, [1, 0.35, 0.6], 9);
    if (b.coreHp <= 0) this._killBoss(ownerId);
    else this._sfx('hitEnemy');
  }

  _killBoss(ownerId) {
    const b = this.boss;
    b.coreHp = 0;
    b.dead = true;
    b.deathT = 2.2;
    this.runStats.warlords++;
    this.rings = [];
    this.killsThisLevel++;
    this._awardKill(b.score, ownerId, 'boss');
    this._bankPot();
    for (let i = 0; i < 3; i++) {
      this._burst(b.x + rand(-5, 5), rand(1, 4), b.z + rand(-5, 5), 40, [1, 0.5, 0.1], 16);
    }
    this._burst(b.x, 3, b.z, 30, [1, 0.9, 0.6], 12);
    this._spawnShards(b.x, b.z, [0.85, 0.16, 0.28]);
    this._spawnShards(b.x + 3, b.z, [0.55, 0.10, 0.18]);
    this._spawnShards(b.x - 3, b.z, [1.0, 0.45, 0.25]);
    this._sfx('bossDown');
    this.shake = 2;
    this.hud.message('WARLORD DESTROYED', '#3cff78', 3);
    this._medal('giantkiller');
  }

  /* opts: { from: 'boss'|'player', owner, speed, max } — player rings come
   * from the SHOCK DISCHARGE upgrade and hit hostiles instead of the squad. */
  _spawnRing(x, z, dmg, opts) {
    opts = opts || {};
    this.rings.push({
      x, z,
      r: opts.from === 'player' ? 2.5 : (this.boss ? this.boss.radius : 6),
      speed: opts.speed || (this.boss ? this.boss.ringSpeed : 28),
      max: opts.max || 190,
      from: opts.from || 'boss',
      owner: opts.owner || null,
      dmg, hit: {}, hitE: null,
    });
    this._sfx('shock');
    if (opts.from === 'player') this._noise(x, z, 55, 0.6);
    this._burst(x, 0.8, z, 26, opts.from === 'player' ? [0.3, 0.95, 0.8] : [1, 0.55, 0.2], 12);
  }

  _updateRings(dt) {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.r += r.speed * dt;
      if (r.from === 'player') {
        // squad shockwave: sweeps hostiles once each, blocked by cover
        for (let j = this.enemies.length - 1; j >= 0; j--) {
          const e = this.enemies[j];
          if (r.hitE && r.hitE.indexOf(e) >= 0) continue;
          const d = Math.hypot(e.x - r.x, e.z - r.z);
          if (Math.abs(d - r.r) < 2.6) {
            (r.hitE || (r.hitE = [])).push(e);
            if (this._losClear(r.x, r.z, e.x, e.z)) this._hurtEnemy(j, r.dmg, r.owner, 'shock');
          }
        }
      } else {
        for (const p of this.players) {
          if (!p.alive || r.hit[p.id]) continue;
          const d = Math.hypot(p.x - r.x, p.z - r.z);
          if (Math.abs(d - r.r) < 2.4) {
            r.hit[p.id] = true;   // the wave passed — cover decides if it hurt
            if (this._losClear(r.x, r.z, p.x, p.z)) this._damagePlayer(p, r.dmg);
          }
        }
      }
      if (r.r > r.max) this.rings.splice(i, 1);
    }
  }

  _burst(x, y, z, n, color, power) {
    this.frameBursts.push({ x, y, z, n, c: color, p: power });
    // a matching light flash so explosions momentarily light up the arena
    this.flashes.push({ x, y: y + 1.2, z, c: color, p: power, life: 0.28, max: 0.28 });
    if (this.flashes.length > 32) this.flashes.splice(0, this.flashes.length - 32);
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(power * 0.25, power);
      this.particles.push({
        x, y: y + rand(-0.5, 0.5), z,
        vx: Math.cos(a) * v, vz: Math.sin(a) * v,
        vy: rand(2, power * 0.9),
        life: rand(0.4, 1.1), maxLife: 1.1,
        size: rand(2.5, 6),
        r: color[0], g: color[1], b: color[2],
      });
    }
    if (this.particles.length > 1500) this.particles.splice(0, this.particles.length - 1500);
  }

  /* A destroyed tank shatters into tumbling flat-shaded polygon shards —
   * the signature Spectre kill. queue=false when replaying a host event. */
  _spawnShards(x, z, color, queue = true) {
    if (queue) this.frameDebris.push({ x, z, c: color });
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(6, 20);
      this.debris.push({
        x, y: rand(0.8, 2.2), z,
        vx: Math.cos(a) * v, vz: Math.sin(a) * v,
        vy: rand(8, 22),
        yaw: rand(0, Math.PI * 2), tumble: rand(0, Math.PI * 2),
        vyaw: rand(-6, 6), vtumble: rand(-10, 10),
        scale: rand(0.7, 2.0),
        life: rand(1.2, 2.2),
        c: color,
      });
    }
    if (this.debris.length > 220) this.debris.splice(0, this.debris.length - 220);
  }

  _updateDebris(dt) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0) { this.debris.splice(i, 1); continue; }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      d.vy -= 30 * dt;
      d.yaw += d.vyaw * dt;
      d.tumble += d.vtumble * dt;
      if (d.y < 0.15) {
        d.y = 0.15;
        d.vy *= -0.35;
        d.vx *= 0.6; d.vz *= 0.6;
        d.vtumble *= 0.5;
      }
    }
  }

  _updateParticles(dt) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) this.flashes.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) { this.particles.splice(i, 1); continue; }
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.z += pt.vz * dt;
      pt.vy -= 22 * dt;
      if (pt.y < 0.1) { pt.y = 0.1; pt.vy *= -0.4; pt.vx *= 0.7; pt.vz *= 0.7; }
    }
  }

  _levelClear() {
    let sh = 0;
    for (const p of this.players) sh += Math.max(0, p.shields);
    this.levelBonus = this.level * 250 +
      Math.round(sh) * 3 +
      this.killsThisLevel * 50 +
      this.pot;                    // whatever's still riding banks with the clear
    // GHOST EXTRACTION: the alarm never went off before the gate opened —
    // the purest way to play the sector, paid accordingly
    if (this.ghostRun && !this.bossLevel) {
      this.levelBonus += 500 * this.level;
      this._medal('ghost');
    }
    this.score += this.levelBonus;
    this.pot = 0;
    if (this.levelUntouched) this._medal('untouchable');
    this._rollGates();
    this.mode = 'levelclear';
    this._sfx('levelClear');
  }

  /* Warp gates: the strategic beat between sectors. STANDARD is always on
   * offer next to two mutated routes that pay a tech signing bonus. Daily
   * runs seed the roll so everyone faces the same map. The WARLORD allows
   * no alternate routes. */
  _rollGates() {
    const next = this.level + 1;
    if (this.versus || next % BOSS_EVERY === 0) { this.gates = null; return; }
    const rng = this.dailySeed ? mulberry32(hashStr(this.dailySeed + '#gates' + this.level)) : Math.random;
    const pool = MUTATORS.filter((m) => m.id !== 'gauntlet' || next >= 4);
    const i1 = (rng() * pool.length) | 0;
    let i2 = (rng() * (pool.length - 1)) | 0;
    if (i2 >= i1) i2++;
    this.gates = [
      { id: 'standard', name: 'STANDARD SECTOR', desc: 'no modifiers', tech: 0 },
      pool[i1], pool[i2],
    ];
  }

  _beginDeath() {
    if (this.mode !== 'playing') return;
    this.mode = 'dying';
    this.deathTimer = 2.2;
    this.shake = 2;
  }

  /* gateId: which warp gate the squad took ('standard' / mutator id / null). */
  nextLevel(gateId) {
    this.level++;
    const gate = (this.gates || []).find((g) => g.id === gateId);
    this.mutator = gate && gate.id !== 'standard' ? gate.id : null;
    this.gates = null;
    // partial resupply between sectors; revive anyone who fell
    for (const p of this.players) {
      const wasDead = !p.alive;
      p.alive = true; p.respawnT = 0; p.lowWarned = false;
      const base = wasDead ? 0 : p.shields;
      p.shields = Math.min(p.maxShields, base + p.maxShields * 0.4);
      p.nades = Math.min(p.maxNades, p.nades + 2);
    }
    this.startLevel();
    // riskier gates pay their tech signing bonus the moment you deploy
    if (gate && gate.tech) for (const p of this.players) this._awardTech(p, gate.tech);
  }

  /* during 'dying': keep simulating particles & enemies for drama */
  updateDying(dt) {
    this.frameSounds.length = 0;
    this.frameBursts.length = 0;
    this.frameDebris.length = 0;
    this.noises.length = 0;   // no patrols left to hear anything
    this.deathTimer -= dt;
    this.shake = Math.max(0, this.shake - dt * 1.2);
    this._updateParticles(dt);
    this._updateDebris(dt);
    this._updateProjectiles(dt);
    this._updateRings(dt);
    for (const f of this.flags) f.spin += dt * 2.2;
    if (this.deathTimer <= 0) {
      this.mode = 'gameover';
      this._sfx('gameOver');
    }
  }
}
