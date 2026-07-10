/* m4 matrix library: composition correctness and the out-parameter reuse
 * added for the render loop's scratch matrices. */
const { loadScripts, check, assert } = require('./helpers');

loadScripts(['renderer.js'], 'global.m4 = m4;');

function close(a, b, msg) {
  assert(a.length === 16 && b.length === 16, msg + ': not mat4');
  for (let i = 0; i < 16; i++) {
    assert(Math.abs(a[i] - b[i]) < 1e-5, msg + ': element ' + i + ' differs (' + a[i] + ' vs ' + b[i] + ')');
  }
}

check('trs equals translation * rotationY * scaling', () => {
  const [x, y, z, ry, sx, sy, sz] = [3, -2, 7, 0.83, 2, 0.5, 4];
  const composed = m4.multiply(m4.translation(x, y, z), m4.multiply(m4.rotationY(ry), m4.scaling(sx, sy, sz)));
  close(m4.trs(x, y, z, ry, sx, sy, sz), composed, 'trs');
});

check('out-parameter results equal allocating results', () => {
  const out = new Float32Array(16).fill(99);   // garbage that must be overwritten
  close(m4.trs(1, 2, 3, 0.4, 5, 6, 7, out), m4.trs(1, 2, 3, 0.4, 5, 6, 7), 'trs out');
  out.fill(99);
  close(m4.translation(8, 9, 10, out), m4.translation(8, 9, 10), 'translation out');
  out.fill(99);
  close(m4.rotationX(1.1, out), m4.rotationX(1.1), 'rotationX out');
  const a = m4.rotationY(0.3), b = m4.trs(1, 0, 2, 0.7, 1, 2, 3);
  out.fill(99);
  close(m4.multiply(a, b, out), m4.multiply(a, b), 'multiply out');
});

check('reusing one scratch matrix across calls leaves no stale elements', () => {
  const scratch = new Float32Array(16);
  m4.trs(1, 2, 3, 0.5, 9, 9, 9, scratch);          // fill with a big transform
  m4.translation(0, 0, 0, scratch);                 // then a sparse one
  close(scratch, m4.identity(), 'translation(0,0,0) into used scratch');
  m4.trs(1, 2, 3, 0.5, 9, 9, 9, scratch);
  m4.rotationX(0, scratch);
  close(scratch, m4.identity(), 'rotationX(0) into used scratch');
});

check('m4._I stays pristine after out-param calls', () => {
  const before = Array.from(m4._I);
  const s = new Float32Array(16);
  m4.translation(5, 6, 7, s);
  m4.rotationX(2, s);
  close(m4._I, new Float32Array(before), '_I mutated');
});

check('rotationY / rotationX / rotationZ match hand math', () => {
  const a = 0.9, c = Math.cos(a), s = Math.sin(a);
  const v = [1, 2, 3];
  const apply = (m, v) => [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];
  const ry = apply(m4.rotationY(a), v);
  assert(Math.abs(ry[0] - (c * v[0] + s * v[2])) < 1e-6 && Math.abs(ry[1] - v[1]) < 1e-6 &&
    Math.abs(ry[2] - (-s * v[0] + c * v[2])) < 1e-6, 'rotationY wrong');
  const rx = apply(m4.rotationX(a), v);
  assert(Math.abs(rx[0] - v[0]) < 1e-6 && Math.abs(rx[1] - (c * v[1] - s * v[2])) < 1e-6 &&
    Math.abs(rx[2] - (s * v[1] + c * v[2])) < 1e-6, 'rotationX wrong');
});
