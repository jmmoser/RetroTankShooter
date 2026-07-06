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
 */

const ARENA_HALF = 230;          // arena is a square, +/- ARENA_HALF
const WALL_PAD = 3;              // keep tanks this far from the wall
const COMBO_WINDOW = 4;          // seconds between kills to keep the chain
const BOSS_EVERY = 5;            // a WARLORD guards every Nth sector

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

const ENEMY_TYPES = {
  drone:   { hp: 60,  speed: 11, turn: 1.5, fireRange: 80,  fireCd: 2.2, aggro: 120, score: 150, shotSpeed: 42, dmg: 14, lead: 0 },
  hunter:  { hp: 85,  speed: 18, turn: 2.4, fireRange: 62,  fireCd: 1.5, aggro: 999, score: 300, shotSpeed: 52, dmg: 18, lead: 0.8 },
  sniper:  { hp: 75,  speed: 7,  turn: 1.2, fireRange: 145, fireCd: 3.2, aggro: 180, score: 400, shotSpeed: 78, dmg: 26, lead: 0.9 },
  phantom: { hp: 110, speed: 15, turn: 2.2, fireRange: 95,  fireCd: 2.3, aggro: 999, score: 600, shotSpeed: 60, dmg: 22, lead: 0.8, cloaks: true },
};

// Hull colors used for the shard debris a destroyed tank breaks into.
const DEBRIS_COLORS = {
  drone:   [1.0, 0.30, 0.24],
  hunter:  [1.0, 0.62, 0.14],
  sniper:  [0.78, 0.44, 1.0],
  phantom: [0.62, 0.92, 0.95],
  player:  [0.25, 1.0, 0.82],
};

