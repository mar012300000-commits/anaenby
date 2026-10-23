import * as THREE from 'three';

// Paper flyers glued onto the scanned pillar. Each flyer is conformed to the real scan
// surface by ray-casting a grid onto it, then gets crumple folds, a peeled corner, a soft
// contact shadow, street dirt and worn print, and shading that follows the paper's bends.

const W = 0.297;               // A3, meters
const H = 0.42;
const EXT_W = W * 1.35;        // sampled area (paper + room for the shadow)
const EXT_H = H * 1.3;
const GX = 28;                 // surface samples across EXT_W
const GY = 38;                 // surface samples across EXT_H
const R0 = 0.28;               // approx. distance from pillar axis to a face
const PAPER_LIGHT = 0.99;        // matches the flat overcast light baked into the scan
const UP = new THREE.Vector3(0, 1, 0);

export async function createFlyers({ scan, center, specs }) {
  try {
    await Promise.all([
      document.fonts.load('800 200px Manrope'),
      document.fonts.load('500 30px "IBM Plex Mono"'),
    ]);
  } catch (e) { /* fall back to system fonts */ }
  return specs.map((spec, i) => buildFlyer(spec, i, scan, center));
}

function buildFlyer(spec, index, scan, center) {
  const rand = mulberry32(1000 + index * 77);

  // face frame: n = outward normal, t = viewer's right, u/v = rotated paper axes
  const n = new THREE.Vector3(spec.normal[0], 0, spec.normal[1]).normalize();
  const t = new THREE.Vector3(n.z, 0, -n.x);
  const rot = THREE.MathUtils.degToRad(spec.rot);
  const u = t.clone().multiplyScalar(Math.cos(rot)).addScaledVector(UP, Math.sin(rot));
  const v = t.clone().multiplyScalar(-Math.sin(rot)).addScaledVector(UP, Math.cos(rot));
  const base = new THREE.Vector3(center.x, spec.y, center.z)
    .addScaledVector(t, spec.lateral)
    .addScaledVector(n, R0);

  // --- measure the real surface height under the flyer ---
  const patch = localPatch(scan, base, 0.6);
  const ray = new THREE.Raycaster();
  ray.far = 0.8;
  const dir = n.clone().negate();
  const origin = new THREE.Vector3();
  const raw = new Float32Array(GX * GY);

  for (let j = 0; j < GY; j++) {
    for (let i = 0; i < GX; i++) {
      const a = (i / (GX - 1) - 0.5) * EXT_W;
      const b = (j / (GY - 1) - 0.5) * EXT_H;
      origin.copy(base).addScaledVector(u, a).addScaledVector(v, b).addScaledVector(n, 0.4);
      ray.set(origin, dir);
      const hit = ray.intersectObject(patch, false)[0];
      raw[j * GX + i] = hit ? 0.4 - hit.distance : NaN;
    }
  }
  patch.geometry.dispose();
  fillMissing(raw);

  const smooth1 = blur(raw, 1);
  const smooth3 = blur(raw, 4);
  const paperH = new Float32Array(GX * GY);
  const shadowH = new Float32Array(GX * GY);
  for (let k = 0; k < raw.length; k++) {
    // paper can't follow sharp scan noise: follow the smoothed surface, never sink into it
    paperH[k] = Math.max(smooth3[k] + 0.0035, smooth1[k] + 0.002);
    shadowH[k] = Math.max(smooth3[k] + 0.0015, smooth1[k] + 0.0008);
  }

  const toWorld = (x, y, h, out) =>
    out.copy(base).addScaledVector(u, x).addScaledVector(v, y).addScaledVector(n, h);

  // --- paper mesh ---
  const peel = { br: [1, -1], bl: [-1, -1], tr: [1, 1], tl: [-1, 1] }[spec.peel];
  const pcx = peel[0] * W / 2, pcy = peel[1] * H / 2;
  const peelR = 0.12 + rand() * 0.04;
  const peelLift = 0.028 + rand() * 0.02;

  // the sheet was crumpled before it was pasted: a few sharp folds plus soft unevenness
  const creases = Array.from({ length: 4 + Math.floor(rand() * 3) }, () => {
    const ang = rand() * Math.PI;
    return {
      x: (rand() - 0.5) * W * 0.9,
      y: (rand() - 0.5) * H * 0.9,
      dx: Math.cos(ang),
      dy: Math.sin(ang),
      len: 0.07 + rand() * 0.22,                        // half length of the fold
      w: 0.01 + rand() * 0.022,                         // how far the fold spreads
      amp: (rand() < 0.5 ? -1 : 1) * (0.0012 + rand() * 0.002),
    };
  });
  const bumps = valueNoise(rand);

  const geo = new THREE.PlaneGeometry(W, H, 48, 68);
  const P = geo.attributes.position;
  const p = new THREE.Vector3();
  for (let k = 0; k < P.count; k++) {
    let x = P.getX(k), y = P.getY(k);
    const h = sample(paperH, x, y);

    // folds: a sharp ridge or valley along each crease, fading towards its ends
    let fold = 0;
    for (const c of creases) {
      const rx = x - c.x, ry = y - c.y;
      const along = rx * c.dx + ry * c.dy;
      const across = Math.abs(-rx * c.dy + ry * c.dx);
      const fade = Math.max(0, 1 - Math.abs(along) / c.len);
      fold += c.amp * Math.pow(Math.max(0, 1 - across / c.w), 1.4) * Math.sqrt(fade);
    }
    // soft unevenness of paper that dried on a rough surface
    const lumpy = 0.0016 * (bumps(x * 14, y * 14) - 0.5) + 0.0006 * (bumps(x * 37 + 9, y * 37) - 0.5);

    // edges stay pasted down, so the crumpling is flatter there
    const edge = Math.max(0, Math.min(1, (W / 2 - Math.abs(x)) / 0.035, (H / 2 - Math.abs(y)) / 0.035));
    // never let a valley dip into the pillar
    const relief = Math.max(-0.001, (fold + lumpy) * (0.35 + 0.65 * edge) + 0.0018 * edge);

    // corner that came unglued and curls away from the pillar
    const d = Math.hypot(x - pcx, y - pcy);
    const c = Math.max(0, 1 - d / peelR);
    const lift = peelLift * Math.pow(c, 2.2);
    x -= Math.sign(pcx) * lift * 0.35;
    y -= Math.sign(pcy) * lift * 0.35;

    toWorld(x, y, h + lift + relief, p);
    P.setXYZ(k, p.x, p.y, p.z);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(P.count * 3), 3));

  const map = new THREE.CanvasTexture(paperCanvas(spec, rand, creases));
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;

  const material = new THREE.MeshBasicMaterial({
    map,
    vertexColors: true,
    alphaTest: 0.5,              // ragged edge and a small tear are cut out of the texture
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = 2;

  // --- soft contact shadow on the pillar ---
  const sgeo = new THREE.PlaneGeometry(EXT_W, EXT_H, GX - 1, GY - 1);
  const SP = sgeo.attributes.position;
  for (let k = 0; k < SP.count; k++) {
    const x = SP.getX(k), y = SP.getY(k);
    toWorld(x, y, sample(shadowH, x, y), p);
    SP.setXYZ(k, p.x, p.y, p.z);
  }
  sgeo.computeBoundingSphere();
  const smap = new THREE.CanvasTexture(shadowCanvas(pcx, pcy, peelR));
  const shadow = new THREE.Mesh(sgeo, new THREE.MeshBasicMaterial({
    map: smap,
    color: 0x000000,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -0.5,
    polygonOffsetUnits: -2,
  }));
  shadow.renderOrder = 1;

  const group = new THREE.Group();
  group.add(shadow, mesh);

  // bake soft sky light from above-front into vertex colors, so bends and the peel read
  const L = n.clone().multiplyScalar(0.7).addScaledVector(UP, 0.7).normalize();
  const flatDot = n.dot(L);
  const N = geo.attributes.normal;
  const C = geo.attributes.color;
  const nv = new THREE.Vector3();
  for (let k = 0; k < N.count; k++) {
    nv.fromBufferAttribute(N, k);
    // brightness follows how far the paper tilts towards or away from the sky
    const shade = THREE.MathUtils.clamp(1 + 1.7 * (nv.dot(L) - flatDot), 0.55, 1.08);
    const lin = Math.pow(PAPER_LIGHT * shade, 2.2);
    C.setXYZ(k, lin, lin, lin);
  }

  const flyer = {
    spec,
    href: spec.href,
    group,
    mesh,
    normal: n,
    centerLocal: toWorld(0, 0, sample(paperH, 0, 0), new THREE.Vector3()),
    setHover(on) {
      material.color.setScalar(on ? 1.18 : 1);
    },
  };
  mesh.userData.flyer = flyer;
  return flyer;
}

// ---------- surface helpers ----------

// triangles of the scan near p, as a small mesh that is cheap to ray-cast
function localPatch(scan, p, radius) {
  const pos = [];
  const r2 = radius * radius;
  scan.traverse((m) => {
    if (!m.isMesh) return;
    const g = m.geometry;
    const P = g.attributes.position, I = g.index;
    const count = I ? I.count : P.count;
    for (let i = 0; i < count; i += 3) {
      const a = I ? I.getX(i) : i, b = I ? I.getX(i + 1) : i + 1, c = I ? I.getX(i + 2) : i + 2;
      const dx = (P.getX(a) + P.getX(b) + P.getX(c)) / 3 - p.x;
      const dy = (P.getY(a) + P.getY(b) + P.getY(c)) / 3 - p.y;
      const dz = (P.getZ(a) + P.getZ(b) + P.getZ(c)) / 3 - p.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      for (const k of [a, b, c]) pos.push(P.getX(k), P.getY(k), P.getZ(k));
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeBoundingSphere();
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
}

function fillMissing(arr) {
  let sum = 0, cnt = 0;
  for (const x of arr) if (!Number.isNaN(x)) { sum += x; cnt++; }
  const mean = cnt ? sum / cnt : 0;
  for (let k = 0; k < arr.length; k++) if (Number.isNaN(arr[k])) arr[k] = mean;
}

function blur(src, passes) {
  let a = Float32Array.from(src);
  for (let pass = 0; pass < passes; pass++) {
    const b = new Float32Array(a.length);
    for (let j = 0; j < GY; j++) {
      for (let i = 0; i < GX; i++) {
        let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= GX || jj >= GY) continue;
            s += a[jj * GX + ii]; c++;
          }
        }
        b[j * GX + i] = s / c;
      }
    }
    a = b;
  }
  return a;
}

// bilinear lookup of a GX×GY grid at paper-plane coords (x, y)
function sample(grid, x, y) {
  const gx = THREE.MathUtils.clamp((x / EXT_W + 0.5) * (GX - 1), 0, GX - 1);
  const gy = THREE.MathUtils.clamp((y / EXT_H + 0.5) * (GY - 1), 0, GY - 1);
  const i0 = Math.min(Math.floor(gx), GX - 2), j0 = Math.min(Math.floor(gy), GY - 2);
  const fx = gx - i0, fy = gy - j0;
  const v00 = grid[j0 * GX + i0], v10 = grid[j0 * GX + i0 + 1];
  const v01 = grid[(j0 + 1) * GX + i0], v11 = grid[(j0 + 1) * GX + i0 + 1];
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

// ---------- textures ----------

function paperCanvas(spec, rand, creases) {
  const cw = 1024, ch = Math.round(1024 * H / W);
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  const px = (x) => (x / W + 0.5) * cw;      // paper meters → canvas pixels
  const py = (y) => (0.5 - y / H) * ch;
  const clear = (rgba) => rgba.replace(/[\d.]+\)$/, '0)');
  const blob = (x, y, r, rgba) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba);
    g.addColorStop(1, clear(rgba));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  // --- paper: off-white, slightly yellowed towards the bottom where rain sits longest ---
  ctx.fillStyle = '#f3f3f0'; // PAPER ALT
  ctx.fillRect(0, 0, cw, ch);
  const tone = ctx.createLinearGradient(0, 0, 0, ch);
  tone.addColorStop(0, 'rgba(255,255,255,0.25)');
  tone.addColorStop(0.6, 'rgba(200,190,160,0.05)');
  tone.addColorStop(1, 'rgba(170,150,100,0.16)');
  ctx.fillStyle = tone;
  ctx.fillRect(0, 0, cw, ch);

  // --- print on its own layer so it can wear off independently ---
  const ink = document.createElement('canvas');
  ink.width = cw; ink.height = ch;
  const ic = ink.getContext('2d');
  const m = Math.round(cw * 0.07);           // 7% safe field
  const mono = (size) => `500 ${size}px "IBM Plex Mono", "DejaVu Sans Mono", monospace`;
  ic.textBaseline = 'alphabetic';
  ic.fillStyle = '#0a0a0a';
  ic.font = mono(30);
  ic.textAlign = 'left';
  ic.fillText('ANAENBY / OBJECT ARCHIVE', m, m + 22);
  ic.textAlign = 'right';
  ic.fillText(spec.index, cw - m, m + 22);
  ic.fillRect(m, m + 50, cw - 2 * m, 3);

  let size = 300;
  const setWord = () => {
    ic.font = `800 ${size}px Manrope, Arial, sans-serif`;
    if ('letterSpacing' in ic) ic.letterSpacing = `${Math.round(-size * 0.035)}px`;
  };
  setWord();
  while (ic.measureText(spec.label).width > cw - 2 * m && size > 80) { size -= 6; setWord(); }
  ic.textAlign = 'left';
  ic.fillText(spec.label, m - size * 0.04, ch * 0.6);
  if ('letterSpacing' in ic) ic.letterSpacing = '0px';

  ic.font = mono(34);
  ic.fillStyle = '#0000ee';                  // LINK: this sheet is a way in
  ic.fillText('OPEN FIELD ↗', m, ch - m);
  ic.fillRect(m, ch - m + 12, ic.measureText('OPEN FIELD ↗').width, 3);

  // wear: pinholes in the ink and a few scuffs
  ic.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 2600; i++) {
    ic.fillStyle = `rgba(0,0,0,${0.3 + rand() * 0.7})`;
    ic.beginPath();
    ic.arc(rand() * cw, rand() * ch, 0.6 + rand() * 1.8, 0, Math.PI * 2);
    ic.fill();
  }
  for (let i = 0; i < 7; i++) {
    const x0 = rand() * cw, y0 = ch * (0.3 + rand() * 0.5), a = rand() * Math.PI, l = 60 + rand() * 260;
    ic.strokeStyle = `rgba(0,0,0,${0.35 + rand() * 0.4})`;
    ic.lineWidth = 1 + rand() * 2.5;
    ic.beginPath();
    ic.moveTo(x0, y0);
    ic.quadraticCurveTo(
      x0 + Math.cos(a) * l * 0.5 + (rand() - 0.5) * 30, y0 + Math.sin(a) * l * 0.5 + (rand() - 0.5) * 30,
      x0 + Math.cos(a) * l, y0 + Math.sin(a) * l);
    ic.stroke();
  }
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(ink, 0, 0);
  ctx.restore();
  // one patch where a sleeve or the rain rubbed the print paler
  const rub = ctx.createRadialGradient(cw * (0.3 + rand() * 0.4), ch * (0.55 + rand() * 0.1), 0, cw / 2, ch * 0.6, 260);
  rub.addColorStop(0, 'rgba(243,243,240,0.28)');
  rub.addColorStop(1, 'rgba(243,243,240,0)');
  ctx.fillStyle = rub;
  ctx.fillRect(0, 0, cw, ch);

  // --- folds: the same creases as in the geometry, one lit side and one dark side ---
  for (const c of creases) {
    const x0 = px(c.x - c.dx * c.len), y0 = py(c.y - c.dy * c.len);
    const x1 = px(c.x + c.dx * c.len), y1 = py(c.y + c.dy * c.len);
    const nx = -(y1 - y0), ny = x1 - x0, nl = Math.hypot(nx, ny) || 1;
    const ox = (nx / nl) * 2, oy = (ny / nl) * 2;
    const line = (dx, dy, style, width) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, clear(style));
      g.addColorStop(0.5, style);
      g.addColorStop(1, clear(style));
      ctx.strokeStyle = g;
      ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x0 + dx, y0 + dy); ctx.lineTo(x1 + dx, y1 + dy); ctx.stroke();
    };
    line(-ox, -oy, 'rgba(60,50,35,0.16)', 2);
    line(ox, oy, 'rgba(255,255,255,0.55)', 2.5);
    line(-ox * 4, -oy * 4, 'rgba(60,50,35,0.05)', 10);
  }

  // --- dirt ---
  // grime, heavier towards the bottom and the edges
  for (let i = 0; i < 26; i++) {
    const nearEdge = rand() < 0.5;
    const x = nearEdge ? (rand() < 0.5 ? rand() * 120 : cw - rand() * 120) : rand() * cw;
    const y = ch * Math.pow(rand(), 0.55);
    const r = 80 + rand() * 30, g = 70 + rand() * 25, b = 50 + rand() * 20;
    blob(x, y, 30 + rand() * 170, `rgba(${r | 0},${g | 0},${b | 0},${(0.04 + rand() * 0.09).toFixed(3)})`);
  }
  // rain streaks running down from the top edge and from the folds
  for (let i = 0; i < 9; i++) {
    const x = rand() * cw, y0 = rand() < 0.6 ? 0 : rand() * ch * 0.6, len = 150 + rand() * 520, wdt = 2 + rand() * 9;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + len);
    g.addColorStop(0, `rgba(95,85,60,${(0.06 + rand() * 0.1).toFixed(3)})`);
    g.addColorStop(1, 'rgba(95,85,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y0, wdt, len);
  }
  // wheat-paste stains where the glue soaked through near the edges
  for (let i = 0; i < 14; i++) {
    const side = Math.floor(rand() * 4);
    const along = rand();
    const x = side === 0 ? 10 + rand() * 50 : side === 1 ? cw - 10 - rand() * 50 : along * cw;
    const y = side === 2 ? 10 + rand() * 50 : side === 3 ? ch - 10 - rand() * 50 : along * ch;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, 0.35 + rand() * 0.5);
    blob(0, 0, 40 + rand() * 90, `rgba(150,128,75,${(0.07 + rand() * 0.07).toFixed(3)})`);
    ctx.restore();
  }
  // a dried drop ring
  ctx.strokeStyle = 'rgba(120,100,70,0.12)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(cw * (0.2 + rand() * 0.6), ch * (0.65 + rand() * 0.25), 30 + rand() * 30, 22 + rand() * 25, rand(), 0, Math.PI * 2);
  ctx.stroke();
  // dust and street grit
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(40,35,28,${(0.08 + rand() * 0.35).toFixed(3)})`;
    ctx.fillRect(rand() * cw, ch * Math.pow(rand(), 0.7), 1 + rand() * 2, 1 + rand() * 2);
  }
  // darker, handled edges
  ctx.save();
  ctx.filter = 'blur(16px)';
  ctx.strokeStyle = 'rgba(80,68,48,0.2)';
  ctx.lineWidth = 36;
  ctx.strokeRect(0, 0, cw, ch);
  ctx.restore();

  // --- paper grain ---
  const img = ctx.getImageData(0, 0, cw, ch);
  const d = img.data;
  for (let k = 0; k < d.length; k += 4) {
    const delta = (rand() - 0.5) * 16;
    d[k] += delta; d[k + 1] += delta; d[k + 2] += delta;
  }
  ctx.putImageData(img, 0, 0);

  // --- ragged edge and one small tear, cut out through alpha ---
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  for (let i = 0; i < 420; i++) {
    const t = rand(), r = 1 + rand() * 3.5, side = Math.floor(rand() * 4);
    const x = side === 0 ? 0 : side === 1 ? cw : t * cw;
    const y = side === 2 ? 0 : side === 3 ? ch : t * ch;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const fromTop = rand() < 0.5;
  const tx = cw * (0.25 + rand() * 0.5), depth = 18 + rand() * 26, span = 36 + rand() * 50;
  const ty = fromTop ? 0 : ch;
  const dirY = fromTop ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(tx - span / 2, ty);
  for (let s = 0; s <= 8; s++) {
    const f = s / 8;
    ctx.lineTo(
      tx - span / 2 + f * span + (rand() - 0.5) * 8,
      ty + dirY * (Math.sin(f * Math.PI) * depth + (rand() - 0.5) * 6));
  }
  ctx.lineTo(tx + span / 2, ty);
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  return cv;
}

// smooth 2D value noise in [0, 1], seeded
function valueNoise(rand) {
  const N = 64;
  const grid = Float32Array.from({ length: N * N }, () => rand());
  const at = (i, j) => grid[((j % N + N) % N) * N + ((i % N + N) % N)];
  return (x, y) => {
    const i = Math.floor(x), j = Math.floor(y);
    const fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * sx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * sx;
    return a + (b - a) * sy;
  };
}

function shadowCanvas(pcx, pcy, peelR) {
  const cw = 256, ch = Math.round(256 * EXT_H / EXT_W);
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  const sx = cw / EXT_W, sy = ch / EXT_H;
  const px = (x) => cw / 2 + x * sx;
  const py = (y) => ch / 2 - y * sy;

  ctx.filter = 'blur(6px)';
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  const drop = 0.006; // light comes from above
  ctx.fillRect(px(-W / 2), py(H / 2 - drop), W * sx, H * sy);

  // deeper, wider shadow under the peeled corner
  ctx.filter = 'blur(10px)';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.arc(px(pcx * 0.97), py(pcy - 0.012), peelR * 0.55 * sx, 0, Math.PI * 2);
  ctx.fill();
  return cv;
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
