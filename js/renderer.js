/* WebGL flat-shaded renderer + small column-major mat4 library.
 *
 * Beyond the base forward pass this renderer carries the game's whole "neon
 * over the void" look:
 *  - up to MAX_LIGHTS dynamic point lights (muzzle flashes, explosions,
 *    tracers) applied to lit geometry, so the action illuminates the arena
 *  - a real-time directional SHADOW MAP: a depth-only pass from the sun,
 *    packed into RGBA8 (portable to WebGL1, no depth-texture extension) and
 *    sampled back with a 3x3 PCF kernel, so hulls and cover ground themselves
 *    on the arena floor instead of floating over it
 *  - specular + fresnel rim lighting, which is what keeps flat-shaded facets
 *    from reading as untextured cardboard
 *  - additive blending + soft round particles for glowing energy effects
 *  - an HDR-ish glow pipeline: scene renders into an offscreen target, a
 *    bright-pass extracts hot pixels, they get gaussian-blurred at half res,
 *    and the composite pass adds the bloom back over an ACES-tonemapped,
 *    graded image with FXAA, chromatic aberration, radial speed blur, film
 *    grain and a vignette.
 * Every stage degrades gracefully: if FBOs fail (or GLOW FX is off in
 * settings) everything renders straight to the canvas like before, and if the
 * shadow target fails the sun just stops casting.
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
  perspective(fovY, aspect, near, far, out) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    out = out ? out.fill(0) : new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  },
  /* Orthographic projection — the shadow map's light frustum. */
  ortho(l, r, b, t, n, f, out) {
    out = out ? out.fill(0) : new Float32Array(16);
    out[0] = 2 / (r - l);
    out[5] = 2 / (t - b);
    out[10] = -2 / (f - n);
    out[12] = -(r + l) / (r - l);
    out[13] = -(t + b) / (t - b);
    out[14] = -(f + n) / (f - n);
    out[15] = 1;
    return out;
  },
  /* Right-handed look-at view matrix (used to place the sun's camera). */
  lookAt(ex, ey, ez, cx, cy, cz, ux, uy, uz, out) {
    let zx = ex - cx, zy = ey - cy, zz = ez - cz;
    let l = Math.hypot(zx, zy, zz) || 1;
    zx /= l; zy /= l; zz /= l;
    let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
    l = Math.hypot(xx, xy, xz) || 1;
    xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const m = out || new Float32Array(16);
    m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
    m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
    m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
    m[12] = -(xx * ex + xy * ey + xz * ez);
    m[13] = -(yx * ex + yy * ey + yz * ez);
    m[14] = -(zx * ex + zy * ey + zz * ez);
    m[15] = 1;
    return m;
  },
  /* All builders below take an optional `out` matrix so per-frame callers can
   * reuse scratch storage instead of allocating hundreds of Float32Arrays a
   * frame (uniformMatrix4fv copies immediately, so reuse across draws is safe).
   * `out` must not alias an input of multiply(). */
  multiply(a, b, out) {
    out = out || new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  },
  translation(x, y, z, out) {
    const m = out || new Float32Array(16);
    m.set(m4._I);
    m[12] = x; m[13] = y; m[14] = z;
    return m;
  },
  rotationY(a, out) {
    const c = Math.cos(a), s = Math.sin(a);
    const m = out || new Float32Array(16);
    m.set(m4._I);
    m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
    return m;
  },
  rotationX(a, out) {
    const c = Math.cos(a), s = Math.sin(a);
    const m = out || new Float32Array(16);
    m.set(m4._I);
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
    return m;
  },
  rotationZ(a, out) {
    const c = Math.cos(a), s = Math.sin(a);
    const m = out || new Float32Array(16);
    m.set(m4._I);
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
    return m;
  },
  scaling(x, y, z) {
    return new Float32Array([x,0,0,0, 0,y,0,0, 0,0,z,0, 0,0,0,1]);
  },
  /* translate * rotY * scale — the common entity transform */
  trs(x, y, z, ry, sx, sy, sz, out) {
    const c = Math.cos(ry), s = Math.sin(ry);
    const m = out || new Float32Array(16);
    m[0] = c * sx;  m[1] = 0;  m[2] = -s * sx; m[3] = 0;
    m[4] = 0;       m[5] = sy; m[6] = 0;       m[7] = 0;
    m[8] = s * sz;  m[9] = 0;  m[10] = c * sz; m[11] = 0;
    m[12] = x;      m[13] = y; m[14] = z;      m[15] = 1;
    return m;
  },
};
m4._I = m4.identity();

