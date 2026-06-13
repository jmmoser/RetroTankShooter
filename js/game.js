/* Core game state: arena generation, player, enemy AI, projectiles, pickups. */

const ARENA_HALF = 230;          // arena is a square, +/- ARENA_HALF (large, lonely)
const WALL_PAD = 3;              // keep tanks this far from the wall

const LOADOUTS = [
  { name: 'SCOUT',      speed: 5, armor: 2, ammo: 3 },
  { name: 'VANGUARD',   speed: 3, armor: 3, ammo: 4 },
  { name: 'JUGGERNAUT', speed: 2, armor: 5, ammo: 3 },
];

// Tuned harder: faster, more aggressive, longer reach, deadlier hits.
const ENEMY_TYPES = {
  drone:  { hp: 60,  speed: 11, turn: 1.5, fireRange: 80,  fireCd: 2.2, aggro: 120, score: 150, shotSpeed: 42, dmg: 14 },
  hunter: { hp: 85,  speed: 18, turn: 2.4, fireRange: 62,  fireCd: 1.5, aggro: 999, score: 300, shotSpeed: 52, dmg: 18 },
  sniper: { hp: 75,  speed: 7,  turn: 1.2, fireRange: 145, fireCd: 3.2, aggro: 180, score: 400, shotSpeed: 78, dmg: 26 },
};

