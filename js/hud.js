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

  damage(amount01) {
    this.flash = Math.min(1, this.flash + amount01);
    if (typeof Input !== 'undefined') Input.vibrate(45);
  }
  pickup() {
    this.pickupFlash = 0.5;
    if (typeof Input !== 'undefined') Input.vibrate(12);
  }

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
    this._objective(ctx, W, H, s, game);
    this._combo(ctx, W, H, s, game);
    this._scorePops(ctx, W, H, s, dt);
    this._touchControls(ctx, game);
    this._renderMessages(ctx, W, H, s, dt);
  }

  /* On-screen touch controls: floating stick + fire/nade/boost/cam/pause.
   * Input owns the layout and live state (CSS px); this just draws it in the
   * phosphor style so the controls read as part of the cockpit. */
  _touchControls(ctx, game) {
    if (typeof Input === 'undefined') return;
    const ui = Input.touchUI();
    if (!ui.mode || !ui.enabled) return;
    const d = this.dpr || 1;
    const p = game.player;
    const font = (px, bold) => `${bold ? 'bold ' : ''}${Math.round(px * d)}px "Courier New", monospace`;

    ctx.save();
    ctx.lineWidth = Math.max(1, 1.5 * d);

    // ---- movement stick (or its idle ghost)
    const st = ui.stick;
    if (st.id !== null) {
      const bx = st.baseX * d, by = st.baseY * d, R = ui.stickMax * d;
      ctx.strokeStyle = 'rgba(79,214,187,0.55)';
      ctx.beginPath(); ctx.arc(bx, by, R, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(79,214,187,0.2)';
      ctx.beginPath(); ctx.arc(bx, by, R * 0.45, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(79,214,187,0.75)';
      ctx.shadowColor = '#4fd6bb';
      ctx.shadowBlur = 12 * d;
      ctx.beginPath(); ctx.arc(bx + st.dx * d, by + st.dy * d, 26 * d, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = '#4fd6bb';
      ctx.setLineDash([6 * d, 6 * d]);
      ctx.beginPath(); ctx.arc(ui.restX * d, ui.restY * d, 44 * d, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#4fd6bb';
      ctx.textAlign = 'center';
      ctx.font = font(11, true);
      ctx.fillText('MOVE', ui.restX * d, ui.restY * d);
      ctx.globalAlpha = 1;
    }

    // ---- buttons
    const COLORS = {
      fire:  '#ff6a5a',
      nade:  '#8cff6e',
      boost: '#6fc7e8',
      cam:   '#4fd6bb',
      pause: '#4fd6bb',
    };
    for (const b of ui.buttons) {
      const bx = b.x * d, by = b.y * d, r = b.r * d;
      const col = COLORS[b.key] || '#4fd6bb';
      const held = b.id !== null;
      ctx.globalAlpha = held ? 0.95 : 0.55;
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.stroke();
      if (held) {
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.95;
      }
      // boost shows its gauge as a sweeping arc around the rim
      if (b.key === 'boost' && p && p.maxBoost) {
        const frac = Math.max(0, Math.min(1, p.boost / p.maxBoost));
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = Math.max(1, 3 * d);
        ctx.beginPath();
        ctx.arc(bx, by, r - 4 * d, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = Math.max(1, 1.5 * d);
      }
      ctx.fillStyle = col;
      ctx.textAlign = 'center';
      if (b.key === 'pause') {
        // two bars beat a font glyph at this size
        const bw = 3.5 * d, bh = 12 * d;
        ctx.fillRect(bx - 4.5 * d, by - bh / 2, bw, bh);
        ctx.fillRect(bx + 1 * d, by - bh / 2, bw, bh);
      } else {
        const label = b.key === 'nade' && p ? `NADE ${p.nades || 0}` : b.label;
        ctx.font = font(b.key === 'fire' ? 13 : 10, true);
        ctx.fillText(label, bx, by);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /* Below the radar: the WARLORD health bar on boss sectors, or the sector
   * alert meter once flags start falling. */
  _objective(ctx, W, H, s, game) {
    const b = game.boss;
    const font = (px, bold) => `${bold ? 'bold ' : ''}${Math.round(px * s)}px "Courier New", monospace`;
    const topY = (74 * 2 + 18) * s;   // just under the radar dish
    ctx.textAlign = 'center';

    if (b && !b.dead) {
      const bw = 320 * s, bh = 11 * s;
      const bx = W / 2 - bw / 2, by = topY + 24 * s;
      ctx.font = font(14, true);
      ctx.fillStyle = '#ff4a3c';
      ctx.shadowColor = '#ff4a3c';
      ctx.shadowBlur = 8;
      ctx.fillText(b.vulnerable ? 'WARLORD — CORE EXPOSED' : 'WARLORD', W / 2, by - 10 * s);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,74,60,0.8)';
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(bx, by, bw, bh);
      const frac = Math.max(0, b.coreHp / b.coreMax);
      ctx.fillStyle = b.vulnerable ? '#ff4a3c' : 'rgba(255,74,60,0.35)';
      ctx.fillRect(bx + 2 * s, by + 2 * s, (bw - 4 * s) * frac, bh - 4 * s);
      if (!b.vulnerable) {
        // shielded phase: show the turrets that still guard the core
        ctx.font = font(11, true);
        ctx.fillStyle = '#ffd24a';
        ctx.fillText('DESTROY THE TURRETS', W / 2, by + bh + 12 * s);
        const alive = b.turrets.filter((t) => t.hp > 0).length;
        const pw = 14 * s, gap = 6 * s;
        const total = b.turrets.length;
        let px = W / 2 - (total * pw + (total - 1) * gap) / 2;
        for (let i = 0; i < total; i++) {
          ctx.fillStyle = i < alive ? '#ff9d4a' : 'rgba(255,157,74,0.18)';
          ctx.fillRect(px, by + bh + 18 * s, pw, 5 * s);
          px += pw + gap;
        }
      }
      return;
    }

    if (game.alert > 0 && game.flagsLeft() > 0) {
      const aw = 110 * s, ah = 5 * s;
      const ax = W / 2 - aw / 2, ay = topY + 16 * s;
      const a01 = Math.min(1, game.alert);
      const r = Math.round(120 + a01 * 135), g = Math.round(200 - a01 * 130);
      ctx.font = font(10, true);
      ctx.fillStyle = `rgba(${r},${g},80,0.9)`;
      ctx.fillText('ALERT', W / 2, ay - 7 * s);
      ctx.strokeStyle = `rgba(${r},${g},80,0.6)`;
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(ax, ay, aw, ah);
      ctx.fillStyle = `rgb(${r},${g},80)`;
      ctx.fillRect(ax + s, ay + s, (aw - 2 * s) * a01, ah - 2 * s);
    }
  }

  /* Kill-chain multiplier under the crosshair, with its decay timer. */
  _combo(ctx, W, H, s, game) {
    if (!game.mult || game.mult <= 1) return;
    const t = performance.now() / 1000;
    const y = H / 2 + 74 * s;
    const pulse = 1 + 0.06 * Math.sin(t * 10);
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(34 * s * pulse)}px "Courier New", monospace`;
    ctx.fillStyle = '#ffd24a';
    ctx.shadowColor = '#ffd24a';
    ctx.shadowBlur = 16;
    ctx.fillText('×' + game.mult, W / 2, y);
    ctx.shadowBlur = 0;
    const frac = Math.max(0, Math.min(1, (game.comboT || 0) / 4));
    const bw = 100 * s, bh = 4 * s;
    ctx.fillStyle = 'rgba(232,199,90,0.25)';
    ctx.fillRect(W / 2 - bw / 2, y + 16 * s, bw, bh);
    ctx.fillStyle = '#e8c75a';
    ctx.fillRect(W / 2 - bw / 2, y + 16 * s, bw * frac, bh);
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
      if (o.dead) continue;
      const [bx, by] = toRadar(o.x, o.z);
      ctx.fillRect(bx - 1.5 * s, by - 1.5 * s, 3 * s, 3 * s);
    }

    const flagPulse = 0.6 + 0.4 * Math.sin(t * 5);
    const beaconOn = game.flagsLeft() <= 2;   // last flags: clamp to the rim
    ctx.fillStyle = `rgba(60,255,120,${flagPulse})`;
    for (const f of game.flags) {
      if (f.taken) continue;
      let [bx, by] = toRadar(f.x, f.z);
      const dx = bx - cx, dy = by - cy;
      const d = Math.hypot(dx, dy);
      if (d > R - 5 * s) {
        if (!beaconOn) continue;   // out of range and no beacon yet
        // pin an arrowhead on the rim pointing at the flag
        const nx = dx / d, ny = dy / d;
        const px2 = cx + nx * (R - 6 * s), py2 = cy + ny * (R - 6 * s);
        ctx.beginPath();
        ctx.moveTo(px2 + nx * 5 * s, py2 + ny * 5 * s);
        ctx.lineTo(px2 - ny * 4 * s, py2 + nx * 4 * s);
        ctx.lineTo(px2 + ny * 4 * s, py2 - nx * 4 * s);
        ctx.closePath();
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.arc(bx, by, 3 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    // the WARLORD: a big pulsing diamond, pinned to the rim when out of range
    if (game.boss && !game.boss.dead) {
      const b = game.boss;
      let [bx, by] = toRadar(b.x, b.z);
      const dx = bx - cx, dy = by - cy;
      const d = Math.hypot(dx, dy);
      if (d > R - 7 * s) {
        bx = cx + (dx / d) * (R - 7 * s);
        by = cy + (dy / d) * (R - 7 * s);
      }
      const br = (5.5 + Math.sin(t * 6) * 1.2) * s;
      ctx.fillStyle = '#ff4a3c';
      ctx.beginPath();
      ctx.moveTo(bx, by - br);
      ctx.lineTo(bx + br, by);
      ctx.lineTo(bx, by + br);
      ctx.lineTo(bx - br, by);
      ctx.closePath();
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
    if (game.bossLevel) {
      const bossUp = game.boss && !game.boss.dead;
      ctx.fillStyle = bossUp ? '#ff4a3c' : '#e8c75a';
      ctx.fillText(bossUp ? 'TARGET WARLORD' : 'TARGET DOWN', W - pad, H - pad - 12 * s);
    } else {
      const fl = game.flagsLeft();
      ctx.fillStyle = fl > 0 ? '#3cff78' : '#e8c75a';
      ctx.fillText('FLAGS ' + fl, W - pad, H - pad - 12 * s);
    }

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
