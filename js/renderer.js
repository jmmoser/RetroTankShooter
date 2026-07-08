/* Minimal WebGL flat-shaded renderer + small column-major mat4 library.
 *
 * Beyond the base forward pass this renderer carries the game's whole "neon
 * over the void" look:
 *  - up to MAX_LIGHTS dynamic point lights (muzzle flashes, explosions,
 *    tracers) applied to lit geometry, so the action illuminates the arena
 *  - additive blending + soft round particles for glowing energy effects
 *  - an HDR-ish glow pipeline: scene renders into an offscreen target, a
 *    bright-pass extracts hot pixels, they get gaussian-blurred at half res,
 *    and the composite pass adds the bloom back with FXAA + a vignette.
 * The glow pipeline degrades gracefully: if FBOs fail (or GLOW FX is off in
 * settings) everything renders straight to the canvas like before.
 *
 * Antialiasing: the context is created with antialias:true, but that only
 * covers direct-to-canvas rendering — an offscreen FBO gets no MSAA, which
 * left every wireframe line jagged whenever glow was on. On WebGL2 the scene
 * pass therefore renders into a multisampled renderbuffer and is resolved
 * (blitFramebuffer) into the scene texture before post-processing. On WebGL1
 * there is no multisampled-FBO API, so FXAA in the composite remains the
 * only smoothing there.
 */

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

const MAX_LIGHTS = 12;

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
varying vec3 vWorld;
varying float vFogDepth;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vec4 viewPos = uView * world;
  gl_Position = uProj * viewPos;
  vColor = aColor;
  vNormal = normalize(mat3(uModel) * aNormal);
  vWorld = world.xyz;
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
uniform float uSoftPoint;
uniform vec3 uTint;
uniform int uNumLights;
uniform vec4 uLightPosR[${MAX_LIGHTS}];   // xyz = world pos, w = 1/radius
uniform vec3 uLightCol[${MAX_LIGHTS}];
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vFogDepth;
void main() {
  float pointFade = 1.0;
  if (uPointMode > 0.5) {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r2 = dot(d, d);
    if (r2 > 0.25) discard;
    // soft points: bright core melting to nothing at the rim (additive draws)
    if (uSoftPoint > 0.5) {
      float r = sqrt(r2) * 2.0;
      pointFade = (1.0 - r) * (1.0 - r) * (1.0 + 2.0 * r);
    }
  }
  float diff = max(dot(normalize(vNormal), uLightDir), 0.0);
  vec3 lit = vColor * (0.32 + 0.7 * diff);
  // dynamic point lights: shots and explosions splash light onto lit geometry
  vec3 dyn = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uNumLights) break;
    vec3 dv = uLightPosR[i].xyz - vWorld;
    float att = clamp(1.0 - length(dv) * uLightPosR[i].w, 0.0, 1.0);
    dyn += uLightCol[i] * (att * att);
  }
  lit += dyn * (vColor * 1.4 + 0.12);
  vec3 col = mix(lit, vColor, uUnlit) * uTint * pointFade;
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  fog = clamp(fog, 0.0, 1.0);
  gl_FragColor = vec4(mix(col, uFogColor * (1.0 - uSoftPoint * uPointMode), fog), 1.0);
}
`;

/* ---- post-processing shaders ------------------------------------------- */

const QUAD_VS = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/* Bright pass: keep only what's hotter than the threshold, with a soft knee
 * so glow ramps in instead of popping. */
const BRIGHT_FS = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUV;
void main() {
  vec3 c = texture2D(uTex, vUV).rgb;
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  float k = smoothstep(0.32, 0.75, luma);
  gl_FragColor = vec4(c * k, 1.0);
}
`;