// beginFrame scratch — the camera matrices are rebuilt every frame, so give
// them fixed storage like every other per-frame matrix in the codebase
const CAM_PROJ = new Float32Array(16);
const CAM_A = new Float32Array(16);
const CAM_B = new Float32Array(16);
const CAM_C = new Float32Array(16);
// shadow pass scratch
const SUN_PROJ = new Float32Array(16);
const SUN_VIEW = new Float32Array(16);
const SUN_VP = new Float32Array(16);

const MAX_LIGHTS = 12;
// RENDER QUALITY picks the map size: HIGH resolves a tank's silhouette
// cleanly, LOW quarters the fill cost of the sun pass for weak GPUs
const SHADOW_SIZE_HI = 1024;
const SHADOW_SIZE_LO = 512;
// half-extent of the sun's ortho box, in world units, centred ahead of the
// camera — tight enough that a 1024 map still resolves a tank's silhouette
const SHADOW_RADIUS = 62;

const VS = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat4 uShadowMat;
uniform mediump float uPointMode;
uniform mediump float uPixelScale;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vFogDepth;
varying vec4 vShadowPos;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vec4 viewPos = uView * world;
  gl_Position = uProj * viewPos;
  vColor = aColor;
  // proper normal transform under non-uniform scale: for M = R*S the normal
  // matrix is R*S^-1 = mat3(M)*S^-2, and the squared per-axis scales are the
  // squared lengths of mat3(M)'s columns
  vec3 s2 = vec3(
    dot(uModel[0].xyz, uModel[0].xyz),
    dot(uModel[1].xyz, uModel[1].xyz),
    dot(uModel[2].xyz, uModel[2].xyz));
  vNormal = normalize(mat3(uModel) * (aNormal / max(s2, vec3(1e-8))));
  vWorld = world.xyz;
  vFogDepth = -viewPos.z;
  vShadowPos = uShadowMat * world;
  if (uPointMode > 0.5) {
    gl_PointSize = clamp(aNormal.x * uPixelScale / max(gl_Position.w, 0.1), 1.0, 64.0);
  }
}
`;

const FS = `
precision mediump float;
uniform vec3 uLightDir;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uUnlit;
uniform float uPointMode;
uniform float uSoftPoint;
uniform vec3 uTint;
uniform int uNumLights;
uniform vec4 uLightPosR[${MAX_LIGHTS}];   // xyz = world pos, w = 1/radius
uniform vec3 uLightCol[${MAX_LIGHTS}];
uniform sampler2D uShadowMap;
uniform float uShadowOn;
uniform float uShadowTexel;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vFogDepth;
varying vec4 vShadowPos;

float unpackDepth(vec4 c) {
  return dot(c, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}

/* 3x3 PCF over the packed depth map, feathered to nothing at the edge of the
 * sun's ortho box so geometry does not pop as the box follows the camera. */
float sunShadow(float ndl) {
  if (uShadowOn < 0.5) return 1.0;
  vec3 sp = vShadowPos.xyz / vShadowPos.w;
  sp = sp * 0.5 + 0.5;
  if (sp.z > 1.0) return 1.0;
  vec2 edge = abs(sp.xy - 0.5);
  float fade = 1.0 - smoothstep(0.40, 0.499, max(edge.x, edge.y));
  if (fade <= 0.0) return 1.0;
  // slope-scaled bias: grazing facets need much more slack than flat ones
  float bias = 0.0016 + 0.0075 * (1.0 - ndl);
  float lit = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uShadowTexel;
      float d = unpackDepth(texture2D(uShadowMap, sp.xy + o));
      lit += step(sp.z - bias, d);
    }
  }
  lit /= 9.0;
  return mix(1.0, lit, fade);
}

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
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  float diff = max(dot(N, uLightDir), 0.0);
  float shadow = mix(1.0, sunShadow(diff), step(0.5, 1.0 - uPointMode));
  // ambient is only lightly shadowed — shadowed facets go cool and deep, not
  // black, which is what keeps the arena readable in the dark
  vec3 lit = vColor * (0.32 * (0.80 + 0.20 * shadow) + 0.7 * diff * shadow);
  // specular: a tight sun highlight rakes across the facets as hulls turn
  vec3 H = normalize(uLightDir + V);
  float spec = pow(max(dot(N, H), 0.0), 28.0) * diff * shadow;
  lit += vec3(0.55, 0.62, 0.68) * spec * 0.55;
  // fresnel rim in the arena's cold key colour — reads the silhouette of every
  // hull against the void even when it is facing away from the sun. Masked off
  // near-horizontal facets: the arena floor is seen at a permanent grazing
  // angle, and an unmasked fresnel term turns the whole ground into haze.
  float rim = pow(1.0 - max(dot(N, V), 0.0), 4.0) * (1.0 - abs(N.y) * 0.9);
  lit += vec3(0.16, 0.42, 0.44) * rim * (0.30 + 0.70 * vColor);
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