const POWERUP_TYPES = {
  ammo:      { tint: [0.95, 0.8, 0.25], label: '+AMMO' },
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
    this.depots = [];      // resupply pads: { x, z, type: 'ammo'|'shield' }
    this.players = [];     // all tanks in the run (co-op); player[0..n]
    this.player = null;    // alias to the LOCAL player (for HUD / camera)
    this.localId = null;
    this.frameSounds = []; // sfx triggered this update — drained by the net layer
    this.frameBursts = []; // particle bursts this update — drained by the net layer
    this.frameDebris = []; // shard spawns this update — drained by the net layer
    this.levelBonus = 0;
    this.killsThisLevel = 0;
    this.combo = 0;        // kills in the current chain
    this.comboT = 0;       // time left before the chain expires
    this.mult = 1;         // score multiplier from the chain
    this.alert = 0;        // 0..1 — fraction of flags secured this sector
    this.alertTier = 0;    // reinforcement waves already triggered
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
    this.runStats = { kills: 0, flags: 0, warlords: 0, bestMult: 1 };
  }

  /* Queue a sound: plays locally and is mirrored to clients by the host. */
  _sfx(key) {
    this.frameSounds.push(key);
    AudioSys.play(key);
  }

  _makePlayer(def, idx) {
    const lo = LOADOUTS[def.loadoutIndex] || LOADOUTS[1];
    const p = {
      id: def.id,
      name: def.name || ('PLAYER ' + (idx + 1)),
      colorIdx: idx % PLAYER_TINTS.length,
      input: { turn: 0, drive: 0, fire: false, nade: false, boost: false },
      x: 0, z: 0, angle: 0,
      speed: 0,
      maxSpeed: 14 + lo.speed * 3.2,
      accel: 26 + lo.speed * 5,
      turnRate: 1.7 + lo.speed * 0.14,
      maxShields: 50 + lo.armor * 22,
      shields: 0,
      maxAmmo: 14 + lo.ammo * 8,
      ammo: 0,
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
    };
    p.shields = p.maxShields;
    p.ammo = p.maxAmmo;
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
    this.runStats = { kills: 0, flags: 0, warlords: 0, bestMult: 1 };
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
    this.shake = 0;
    this.killsThisLevel = 0;
    this.combo = 0; this.comboT = 0; this.mult = 1;
    this.alert = 0; this.alertTier = 0;
    this.pendingSpawns = [];
    this.rings = [];
    this.boss = null;
    this.bossLevel = !this.versus && L >= BOSS_EVERY && L % BOSS_EVERY === 0;

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
      p.speed = 0;
      p.fx.overdrive = 0; p.fx.rapid = 0;
      p.boost = p.maxBoost;
      p.alive = true; p.respawnT = 0; p.lowWarned = false;
      p.input.fire = false; p.input.nade = false; p.input.mine = false;
      p.depotAcc = 0; p.onDepot = false;
    });

    if (this.versus) {
      // deathmatch arena: cover and contested resupply, no AI
      this._genObstacles(34);
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
      this._genObstacles(48 + Math.min(L * 3, 36));
      this._genFlags(6 + Math.min(L, 10));
      this._genEnemies();
      this._genDepots();
    }
    // a couple of starter pickups scattered on the field
    for (let i = 0; i < 2; i++) {
      const pos = this._findSpot(4, 40);
      if (pos) this._spawnPowerup(pos[0], pos[1], RNG() < 0.5 ? 'ammo' : 'shield');
    }
    RNG = Math.random;   // seeded window ends with generation
    this.mode = 'playing';
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

  _genObstacles(count) {
    // Spectre-style solid slabs: saturated flat-shaded colors that pop
    // against the void, dimming into the fog with distance.
    const palette = [
      [0.72, 0.20, 0.20], [0.20, 0.42, 0.78], [0.20, 0.62, 0.32],
      [0.62, 0.62, 0.62], [0.72, 0.54, 0.18], [0.46, 0.28, 0.72],
    ];
    for (let i = 0; i < count; i++) {
      for (let tries = 0; tries < 40; tries++) {
        const x = rand(-ARENA_HALF + 10, ARENA_HALF - 10);
        const z = rand(-ARENA_HALF + 10, ARENA_HALF - 10);
        // keep deploy zones clear
        let nearSpawn = false;
        for (const sp of this._spawnPoints()) {
          if (Math.hypot(x - sp[0], z - sp[1]) < 18) { nearSpawn = true; break; }
        }
        if (nearSpawn) continue;
        const pyramid = RNG() < 0.4;
        const w = pyramid ? rand(5, 9) : rand(4, 11);
        const d = pyramid ? w : rand(4, 11);
        const h = pyramid ? rand(5, 11) : rand(3, 9);
        if (this._collidesObstacle(x, z, Math.max(w, d) / 2 + 5)) continue;
        this.obstacles.push({
          x, z, w, d, h,
          type: pyramid ? 'pyramid' : 'block',
          color: palette[(RNG() * palette.length) | 0],
        });
        break;
      }
    }
  }

  _genFlags(count) {
    for (let i = 0; i < count; i++) {
      const pos = this._findSpot(3.5, 25);
      if (pos) this.flags.push({ x: pos[0], z: pos[1], taken: false, spin: rand(0, Math.PI * 2) });
    }
  }

  _genDepots() {
    // one ammo pad and one shield pad per sector — drive on to resupply
    for (const type of ['ammo', 'shield']) {
      const pos = this._findSpot(6, 45);
      if (pos) this.depots.push({ x: pos[0], z: pos[1], type });
    }
  }

  _spawnEnemy(type, x, z) {
    const L = this.level;
    const spec = ENEMY_TYPES[type];
    const diff = 1 + (L - 1) * 0.085;
    // elites: hardened variants that show up from sector 3 — tougher, faster,
    // meaner and worth half again the score. They strobe white-hot in the
    // arena and wear a ring on the radar.
    const elite = !this.bossLevel && L >= 3 && RNG() < Math.min(0.06 + L * 0.02, 0.3);
    this.enemies.push({
      type,
      elite,
      x, z,
      angle: rand(0, Math.PI * 2),
      hp: spec.hp * (elite ? 1.6 : 1),
      maxHp: spec.hp * (elite ? 1.6 : 1),
      speed: spec.speed * diff * (elite ? 1.15 : 1),
      turn: spec.turn * diff,
      fireRange: spec.fireRange,
      fireCd: rand(1, spec.fireCd),
      fireDelay: spec.fireCd / diff / (elite ? 1.2 : 1),
      aggro: spec.aggro,
      score: elite ? Math.round(spec.score * 1.5) : spec.score,
      shotSpeed: spec.shotSpeed,
      dmg: spec.dmg * (elite ? 1.25 : 1),
      lead: spec.lead || 0,
      cloak: spec.cloaks ? 1 : 0,
      decloakT: 0,
      wanderX: x, wanderZ: z,
      wanderT: 0,
      hitFlash: 0,
    });
  }

  _genEnemies() {
    const L = this.level;
    const total = Math.min(4 + Math.floor(L * 1.5), 16);
    for (let i = 0; i < total; i++) {
      let type = 'drone';
      if (L >= 2 && i % 3 === 1) type = 'hunter';
      if (L >= 4 && i % 4 === 2) type = 'sniper';
      if (L >= 5 && i % 5 === 3) type = 'phantom';
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
    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) { this.comboT = 0; this.combo = 0; this.mult = 1; }
    }

    for (const p of this.players) this._updatePlayer(p, dt);
    if (!this.versus) {
      this._updateEnemies(dt);
      this._updateBoss(dt);
      this._updateRings(dt);
      this._updateSpawns(dt);
    }
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
      : this.flagsLeft() === 0;
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

  // ---- alert escalation -----------------------------------------------------
  // Securing flags raises the sector alert: survivors get faster and meaner,
  // and crossing a threshold warps reinforcements in near the objective.

  _onFlagSecured() {
    const total = this.flags.length;
    if (!total) return;
    let taken = 0;
    for (const f of this.flags) if (f.taken) taken++;
    this.alert = taken / total;

    const thresholds = [0.45, 0.75, 0.92];
    while (this.alertTier < thresholds.length && this.alert >= thresholds[this.alertTier]) {
      this.alertTier++;
      if (this.flagsLeft() === 0) break;   // sector's done — no pointless wave
      const wave = Math.min(4, 1 + Math.floor((this.level + this.alertTier) / 3));
      let queued = 0;
      for (let i = 0; i < wave; i++) {
        if (this.enemies.length + this.pendingSpawns.length >= 18) break;
        const live = this.flags.filter((f) => !f.taken);
        const f = live[(RNG() * live.length) | 0];
        const pos = this._findSpotNear(f.x, f.z, 12, 30, 4, 45);
        if (!pos) continue;
        this.pendingSpawns.push({ x: pos[0], z: pos[1], type: this._reinforcementType(), t: 1.8, tick: 0 });
        queued++;
      }
      if (queued > 0) {
        this._sfx('alarm');
        this.hud.message('ALERT LEVEL ' + this.alertTier + ' — REINFORCEMENTS INBOUND', '#ff4a3c', 2.4);
      }
    }
  }

  _reinforcementType() {
    const L = this.level, r = RNG();
    if (L >= 5 && r < 0.18) return 'phantom';
    if (L >= 4 && r < 0.40) return 'sniper';
    if (L >= 2 && r < 0.75) return 'hunter';
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
        this._spawnEnemy(s.type, s.x, s.z);
        this._burst(s.x, 1.5, s.z, 22, [1, 0.3, 0.6], 11);
        this._sfx('warp');
      }
    }
  }

  // ---- combo multiplier -------------------------------------------------------
  // Kills chain into a score multiplier; taking any damage breaks it.

  _awardKill(baseScore, ownerId) {
    this.combo++;
    this.comboT = COMBO_WINDOW;
    const mult = this.combo >= 8 ? 5 : this.combo >= 5 ? 4 : this.combo >= 3 ? 3 : this.combo >= 2 ? 2 : 1;
    if (mult > this.mult) {
      this._sfx('combo');
      this.hud.message('COMBO ×' + mult, '#ffd24a', 1.4);
    }
    this.mult = mult;
    this.runStats.kills++;
    this.runStats.bestMult = Math.max(this.runStats.bestMult, mult);
    const pts = baseScore * mult;
    this.score += pts;
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
  }

  _respawn(p) {
    if (this.versus) {
      // deathmatch: always come back, fresh loadout, away from the fight
      const pos = this._findSpotNear(0, 0, 80, ARENA_HALF - 30, 4, 55) || [0, 0];
      p.x = pos[0]; p.z = pos[1];
      p.angle = angleTo(-p.x, -p.z);
      p.speed = 0;
      p.alive = true;
      p.shields = p.maxShields;
      p.ammo = p.maxAmmo;
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
    p.alive = true;
    p.shields = p.maxShields * 0.6;
    p.ammo = Math.max(p.ammo, Math.round(p.maxAmmo * 0.5));
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

    const input = p.input;
    const isLocal = p.id === this.localId;

    // turbo boost: hold SHIFT while driving forward; the gauge drains fast
    // and trickles back when idle — Spectre's classic hit-and-run tool.
    // Hysteresis: a drained gauge must recover before boost re-engages.
    const wantBoost = !!input.boost && input.drive > 0.1 &&
      (p.boosting ? p.boost > 0 : p.boost > 15);
    if (wantBoost && !p.boosting) this._sfx('boost');
    p.boosting = wantBoost;
    if (p.boosting) p.boost = Math.max(0, p.boost - dt * 34);
    else p.boost = Math.min(p.maxBoost, p.boost + dt * 13);

    const boostMult = (p.fx.overdrive > 0 ? 1.5 : 1) * (p.boosting ? 1.65 : 1);
    const maxSpd = p.maxSpeed * boostMult;

    // throttle
    const target = input.drive >= 0 ? input.drive * maxSpd : input.drive * maxSpd * 0.55;
    const rate = p.accel * (Math.abs(target) > Math.abs(p.speed) ? 1 : 2.2) * (p.boosting ? 1.5 : 1);
    if (p.speed < target) p.speed = Math.min(target, p.speed + rate * dt);
    else if (p.speed > target) p.speed = Math.max(target, p.speed - rate * dt);

    // steering scales down slightly at top speed for weight
    const steerScale = 1 - 0.25 * Math.min(1, Math.abs(p.speed) / maxSpd);
    p.angle += input.turn * p.turnRate * steerScale * dt * (p.speed < -0.5 ? -1 : 1);

    p.x += fwdX(p.angle) * p.speed * dt;
    p.z += fwdZ(p.angle) * p.speed * dt;

    // bouncy walls: slam into a slab or the perimeter and you rebound
    const hit = this._collideTank(p, 1.9);
    if (hit && Math.abs(p.speed) > p.maxSpeed * 0.45 && p.bounceCd <= 0) {
      p.bounceCd = 0.35;
      p.speed *= -0.45;
      p.boosting = false;
      this._sfx('bounce');
      this._burst(p.x + fwdX(p.angle) * 2.5, 1.2, p.z + fwdZ(p.angle) * 2.5, 8, [0.9, 0.9, 0.7], 6);
      if (isLocal) this.shake = Math.min(this.shake + 0.45, 1.2);
    } else if (hit) {
      p.speed *= 0.5;
    }

    // main cannon
    p.fireCd -= dt;
    const delay = p.fireDelay * (p.fx.rapid > 0 ? 0.45 : 1);
    if (input.fire && p.fireCd <= 0) {
      if (p.ammo > 0) {
        p.ammo--;
        p.fireCd = delay;
        const shotAngle = this._aimAssist(p);
        const bx = p.x + fwdX(shotAngle) * 3.2;
        const bz = p.z + fwdZ(shotAngle) * 3.2;
        this.projectiles.push({
          x: bx, z: bz, y: 1.6, angle: shotAngle,
          speed: 72, from: 'player', owner: p.id, dmg: 25, life: 4,
        });
        this._burst(bx, 1.6, bz, 4, [1, 0.9, 0.5], 5); // muzzle flash
        this._sfx('fire');
        if (isLocal) this.shake = Math.min(this.shake + 0.12, 0.5);
      } else {
        p.fireCd = 0.3;
        this._sfx('select'); // dry-fire click
        if (isLocal && RNG() < 0.3) this.hud.message('OUT OF AMMO', '#ff4a3c', 1.2);
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
    // togglable in settings; the host's sim applies it for everyone in co-op
    if (typeof Settings !== 'undefined' && !Settings.get('aimAssist')) return p.angle;
    const CONE = 0.15, RANGE = 150;
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

  _updateEnemies(dt) {
    // sector alert makes survivors faster and more trigger-happy
    const alertMul = 1 + this.alert * 0.4;
    for (const e of this.enemies) {
      e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
      const p = this._nearestPlayer(e.x, e.z);
      const distP = p ? Math.hypot(p.x - e.x, p.z - e.z) : Infinity;
      const hunting = !!p && distP < e.aggro;

      // phantoms shimmer out of visibility while stalking, decloak to fire
      if (ENEMY_TYPES[e.type].cloaks) {
        e.decloakT = Math.max(0, e.decloakT - dt);
        const target = (e.decloakT > 0 || e.hitFlash > 0) ? 0 : 1;
        e.cloak += (target - e.cloak) * Math.min(1, dt * 2.5);
      }

      // pick a destination
      let tx, tz;
      if (hunting) {
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

      let desired = angleTo(tx - e.x, tz - e.z);

      // crude obstacle avoidance: probe ahead, steer right if blocked
      const probe = 7;
      const ax = e.x + fwdX(e.angle) * probe, az = e.z + fwdZ(e.angle) * probe;
      if (this._collidesObstacle(ax, az, 2.2) ||
          Math.abs(ax) > ARENA_HALF - 4 || Math.abs(az) > ARENA_HALF - 4) {
        desired = e.angle + 1.4;
      }

      const diff = wrapAngle(desired - e.angle);
      const maxTurn = e.turn * alertMul * dt;
      e.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));

      // snipers hold still at range; others close in
      const wantStop = e.type === 'sniper' && hunting && distP < e.fireRange * 0.8;
      if (!wantStop && Math.abs(diff) < 1.2 && !(hunting && distP < 9)) {
        e.x += fwdX(e.angle) * e.speed * alertMul * dt;
        e.z += fwdZ(e.angle) * e.speed * alertMul * dt;
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
        if (e.lead > 0 && Math.abs(p.speed) > 1) {
          const tFly = distP / e.shotSpeed;
          aimX += fwdX(p.angle) * p.speed * tFly * e.lead;
          aimZ += fwdZ(p.angle) * p.speed * tFly * e.lead;
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
        }
      }
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

      let dead = pr.life <= 0 ||
        Math.abs(pr.x) > ARENA_HALF || Math.abs(pr.z) > ARENA_HALF;

      if (!dead && this._collidesObstacle(pr.x, pr.z, 0.4)) {
        dead = true;
        this._burst(pr.x, 1.6, pr.z, 8, [1, 0.8, 0.4], 6);
        this._sfx('hitWall');
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
          if (dist2(pr.x, pr.z, e.x, e.z) < 2.4 * 2.4) {
            dead = true;
            this._hurtEnemy(j, pr.dmg, pr.owner);
            break;
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
      }

      if (dead) this.projectiles.splice(i, 1);
    }
  }

  _nadeBoom(pr) {
    const R = 10;
    this._burst(pr.x, 1.2, pr.z, 40, [1, 0.7, 0.25], 16);
    this._burst(pr.x, 2.2, pr.z, 18, [1, 0.95, 0.7], 10);
    this._sfx('nadeBoom');
    this.shake = Math.min(this.shake + 0.5, 1.2);
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
        this._hurtEnemy(j, dmg, pr.owner);
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
      if (d < R) this._hurtEnemy(j, falloff(d), m.owner);
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

  _hurtEnemy(index, dmg, ownerId) {
    const e = this.enemies[index];
    e.hp -= dmg;
    e.hitFlash = 1;
    if (ENEMY_TYPES[e.type].cloaks) e.decloakT = Math.max(e.decloakT, 1.2);
    this._burst(e.x, 1.5, e.z, 10, [1, 0.6, 0.3], 8);
    if (e.hp <= 0) this._killEnemy(index, ownerId);
    else this._sfx('hitEnemy');
  }

  _killEnemy(index, ownerId) {
    const e = this.enemies[index];
    this.enemies.splice(index, 1);
    this.killsThisLevel++;
    this._awardKill(e.score, ownerId);
    this._burst(e.x, 1.5, e.z, 34, [1, 0.55, 0.15], 14);
    this._burst(e.x, 1.5, e.z, 16, [0.9, 0.9, 0.9], 9);
    this._spawnShards(e.x, e.z, DEBRIS_COLORS[e.type] || DEBRIS_COLORS.drone);
    this._sfx('explosion');
    this.shake = Math.min(this.shake + 0.4, 1);
    // chance to drop a pickup
    if (RNG() < 0.35) {
      const keys = Object.keys(POWERUP_TYPES);
      this._spawnPowerup(e.x, e.z, keys[(RNG() * keys.length) | 0]);
    }
  }

  _damagePlayer(p, dmg, attackerId) {
    const isLocal = p.id === this.localId;
    p.shields -= dmg;
    this._breakCombo();   // any hit on the squad snaps the kill chain
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
    for (const p of this.players) {
      if (!p.alive) continue;
      const isLocal = p.id === this.localId;
      // flags
      for (const f of this.flags) {
        if (f.taken) continue;
        if (dist2(p.x, p.z, f.x, f.z) < 3.4 * 3.4) {
          f.taken = true;
          this.runStats.flags++;
          const pts = 100 * this.level * this.mult;
          this.score += pts;
          this._burst(f.x, 2.5, f.z, 18, [0.3, 1, 0.5], 8);
          this._sfx('flag');
          if (isLocal) {
            this.hud.pickup();
            this.hud.scorePop('+' + pts + (this.mult > 1 ? ' ×' + this.mult : ''));
          }
          const left = this.flagsLeft();
          if (isLocal) {
            this.hud.message(left > 0 ? `FLAG SECURED — ${left} LEFT` : 'ALL FLAGS SECURED', '#3cff78', 1.6);
          }
          this._onFlagSecured();
        }
      }
      // powerups
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
        this.hud.message(on.type === 'ammo' ? 'AMMO DEPOT — RESUPPLYING' : 'SHIELD DEPOT — RECHARGING', '#4fd6bb', 1.6);
      }
      p.onDepot = !!on;
      if (!on) { p.depotAcc = 0; continue; }
      if (on.type === 'shield') {
        if (p.shields < p.maxShields) {
          p.shields = Math.min(p.maxShields, p.shields + dt * 9);
          p.depotAcc += dt;
          if (p.depotAcc >= 0.5) { p.depotAcc -= 0.5; this._sfx('refuel'); }
        }
      } else {
        if (p.ammo < p.maxAmmo) {
          p.depotAcc += dt * 2.5;
          while (p.depotAcc >= 1 && p.ammo < p.maxAmmo) {
            p.depotAcc -= 1;
            p.ammo++;
            this._sfx('refuel');
          }
        }
      }
    }
  }

  _applyPowerup(p, type) {
    const spec = POWERUP_TYPES[type];
    switch (type) {
      case 'ammo':   p.ammo = Math.min(p.maxAmmo, p.ammo + 18); break;
      case 'shield': p.shields = Math.min(p.maxShields, p.shields + 35); break;
      case 'nade':   p.nades = Math.min(p.maxNades, p.nades + 2); break;
      case 'mine':   p.mines = Math.min(p.maxMines, p.mines + 2); break;
      case 'overdrive': p.fx.overdrive = 10; break;
      case 'rapid':     p.fx.rapid = 10; break;
    }
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
      if (Math.abs(t.speed) > 1) {
        const tFly = dist / 55;
        aimX += fwdX(t.angle) * t.speed * tFly * 0.7;
        aimZ += fwdZ(t.angle) * t.speed * tFly * 0.7;
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
      this._awardKill(400, ownerId);
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
    this._awardKill(b.score, ownerId);
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
  }

  _spawnRing(x, z, dmg) {
    this.rings.push({
      x, z,
      r: this.boss ? this.boss.radius : 6,
      speed: this.boss ? this.boss.ringSpeed : 28,
      dmg, hit: {},
    });
    this._sfx('shock');
    this._burst(x, 0.8, z, 26, [1, 0.55, 0.2], 12);
  }

  _updateRings(dt) {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.r += r.speed * dt;
      for (const p of this.players) {
        if (!p.alive || r.hit[p.id]) continue;
        const d = Math.hypot(p.x - r.x, p.z - r.z);
        if (Math.abs(d - r.r) < 2.4) {
          r.hit[p.id] = true;   // the wave passed — cover decides if it hurt
          if (this._losClear(r.x, r.z, p.x, p.z)) this._damagePlayer(p, r.dmg);
        }
      }
      if (r.r > 190) this.rings.splice(i, 1);
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
    let sh = 0, am = 0;
    for (const p of this.players) { sh += Math.max(0, p.shields); am += p.ammo; }
    this.levelBonus = this.level * 250 +
      Math.round(sh) * 3 +
      am * 5 +
      this.killsThisLevel * 50;
    this.score += this.levelBonus;
    this.mode = 'levelclear';
    this._sfx('levelClear');
  }

  _beginDeath() {
    if (this.mode !== 'playing') return;
    this.mode = 'dying';
    this.deathTimer = 2.2;
    this.shake = 2;
  }

  nextLevel() {
    this.level++;
    // partial resupply between sectors; revive anyone who fell
    for (const p of this.players) {
      const wasDead = !p.alive;
      p.alive = true; p.respawnT = 0; p.lowWarned = false;
      const base = wasDead ? 0 : p.shields;
      p.shields = Math.min(p.maxShields, base + p.maxShields * 0.4);
      p.ammo = Math.min(p.maxAmmo, (wasDead ? 0 : p.ammo) + Math.round(p.maxAmmo * 0.6));
      p.nades = Math.min(p.maxNades, p.nades + 2);
    }
    this.startLevel();
  }

  /* during 'dying': keep simulating particles & enemies for drama */
  updateDying(dt) {
    this.frameSounds.length = 0;
    this.frameBursts.length = 0;
    this.frameDebris.length = 0;
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