/* 9-tap separable gaussian; uDir carries texel-size * direction. */
const BLUR_FS = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uDir;
varying vec2 vUV;
void main() {
  vec3 sum = texture2D(uTex, vUV).rgb * 0.227027;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  sum += texture2D(uTex, vUV + o1).rgb * 0.3162162162;
  sum += texture2D(uTex, vUV - o1).rgb * 0.3162162162;
  sum += texture2D(uTex, vUV + o2).rgb * 0.0702702703;
  sum += texture2D(uTex, vUV - o2).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}
`;

/* Composite: FXAA the sharp scene (the offscreen target has no MSAA), add
 * the blurred bloom on top, then a gentle vignette to pull focus center. */
const COMPOSITE_FS = `
precision mediump float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uTexel;
uniform float uBloomStrength;
varying vec2 vUV;

vec3 fxaa(sampler2D tex, vec2 uv, vec2 texel) {
  vec3 rgbNW = texture2D(tex, uv + vec2(-1.0, -1.0) * texel).rgb;
  vec3 rgbNE = texture2D(tex, uv + vec2( 1.0, -1.0) * texel).rgb;
  vec3 rgbSW = texture2D(tex, uv + vec2(-1.0,  1.0) * texel).rgb;
  vec3 rgbSE = texture2D(tex, uv + vec2( 1.0,  1.0) * texel).rgb;
  vec3 rgbM  = texture2D(tex, uv).rgb;
  vec3 luma = vec3(0.299, 0.587, 0.114);
  float lumaNW = dot(rgbNW, luma);
  float lumaNE = dot(rgbNE, luma);
  float lumaSW = dot(rgbSW, luma);
  float lumaSE = dot(rgbSE, luma);
  float lumaM  = dot(rgbM,  luma);
  float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
  vec2 dir = vec2(-((lumaNW + lumaNE) - (lumaSW + lumaSE)),
                   ((lumaNW + lumaSW) - (lumaNE + lumaSE)));
  float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.03125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * texel;
  vec3 rgbA = 0.5 * (
    texture2D(tex, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
    texture2D(tex, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D(tex, uv + dir * -0.5).rgb +
    texture2D(tex, uv + dir *  0.5).rgb);
  float lumaB = dot(rgbB, luma);
  if (lumaB < lumaMin || lumaB > lumaMax) return rgbA;
  return rgbB;
}

void main() {
  vec3 scene = fxaa(uScene, vUV, uTexel);
  vec3 bloom = texture2D(uBloom, vUV).rgb;
  vec3 col = scene + bloom * uBloomStrength;
  // soft filmic-ish rolloff so stacked glow saturates instead of clipping
  col = col / (1.0 + col * 0.10);
  vec2 v = vUV - 0.5;
  col *= 1.0 - dot(v, v) * 0.38;
  gl_FragColor = vec4(col, 1.0);
}
`;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const ctxOpts = { antialias: true, alpha: false };
    const gl = canvas.getContext('webgl2', ctxOpts) ||
               canvas.getContext('webgl', ctxOpts);
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' &&
                    gl instanceof WebGL2RenderingContext;

    this.program = this._buildProgram(VS, FS);
    gl.useProgram(this.program);

    this.attribs = {
      pos: gl.getAttribLocation(this.program, 'aPos'),
      normal: gl.getAttribLocation(this.program, 'aNormal'),
      color: gl.getAttribLocation(this.program, 'aColor'),
    };
    this.uniforms = {};
    for (const name of ['uProj', 'uView', 'uModel', 'uLightDir', 'uFogColor',
                        'uFogDensity', 'uUnlit', 'uPointMode', 'uSoftPoint', 'uTint',
                        'uPixelScale', 'uNumLights', 'uLightPosR', 'uLightCol']) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // near-black void; fog closes in so the larger arena dissolves into dark
    this.fogColor = [0.004, 0.014, 0.012];
    gl.clearColor(this.fogColor[0], this.fogColor[1], this.fogColor[2], 1);
    gl.uniform3fv(this.uniforms.uFogColor, this.fogColor);
    this.fogDensity = 0.0058;
    gl.uniform1f(this.uniforms.uFogDensity, this.fogDensity);
    const L = [0.35, 0.8, 0.48];
    const ll = Math.hypot(L[0], L[1], L[2]);
    gl.uniform3f(this.uniforms.uLightDir, L[0] / ll, L[1] / ll, L[2] / ll);
    gl.uniform3f(this.uniforms.uTint, 1, 1, 1);
    gl.uniform1f(this.uniforms.uUnlit, 0);
    gl.uniform1f(this.uniforms.uPointMode, 0);
    gl.uniform1f(this.uniforms.uSoftPoint, 0);
    gl.uniform1i(this.uniforms.uNumLights, 0);

    // streaming particle buffer
    this.maxParticles = 2048;
    this.particleData = new Float32Array(this.maxParticles * 9);
    this.particleVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.particleData.byteLength, gl.DYNAMIC_DRAW);

    this.identityModel = m4.identity();

    // dynamic light scratch buffers (filled by setLights each frame)
    this.lightPosR = new Float32Array(MAX_LIGHTS * 4);
    this.lightCol = new Float32Array(MAX_LIGHTS * 3);

    // ---- glow pipeline ----------------------------------------------------
    this.glowEnabled = true;    // user setting (setGlow)
    this.msaaEnabled = true;    // user setting (setMsaa): RENDER QUALITY HIGH
    this.glowSupported = true;  // flipped false if FBO setup fails
    this.bloomStrength = 1.15;
    try {
      this._initPost();
    } catch (e) {
      this.glowSupported = false;
    }
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

  /* ---- post-processing setup ---------------------------------------------- */

  _initPost() {
    const gl = this.gl;
    this.quadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const makePostProg = (fs, uniformNames) => {
      const prog = this._buildProgram(QUAD_VS, fs);
      const u = {};
      for (const n of uniformNames) u[n] = gl.getUniformLocation(prog, n);
      return { prog, aPos: gl.getAttribLocation(prog, 'aPos'), u };
    };
    this.brightProg = makePostProg(BRIGHT_FS, ['uTex']);
    this.blurProg = makePostProg(BLUR_FS, ['uTex', 'uDir']);
    this.compositeProg = makePostProg(COMPOSITE_FS,
      ['uScene', 'uBloom', 'uTexel', 'uBloomStrength']);

    this.sceneFbo = null;   // allocated lazily in _resizePost
    this.msaaFbo = null;    // WebGL2 only: multisampled scene target
    this.msaaBroken = false; // flipped true if MSAA setup fails; don't retry
    this.pingFbo = [null, null];
    this.postW = 0;
    this.postH = 0;
  }

  _makeTarget(w, h, depth) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let rb = null;
    if (depth) {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) throw new Error('FBO incomplete');
    return { fbo, tex, rb, w, h };
  }

  _dropTarget(t) {
    if (!t) return;
    const gl = this.gl;
    gl.deleteFramebuffer(t.fbo);
    if (t.tex) gl.deleteTexture(t.tex);
    if (t.rb) gl.deleteRenderbuffer(t.rb);
    if (t.colorRb) gl.deleteRenderbuffer(t.colorRb);
  }

  /* WebGL2: multisampled color+depth renderbuffer target for the scene pass.
   * Resolved into the plain scene texture in endFrame via blitFramebuffer. */
  _makeMsaaTarget(w, h) {
    const gl = this.gl;
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
    if (samples < 2) throw new Error('MSAA unavailable');
    const colorRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, colorRb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT16, w, h);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorRb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteFramebuffer(fbo);
      gl.deleteRenderbuffer(colorRb);
      gl.deleteRenderbuffer(rb);
      throw new Error('MSAA FBO incomplete');
    }
    return { fbo, tex: null, rb, colorRb, w, h };
  }

  _resizePost() {
    const w = this.canvas.width, h = this.canvas.height;
    if (this.postW === w && this.postH === h && this.sceneFbo) return;
    this._dropTarget(this.sceneFbo);
    this._dropTarget(this.msaaFbo);
    this.msaaFbo = null;
    this._dropTarget(this.pingFbo[0]);
    this._dropTarget(this.pingFbo[1]);
    const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
    if (this.isWebGL2 && this.msaaEnabled && !this.msaaBroken) {
      try {
        this.msaaFbo = this._makeMsaaTarget(w, h);
      } catch (e) {
        this.msaaBroken = true;   // GPU refused: scene texture keeps its own depth
      }
    }
    // with MSAA the depth buffer lives on the multisampled target instead
    this.sceneFbo = this._makeTarget(w, h, !this.msaaFbo);
    this.pingFbo[0] = this._makeTarget(bw, bh, false);
    this.pingFbo[1] = this._makeTarget(bw, bh, false);
    this.postW = w;
    this.postH = h;
  }

  setGlow(on) { this.glowEnabled = !!on; }

  /* RENDER QUALITY: HIGH multisamples the scene pass (WebGL2), LOW renders
   * it plain and leaves the smoothing to FXAA — much cheaper in fill rate.
   * Rebuilds the offscreen targets on the next frame, since depth ownership
   * moves between the MSAA renderbuffer and the scene texture. */
  setMsaa(on) {
    on = !!on;
    if (on === this.msaaEnabled) return;
    this.msaaEnabled = on;
    this.postW = 0;
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
    gl.useProgram(this.program);

    this.glowActive = this.glowEnabled && this.glowSupported;
    if (this.glowActive) {
      try {
        this._resizePost();
      } catch (e) {
        this.glowSupported = false;   // GPU refused: fall back for good
        this.glowActive = false;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,
      this.glowActive ? (this.msaaFbo || this.sceneFbo).fbo : null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
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

  /* lights: array of {x, y, z, r, g, b, radius} — world-space point lights
   * splashed onto lit geometry this frame. Call between beginFrame and the
   * first draw. Anything beyond MAX_LIGHTS is dropped. */
  setLights(lights) {
    const gl = this.gl;
    const n = Math.min(lights ? lights.length : 0, MAX_LIGHTS);
    for (let i = 0; i < n; i++) {
      const l = lights[i], o4 = i * 4, o3 = i * 3;
      this.lightPosR[o4] = l.x;
      this.lightPosR[o4 + 1] = l.y;
      this.lightPosR[o4 + 2] = l.z;
      this.lightPosR[o4 + 3] = 1 / Math.max(l.radius, 0.001);
      this.lightCol[o3] = l.r;
      this.lightCol[o3 + 1] = l.g;
      this.lightCol[o3 + 2] = l.b;
    }
    gl.uniform1i(this.uniforms.uNumLights, n);
    if (n > 0) {
      gl.uniform4fv(this.uniforms.uLightPosR, this.lightPosR);
      gl.uniform3fv(this.uniforms.uLightCol, this.lightCol);
    }
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

  /* opts: unlit, tint, nofog (skybox geometry must not dissolve into fog),
   * points (GL_POINTS mesh with size in aNormal.x, like the particle path),
   * additive (glow geometry: blend ONE,ONE with no depth writes),
   * soft (round points fade at the rim instead of hard-clipping),
   * nodepth (backdrop geometry: no depth test or writes — at sky distances
   * the 16-bit FBO depth buffer can't separate the layers and they z-fight,
   * so the backdrop relies on painter's order instead) */
  draw(mesh, model, opts) {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.uniforms.uModel, false, model || this.identityModel);
    gl.uniform1f(this.uniforms.uUnlit, opts && opts.unlit ? 1 : 0);
    const tint = (opts && opts.tint) || null;
    if (tint) gl.uniform3fv(this.uniforms.uTint, tint);
    const nofog = opts && opts.nofog;
    if (nofog) gl.uniform1f(this.uniforms.uFogDensity, 0);
    const points = opts && opts.points;
    if (points) {
      gl.uniform1f(this.uniforms.uPointMode, 1);
      gl.uniform1f(this.uniforms.uPixelScale, this.pixelScale);
    }
    const soft = opts && opts.soft;
    if (soft) gl.uniform1f(this.uniforms.uSoftPoint, 1);
    const additive = opts && opts.additive;
    if (additive) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.depthMask(false);
    }
    const nodepth = opts && opts.nodepth;
    if (nodepth) {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
    this._bindVertexFormat(mesh.vbo);
    gl.drawArrays(mesh.mode, 0, mesh.count);
    if (additive) {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
    if (nodepth) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
    }
    if (tint) gl.uniform3f(this.uniforms.uTint, 1, 1, 1);
    if (nofog) gl.uniform1f(this.uniforms.uFogDensity, this.fogDensity);
    if (points) gl.uniform1f(this.uniforms.uPointMode, 0);
    if (soft) gl.uniform1f(this.uniforms.uSoftPoint, 0);
  }

  /* particles: array of {x,y,z,size,r,g,b} — soft additive glow sprites */
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
    gl.uniform1f(this.uniforms.uSoftPoint, 1);
    gl.uniform1f(this.uniforms.uPixelScale, this.pixelScale);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
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
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.uniform1f(this.uniforms.uPointMode, 0);
    gl.uniform1f(this.uniforms.uSoftPoint, 0);
    gl.uniform1f(this.uniforms.uUnlit, 0);
  }

  /* ---- glow composition ----------------------------------------------------
   * Call once after all scene draws. When glow is off this is a no-op (the
   * scene already went straight to the canvas). */
  endFrame() {
    if (!this.glowActive) return;
    const gl = this.gl;

    // resolve the multisampled scene into the plain texture the post passes read
    if (this.msaaFbo) {
      const w = this.sceneFbo.w, h = this.sceneFbo.h;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaFbo.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneFbo.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    // the fullscreen triangle only uses aPos; park the other arrays
    gl.disableVertexAttribArray(this.attribs.normal);
    gl.disableVertexAttribArray(this.attribs.color);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);

    const fullscreen = (p) => {
      gl.enableVertexAttribArray(p.aPos);
      gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const ping = this.pingFbo;
    const bw = ping[0].w, bh = ping[0].h;

    // 1) bright pass: scene -> ping[0] at half res
    gl.useProgram(this.brightProg.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, ping[0].fbo);
    gl.viewport(0, 0, bw, bh);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneFbo.tex);
    gl.uniform1i(this.brightProg.u.uTex, 0);
    fullscreen(this.brightProg);

    // 2) two gaussian iterations (H+V each) ping-ponging at half res
    gl.useProgram(this.blurProg.prog);
    gl.uniform1i(this.blurProg.u.uTex, 0);
    let src = 0;
    for (let i = 0; i < 4; i++) {
      const dst = 1 - src;
      gl.bindFramebuffer(gl.FRAMEBUFFER, ping[dst].fbo);
      gl.bindTexture(gl.TEXTURE_2D, ping[src].tex);
      const spread = 1 + (i >> 1);   // second iteration reaches further
      if (i % 2 === 0) gl.uniform2f(this.blurProg.u.uDir, spread / bw, 0);
      else gl.uniform2f(this.blurProg.u.uDir, 0, spread / bh);
      fullscreen(this.blurProg);
      src = dst;
    }

    // 3) composite to the canvas: FXAA'd scene + bloom + vignette
    gl.useProgram(this.compositeProg.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneFbo.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ping[src].tex);
    gl.uniform1i(this.compositeProg.u.uScene, 0);
    gl.uniform1i(this.compositeProg.u.uBloom, 1);
    gl.uniform2f(this.compositeProg.u.uTexel, 1 / this.canvas.width, 1 / this.canvas.height);
    gl.uniform1f(this.compositeProg.u.uBloomStrength, this.bloomStrength);
    fullscreen(this.compositeProg);

    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }
}