/* ---- shadow pass -------------------------------------------------------- */
/* Depth-only render from the sun. The depth is packed into RGBA8 by hand
 * rather than written to a depth texture, because depth-texture support is an
 * extension on WebGL1 and this way the pass is identical everywhere. */

const SHADOW_VS = `
attribute vec3 aPos;
uniform mat4 uModel;
uniform mat4 uLightVP;
void main() {
  gl_Position = uLightVP * (uModel * vec4(aPos, 1.0));
}
`;

const SHADOW_FS = `
precision highp float;
void main() {
  const vec4 bit = vec4(1.0, 255.0, 65025.0, 16581375.0);
  const vec4 mask = vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  vec4 c = fract(gl_FragCoord.z * bit);
  c -= c.gbaa * mask;
  gl_FragColor = c;
}
`;

/* ---- post-processing shaders ------------------------------------------- */

const QUAD_VS = `
attribute vec3 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos.xy * 0.5 + 0.5;
  gl_Position = vec4(aPos.xy, 0.0, 1.0);
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

/* Composite — the whole "film" half of the look lives here:
 *   FXAA -> radial speed blur -> chromatic aberration -> bloom add ->
 *   exposure -> ACES tonemap -> grade/flash -> vignette -> grain
 * Every effect is driven by a uniform the game animates (setPostFx), so
 * boosting, taking a hit and dying all read differently on screen. */
const COMPOSITE_FS = `
precision mediump float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uTexel;
uniform float uBloomStrength;
uniform float uTime;
uniform float uExposure;
uniform float uAberration;
uniform float uRadial;
uniform float uGrain;
uniform float uVignette;
uniform float uSaturation;
uniform vec3 uGrade;
uniform vec3 uFlash;
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

