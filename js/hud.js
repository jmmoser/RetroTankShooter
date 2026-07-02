/* 2D canvas HUD: radar, shield/ammo readouts, messages, crosshair, damage flash. */
class HUD {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.messages = []; // {text, t, dur, color}
    this.pops = [];     // floating score popups {text, t}
    this.flash = 0;     // red damage flash 0..1
    this.pickupFlash = 0;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  message(text, color = '#4fd6bb', dur = 2.2) {
    this.messages.push({ text, t: 0, dur, color });
    if (this.messages.length > 3) this.messages.shift();
  }

  damage(amount01) { this.flash = Math.min(1, this.flash + amount01); }
  pickup() { this.pickupFlash = 0.5; }

  scorePop(text) {
    this.pops.push({ text, t: 0 });
    if (this.pops.length > 5) this.pops.shift();
  }

  clear() {
    this.resize();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /* game: Game instance; dt seconds */
  render(game, dt) {
    this.clear();
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const s = Math.min(W, H) / 720; // ui scale
    ctx.textBaseline = 'middle';

    this.flash = Math.max(0, this.flash - dt * 1.8);
    this.pickupFlash = Math.max(0, this.pickupFlash - dt * 1.5);

    if (this.flash > 0) {
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.75);
      g.addColorStop(0, 'rgba(255,40,30,0)');
      g.addColorStop(1, `rgba(255,40,30,${0.45 * this.flash})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    if (this.pickupFlash > 0) {
      ctx.fillStyle = `rgba(79,214,187,${0.12 * this.pickupFlash})`;
      ctx.fillRect(0, 0, W, H);
    }

    if (!game || game.mode !== 'playing') { this._renderMessages(ctx, W, H, s, dt); return; }

    this._crosshair(ctx, W, H, s);
    this._radar(ctx, W, H, s, game);
    this._bars(ctx, W, H, s, game);
    this._scorePops(ctx, W, H, s, dt);
    this._renderMessages(ctx, W, H, s, dt);
  }

  _scorePops(ctx, W, H, s, dt) {
    ctx.textAlign = 'left';
    ctx.font = `bold ${Math.round(15 * s)}px "Courier New", monospace`;
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.t += dt;
      if (p.t > 1.1) { this.pops.splice(i, 1); continue; }
      const a = Math.min(1, (1.1 - p.t) / 0.4);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#e8c75a';
      ctx.fillText(p.text, W / 2 + 34 * s, H / 2 - 20 * s - p.t * 42 * s - i * 18 * s);
      ctx.globalAlpha = 1;
    }
  }

  _crosshair(ctx, W, H, s) {
    const cx = W / 2, cy = H / 2;
    const r = 14 * s;
    ctx.strokeStyle = 'rgba(79,214,187,0.85)';
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(cx + dx * r * 0.4, cy + dy * r * 0.4);
      ctx.lineTo(cx + dx * r, cy + dy * r);
    }
    ctx.stroke();
  }

  _radar(ctx, W, H, s, game) {
    const R = 74 * s;
    const cx = W / 2, cy = R + 18 * s;
    const range = 95;
    const p = game.player;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(5,18,14,0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,214,187,0.8)';
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(79,214,187,0.25)';
    ctx.stroke();

    // sweep
    const sweepA = (performance.now() / 1000 * 1.6) % (Math.PI * 2);
    const grad = ctx.createConicGradient
      ? ctx.createConicGradient(sweepA, cx, cy)
      : null;
    if (grad) {
      grad.addColorStop(0, 'rgba(79,214,187,0.30)');
      grad.addColorStop(0.12, 'rgba(79,214,187,0)');
      grad.addColorStop(1, 'rgba(79,214,187,0)');
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // clip blips to the dish
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    // rotate so "up" is the player's heading
    const toRadar = (x, z) => {
      const dx = x - p.x, dz = z - p.z;
      const ca = Math.cos(p.angle), sa = Math.sin(p.angle);
      // world->local: inverse rotation; forward(-Z local) should map up
      const lx = dx * ca - dz * sa;
      const lz = dx * sa + dz * ca;
      return [cx + (lx / range) * R, cy + (lz / range) * R];
    };

    const t = performance.now() / 1000;

    ctx.fillStyle = 'rgba(60,110,95,0.8)';
    for (const o of game.obstacles) {
      const [bx, by] = toRadar(o.x, o.z);
      ctx.fillRect(bx - 1.5 * s, by - 1.5 * s, 3 * s, 3 * s);
    }

    const flagPulse = 0.6 + 0.4 * Math.sin(t * 5);
    ctx.fillStyle = `rgba(60,255,120,${flagPulse})`;
    for (const f of game.flags) {
      if (f.taken) continue;
      const [bx, by] = toRadar(f.x, f.z);
      ctx.beginPath();
      ctx.arc(bx, by, 3 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#ffd24a';
    for (const u of game.powerups) {
      const [bx, by] = toRadar(u.x, u.z);
      ctx.fillRect(bx - 2 * s, by - 2 * s, 4 * s, 4 * s);
    }

    // resupply depots: hollow squares in their pad color
    ctx.lineWidth = Math.max(1, 1.4 * s);
    for (const d of (game.depots || [])) {
      const [bx, by] = toRadar(d.x, d.z);
      ctx.strokeStyle = d.type === 'ammo' ? '#e8c75a' : '#4dff9e';
      ctx.strokeRect(bx - 3 * s, by - 3 * s, 6 * s, 6 * s);
    }

    ctx.fillStyle = '#ff4a3c';
    for (const e of game.enemies) {
      if (e.cloak > 0.6) continue; // cloaked phantoms hide from radar too
      const [bx, by] = toRadar(e.x, e.z);
      ctx.beginPath();
      ctx.arc(bx, by, 3.2 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    // player wedge at center
    ctx.fillStyle = '#4fd6bb';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5 * s);
    ctx.lineTo(cx - 3.5 * s, cy + 4 * s);
    ctx.lineTo(cx + 3.5 * s, cy + 4 * s);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _bars(ctx, W, H, s, game) {
    const p = game.player;
    const pad = 18 * s;
    const font = (px, bold) => `${bold ? 'bold ' : ''}${Math.round(px * s)}px "Courier New", monospace`;

    // ---- bottom-left: shields + ammo
    const bw = 240 * s, bh = 14 * s;
    const bx = pad, by = H - pad - bh;
    const sh01 = Math.max(0, p.shields / p.maxShields);
    ctx.font = font(13, true);
    ctx.fillStyle = 'rgba(79,214,187,0.9)';
    ctx.textAlign = 'left';
    ctx.fillText('SHIELDS', bx, by - 14 * s);
    ctx.strokeStyle = 'rgba(79,214,187,0.7)';
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(bx, by, bw, bh);
    const shCol = sh01 > 0.5 ? '#4fd6bb' : sh01 > 0.25 ? '#ffd24a' : '#ff4a3c';
    ctx.fillStyle = shCol;
    if (sh01 > 0.25 || Math.sin(performance.now() / 90) > -0.3) {
      ctx.fillRect(bx + 2 * s, by + 2 * s, (bw - 4 * s) * sh01, bh - 4 * s);
    }

    // boost gauge just above the shields bar
    if (p.maxBoost) {
      const bo01 = Math.max(0, Math.min(1, p.boost / p.maxBoost));
      const gy = by - 32 * s, gh = 6 * s;
      ctx.font = font(11, true);
      ctx.fillStyle = 'rgba(111,199,232,0.9)';
      ctx.fillText('BOOST', bx, gy - 8 * s);
      ctx.strokeStyle = 'rgba(111,199,232,0.6)';
      ctx.strokeRect(bx, gy, bw * 0.7, gh);
      ctx.fillStyle = p.boosting ? '#bfeaff' : '#6fc7e8';
      ctx.fillRect(bx + s, gy + s, (bw * 0.7 - 2 * s) * bo01, gh - 2 * s);
    }

    // ammo pips
    const ay = by - 68 * s;
    ctx.font = font(13, true);
    ctx.fillStyle = 'rgba(79,214,187,0.9)';
    ctx.fillText('AMMO ' + p.ammo, bx, ay - 12 * s);
    const pipW = 7 * s, pipH = 10 * s, gap = 3 * s;
    const maxPips = 30;
    const pipsShown = Math.min(maxPips, p.maxAmmo);
    const perPip = p.maxAmmo / pipsShown;
    for (let i = 0; i < pipsShown; i++) {
      const filled = p.ammo >= (i + 1) * perPip - 0.001;
      ctx.fillStyle = filled ? '#e8c75a' : 'rgba(79,214,187,0.18)';
      ctx.fillRect(bx + i * (pipW + gap), ay, pipW, pipH);
    }

    // grenade diamonds under the ammo row
    if (p.maxNades) {
      const ny = ay - 34 * s;
      ctx.fillStyle = 'rgba(140,255,110,0.9)';
      ctx.fillText('NADES', bx, ny - 2 * s);
      for (let i = 0; i < p.maxNades; i++) {
        const cx2 = bx + 78 * s + i * 18 * s, cy2 = ny - 2 * s;
        const r = 5.5 * s;
        ctx.beginPath();
        ctx.moveTo(cx2, cy2 - r);
        ctx.lineTo(cx2 + r, cy2);
        ctx.lineTo(cx2, cy2 + r);
        ctx.lineTo(cx2 - r, cy2);
        ctx.closePath();
        if (i < (p.nades || 0)) { ctx.fillStyle = '#8cff6e'; ctx.fill(); }
        else { ctx.strokeStyle = 'rgba(140,255,110,0.3)'; ctx.lineWidth = Math.max(1, s); ctx.stroke(); }
      }
    }

    // ---- bottom-right: score / level / flags
    ctx.textAlign = 'right';
    ctx.font = font(16, true);
    ctx.fillStyle = '#4fd6bb';
    ctx.fillText('SCORE ' + String(game.score).padStart(7, '0'), W - pad, H - pad - 64 * s);
    ctx.font = font(14, false);
    ctx.fillText('SECTOR ' + game.level, W - pad, H - pad - 38 * s);
    const fl = game.flagsLeft();
    ctx.fillStyle = fl > 0 ? '#3cff78' : '#e8c75a';
    ctx.fillText('FLAGS ' + fl, W - pad, H - pad - 12 * s);

    // ---- active effects
    let ey = H - pad - 96 * s;
    ctx.font = font(12, true);
    if (p.fx.overdrive > 0) {
      ctx.fillStyle = '#ffd24a';
      ctx.fillText('OVERDRIVE ' + p.fx.overdrive.toFixed(0), W - pad, ey);
      ey -= 20 * s;
    }
    if (p.fx.rapid > 0) {
      ctx.fillStyle = '#ff9d4a';
      ctx.fillText('RAPID FIRE ' + p.fx.rapid.toFixed(0), W - pad, ey);
    }
  }

  _renderMessages(ctx, W, H, s, dt) {
    const font = (px) => `bold ${Math.round(px * s)}px "Courier New", monospace`;
    ctx.textAlign = 'center';
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      m.t += dt;
      if (m.t > m.dur) { this.messages.splice(i, 1); continue; }
      const a = Math.min(1, (m.dur - m.t) / 0.5) * Math.min(1, m.t / 0.1);
      ctx.font = font(26);
      ctx.globalAlpha = a;
      ctx.fillStyle = m.color;
      ctx.shadowColor = m.color;
      ctx.shadowBlur = 14;
      ctx.fillText(m.text, W / 2, H * 0.32 - i * 40 * s);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }
}
