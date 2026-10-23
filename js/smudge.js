import * as THREE from 'three';

// Smears the band and show names on the real posters of the scanned pillar so they stop
// being readable; the rest of each poster stays sharp. Done in the scan's fragment shader:
// only fragments inside the title boxes get a two-scale blur plus a wavy, rubbed-in offset.
// The texture file itself is never modified.

const BLUR_RADIUS = 0.019;  // meters on the surface: kills small type
const WASH_RADIUS = 0.045;  // meters: wide pass that flattens big headline letters
const WASH = 0.45;          // share of the wide pass in the mix
const WARP = 0.008;         // meters, peak-to-peak wobble of the smear
const TAPS = 12;
const WASH_TAPS = 8;

const GLSL_VERTEX = /* glsl */ `
attribute float aUvPerM;
varying vec3 vScanPos;
varying float vUvPerM;
`;

const GLSL_COMMON = /* glsl */ `
varying vec3 vScanPos;
varying float vUvPerM;
uniform vec2 uPillar;
uniform vec2 uFaces[2];
uniform vec4 uTitles[TITLE_COUNT];     // per title: lateral min/max, height min/max (meters)
uniform float uTitleFace[TITLE_COUNT]; // which face each title sits on

float smudgeHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float smudgeNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(smudgeHash(i), smudgeHash(i + vec2(1, 0)), u.x),
             mix(smudgeHash(i + vec2(0, 1)), smudgeHash(i + vec2(1, 1)), u.x), u.y);
}
// 1 inside a title box on its pillar face, 0 elsewhere, with soft borders
float posterMask(vec3 p) {
  vec2 q = p.xz - uPillar;
  float m = 0.0;
  for (int i = 0; i < TITLE_COUNT; i++) {
    vec2 n = uFaces[int(uTitleFace[i])];
    float d = dot(q, n);
    float lat = dot(q, vec2(n.y, -n.x));   // viewer's right is positive
    vec4 r = uTitles[i];
    // generous depth range: some posters hang off the pillar like loose flaps
    float onFace = smoothstep(0.17, 0.22, d) * (1.0 - smoothstep(0.55, 0.65, d));
    float inX = smoothstep(r.x - 0.03, r.x, lat) * (1.0 - smoothstep(r.y, r.y + 0.03, lat));
    float inY = smoothstep(r.z - 0.03, r.z, p.y) * (1.0 - smoothstep(r.w, r.w + 0.03, p.y));
    m = max(m, onFace * inX * inY);
  }
  return m;
}
`;

const GLSL_MAP = /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  float smudge = posterMask( vScanPos );
  // vUvPerM turns surface meters into texture units for this triangle
  vec2 sp = vec2( vScanPos.x + vScanPos.z, vScanPos.y );
  vec2 warp = vec2( smudgeNoise( sp * 9.0 ), smudgeNoise( sp * 9.0 + 17.3 ) ) - 0.5;
  vec2 base = vMapUv + warp * vUvPerM * ${WARP.toFixed(4)};
  // read pre-blurred mip levels so the sparse taps melt into one soft smear
  float texels = vUvPerM * 8192.0;
  float blurBias = log2( max( 1.0, texels * ${BLUR_RADIUS.toFixed(4)} / 3.0 ) );
  float washBias = log2( max( 1.0, texels * ${WASH_RADIUS.toFixed(4)} / 4.0 ) );
  vec4 acc = vec4( 0.0 );
  for ( int i = 0; i < ${TAPS}; i++ ) {
    float fi = float( i ) + 0.5;
    float a = fi * 2.39996;
    acc += texture2D( map, base + vec2( cos( a ), sin( a ) ) * sqrt( fi / ${TAPS}.0 ) * vUvPerM * ${BLUR_RADIUS.toFixed(4)}, blurBias );
  }
  vec4 wash = vec4( 0.0 );
  for ( int i = 0; i < ${WASH_TAPS}; i++ ) {
    float fi = float( i ) + 0.5;
    float a = fi * 2.39996 + 1.3;
    wash += texture2D( map, base + vec2( cos( a ), sin( a ) ) * sqrt( fi / ${WASH_TAPS}.0 ) * vUvPerM * ${WASH_RADIUS.toFixed(4)}, washBias );
  }
  vec4 smeared = mix( acc / ${TAPS}.0, wash / ${WASH_TAPS}.0, ${WASH.toFixed(2)} );
  sampledDiffuseColor = mix( sampledDiffuseColor, smeared, smudge );
  diffuseColor *= sampledDiffuseColor;
#endif
`;

// texel density differs per UV island (≈900–2800 px/m on the pillar), so store it per
// triangle; the scan geometry is non-indexed, so each triangle owns its three vertices
function addUvDensity(geometry) {
  const P = geometry.attributes.position, U = geometry.attributes.uv;
  const out = new Float32Array(P.count);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const ua = new THREE.Vector2(), ub = new THREE.Vector2();
  for (let i = 0; i + 2 < P.count; i += 3) {
    let uv = 0, pos = 0;
    for (const [m, n] of [[0, 1], [1, 2], [2, 0]]) {
      pos += a.fromBufferAttribute(P, i + m).distanceTo(b.fromBufferAttribute(P, i + n));
      uv += ua.fromBufferAttribute(U, i + m).distanceTo(ub.fromBufferAttribute(U, i + n));
    }
    const d = pos > 1e-6 ? THREE.MathUtils.clamp(uv / pos, 0.05, 0.5) : 0.11;
    out[i] = out[i + 1] = out[i + 2] = d;
  }
  geometry.setAttribute('aUvPerM', new THREE.BufferAttribute(out, 1));
}

export function smudgePosters(material, scan, { center, faces, titles }) {
  scan.traverse((m) => {
    if (m.isMesh && !m.geometry.index && m.geometry.attributes.uv) addUvDensity(m.geometry);
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPillar = { value: new THREE.Vector2(center.x, center.z) };
    shader.uniforms.uFaces = { value: faces.map(([x, z]) => new THREE.Vector2(x, z)) };
    shader.uniforms.uTitles = { value: titles.map((t) => new THREE.Vector4(t.lat[0], t.lat[1], t.y[0], t.y[1])) };
    shader.uniforms.uTitleFace = { value: titles.map((t) => t.face) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + GLSL_VERTEX)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvScanPos = position;\nvUvPerM = aUvPerM;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n#define TITLE_COUNT ${titles.length}\n` + GLSL_COMMON)
      .replace('#include <map_fragment>', GLSL_MAP);
  };
  material.needsUpdate = true;
}
