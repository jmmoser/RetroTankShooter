/* Message hierarchy: the HUD funnels ~50 call sites, and if they all shout at
 * the same size in the same place the player reads none of them. */
const { check, assert } = require('./helpers');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
global.window = global;
global.Settings = { get: () => 1 };
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/hud.js'), 'utf8') + '\n;global.HUD = HUD;');

/* A canvas stand-in that records what was drawn where, at what size. */
function fakeCtx() {
  const draws = [];
  const ctx = {
    draws, font: '', fillStyle: '', strokeStyle: '', shadowColor: '', shadowBlur: 0,
    globalAlpha: 1, textAlign: '', textBaseline: '', lineWidth: 1, lineCap: '',
    fillText(t, x, y) { draws.push({ t, x, y, font: this.font, blur: this.shadowBlur, align: this.textAlign }); },
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {},
    fill() {}, fillRect() {}, strokeRect() {}, clip() {}, translate() {}, rotate() {},
    setLineDash() {}, closePath() {}, measureText: () => ({ width: 100 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createConicGradient: () => ({ addColorStop() {} }),
  };
  return ctx;
}
function newHud() {
  const h = new HUD({ getContext: () => fakeCtx(), clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 });
  h.resize = () => { h.dpr = 1; };
  return h;
}
const sizeOf = (f) => parseInt(/(\d+)px/.exec(f)[1], 10);

check('chatter never reaches the centre column', () => {
  const h = newHud();
  h.message('NO GRENADES', '#f00', 1.2, 'chatter');
  assert(h.messages.length === 0, 'chatter landed in the alert/info column');
  assert(h.chatter.length === 1, 'chatter went nowhere');
});

check('an alert outweighs an info line, which outweighs chatter', () => {
  const h = newHud();
  h.message('SPOTTED', '#f00', 2, 'alert');
  h.message('ZONE SECURED', '#0f0', 2);
  const ctx = fakeCtx();
  h._renderMessages(ctx, 1280, 720, 1, 1 / 60);
  const alert = ctx.draws.find((d) => d.t === 'SPOTTED');
  const info = ctx.draws.find((d) => d.t === 'ZONE SECURED');
  assert(sizeOf(alert.font) > sizeOf(info.font),
    'alert ' + sizeOf(alert.font) + 'px vs info ' + sizeOf(info.font) + 'px');
  assert(alert.blur > info.blur, 'alert is not lit brighter than info');

  const c = fakeCtx();
  h.message('SOUND ON', '#0ff', 1, 'chatter');
  h._renderChatter(c, 1280, 720, 1, 1 / 60);
  const chat = c.draws.find((d) => d.t === 'SOUND ON');
  assert(sizeOf(chat.font) < sizeOf(info.font), 'chatter is not smaller than info');
  assert(chat.blur === 0, 'chatter is glowing');
});

check('the column stacks away from the radar, not into it', () => {
  const h = newHud();
  h.message('FIRST', '#f00', 2, 'alert');
  h.message('SECOND', '#f00', 2, 'alert');
  h.message('THIRD', '#f00', 2, 'alert');
  const ctx = fakeCtx();
  h._renderMessages(ctx, 1280, 720, 1, 1 / 60);
  const y = ['FIRST', 'SECOND', 'THIRD'].map((t) => ctx.draws.find((d) => d.t === t).y);
  assert(y[0] < y[1] && y[1] < y[2], 'rows stack upward: ' + JSON.stringify(y));
  // the radar dish plus its labels own the top ~200px of a 720 frame
  assert(Math.min(...y) > 200, 'the column starts inside the radar at y=' + Math.min(...y));
});

check('chatter sits low, over the bars it explains', () => {
  const h = newHud();
  h.message('NO MINES', '#f00', 1.2, 'chatter');
  const ctx = fakeCtx();
  h._renderChatter(ctx, 1280, 720, 1, 1 / 60);
  const d = ctx.draws.find((x) => x.t === 'NO MINES');
  assert(d.y > 720 * 0.6, 'chatter drew at y=' + d.y + ', up in the play area');
  assert(d.align === 'left' && d.x < 100, 'chatter is not anchored to the bars');
});

check('chatter cannot flood: only the last couple survive', () => {
  const h = newHud();
  for (let i = 0; i < 8; i++) h.message('N' + i, '#fff', 2, 'chatter');
  assert(h.chatter.length <= 2, 'chatter queue grew to ' + h.chatter.length);
  assert(h.chatter[h.chatter.length - 1].text === 'N7', 'the newest chatter was dropped');
});

check('expired rows are reaped without skipping their neighbours', () => {
  // the reap runs inside a forward loop; a naive splice drops the next row
  const h = newHud();
  h.message('A', '#fff', 0.01, 'alert');
  h.message('B', '#fff', 0.01, 'alert');
  h.message('C', '#fff', 9, 'alert');
  h._renderMessages(fakeCtx(), 1280, 720, 1, 1);
  assert(h.messages.length === 1 && h.messages[0].text === 'C',
    'left ' + JSON.stringify(h.messages.map((m) => m.text)));
});
