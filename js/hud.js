/* 2D canvas HUD: radar, shield/ammo readouts, messages, crosshair, damage flash. */

// css colors matching the lobby roster dots (PLAYER_TINTS by colorIdx)
const PLAYER_HEX = ['#4fd6bb', '#b07bd6', '#e8c75a', '#6fc7e8'];

/* Radar blip color per enemy type. Everyone gets distinct SHAPES; the
 * colorblind setting additionally splits the hues (deuteranopia-safe). */
const CB_BLIP_COLORS = {
  drone: '#ff8c1a', hunter: '#ffe84a', sniper: '#4a90ff', phantom: '#e8f4ff',
  rusher: '#ff5ac8', shellback: '#c9d4e0', warden: '#ffd24a',
};
function enemyBlipColor(type) {
  const cb = typeof Settings !== 'undefined' && Settings.get('colorblind');
  if (!cb) {
    if (type === 'rusher') return '#ff7ab0';
    if (type === 'warden') return '#ffd24a';
    return '#ff4a3c';
  }
  return CB_BLIP_COLORS[type] || '#ff8c1a';
}

class HUD {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.messages = []; // {text, t, dur, color}
    this.pops = [];     // floating score popups {text, t}
    this.flash = 0;     // red damage flash 0..1
    this.pickupFlash = 0;
    this.recordScore = 0; // the score being chased (high score / daily best);
                          // main.js arms it per run, score goes gold past it
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
      // the gradient shape only depends on the canvas size — rebuild on
      // resize, fade via globalAlpha instead of re-baking per frame
      if (!this._flashGrad || this._flashW !== W || this._flashH !== H) {
        const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.75);
        g.addColorStop(0, 'rgba(255,40,30,0)');
        g.addColorStop(1, 'rgba(255,40,30,0.45)');
        this._flashGrad = g;
        this._flashW = W; this._flashH = H;
      }
      ctx.globalAlpha = this.flash;
      ctx.fillStyle = this._flashGrad;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
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
      mine:  '#ff7ab0',
      vent:  '#e8c75a',
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
      // vent wears the heat gauge on its rim — tap when it's climbing
      if (b.key === 'vent' && p && p.maxHeat) {
        const frac = Math.max(0, Math.min(1, (p.heat || 0) / p.maxHeat));
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
        const label = b.key === 'nade' && p ? `NADE ${p.nades || 0}`
          : b.key === 'mine' && p ? `MINE ${p.mines || 0}` : b.label;
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

    // versus: live scoreboard under the radar
    if (game.versus) {
      const rows = game.players
        .map((p) => ({ name: p.name || '?', kills: (game.killCounts || {})[p.id] || 0, ci: p.colorIdx || 0 }))
        .sort((a, bb) => bb.kills - a.kills);
      ctx.font = font(11, true);
      ctx.fillStyle = '#ffd24a';
      ctx.fillText('FIRST TO ' + (game.killTarget || 10), W / 2, topY + 14 * s);
      ctx.font = font(12, true);
      rows.forEach((r, i) => {
        const y = topY + (30 + i * 16) * s;
        ctx.fillStyle = PLAYER_HEX[r.ci] || PLAYER_HEX[0];
        ctx.textAlign = 'right';
        ctx.fillText(r.name, W / 2 + 40 * s, y);
        ctx.textAlign = 'left';
        ctx.fillText(String(r.kills), W / 2 + 52 * s, y);
      });
      ctx.textAlign = 'center';
      return;
    }

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

    // stealth status under the dish: the whole pivot in one line — are you
    // a ghost, a rumor, or the thing every hull in the sector is hunting
    {
      const t2 = performance.now() / 1000;
      let label, col;
      if ((game.alarmT || 0) > 0) {
        label = game.exit ? 'GET TO THE GATE' : 'ALARM — GRID HUNTING';
        col = Math.sin(t2 * 9) > -0.2 ? '#ff4a3c' : '#8a2a20';
      } else if (game.suspicion) {
        label = 'PATROLS SUSPICIOUS';
        col = '#ffd24a';
      } else {
        label = 'UNDETECTED';
        col = 'rgba(79,214,187,0.75)';
      }
      ctx.font = font(11, true);
      ctx.fillStyle = col;
      ctx.fillText(label, W / 2, topY + 14 * s);
    }

    // sector bounty, live under the dish
    if (game.bounty) {
      const b = game.bounty;
      ctx.font = font(10, true);
      ctx.fillStyle = b.paid ? '#3cff78' : '#e8c75a';
      ctx.fillText(
        b.paid ? '✓ BOUNTY PAID' : 'BOUNTY: ' + b.name + '  ' + b.prog + '/' + b.n,
        W / 2, topY + 30 * s);
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
    const frac = Math.max(0, Math.min(1, (game.comboT || 0) / (game.comboWin || 4)));
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

    // sweep — one cached angle-0 gradient at the origin, rotated into place
    // (conic gradients are radius-independent, so it survives resizes too)
    if (this._sweepGrad === undefined) {
      if (ctx.createConicGradient) {
        const grad = ctx.createConicGradient(0, 0, 0);
        grad.addColorStop(0, 'rgba(79,214,187,0.30)');
        grad.addColorStop(0.12, 'rgba(79,214,187,0)');
        grad.addColorStop(1, 'rgba(79,214,187,0)');
        this._sweepGrad = grad;
      } else {
        this._sweepGrad = null;
      }
    }
    if (this._sweepGrad) {
      const sweepA = (performance.now() / 1000 * 1.6) % (Math.PI * 2);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(sweepA);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fillStyle = this._sweepGrad;
      ctx.fill();
      ctx.restore();
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
      // live capture: a progress arc sweeps around the zone blip
      if ((f.cap || 0) > 0.01) {
        ctx.strokeStyle = '#3cff78';
        ctx.lineWidth = Math.max(1, 1.4 * s);
        ctx.beginPath();
        ctx.arc(bx, by, 5.5 * s, -Math.PI / 2, -Math.PI / 2 + f.cap * Math.PI * 2);
        ctx.stroke();
      }
    }

    // extraction gate: an ice-white diamond, pinned to the rim like a beacon
    if (game.exit) {
      let [bx, by] = toRadar(game.exit.x, game.exit.z);
      const dx = bx - cx, dy = by - cy;
      const d = Math.hypot(dx, dy);
      if (d > R - 7 * s) {
        bx = cx + (dx / d) * (R - 7 * s);
        by = cy + (dy / d) * (R - 7 * s);
      }
      const er = (4.5 + Math.sin(t * 7) * 1.1) * s;
      ctx.fillStyle = '#d8f4ff';
      ctx.beginPath();
      ctx.moveTo(bx, by - er);
      ctx.lineTo(bx + er, by);
      ctx.lineTo(bx, by + er);
      ctx.lineTo(bx - er, by);
      ctx.closePath();
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
      ctx.strokeStyle = d.type === 'coolant' ? '#e8c75a' : '#4dff9e';
      ctx.strokeRect(bx - 3 * s, by - 3 * s, 6 * s, 6 * s);
    }

    // own squad's mines: tiny hot dots
    ctx.fillStyle = '#ff7ab0';
    for (const m of (game.mines || [])) {
      const [bx, by] = toRadar(m.x, m.z);
      ctx.fillRect(bx - 1.2 * s, by - 1.2 * s, 2.4 * s, 2.4 * s);
    }

    // other tanks (teammates in co-op, prey in versus) in their hull color
    for (const pl of game.players || []) {
      if (pl === p || !pl.alive) continue;
      let [bx, by] = toRadar(pl.x, pl.z);
      const dx = bx - cx, dy = by - cy;
      const dd = Math.hypot(dx, dy);
      if (dd > R - 5 * s) { bx = cx + (dx / dd) * (R - 5 * s); by = cy + (dy / dd) * (R - 5 * s); }
      ctx.fillStyle = PLAYER_HEX[pl.colorIdx] || PLAYER_HEX[0];
      ctx.beginPath();
      ctx.moveTo(bx, by - 3.4 * s);
      ctx.lineTo(bx - 2.8 * s, by + 2.8 * s);
      ctx.lineTo(bx + 2.8 * s, by + 2.8 * s);
      ctx.closePath();
      ctx.fill();
    }

    // hostiles: one shape per type so silhouettes carry the info, not just
    // hue — and awareness carries in brightness: dim = blind patrol,
    // half-lit = investigating, full = it knows you're here
    for (const e of game.enemies) {
      if (e.cloak > 0.6) continue; // cloaked phantoms hide from radar too
      const [bx, by] = toRadar(e.x, e.z);
      const r = 3.2 * s;
      ctx.globalAlpha = e.alerted ? 1 : ((e.sense || 0) >= 0.4 ? 0.8 : 0.42);
      ctx.fillStyle = enemyBlipColor(e.type);
      ctx.beginPath();
      if (e.type === 'hunter') {
        ctx.moveTo(bx, by - r); ctx.lineTo(bx - r, by + r); ctx.lineTo(bx + r, by + r);
        ctx.closePath(); ctx.fill();
      } else if (e.type === 'sniper') {
        ctx.fillRect(bx - r * 0.9, by - r * 0.9, r * 1.8, r * 1.8);
      } else if (e.type === 'phantom') {
        ctx.moveTo(bx, by - r); ctx.lineTo(bx + r, by); ctx.lineTo(bx, by + r); ctx.lineTo(bx - r, by);
        ctx.closePath(); ctx.fill();
      } else if (e.type === 'rusher') {
        // rushers read as a hot cross — small, fast, urgent
        const rr = r * 0.95;
        ctx.fillRect(bx - rr, by - 1.1 * s, rr * 2, 2.2 * s);
        ctx.fillRect(bx - 1.1 * s, by - rr, 2.2 * s, rr * 2);
      } else if (e.type === 'shellback') {
        // hollow square = armored front, crack it from behind
        ctx.strokeStyle = enemyBlipColor(e.type);
        ctx.lineWidth = Math.max(1, 1.4 * s);
        ctx.strokeRect(bx - r, by - r, r * 2, r * 2);
      } else if (e.type === 'warden') {
        // dot inside a ring = the umbrella carrier — priority target
        ctx.arc(bx, by, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = enemyBlipColor(e.type);
        ctx.lineWidth = Math.max(1, 1.2 * s);
        ctx.beginPath();
        ctx.arc(bx, by, r + 1.6 * s, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fill();
      }
      if (e.elite) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1, s);
        ctx.beginPath();
        ctx.arc(bx, by, r + 2.2 * s, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

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

    // SIGNATURE: how loud you read on enemy sensors — speed, heat and boost
    // all feed it. Keep it low and patrols have to nearly touch you.
    if (!game.versus && p.sig != null) {
      const sg01 = Math.max(0, Math.min(1, p.sig));
      const gy = by - 56 * s, gh = 5 * s;
      const sigCol = sg01 > 0.75 ? '#ff6a5a' : sg01 > 0.45 ? '#ffd24a' : '#4fd6bb';
      ctx.font = font(10, true);
      ctx.fillStyle = sigCol;
      ctx.fillText('SIGNATURE', bx, gy - 7 * s);
      ctx.strokeStyle = 'rgba(79,214,187,0.5)';
      ctx.strokeRect(bx, gy, bw * 0.7, gh);
      ctx.fillStyle = sigCol;
      ctx.fillRect(bx + s, gy + s, (bw * 0.7 - 2 * s) * sg01, gh - 2 * s);
    }

    // heat gauge: the cannon's whole economy in one bar — redline ticks at
    // 55/85, a sweeping marker plus perfect-window band while venting
    const ay = by - 84 * s;
    const heat01 = Math.max(0, Math.min(1, (p.heat || 0) / (p.maxHeat || 100)));
    const overheated = (p.overheatT || 0) > 0;
    const heatCol = overheated ? '#ff4a3c' : heat01 > 0.85 ? '#ff6a3c' : heat01 > 0.55 ? '#ffd24a' : '#4fd6bb';
    let heatLabel = 'HEAT';
    if (overheated) heatLabel = 'OVERHEAT';
    else if ((p.venting || 0) > 0) heatLabel = 'VENTING — TAP AGAIN IN THE BAND';
    else if ((p.superShots || 0) > 0) heatLabel = 'SUPERCHARGED ×' + p.superShots;
    ctx.font = font(13, true);
    ctx.fillStyle = (p.superShots > 0 && !overheated) ? '#4fd6bb' : heatCol;
    ctx.fillText(heatLabel, bx, ay - 12 * s);
    const hw = bw, hh = 10 * s;
    ctx.strokeStyle = 'rgba(79,214,187,0.7)';
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(bx, ay, hw, hh);
    if (!overheated || Math.sin(performance.now() / 90) > -0.3) {
      ctx.fillStyle = heatCol;
      ctx.fillRect(bx + s, ay + s, (hw - 2 * s) * heat01, hh - 2 * s);
    }
    ctx.fillStyle = 'rgba(255,210,74,0.7)';
    ctx.fillRect(bx + hw * 0.55, ay - 2 * s, s, hh + 4 * s);
    ctx.fillStyle = 'rgba(255,90,60,0.8)';
    ctx.fillRect(bx + hw * 0.85, ay - 2 * s, s, hh + 4 * s);
    if ((p.venting || 0) > 0) {
      const widen = p.ventWiden != null ? p.ventWiden : (((p.up || {}).vent || 0) * 0.1);
      const w0 = VENT_WIN[0] / VENT_TIME, w1 = (VENT_WIN[1] + widen) / VENT_TIME;
      ctx.fillStyle = 'rgba(79,214,187,0.4)';
      ctx.fillRect(bx + hw * w0, ay, hw * (w1 - w0), hh);
      const mx = bx + hw * Math.min(1, p.venting / VENT_TIME);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(mx - s, ay - 3 * s, 2 * s, hh + 6 * s);
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

    // mine triangles beside the grenades
    if (p.maxMines) {
      const my = ay - 34 * s;
      // sit past the widest possible nade row — BANDOLIER stacks push
      // maxNades beyond the 6 the old fixed offset assumed
      const mx = bx + 78 * s + Math.max(p.maxNades || 0, 6) * 18 * s + 22 * s;
      ctx.font = font(13, true);
      ctx.fillStyle = 'rgba(255,122,176,0.9)';
      ctx.fillText('MINES', mx, my - 2 * s);
      for (let i = 0; i < p.maxMines; i++) {
        const cx2 = mx + 78 * s + i * 16 * s, cy2 = my - 2 * s;
        const r = 5 * s;
        ctx.beginPath();
        ctx.moveTo(cx2, cy2 - r);
        ctx.lineTo(cx2 + r, cy2 + r);
        ctx.lineTo(cx2 - r, cy2 + r);
        ctx.closePath();
        if (i < (p.mines || 0)) { ctx.fillStyle = '#ff7ab0'; ctx.fill(); }
        else { ctx.strokeStyle = 'rgba(255,122,176,0.3)'; ctx.lineWidth = Math.max(1, s); ctx.stroke(); }
      }
    }

    // ---- bottom-right: score / level / flags
    ctx.textAlign = 'right';
    ctx.font = font(16, true);
    const onRecord = this.recordScore > 0 && game.score > this.recordScore && !game.versus;
    if (onRecord) {
      ctx.fillStyle = '#ffd24a';
      ctx.shadowColor = '#ffd24a';
      ctx.shadowBlur = 10;
    } else {
      ctx.fillStyle = '#4fd6bb';
    }
    ctx.fillText('SCORE ' + String(game.score).padStart(7, '0'), W - pad, H - pad - 64 * s);
    ctx.shadowBlur = 0;
    // the unbanked pot: kill score riding on the line until a zone banks it
    if (!game.versus && (game.pot || 0) > 0) {
      const pp = 1 + 0.05 * Math.sin(performance.now() / 140);
      ctx.font = `bold ${Math.round(13 * s * pp)}px "Courier New", monospace`;
      ctx.fillStyle = '#ffd24a';
      ctx.fillText('POT +' + game.pot, W - pad, H - pad - 102 * s);
      ctx.font = font(16, true);
    }
    if (onRecord) {
      ctx.font = font(10, true);
      ctx.fillStyle = '#ffd24a';
      ctx.fillText('★ RECORD PACE', W - pad, H - pad - 84 * s);
      ctx.font = font(16, true);
    }
    ctx.font = font(14, false);
    ctx.fillText('SECTOR ' + game.level, W - pad, H - pad - 38 * s);
    if (game.versus) {
      const k = (game.killCounts || {})[p.id] || 0;
      ctx.fillStyle = '#ffd24a';
      ctx.fillText('KILLS ' + k + '/' + (game.killTarget || 10), W - pad, H - pad - 12 * s);
    } else if (game.bossLevel) {
      const bossUp = game.boss && !game.boss.dead;
      ctx.fillStyle = bossUp ? '#ff4a3c' : '#e8c75a';
      ctx.fillText(bossUp ? 'TARGET WARLORD' : 'TARGET DOWN', W - pad, H - pad - 12 * s);
    } else if (game.exit) {
      const pp = Math.sin(performance.now() / 160) > -0.3;
      ctx.fillStyle = pp ? '#d8f4ff' : '#7fb4c9';
      ctx.fillText('EXTRACT ▸', W - pad, H - pad - 12 * s);
    } else {
      const fl = game.flagsLeft();
      ctx.fillStyle = fl > 0 ? '#3cff78' : '#e8c75a';
      ctx.fillText('ZONES ' + fl, W - pad, H - pad - 12 * s);
    }

    // ---- TECH progress toward the next upgrade draft
    if (!game.versus && p.techLvl != null) {
      const t01 = Math.max(0, Math.min(1, p.tech01 || 0));
      const tw = 120 * s, th = 5 * s;
      const tx = W - pad - tw, ty = H - pad - 124 * s;
      ctx.font = font(10, true);
      ctx.fillStyle = '#e8c75a';
      ctx.fillText('TECH ' + (p.techLvl + 1), W - pad, ty - 8 * s);
      ctx.strokeStyle = 'rgba(232,199,90,0.5)';
      ctx.lineWidth = Math.max(1, s);
      ctx.strokeRect(tx, ty, tw, th);
      ctx.fillStyle = '#e8c75a';
      ctx.fillRect(tx + s, ty + s, (tw - 2 * s) * t01, th - 2 * s);
    }

    // ---- active effects
    let ey = H - pad - 148 * s;
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
