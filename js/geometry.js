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

    build() { return new Float32Array(this.data); }
  }

  // ---- palette (bright flat-shaded solids over a dark teal world) --------
  const C = {
    hullEnemy:   [0.85, 0.22, 0.16],
    hullHunter:  [0.95, 0.55, 0.12],
    hullSniper:  [0.62, 0.30, 0.85],
    hullPlayer:  [0.18, 0.78, 0.65],
    tread:       [0.10, 0.12, 0.12],
    barrel:      [0.75, 0.78, 0.75],
    flagPole:    [0.88, 0.90, 0.88],
    flagCloth:   [0.20, 0.95, 0.45],
    shotPlayer:  [1.0, 0.95, 0.45],
    shotEnemy:   [1.0, 0.35, 0.25],
    wall:        [0.16, 0.42, 0.36],
    wallTop:     [0.30, 0.85, 0.70],
  };

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

  /* Ground: solid dark plane + bright grid lines (line list, y slightly raised). */
  function ground(half, step) {
    const b = new MeshBuilder();
    const g = [0.045, 0.10, 0.085];
    b.quad([-half, 0, -half], [-half, 0, half], [half, 0, half], [half, 0, -half], g);
    return b.build();
  }

  function gridLines(half, step) {
    const verts = [];
    const c = [0.12, 0.45, 0.37];
    const cMajor = [0.20, 0.66, 0.54];
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

  return { MeshBuilder, C, tank, flag, block, pyramidMesh, shot, powerup, wallSegment, ground, gridLines };
})();
