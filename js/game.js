/* Core game state: arena generation, player, enemy AI, projectiles, pickups.
 *
 * Spectre Challenger-style systems live here: bouncy walls, a turbo boost
 * gauge, lobbed grenades with splash, resupply depots, cloaking phantom
 * tanks, and tanks that shatter into tumbling polygon shards.
 */

const ARENA_HALF = 230;          // arena is a square, +/- ARENA_HALF
const WALL_PAD = 3;              // keep tanks this far from the wall

const LOADOUTS = [
  { name: 'SCOUT',      speed: 5, armor: 2, ammo: 3, nades: 4 },
  { name: 'VANGUARD',   speed: 3, armor: 3, ammo: 4, nades: 3 },
  { name: 'JUGGERNAUT', speed: 2, armor: 5, ammo: 3, nades: 2 },
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
function rand(a, b) { return a + Math.random() * (b - a); }

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

  /* defs: [{ id, name, loadoutIndex }]; localId names the local tank. */
  newRun(defs, localId) {
    if (!Array.isArray(defs)) defs = [{ id: 'solo', loadoutIndex: defs }]; // solo back-compat
    this.level = 1;
    this.score = 0;
    this.players = defs.map((d, i) => this._makePlayer(d, i));
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
    this.debris = [];
    this.depots = [];
    this.shake = 0;
    this.killsThisLevel = 0;

    const n = this.players.length;
    this.players.forEach((p, i) => {
      p.x = (i - (n - 1) / 2) * 8;
      p.z = ARENA_HALF - 22;
      p.angle = 0; p.speed = 0;
      p.fx.overdrive = 0; p.fx.rapid = 0;
      p.boost = p.maxBoost;
      p.alive = true; p.respawnT = 0; p.lowWarned = false;
      p.input.fire = false; p.input.nade = false;
      p.depotAcc = 0; p.onDepot = false;
    });

    this._genObstacles(48 + Math.min(L * 3, 36));
    this._genFlags(6 + Math.min(L, 10));
    this._genEnemies();
    this._genDepots();
    // a couple of starter pickups scattered on the field
    for (let i = 0; i < 2; i++) {
      const pos = this._findSpot(4, 40);
      if (pos) this._spawnPowerup(pos[0], pos[1], Math.random() < 0.5 ? 'ammo' : 'shield');
    }
    this.mode = 'playing';
  }

  flagsLeft() {
    let n = 0;
    for (const f of this.flags) if (!f.taken) n++;
    return n;
  }

  // ---- generation ---------------------------------------------------------

  _collidesObstacle(x, z, r) {
    for (const o of this.obstacles) {
      const hx = o.w / 2 + r, hz = o.d / 2 + r;
      if (Math.abs(x - o.x) < hx && Math.abs(z - o.z) < hz) return o;
    }
    return null;
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
        // keep player spawn corridor clear
        if (Math.hypot(x - 0, z - (ARENA_HALF - 22)) < 18) continue;
        const pyramid = Math.random() < 0.4;
        const w = pyramid ? rand(5, 9) : rand(4, 11);
        const d = pyramid ? w : rand(4, 11);
        const h = pyramid ? rand(5, 11) : rand(3, 9);
        if (this._collidesObstacle(x, z, Math.max(w, d) / 2 + 5)) continue;
        this.obstacles.push({
          x, z, w, d, h,
          type: pyramid ? 'pyramid' : 'block',
          color: palette[(Math.random() * palette.length) | 0],
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
      const spec = ENEMY_TYPES[type];
      const diff = 1 + (L - 1) * 0.085;
      this.enemies.push({
        type,
        x: pos[0], z: pos[1],
        angle: rand(0, Math.PI * 2),
        hp: spec.hp,
        maxHp: spec.hp,
        speed: spec.speed * diff,
        turn: spec.turn * diff,
        fireRange: spec.fireRange,
        fireCd: rand(1, spec.fireCd),
        fireDelay: spec.fireCd / diff,
        aggro: spec.aggro,
        score: spec.score,
        shotSpeed: spec.shotSpeed,
        dmg: spec.dmg,
        lead: spec.lead || 0,
        cloak: spec.cloaks ? 1 : 0,
        decloakT: 0,
        wanderX: pos[0], wanderZ: pos[1],
        wanderT: 0,
        hitFlash: 0,
      });
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

    for (const p of this.players) this._updatePlayer(p, dt);
    this._updateEnemies(dt);
    this._updateProjectiles(dt);
    this._updatePickups(dt);
    this._updateDepots(dt);
    this._updateParticles(dt);
    this._updateDebris(dt);

    for (const f of this.flags) f.spin += dt * 2.2;

    if (this._anyAlive() && this.flagsLeft() === 0) {
      this._levelClear();
    } else if (!this._anyAlive()) {
      this._beginDeath();
    }
  }

  _respawn(p) {
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

    p.fx.overdrive = Math.max(0, p.fx.overdrive - dt);
    p.fx.rapid = Math.max(0, p.fx.rapid - dt);
    p.bounceCd = Math.max(0, p.bounceCd - dt);
    p.nadeCd = Math.max(0, p.nadeCd - dt);

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
        const bx = p.x + fwdX(p.angle) * 3.2;
        const bz = p.z + fwdZ(p.angle) * 3.2;
        this.projectiles.push({
          x: bx, z: bz, y: 1.6, angle: p.angle,
          speed: 72, from: 'player', owner: p.id, dmg: 25, life: 4,
        });
        this._burst(bx, 1.6, bz, 4, [1, 0.9, 0.5], 5); // muzzle flash
        this._sfx('fire');
        if (isLocal) this.shake = Math.min(this.shake + 0.12, 0.5);
      } else {
        p.fireCd = 0.3;
        this._sfx('select'); // dry-fire click
        if (isLocal && Math.random() < 0.3) this.hud.message('OUT OF AMMO', '#ff4a3c', 1.2);
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

    if (isLocal) {
      if (p.shields <= p.maxShields * 0.25 && !p.lowWarned) {
        p.lowWarned = true;
        this.hud.message('SHIELDS CRITICAL', '#ff4a3c', 2.5);
        this._sfx('lowShield');
      }
      if (p.shields > p.maxShields * 0.35) p.lowWarned = false;
    }
  }

  /* Clamp a tank inside the arena and outside obstacles. Returns true if a
   * correction was applied (used for the player bounce). */
  _collideTank(t, radius) {
    let hit = false;
    const lim = ARENA_HALF - WALL_PAD;
    if (t.x < -lim || t.x > lim) { t.x = Math.max(-lim, Math.min(lim, t.x)); hit = true; }
    if (t.z < -lim || t.z > lim) { t.z = Math.max(-lim, Math.min(lim, t.z)); hit = true; }
    for (const o of this.obstacles) {
      const hx = o.w / 2 + radius, hz = o.d / 2 + radius;
      const dx = t.x - o.x, dz = t.z - o.z;
      if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
        const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
        if (px < pz) t.x = o.x + Math.sign(dx || 1) * hx;
        else t.z = o.z + Math.sign(dz || 1) * hz;
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
        if (Math.abs(x - o.x) < o.w / 2 && Math.abs(z - o.z) < o.d / 2) return false;
      }
    }
    return true;
  }

  _updateEnemies(dt) {
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
          if (live.length && Math.random() < 0.6) {
            const f = live[(Math.random() * live.length) | 0];
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
      const maxTurn = e.turn * dt;
      e.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));

      // snipers hold still at range; others close in
      const wantStop = e.type === 'sniper' && hunting && distP < e.fireRange * 0.8;
      if (!wantStop && Math.abs(diff) < 1.2 && !(hunting && distP < 9)) {
        e.x += fwdX(e.angle) * e.speed * dt;
        e.z += fwdZ(e.angle) * e.speed * dt;
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
          e.fireCd = e.fireDelay;
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
        for (let j = this.enemies.length - 1; j >= 0; j--) {
          const e = this.enemies[j];
          if (dist2(pr.x, pr.z, e.x, e.z) < 2.4 * 2.4) {
            dead = true;
            this._hurtEnemy(j, pr.dmg, pr.owner);
            break;
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
    for (let j = this.enemies.length - 1; j >= 0; j--) {
      const e = this.enemies[j];
      const d = Math.hypot(pr.x - e.x, pr.z - e.z);
      if (d < R) {
        const dmg = pr.dmg * (d < 3 ? 1 : 1 - (d - 3) / (R - 3) * 0.75);
        this._hurtEnemy(j, dmg, pr.owner);
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
    this.score += e.score;
    this.killsThisLevel++;
    this._burst(e.x, 1.5, e.z, 34, [1, 0.55, 0.15], 14);
    this._burst(e.x, 1.5, e.z, 16, [0.9, 0.9, 0.9], 9);
    this._spawnShards(e.x, e.z, DEBRIS_COLORS[e.type] || DEBRIS_COLORS.drone);
    this._sfx('explosion');
    this.shake = Math.min(this.shake + 0.4, 1);
    if (ownerId === this.localId) this.hud.scorePop('+' + e.score);
    // chance to drop a pickup
    if (Math.random() < 0.35) {
      const keys = Object.keys(POWERUP_TYPES);
      this._spawnPowerup(e.x, e.z, keys[(Math.random() * keys.length) | 0]);
    }
  }

  _damagePlayer(p, dmg) {
    const isLocal = p.id === this.localId;
    p.shields -= dmg;
    if (isLocal) {
      this.hud.damage(Math.min(0.8, dmg / 30));
      this.shake = Math.min(this.shake + 0.5, 1.2);
    }
    this._sfx('hitPlayer');
    this._burst(p.x, 1.5, p.z, 12, [1, 0.4, 0.2], 8);
    if (p.shields <= 0) {
      p.shields = 0;
      p.alive = false;
      p.respawnT = 4;
      this._burst(p.x, 1.5, p.z, 60, [1, 0.5, 0.1], 18);
      this._burst(p.x, 2.5, p.z, 30, [1, 0.9, 0.6], 12);
      this._spawnShards(p.x, p.z, DEBRIS_COLORS.player);
      this._sfx('bigExplosion');
      if (isLocal) this.shake = 2;
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
          this.score += 100 * this.level;
          this._burst(f.x, 2.5, f.z, 18, [0.3, 1, 0.5], 8);
          this._sfx('flag');
          if (isLocal) {
            this.hud.pickup();
            this.hud.scorePop('+' + 100 * this.level);
          }
          const left = this.flagsLeft();
          if (isLocal) {
            this.hud.message(left > 0 ? `FLAG SECURED — ${left} LEFT` : 'ALL FLAGS SECURED', '#3cff78', 1.6);
          }
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

  _burst(x, y, z, n, color, power) {
    this.frameBursts.push({ x, y, z, n, c: color, p: power });
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
    for (const f of this.flags) f.spin += dt * 2.2;
    if (this.deathTimer <= 0) {
      this.mode = 'gameover';
      this._sfx('gameOver');
    }
  }
}
