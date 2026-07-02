/* Minimal WebGL flat-shaded renderer + small column-major mat4 library. */

const m4 = {
  identity() {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  },
  perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  },
  multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  },
  translation(x, y, z) {
    const m = m4.identity();
    m[12] = x; m[13] = y; m[14] = z;
    return m;
  },
  rotationY(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
  },
  rotationX(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
  },
  rotationZ(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]);
  },
  scaling(x, y, z) {
    return new Float32Array([x,0,0,0, 0,y,0,0, 0,0,z,0, 0,0,0,1]);
  },
  /* translate * rotY * scale — the common entity transform */
  trs(x, y, z, ry, sx, sy, sz) {
    const c = Math.cos(ry), s = Math.sin(ry);
    return new Float32Array([
      c * sx, 0, -s * sx, 0,
      0, sy, 0, 0,
      s * sz, 0, c * sz, 0,
      x, y, z, 1,
    ]);
  },
};

const VS = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mediump float uPointMode;
uniform mediump float uPixelScale;
varying vec3 vColor;
varying vec3 vNormal;
varying float vFogDepth;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vec4 viewPos = uView * world;
  gl_Position = uProj * viewPos;
  vColor = aColor;
  vNormal = normalize(mat3(uModel) * aNormal);
  vFogDepth = -viewPos.z;
  if (uPointMode > 0.5) {
    gl_PointSize = clamp(aNormal.x * uPixelScale / max(gl_Position.w, 0.1), 1.0, 64.0);
  }
}
`;

const FS = `
precision mediump float;
uniform vec3 uLightDir;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uUnlit;
uniform float uPointMode;
uniform vec3 uTint;
varying vec3 vColor;
varying vec3 vNormal;
varying float vFogDepth;
void main() {
  if (uPointMode > 0.5) {
    vec2 d = gl_PointCoord - vec2(0.5);
    if (dot(d, d) > 0.25) discard;
  }
  float diff = max(dot(normalize(vNormal), uLightDir), 0.0);
  vec3 lit = vColor * (0.32 + 0.7 * diff);
  vec3 col = mix(lit, vColor, uUnlit) * uTint;
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  fog = clamp(fog, 0.0, 1.0);
  gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
}
`;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    this.program = this._buildProgram(VS, FS);
    gl.useProgram(this.program);

    this.attribs = {
      pos: gl.getAttribLocation(this.program, 'aPos'),
      normal: gl.getAttribLocation(this.program, 'aNormal'),
      color: gl.getAttribLocation(this.program, 'aColor'),
    };
    this.uniforms = {};
    for (const name of ['uProj', 'uView', 'uModel', 'uLightDir', 'uFogColor',
                        'uFogDensity', 'uUnlit', 'uPointMode', 'uTint', 'uPixelScale']) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // near-black void; fog closes in so the larger arena dissolves into dark
    this.fogColor = [0.004, 0.014, 0.012];
    gl.clearColor(this.fogColor[0], this.fogColor[1], this.fogColor[2], 1);
    gl.uniform3fv(this.uniforms.uFogColor, this.fogColor);
    gl.uniform1f(this.uniforms.uFogDensity, 0.0058);
    const L = [0.35, 0.8, 0.48];
    const ll = Math.hypot(L[0], L[1], L[2]);
    gl.uniform3f(this.uniforms.uLightDir, L[0] / ll, L[1] / ll, L[2] / ll);
    gl.uniform3f(this.uniforms.uTint, 1, 1, 1);
    gl.uniform1f(this.uniforms.uUnlit, 0);
    gl.uniform1f(this.uniforms.uPointMode, 0);

    // streaming particle buffer
    this.maxParticles = 2048;
    this.particleData = new Float32Array(this.maxParticles * 9);
    this.particleVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.particleData.byteLength, gl.DYNAMIC_DRAW);

    this.identityModel = m4.identity();
  }

  _buildProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('Shader error: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  createMesh(data, mode) {
    const gl = this.gl;
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return { vbo, count: data.length / 9, mode: mode !== undefined ? mode : gl.TRIANGLES };
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }
  }

  /* camera: { x, y, z, yaw, pitch, roll, fov } */
  beginFrame(camera) {
    const gl = this.gl;
    this.resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const proj = m4.perspective(camera.fov || 1.22, aspect, 0.1, 800);
    let view = m4.multiply(m4.rotationY(-camera.yaw), m4.translation(-camera.x, -camera.y, -camera.z));
    view = m4.multiply(m4.rotationX(-(camera.pitch || 0)), view);
    if (camera.roll) view = m4.multiply(m4.rotationZ(-camera.roll), view);

    gl.uniformMatrix4fv(this.uniforms.uProj, false, proj);
    gl.uniformMatrix4fv(this.uniforms.uView, false, view);
    this.pixelScale = this.canvas.height * 1.2;
  }

  _bindVertexFormat(vbo) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(this.attribs.pos);
    gl.vertexAttribPointer(this.attribs.pos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.attribs.normal);
    gl.vertexAttribPointer(this.attribs.normal, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(this.attribs.color);
    gl.vertexAttribPointer(this.attribs.color, 3, gl.FLOAT, false, stride, 24);
  }

  draw(mesh, model, opts) {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.uniforms.uModel, false, model || this.identityModel);
    gl.uniform1f(this.uniforms.uUnlit, opts && opts.unlit ? 1 : 0);
    const tint = (opts && opts.tint) || null;
    if (tint) gl.uniform3fv(this.uniforms.uTint, tint);
    this._bindVertexFormat(mesh.vbo);
    gl.drawArrays(mesh.mode, 0, mesh.count);
    if (tint) gl.uniform3f(this.uniforms.uTint, 1, 1, 1);
  }

  /* particles: array of {x,y,z,size,r,g,b} */
  drawParticles(particles) {
    if (!particles.length) return;
    const gl = this.gl;
    const n = Math.min(particles.length, this.maxParticles);
    const d = this.particleData;
    for (let i = 0; i < n; i++) {
      const p = particles[i], o = i * 9;
      d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z;
      d[o + 3] = p.size; d[o + 4] = 1; d[o + 5] = 0;
      d[o + 6] = p.r; d[o + 7] = p.g; d[o + 8] = p.b;
    }
    gl.uniformMatrix4fv(this.uniforms.uModel, false, this.identityModel);
    gl.uniform1f(this.uniforms.uUnlit, 1);
    gl.uniform1f(this.uniforms.uPointMode, 1);
    gl.uniform1f(this.uniforms.uPixelScale, this.pixelScale);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, n * 9));
    const stride = 9 * 4;
    gl.enableVertexAttribArray(this.attribs.pos);
    gl.vertexAttribPointer(this.attribs.pos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.attribs.normal);
    gl.vertexAttribPointer(this.attribs.normal, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(this.attribs.color);
    gl.vertexAttribPointer(this.attribs.color, 3, gl.FLOAT, false, stride, 24);
    gl.drawArrays(gl.POINTS, 0, n);
    gl.uniform1f(this.uniforms.uPointMode, 0);
    gl.uniform1f(this.uniforms.uUnlit, 0);
  }
}
