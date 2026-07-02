/* Procedural flat-shaded mesh builders. Vertex format: pos(3) normal(3) color(3). */
const Geometry = (() => {

  class MeshBuilder {
    constructor() { this.data = []; }

    tri(a, b, c, color, normal) {
      let n = normal;
      if (!n) {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        n = [nx / l, ny / l, nz / l];
      }
      for (const p of [a, b, c]) {
        this.data.push(p[0], p[1], p[2], n[0], n[1], n[2], color[0], color[1], color[2]);
      }
      return this;
    }

    quad(a, b, c, d, color) {
      this.tri(a, b, c, color);
      this.tri(a, c, d, color);
      return this;
    }

    /* Axis-aligned box centered at (cx,cy,cz). */
    box(cx, cy, cz, sx, sy, sz, color) {
      const x0 = cx - sx / 2, x1 = cx + sx / 2;
      const y0 = cy - sy / 2, y1 = cy + sy / 2;
      const z0 = cz - sz / 2, z1 = cz + sz / 2;
      // +Y top
      this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], color);
      // -Y bottom
      this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], color);
      // +X
      this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], color);
      // -X
      this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], color);
      // +Z
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], color);
      // -Z
      this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], color);
      return this;
    }

    /* Square-based pyramid, base centered at (cx, baseY, cz). */
    pyramid(cx, baseY, cz, sx, sz, h, color) {
      const x0 = cx - sx / 2, x1 = cx + sx / 2;
      const z0 = cz - sz / 2, z1 = cz + sz / 2;
      const apex = [cx, baseY + h, cz];
      this.tri([x0, baseY, z1], [x1, baseY, z1], apex, color); // front (+Z)
      this.tri([x1, baseY, z0], [x0, baseY, z0], apex, color); // back (-Z)
      this.tri([x1, baseY, z1], [x1, baseY, z0], apex, color); // +X
      this.tri([x0, baseY, z0], [x0, baseY, z1], apex, color); // -X
      return this;
    }

    /* Octahedron centered at (cx,cy,cz), radius r. */
    octahedron(cx, cy, cz, r, color) {
      const top = [cx, cy + r, cz], bot = [cx, cy - r, cz];
      const px = [cx + r, cy, cz], nx = [cx - r, cy, cz];
      const pz = [cx, cy, cz + r], nz = [cx, cy, cz - r];
      this.tri(px, pz, top, color).tri(pz, nx, top, color)
          .tri(nx, nz, top, color).tri(nz, px, top, color)
          .tri(pz, px, bot, color).tri(nx, pz, bot, color)
          .tri(nz, nx, bot, color).tri(px, nz, bot, color);
      return this;
    }

    /* ---- wireframe primitives (emit GL_LINES vertex pairs) ---------------- */
    edge(a, b, color) {
      const n = [0, 1, 0]; // normal unused for unlit wireframes
      this.data.push(a[0], a[1], a[2], n[0], n[1], n[2], color[0], color[1], color[2]);
      this.data.push(b[0], b[1], b[2], n[0], n[1], n[2], color[0], color[1], color[2]);
      return this;
    }

    /* 12 edges of an axis-aligned box centered at (cx,cy,cz). */
    boxEdges(cx, cy, cz, sx, sy, sz, color) {
      const x0 = cx - sx / 2, x1 = cx + sx / 2;
      const y0 = cy - sy / 2, y1 = cy + sy / 2;
      const z0 = cz - sz / 2, z1 = cz + sz / 2;
      const c000 = [x0, y0, z0], c100 = [x1, y0, z0], c110 = [x1, y1, z0], c010 = [x0, y1, z0];
      const c001 = [x0, y0, z1], c101 = [x1, y0, z1], c111 = [x1, y1, z1], c011 = [x0, y1, z1];
      // bottom loop
      this.edge(c000, c100, color).edge(c100, c101, color).edge(c101, c001, color).edge(c001, c000, color);
      // top loop
      this.edge(c010, c110, color).edge(c110, c111, color).edge(c111, c011, color).edge(c011, c010, color);
      // verticals
      this.edge(c000, c010, color).edge(c100, c110, color).edge(c101, c111, color).edge(c001, c011, color);
      return this;
    }

    build() { return new Float32Array(this.data); }
  }

  // ---- palette: glowing wireframe vehicles over a black void -------------
  // Hull colors are pushed bright/neon so the vector lines read on near-black.
  const C = {
    hullEnemy:   [1.0,  0.28, 0.22],   // hostile red
    hullHunter:  [1.0,  0.62, 0.12],   // amber
    hullSniper:  [0.78, 0.42, 1.0],    // violet
    hullPhantom: [0.62, 0.92, 0.95],   // ghostly ice
    hullPlayer:  [0.25, 1.0,  0.82],   // friendly cyan
    tread:       [0.10, 0.12, 0.12],
    barrel:      [0.85, 0.92, 0.88],
    flagPole:    [0.70, 0.78, 0.74],
    flagCloth:   [0.20, 1.0,  0.45],
    shotPlayer:  [1.0,  0.95, 0.45],
    shotEnemy:   [1.0,  0.32, 0.22],
    shotNade:    [0.55, 1.0,  0.35],
    wall:        [0.08, 0.22, 0.19],   // dim slab base
    wallTop:     [0.16, 0.62, 0.50],   // glowing capstone edge
  };

  /* Solid flat-shaded tank (kept for reference / non-wire use). */
  function tank(hullColor) {
    const b = new MeshBuilder();
    // model faces -Z (forward)
    b.box(-1.35, 0.45, 0, 0.85, 0.9, 4.4, C.tread);   // left tread
    b.box( 1.35, 0.45, 0, 0.85, 0.9, 4.4, C.tread);   // right tread
    b.box(0, 0.85, 0, 2.0, 0.9, 4.2, hullColor);      // hull
    // sloped nose
    b.tri([-1.0, 1.3, -2.1], [1.0, 1.3, -2.1], [0, 0.6, -2.9], hullColor);
    b.box(0, 1.6, 0.3, 1.5, 0.7, 1.9, hullColor);     // turret
    b.box(0, 1.62, -1.6, 0.28, 0.28, 2.6, C.barrel);  // barrel (points -Z)
    return b.build();
  }

  /* Solid flat-shaded hovertank — the sleek Spectre wedge. Model faces -Z.
   * A low arrowhead chassis, angular canopy pod, and a forward cannon; the
   * per-face lighting gives it the classic faceted look. */
  function tankSolid(hull) {
    const b = new MeshBuilder();
    const dark = [hull[0] * 0.45, hull[1] * 0.45, hull[2] * 0.45];
    const mid  = [hull[0] * 0.75, hull[1] * 0.75, hull[2] * 0.75];

    // chassis outlines: bottom (outset) and top (inset) pentagons.
    // order: nose, left shoulder, left tail, right tail, right shoulder
    const yb = 0.28, yt = 1.15;
    const bot = [
      [0, yb, -3.4], [-2.3, yb, -0.6], [-1.8, yb, 2.5], [1.8, yb, 2.5], [2.3, yb, -0.6],
    ];
    const top = [
      [0, yt, -2.2], [-1.5, yt, -0.3], [-1.2, yt, 2.2], [1.2, yt, 2.2], [1.5, yt, -0.3],
    ];
    // top deck (fan from the nose, left-side-first = CCW seen from above)
    b.tri(top[0], top[1], top[2], hull);
    b.tri(top[0], top[2], top[3], hull);
    b.tri(top[0], top[3], top[4], hull);
    // underside (reverse winding)
    b.tri(bot[0], bot[4], bot[3], dark);
    b.tri(bot[0], bot[3], bot[2], dark);
    b.tri(bot[0], bot[2], bot[1], dark);
    // skirt walls, following the top outline direction
    for (let i = 0; i < 5; i++) {
      const j = (i + 1) % 5;
      b.quad(bot[i], bot[j], top[j], top[i], mid);
    }

    // canopy pod behind midship + sloped windshield down to the deck
    b.box(0, 1.45, 1.0, 1.3, 0.6, 1.5, dark);
    b.quad([-0.65, yt, -0.9], [0.65, yt, -0.9], [0.65, 1.75, 0.25], [-0.65, 1.75, 0.25], mid);

    // cannon out over the nose
    b.box(0, 1.05, -2.4, 0.26, 0.26, 2.6, C.barrel);
    return b.build();
  }

  /* Single two-sided triangle — the polygon shards a dying tank bursts into. */
  function shard() {
    const b = new MeshBuilder();
    const a = [0, 0, -0.9], p2 = [0.8, 0, 0.6], p3 = [-0.7, 0.15, 0.5];
    const w = [1, 1, 1];
    b.tri(a, p2, p3, w);
    b.tri(a, p3, p2, w);
    return b.build();
  }

  /* Resupply pad: flat glowing plate with four corner pylons. Tinted at draw. */
  function depot() {
    const b = new MeshBuilder();
    const w = [1, 1, 1], dim = [0.4, 0.4, 0.4];
    b.quad([-3.5, 0.07, -3.5], [-3.5, 0.07, 3.5], [3.5, 0.07, 3.5], [3.5, 0.07, -3.5], w);
    for (const [px, pz] of [[-3.5, -3.5], [3.5, -3.5], [3.5, 3.5], [-3.5, 3.5]]) {
      b.box(px, 0.7, pz, 0.5, 1.4, 0.5, dim);
      b.box(px, 1.5, pz, 0.6, 0.2, 0.6, w);
    }
    return b.build();
  }

  /* Wireframe tank — Spectre-style glowing vector outline. GL_LINES. */
  function tankWire(hullColor) {
    const b = new MeshBuilder();
    // model faces -Z (forward)
    b.boxEdges(-1.35, 0.45, 0, 0.85, 0.9, 4.4, hullColor); // left tread
    b.boxEdges( 1.35, 0.45, 0, 0.85, 0.9, 4.4, hullColor); // right tread
    b.boxEdges(0, 0.85, 0, 2.0, 0.9, 4.2, hullColor);      // hull
    b.boxEdges(0, 1.6, 0.3, 1.5, 0.7, 1.9, hullColor);     // turret
    // sloped nose (triangle + lines back to the hull's leading edge)
    const nl = [-1.0, 1.3, -2.1], nr = [1.0, 1.3, -2.1], na = [0, 0.6, -2.9];
    b.edge(nl, nr, hullColor).edge(nr, na, hullColor).edge(na, nl, hullColor);
    b.edge(nl, [-1.0, 1.3, -2.1], hullColor);
    // gun barrel as a single bright vector line out the front of the turret
    b.edge([0, 1.62, -0.6], [0, 1.62, -3.0], C.barrel);
    return b.build();
  }

  function flag() {
    const b = new MeshBuilder();
    b.box(0, 2.0, 0, 0.18, 4.0, 0.18, C.flagPole);
    // two-sided pennant near the top
    const a = [0.09, 3.9, 0], p2 = [1.6, 3.45, 0], p3 = [0.09, 3.0, 0];
    b.tri(a, p2, p3, C.flagCloth, [0, 0, 1]);
    b.tri(a, p3, p2, C.flagCloth, [0, 0, -1]);
    return b.build();
  }

  function block(color) {
    return new MeshBuilder().box(0, 0.5, 0, 1, 1, 1, color).build();
  }

  function pyramidMesh(color) {
    return new MeshBuilder().pyramid(0, 0, 0, 1, 1, 1, color).build();
  }

  function shot(color) {
    return new MeshBuilder().octahedron(0, 0, 0, 0.45, color).build();
  }

  function powerup() {
    const b = new MeshBuilder();
    b.octahedron(0, 0, 0, 1.0, [1, 1, 1]);
    return b.build();
  }

  function wallSegment() {
    const b = new MeshBuilder();
    b.box(0, 1.0, 0, 1, 2.0, 1, C.wall);
    b.box(0, 2.1, 0, 1, 0.2, 1, C.wallTop);
    return b.build();
  }

  /* Ground: near-black plane + cold grid lines (line list, y slightly raised). */
  function ground(half, step) {
    const b = new MeshBuilder();
    const g = [0.015, 0.035, 0.030]; // almost void, faint cold tint
    b.quad([-half, 0, -half], [-half, 0, half], [half, 0, half], [half, 0, -half], g);
    return b.build();
  }

  function gridLines(half, step) {
    const verts = [];
    const c = [0.09, 0.36, 0.31];
    const cMajor = [0.18, 0.66, 0.55];
    let i = 0;
    for (let v = -half; v <= half; v += step, i++) {
      const col = (i % 4 === 0) ? cMajor : c;
      verts.push(v, 0.03, -half, 0, 1, 0, col[0], col[1], col[2]);
      verts.push(v, 0.03,  half, 0, 1, 0, col[0], col[1], col[2]);
      verts.push(-half, 0.03, v, 0, 1, 0, col[0], col[1], col[2]);
      verts.push( half, 0.03, v, 0, 1, 0, col[0], col[1], col[2]);
    }
    return new Float32Array(verts);
  }

  return { MeshBuilder, C, tank, tankWire, tankSolid, shard, depot, flag, block, pyramidMesh, shot, powerup, wallSegment, ground, gridLines };
})();