/* Narkowicz's ACES approximation — the filmic shoulder that keeps stacked
 * additive glow from clipping to flat white. */
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 fromCenter = vUV - 0.5;
  float r2 = dot(fromCenter, fromCenter);

  // radial speed blur: the frame smears toward the edges under boost
  vec3 scene = fxaa(uScene, vUV, uTexel);
  if (uRadial > 0.001) {
    vec3 sm = scene;
    for (int i = 1; i <= 5; i++) {
      float k = float(i) * 0.2 * uRadial * 0.09;
      sm += texture2D(uScene, vUV - fromCenter * k).rgb;
    }
    scene = mix(scene, sm / 6.0, clamp(uRadial, 0.0, 1.0) * smoothstep(0.02, 0.25, r2));
  }

  // chromatic aberration: lens fringing that grows toward the corners
  if (uAberration > 0.001) {
    vec2 off = fromCenter * uAberration * (0.35 + r2 * 2.4);
    scene.r = texture2D(uScene, vUV + off).r;
    scene.b = texture2D(uScene, vUV - off).b;
  }

  vec3 bloom = texture2D(uBloom, vUV).rgb;
  vec3 col = (scene + bloom * uBloomStrength) * uExposure;
  col = aces(col);

  // grade: a colour multiplier plus an additive flash (hits, warps, deaths)
  col *= uGrade;
  col += uFlash;
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, uSaturation);

  // vignette
  col *= 1.0 - r2 * uVignette;

  // film grain, animated per frame and rolled off in the highlights so it
  // lives in the shadows where real grain lives
  if (uGrain > 0.001) {
    float n = hash(vUV * vec2(1024.0, 768.0) + fract(uTime) * 91.7) - 0.5;
    col += n * uGrain * (1.0 - luma * 0.7);
  }

  gl_FragColor = vec4(max(col, 0.0), 1.0);
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

    // attribute locations are forced identical in every program (see
    // _buildProgram), so one vertex-format binding serves all passes
    this.attribs = { pos: 0, normal: 1, color: 2 };
    this.uniforms = {};
    for (const name of ['uProj', 'uView', 'uModel', 'uLightDir', 'uCamPos', 'uFogColor',
                        'uFogDensity', 'uUnlit', 'uPointMode', 'uSoftPoint', 'uTint',
                        'uPixelScale', 'uNumLights', 'uLightPosR', 'uLightCol',
                        'uShadowMat', 'uShadowMap', 'uShadowOn', 'uShadowTexel']) {
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
    this.sunDir = [0.35, 0.8, 0.48];
    const ll = Math.hypot(this.sunDir[0], this.sunDir[1], this.sunDir[2]);
    this.sunDir = [this.sunDir[0] / ll, this.sunDir[1] / ll, this.sunDir[2] / ll];
    gl.uniform3fv(this.uniforms.uLightDir, this.sunDir);
    gl.uniform3f(this.uniforms.uTint, 1, 1, 1);
    gl.uniform1f(this.uniforms.uUnlit, 0);
    gl.uniform1f(this.uniforms.uPointMode, 0);
    gl.uniform1f(this.uniforms.uSoftPoint, 0);
    gl.uniform1i(this.uniforms.uNumLights, 0);
    gl.uniform1i(this.uniforms.uShadowMap, 0);
    gl.uniform1f(this.uniforms.uShadowOn, 0);
    gl.uniform1f(this.uniforms.uShadowTexel, 1 / SHADOW_SIZE_HI);
    gl.uniformMatrix4fv(this.uniforms.uShadowMat, false, m4._I);

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

    // ---- post / film state --------------------------------------------------
    this.glowEnabled = true;    // user setting (setGlow)
    this.msaaEnabled = true;    // user setting (setMsaa): RENDER QUALITY HIGH
    this.glowSupported = true;  // flipped false if FBO setup fails
    this.bloomStrength = 1.15;
    /* Film-grade knobs the game animates every frame (see setPostFx). These
     * are the defaults — a clean, slightly contrasty image with a hint of
     * grain and lens fringing, i.e. what the game looks like at rest. */
    this.fx = {
      exposure: 1.06,
      aberration: 0.0016,
      radial: 0,
      grain: 0.035,
      vignette: 0.42,
      saturation: 1.08,
      grade: [1, 1, 1],
      flash: [0, 0, 0],
    };
    try {
      this._initPost();
    } catch (e) {
      this.glowSupported = false;
    }

    // ---- shadow map ---------------------------------------------------------
    this.shadowsEnabled = true;
    this.shadowSupported = true;
    this.shadowTarget = null;
    this.shadowSize = SHADOW_SIZE_HI;
    this.shadowCenterX = 0;
    this.shadowCenterZ = 0;
    this.shadowCull = SHADOW_RADIUS * 1.9;
    this._shadowMode = false;
    this.shadowMat = m4.identity();
    try {
      this.shadowProg = this._buildPostLikeProgram(SHADOW_VS, SHADOW_FS,
        ['uModel', 'uLightVP']);
      this._ensureShadowTarget();
    } catch (e) {
      this.shadowSupported = false;
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
    // every program sees the same attribute slots, so a vertex format bound
    // for one pass stays valid across a program switch
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aNormal');
    gl.bindAttribLocation(prog, 2, 'aColor');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  _buildPostLikeProgram(vs, fs, uniformNames) {
    const gl = this.gl;
    const prog = this._buildProgram(vs, fs);
    const u = {};
    for (const n of uniformNames) u[n] = gl.getUniformLocation(prog, n);
    return { prog, aPos: 0, u };
  }

  /* ---- post-processing setup ---------------------------------------------- */

  _initPost() {
    const gl = this.gl;
    this.quadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    // xyz per vertex so the shared aPos slot keeps a 3-float layout
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), gl.STATIC_DRAW);

    this.brightProg = this._buildPostLikeProgram(QUAD_VS, BRIGHT_FS, ['uTex']);
    this.blurProg = this._buildPostLikeProgram(QUAD_VS, BLUR_FS, ['uTex', 'uDir']);
    this.compositeProg = this._buildPostLikeProgram(QUAD_VS, COMPOSITE_FS,
      ['uScene', 'uBloom', 'uTexel', 'uBloomStrength', 'uTime', 'uExposure',
       'uAberration', 'uRadial', 'uGrain', 'uVignette', 'uSaturation',
       'uGrade', 'uFlash']);

    this.sceneFbo = null;   // allocated lazily in _resizePost
    this.msaaFbo = null;    // WebGL2 only: multisampled scene target
    this.msaaBroken = false; // flipped true if MSAA setup fails; don't retry
    this.pingFbo = [null, null];
    this.postW = 0;
    this.postH = 0;
  }

  _makeTarget(w, h, depth, nearest) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // the packed-depth target must never be filtered: interpolating the packed
    // bytes produces garbage depths. Only the blur/scene targets want LINEAR.
    const filter = nearest ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
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
    if (!ok) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      if (rb) gl.deleteRenderbuffer(rb);
      throw new Error('FBO incomplete');
    }
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
    this.sceneFbo = null;
    this._dropTarget(this.msaaFbo);
    this.msaaFbo = null;
    this._dropTarget(this.pingFbo[0]);
    this.pingFbo[0] = null;
    this._dropTarget(this.pingFbo[1]);
    this.pingFbo[1] = null;
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

  /* RENDER QUALITY: HIGH multisamples the scene pass (WebGL2) and runs the
   * wider bloom; LOW renders plain and leaves the smoothing to FXAA — much
   * cheaper in fill rate. Rebuilds the offscreen targets on the next frame,
   * since depth ownership moves between the MSAA renderbuffer and the scene
   * texture. */
  setMsaa(on) {
    on = !!on;
    if (on === this.msaaEnabled) return;
    this.msaaEnabled = on;
    this.postW = 0;
  }

  setShadows(on) { this.shadowsEnabled = !!on; }

  /* (Re)allocate the sun's depth target at the size the current quality
   * setting asks for. Called on the first frame and whenever quality flips. */
  _ensureShadowTarget() {
    const want = this.msaaEnabled ? SHADOW_SIZE_HI : SHADOW_SIZE_LO;
    if (this.shadowTarget && this.shadowSize === want) return;
    this._dropTarget(this.shadowTarget);
    this.shadowTarget = null;
    this.shadowTarget = this._makeTarget(want, want, true, true);
    this.shadowSize = want;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.uShadowTexel, 1 / want);
  }

  /* Per-frame film grade. Partial objects are fine — anything omitted keeps
   * its current value, so callers can nudge one knob without restating the
   * whole grade. */
  setPostFx(o) {
    if (!o) return;
    const fx = this.fx;
    if (o.exposure !== undefined) fx.exposure = o.exposure;
    if (o.aberration !== undefined) fx.aberration = o.aberration;
    if (o.radial !== undefined) fx.radial = o.radial;
    if (o.grain !== undefined) fx.grain = o.grain;
    if (o.vignette !== undefined) fx.vignette = o.vignette;
    if (o.saturation !== undefined) fx.saturation = o.saturation;
    if (o.grade) fx.grade = o.grade;
    if (o.flash) fx.flash = o.flash;
  }

  createMesh(data, mode) {
    const gl = this.gl;
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this._boundVbo = null;   // ARRAY_BUFFER binding changed under the cache
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

  /* ---- shadow pass ---------------------------------------------------------
   * Call before beginFrame with the same camera; draw only the casters (hulls,
   * cover, debris) between begin and end. Returns false when shadows are off
   * or unsupported, in which case the caller skips the caster pass entirely. */
  beginShadow(camera) {
    if (!this.shadowsEnabled || !this.shadowSupported) return false;
    const gl = this.gl;
    try {
      this._ensureShadowTarget();
    } catch (e) {
      this.shadowSupported = false;   // GPU refused the target: stop casting
      return false;
    }
    const SHADOW_SIZE = this.shadowSize;
    const L = this.sunDir;
    // centre the sun's box a little ahead of the camera so the shadowed region
    // covers what the player is actually looking at
    // forward is (-sin yaw, -cos yaw), matching the sim's fwdX/fwdZ
    const ahead = 26;
    const cx = camera.x - Math.sin(camera.yaw) * ahead;
    const cz = camera.z - Math.cos(camera.yaw) * ahead;
    const dist = 150;
    const view = m4.lookAt(cx + L[0] * dist, L[1] * dist, cz + L[2] * dist,
      cx, 0, cz, 0, 1, 0, SUN_VIEW);
    // snap the box to whole shadow texels, or the map crawls with the camera
    // and every shadow edge shimmers
    const texel = (SHADOW_RADIUS * 2) / SHADOW_SIZE;
    const lx = view[0] * cx + view[4] * 0 + view[8] * cz + view[12];
    const ly = view[1] * cx + view[5] * 0 + view[9] * cz + view[13];
    const sx = Math.round(lx / texel) * texel - lx;
    const sy = Math.round(ly / texel) * texel - ly;
    const proj = m4.ortho(-SHADOW_RADIUS + sx, SHADOW_RADIUS + sx,
      -SHADOW_RADIUS + sy, SHADOW_RADIUS + sy, 1, dist * 2 + 120, SUN_PROJ);
    m4.multiply(proj, view, SUN_VP);
    this.shadowMat.set(SUN_VP);
    // published so the caster pass can cull everything the box can't reach
    this.shadowCenterX = cx;
    this.shadowCenterZ = cz;
    this.shadowCull = SHADOW_RADIUS * 1.9;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowTarget.fbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clearColor(1, 1, 1, 1);          // "nothing here" = maximum depth
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.clearColor(this.fogColor[0], this.fogColor[1], this.fogColor[2], 1);
    gl.useProgram(this.shadowProg.prog);
    gl.uniformMatrix4fv(this.shadowProg.u.uLightVP, false, SUN_VP);
    // render backfaces only: the depth recorded is then the *far* side of each
    // solid, which pushes acne off the lit surfaces entirely
    gl.cullFace(gl.FRONT);
    this._shadowMode = true;
    return true;
  }

  endShadow() {
    if (!this._shadowMode) return;
    const gl = this.gl;
    this._shadowMode = false;
    gl.cullFace(gl.BACK);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._shadowCastThisFrame = true;
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
        // free whatever a partial rebuild managed to allocate — this device
        // just proved memory-constrained, don't sit on orphaned targets
        this._dropTarget(this.sceneFbo);
        this.sceneFbo = null;
        this._dropTarget(this.msaaFbo);
        this.msaaFbo = null;
        this._dropTarget(this.pingFbo[0]);
        this.pingFbo[0] = null;
        this._dropTarget(this.pingFbo[1]);
        this.pingFbo[1] = null;
        this.postW = 0;
        this.postH = 0;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,
      this.glowActive ? (this.msaaFbo || this.sceneFbo).fbo : null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const proj = m4.perspective(camera.fov || 1.22, aspect, 0.1, 800, CAM_PROJ);
    let view = m4.multiply(m4.rotationY(-camera.yaw, CAM_A),
      m4.translation(-camera.x, -camera.y, -camera.z, CAM_B), CAM_C);
    view = m4.multiply(m4.rotationX(-(camera.pitch || 0), CAM_A), view, CAM_B);
    if (camera.roll) view = m4.multiply(m4.rotationZ(-camera.roll, CAM_A), view, CAM_C);

    gl.uniformMatrix4fv(this.uniforms.uProj, false, proj);
    gl.uniformMatrix4fv(this.uniforms.uView, false, view);
    gl.uniform3f(this.uniforms.uCamPos, camera.x, camera.y, camera.z);

    // hand the sun's matrix + map to the lighting shader (unit 0 is the
    // shadow map for the whole scene pass; the post passes rebind it later)
    const casting = !!this._shadowCastThisFrame;
    gl.uniform1f(this.uniforms.uShadowOn, casting ? 1 : 0);
    if (casting) {
      gl.uniformMatrix4fv(this.uniforms.uShadowMat, false, this.shadowMat);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowTarget.tex);
    }
    this._shadowCastThisFrame = false;
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
    if (this._boundVbo === vbo) return;   // same mesh drawn back-to-back
    this._boundVbo = vbo;
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
   * decal (ground marks: blend ZERO, ONE_MINUS_SRC_COLOR so the fragment
   * colour reads as an opacity mask — white darkens the floor fully, black
   * leaves it alone, which is what feathers a scorch instead of stamping a
   * hard polygon. Depth-tested but never written, so overlapping marks stack
   * instead of z-fighting),
   * soft (round points fade at the rim instead of hard-clipping),
   * nodepth (backdrop geometry: no depth test or writes — at sky distances
   * the 16-bit FBO depth buffer can't separate the layers and they z-fight,
   * so the backdrop relies on painter's order instead) */
  draw(mesh, model, opts) {
    const gl = this.gl;
    if (this._shadowMode) {
      // depth-only pass: glow, sprites and backdrops cast nothing
      if (opts && (opts.additive || opts.decal || opts.points || opts.nodepth)) return;
      gl.uniformMatrix4fv(this.shadowProg.u.uModel, false, model || this.identityModel);
      this._bindVertexFormat(mesh.vbo);
      gl.drawArrays(mesh.mode, 0, mesh.count);
      return;
    }
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
    const decal = opts && opts.decal;
    if (decal) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_COLOR);
      gl.depthMask(false);
    }
    const nodepth = opts && opts.nodepth;
    if (nodepth) {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
    this._bindVertexFormat(mesh.vbo);
    gl.drawArrays(mesh.mode, 0, mesh.count);
    if (additive || decal) {
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
    if (!particles.length || this._shadowMode) return;
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
    this._bindVertexFormat(this.particleVbo);   // same 9-float layout as meshes
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, n * 9));
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
    this._boundVbo = null;   // buffer + attrib pointers no longer match the cache

    const fullscreen = (p) => {
      gl.enableVertexAttribArray(p.aPos);
      gl.vertexAttribPointer(p.aPos, 3, gl.FLOAT, false, 0, 0);
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

    // 2) gaussian iterations (H+V each) ping-ponging at half res, each pair
    //    reaching further than the last — a wide, filmic falloff rather than a
    //    tight halo. HIGH quality affords three pairs; LOW stops at two.
    gl.useProgram(this.blurProg.prog);
    gl.uniform1i(this.blurProg.u.uTex, 0);
    let src = 0;
    const passes = this.msaaEnabled ? 6 : 4;
    for (let i = 0; i < passes; i++) {
      const dst = 1 - src;
      gl.bindFramebuffer(gl.FRAMEBUFFER, ping[dst].fbo);
      gl.bindTexture(gl.TEXTURE_2D, ping[src].tex);
      const spread = 1 + (i >> 1) * 1.6;   // later iterations reach further
      if (i % 2 === 0) gl.uniform2f(this.blurProg.u.uDir, spread / bw, 0);
      else gl.uniform2f(this.blurProg.u.uDir, 0, spread / bh);
      fullscreen(this.blurProg);
      src = dst;
    }

    // 3) composite to the canvas: graded, tonemapped scene + bloom + film
    const fx = this.fx;
    gl.useProgram(this.compositeProg.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneFbo.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ping[src].tex);
    const u = this.compositeProg.u;
    gl.uniform1i(u.uScene, 0);
    gl.uniform1i(u.uBloom, 1);
    gl.uniform2f(u.uTexel, 1 / this.canvas.width, 1 / this.canvas.height);
    gl.uniform1f(u.uBloomStrength, this.bloomStrength);
    gl.uniform1f(u.uTime, (performance.now() % 10000) / 1000);
    gl.uniform1f(u.uExposure, fx.exposure);
    gl.uniform1f(u.uAberration, fx.aberration);
    gl.uniform1f(u.uRadial, fx.radial);
    gl.uniform1f(u.uGrain, fx.grain);
    gl.uniform1f(u.uVignette, fx.vignette);
    gl.uniform1f(u.uSaturation, fx.saturation);
    gl.uniform3fv(u.uGrade, fx.grade);
    gl.uniform3fv(u.uFlash, fx.flash);
    fullscreen(this.compositeProg);

    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }
}