const POWERUP_TYPES = {
  ammo:      { tint: [0.95, 0.8, 0.25], label: '+AMMO' },
  shield:    { tint: [0.3, 0.95, 0.6],  label: '+SHIELDS' },
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
    this.player = null;
    this.lowShieldWarned = false;
    this.levelBonus = 0;
    this.killsThisLevel = 0;
  }

  newRun(loadoutIndex) {
    const lo = LOADOUTS[loadoutIndex] || LOADOUTS[1];
    this.level = 1;
    this.score = 0;
    this.player = {
      x: 0, z: 0, angle: 0,
      speed: 0,
      maxSpeed: 14 + lo.speed * 3.2,
      accel: 26 + lo.speed * 5,
      turnRate: 1.7 + lo.speed * 0.14,
      maxShields: 50 + lo.armor * 22,
      shields: 0,
      maxAmmo: 14 + lo.ammo * 8,
      ammo: 0,
      fireCd: 0,
      fireDelay: 0.38,
      fx: { overdrive: 0, rapid: 0 },
      alive: true,
      loadout: lo.name,
    };
    this.player.shields = this.player.maxShields;
    this.player.ammo = this.player.maxAmmo;
    this.startLevel();
  }

  startLevel() {
    const L = this.level;
    this.obstacles = [];
    this.flags = [];
    this.enemies = [];
    this.projectiles = [];
    this.powerups = [];
    this.particles = [];
    this.shake = 0;
    this.lowShieldWarned = false;
    this.killsThisLevel = 0;

    const p = this.player;
    p.x = 0; p.z = ARENA_HALF - 22; p.angle = 0; p.speed = 0;
    p.fx.overdrive = 0; p.fx.rapid = 0;

    this._genObstacles(48 + Math.min(L * 3, 36));
    this._genFlags(6 + Math.min(L, 10));
    this._genEnemies();
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
    // cold, desaturated slabs — dim monoliths looming out of the dark
    const palette = [
      [0.16, 0.30, 0.34], [0.12, 0.24, 0.40], [0.22, 0.32, 0.30],
      [0.30, 0.26, 0.34], [0.14, 0.34, 0.32], [0.26, 0.30, 0.22],
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

  _genEnemies() {
    const L = this.level;
    const total = Math.min(4 + Math.floor(L * 1.5), 16);
    for (let i = 0; i < total; i++) {
      let type = 'drone';
      if (L >= 2 && i % 3 === 1) type = 'hunter';
      if (L >= 4 && i % 4 === 2) type = 'sniper';
      const pos = this._findSpot(4, 65);
      if (!pos) continue;
      const spec = ENEMY_TYPES[type];
      const diff = 1 + (L - 1) * 0.085; // steeper per-level scaling
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
    if (this.mode !== 'playing') return;
    this.shake = Math.max(0, this.shake - dt * 3);

    this._updatePlayer(dt);
    this._updateEnemies(dt);
    this._updateProjectiles(dt);
    this._updatePickups(dt);
    this._updateParticles(dt);

    for (const f of this.flags) f.spin += dt * 2.2;

    if (this.player.alive && this.flagsLeft() === 0) {
      this._levelClear();
    }
  }

  _updatePlayer(dt) {
    const p = this.player;
    if (!p.alive) { AudioSys.setEngine(0); return; }

    p.fx.overdrive = Math.max(0, p.fx.overdrive - dt);
    p.fx.rapid = Math.max(0, p.fx.rapid - dt);

    const input = Input.axis();
    const boostMult = (p.fx.overdrive > 0 ? 1.5 : 1);
    const maxSpd = p.maxSpeed * boostMult;

    // throttle
    const target = input.drive >= 0 ? input.drive * maxSpd : input.drive * maxSpd * 0.55;
    const rate = p.accel * (Math.abs(target) > Math.abs(p.speed) ? 1 : 2.2);
    if (p.speed < target) p.speed = Math.min(target, p.speed + rate * dt);
    else if (p.speed > target) p.speed = Math.max(target, p.speed - rate * dt);

    // steering scales down slightly at top speed for weight
    const steerScale = 1 - 0.25 * Math.min(1, Math.abs(p.speed) / maxSpd);
    p.angle += input.turn * p.turnRate * steerScale * dt * (p.speed < -0.5 ? -1 : 1);

    p.x += fwdX(p.angle) * p.speed * dt;
    p.z += fwdZ(p.angle) * p.speed * dt;
    this._collideTank(p, 1.9);

    AudioSys.setEngine(Math.abs(p.speed) / p.maxSpeed);

    // firing
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
          speed: 72, from: 'player', dmg: 25, life: 4,
        });
        AudioSys.play('fire');
        this.shake = Math.min(this.shake + 0.12, 0.5);
      } else {
        p.fireCd = 0.3;
        AudioSys.play('select'); // dry-fire click
        if (Math.random() < 0.3) this.hud.message('OUT OF AMMO', '#ff4a3c', 1.2);
      }
    }

    if (p.shields <= p.maxShields * 0.25 && !this.lowShieldWarned) {
      this.lowShieldWarned = true;
      this.hud.message('SHIELDS CRITICAL', '#ff4a3c', 2.5);
      AudioSys.play('lowShield');
    }
    if (p.shields > p.maxShields * 0.35) this.lowShieldWarned = false;
  }

  _collideTank(t, radius) {
    // arena bounds
    const lim = ARENA_HALF - WALL_PAD;
    t.x = Math.max(-lim, Math.min(lim, t.x));
    t.z = Math.max(-lim, Math.min(lim, t.z));
    // obstacles: push out along least-penetration axis
    for (const o of this.obstacles) {
      const hx = o.w / 2 + radius, hz = o.d / 2 + radius;
      const dx = t.x - o.x, dz = t.z - o.z;
      if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
        const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
        if (px < pz) t.x = o.x + Math.sign(dx || 1) * hx;
        else t.z = o.z + Math.sign(dz || 1) * hz;
      }
    }
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
    const p = this.player;
    for (const e of this.enemies) {
      e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
      const distP = Math.hypot(p.x - e.x, p.z - e.z);
      const hunting = p.alive && distP < e.aggro;

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

      // fire at player
      e.fireCd -= dt;
      if (p.alive && hunting && distP < e.fireRange && e.fireCd <= 0) {
        const aimDiff = Math.abs(wrapAngle(angleTo(p.x - e.x, p.z - e.z) - e.angle));
        if (aimDiff < 0.12 && this._losClear(e.x, e.z, p.x, p.z)) {
          e.fireCd = e.fireDelay;
          this.projectiles.push({
            x: e.x + fwdX(e.angle) * 3.2,
            z: e.z + fwdZ(e.angle) * 3.2,
            y: 1.6, angle: e.angle,
            speed: e.shotSpeed, from: 'enemy', dmg: e.dmg, life: 4,
          });
          AudioSys.play('enemyFire');
        }
      }
    }
  }

  _updateProjectiles(dt) {
    const p = this.player;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      pr.x += fwdX(pr.angle) * pr.speed * dt;
      pr.z += fwdZ(pr.angle) * pr.speed * dt;

      let dead = pr.life <= 0 ||
        Math.abs(pr.x) > ARENA_HALF || Math.abs(pr.z) > ARENA_HALF;

      if (!dead && this._collidesObstacle(pr.x, pr.z, 0.4)) {
        dead = true;
        this._burst(pr.x, 1.6, pr.z, 8, [1, 0.8, 0.4], 6);
        AudioSys.play('hitWall');
      }

      if (!dead && pr.from === 'player') {
        for (let j = this.enemies.length - 1; j >= 0; j--) {
          const e = this.enemies[j];
          if (dist2(pr.x, pr.z, e.x, e.z) < 2.4 * 2.4) {
            dead = true;
            e.hp -= pr.dmg;
            e.hitFlash = 1;
            this._burst(e.x, 1.5, e.z, 10, [1, 0.6, 0.3], 8);
            if (e.hp <= 0) this._killEnemy(j);
            else AudioSys.play('hitEnemy');
            break;
          }
        }
      } else if (!dead && pr.from === 'enemy' && p.alive) {
        if (dist2(pr.x, pr.z, p.x, p.z) < 2.4 * 2.4) {
          dead = true;
          this._damagePlayer(pr.dmg);
        }
      }

      if (dead) this.projectiles.splice(i, 1);
    }
  }

  _killEnemy(index) {
    const e = this.enemies[index];
    this.enemies.splice(index, 1);
    this.score += e.score;
    this.killsThisLevel++;
    this._burst(e.x, 1.5, e.z, 34, [1, 0.55, 0.15], 14);
    this._burst(e.x, 1.5, e.z, 16, [0.9, 0.9, 0.9], 9);
    AudioSys.play('explosion');
    this.shake = Math.min(this.shake + 0.4, 1);
    // chance to drop a pickup
    if (Math.random() < 0.35) {
      const keys = Object.keys(POWERUP_TYPES);
      this._spawnPowerup(e.x, e.z, keys[(Math.random() * keys.length) | 0]);
    }
  }

  _damagePlayer(dmg) {
    const p = this.player;
    p.shields -= dmg;
    this.hud.damage(Math.min(0.8, dmg / 30));
    this.shake = Math.min(this.shake + 0.5, 1.2);
    AudioSys.play('hitPlayer');
    this._burst(p.x, 1.5, p.z, 12, [1, 0.4, 0.2], 8);
    if (p.shields <= 0) {
      p.shields = 0;
      p.alive = false;
      this._burst(p.x, 1.5, p.z, 60, [1, 0.5, 0.1], 18);
      this._burst(p.x, 2.5, p.z, 30, [1, 0.9, 0.6], 12);
      AudioSys.play('bigExplosion');
      AudioSys.setEngine(0);
      this.shake = 2;
      this.mode = 'dying';
      this.deathTimer = 2.2;
    }
  }

  _updatePickups(dt) {
    const p = this.player;
    // flags
    if (p.alive) {
      for (const f of this.flags) {
        if (f.taken) continue;
        if (dist2(p.x, p.z, f.x, f.z) < 3.4 * 3.4) {
          f.taken = true;
          this.score += 100 * this.level;
          this._burst(f.x, 2.5, f.z, 18, [0.3, 1, 0.5], 8);
          AudioSys.play('flag');
          this.hud.pickup();
          const left = this.flagsLeft();
          this.hud.message(left > 0 ? `FLAG SECURED — ${left} LEFT` : 'ALL FLAGS SECURED', '#3cff78', 1.6);
        }
      }
      // powerups
      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const u = this.powerups[i];
        if (dist2(p.x, p.z, u.x, u.z) < 3.2 * 3.2) {
          this.powerups.splice(i, 1);
          this._applyPowerup(u.type);
        }
      }
    }
    for (const u of this.powerups) {
      u.spin += dt * 2.5;
      u.bob += dt * 3;
    }
  }

  _applyPowerup(type) {
    const p = this.player;
    const spec = POWERUP_TYPES[type];
    switch (type) {
      case 'ammo':   p.ammo = Math.min(p.maxAmmo, p.ammo + 18); break;
      case 'shield': p.shields = Math.min(p.maxShields, p.shields + 35); break;
      case 'overdrive': p.fx.overdrive = 10; break;
      case 'rapid':     p.fx.rapid = 10; break;
    }
    this.score += 50;
    AudioSys.play('powerup');
    this.hud.pickup();
    this.hud.message(spec.label, '#ffd24a', 1.4);
  }

  _burst(x, y, z, n, color, power) {
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
    const p = this.player;
    this.levelBonus = this.level * 250 +
      Math.round(p.shields) * 3 +
      p.ammo * 5 +
      this.killsThisLevel * 50;
    this.score += this.levelBonus;
    this.mode = 'levelclear';
    AudioSys.play('levelClear');
    AudioSys.setEngine(0);
  }

  nextLevel() {
    const p = this.player;
    this.level++;
    // partial resupply between sectors
    p.shields = Math.min(p.maxShields, p.shields + p.maxShields * 0.4);
    p.ammo = Math.min(p.maxAmmo, p.ammo + Math.round(p.maxAmmo * 0.6));
    this.startLevel();
  }

  /* during 'dying': keep simulating particles & enemies for drama */
  updateDying(dt) {
    this.deathTimer -= dt;
    this.shake = Math.max(0, this.shake - dt * 1.2);
    this._updateParticles(dt);
    this._updateProjectiles(dt);
    for (const f of this.flags) f.spin += dt * 2.2;
    if (this.deathTimer <= 0) {
      this.mode = 'gameover';
      AudioSys.play('gameOver');
    }
  }
}
