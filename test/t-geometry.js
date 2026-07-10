/* Mesh-builder invariants: outward winding (back-face culling keeps the
 * near faces), grid/wall edge coverage, and arena-wall geometry. */
const { loadScripts, check, assert } = require('./helpers');

loadScripts(['geometry.js'], 'global.Geometry = Geometry;');

const STRIDE = 9; // pos(3) normal(3) color(3)

/* Iterate GL_TRIANGLES vertex data as [a, b, c] position triples. */
function* tris(data) {
  for (let i = 0; i + STRIDE * 3 <= data.length; i += STRIDE * 3) {
    const p = (k) => [data[i + k * STRIDE], data[i + k * STRIDE + 1], data[i + k * STRIDE + 2]];
    yield [p(0), p(1), p(2)];
  }
}

function faceNormal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

/* Every face of a convex solid centered at `center` must wind CCW-outward:
 * dot(face normal, centroid - center) > 0. */
function assertOutward(data, center, what) {
  let n = 0;
  for (const [a, b, c] of tris(data)) {
    const nor = faceNormal(a, b, c);
    const cx = (a[0] + b[0] + c[0]) / 3 - center[0];
    const cy = (a[1] + b[1] + c[1]) / 3 - center[1];
    const cz = (a[2] + b[2] + c[2]) / 3 - center[2];
    const dot = nor[0] * cx + nor[1] * cy + nor[2] * cz;
    assert(dot > 0, what + ' face ' + n + ' winds inward (dot=' + dot.toFixed(3) + ')');
    n++;
  }
  assert(n > 0, what + ' produced no triangles');
}

check('octahedron faces all wind outward (glow-halo regression)', () => {
  const data = new Geometry.MeshBuilder().octahedron(0, 0, 0, 1, [1, 1, 1]).build();
  assert(data.length === 8 * 3 * STRIDE, 'octahedron should be 8 tris');
  assertOutward(data, [0, 0, 0], 'octahedron');
});

check('box and pyramid faces wind outward', () => {
  assertOutward(new Geometry.MeshBuilder().box(0, 0, 0, 2, 2, 2, [1, 1, 1]).build(), [0, 0, 0], 'box');
  // pyramid() emits sides only (no base); its centroid sits above the base
  assertOutward(new Geometry.MeshBuilder().pyramid(0, 0, 0, 2, 2, 2, [1, 1, 1]).build(), [0, 0.5, 0], 'pyramid');
});

check('gridLines covers both edges even when step does not divide the span', () => {
  const half = 175, step = 8; // 350 % 8 !== 0 — the original off-by-one case
  const data = Geometry.gridLines(half, step);
  const xs = new Set(), zs = new Set();
  for (let i = 0; i + STRIDE * 2 <= data.length; i += STRIDE * 2) {
    const [x0, , z0] = [data[i], data[i + 1], data[i + 2]];
    const [x1, , z1] = [data[i + STRIDE], data[i + STRIDE + 1], data[i + STRIDE + 2]];
    if (x0 === x1) xs.add(x0);      // vertical line at x
    if (z0 === z1) zs.add(z0);      // horizontal line at z
  }
  for (const edge of [-half, half]) {
    assert(xs.has(edge), 'no grid line at x=' + edge);
    assert(zs.has(edge), 'no grid line at z=' + edge);
  }
});

check('arenaWall: full perimeter, no corner gap, no overlapping boxes', () => {
  const half = 175;
  const data = Geometry.arenaWall(half);
  // 4 sides x (body + cap) = 8 boxes, 36 verts each
  assert(data.length === 8 * 36 * STRIDE, 'unexpected vertex count ' + data.length / STRIDE);
  // recover each box's AABB from its 36-vertex group
  const boxes = [];
  for (let b = 0; b < 8; b++) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < 36; v++) {
      const o = (b * 36 + v) * STRIDE;
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], data[o + k]);
        mx[k] = Math.max(mx[k], data[o + k]);
      }
    }
    boxes.push({ mn, mx });
  }
  // strict volume overlap between any two boxes would z-fight; touching is fine
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlaps = [0, 1, 2].every((k) => a.mn[k] < b.mx[k] - 1e-6 && b.mn[k] < a.mx[k] - 1e-6);
      assert(!overlaps, 'wall boxes ' + i + ' and ' + j + ' overlap');
    }
  }
  // every point of the play boundary must have wall directly outside it:
  // sweep the perimeter and require an enclosing box at ground level
  const lim = half + 1.5;
  for (let t = -half; t <= half; t += 5) {
    for (const [x, z] of [[t, lim], [t, -lim], [lim, t], [-lim, t]]) {
      const covered = boxes.some((b) =>
        x >= b.mn[0] - 1e-6 && x <= b.mx[0] + 1e-6 &&
        z >= b.mn[2] - 1e-6 && z <= b.mx[2] + 1e-6 && b.mn[1] < 0.5);
      assert(covered, 'perimeter gap at (' + x + ', ' + z + ')');
    }
  }
  // the old per-segment walls left this corner bare
  const corner = boxes.some((b) =>
    half <= b.mx[0] && half <= b.mx[2] && b.mn[1] < 0.5 &&
    b.mn[0] <= half + 3 && b.mn[2] <= half + 3);
  assert(corner, '(+X,+Z) corner not covered');
});

check('tankWire has no degenerate zero-length edges', () => {
  const data = Geometry.tankWire([1, 1, 1]);
  for (let i = 0; i + STRIDE * 2 <= data.length; i += STRIDE * 2) {
    const dx = data[i] - data[i + STRIDE];
    const dy = data[i + 1] - data[i + STRIDE + 1];
    const dz = data[i + 2] - data[i + STRIDE + 2];
    assert(dx * dx + dy * dy + dz * dz > 1e-9, 'zero-length edge at vertex ' + i / STRIDE);
  }
});
