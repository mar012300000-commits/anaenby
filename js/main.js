import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createFlyers } from './flyers.js';
import { smudgePosters } from './smudge.js';

const MODEL_DIR = 'models/scan/';
const OBJ_FILE = 'Scaniverse_2026_09_28_190025.obj';
const TEXTURE_FILE = 'Scaniverse_2026_09_28_190025.jpg';

// axis of the three-sided poster pillar in scan coordinates (meters)
const PILLAR = { x: -0.017, z: 0.065 };

// flyers glued to the pillar faces; normal = outward face normal (x, z)
const FLYERS = [
  { label: 'shop',    index: '01 / 03', href: 'shop.html',    normal: [0.9995, -0.0331], lateral: 0.07,  y: 1.50, rot: -2.5, peel: 'br' },
  { label: 'persons', index: '02 / 03', href: 'persons.html', normal: [-0.4693, 0.8830], lateral: -0.09, y: 1.38, rot: 3.2,  peel: 'tr' },
  { label: 'project', index: '03 / 03', href: 'project.html', normal: [-0.5319, -0.8468], lateral: 0.06, y: 1.58, rot: -1.4, peel: 'bl' },
];

// band and show names printed on the real posters, blurred so they are not readable;
// face 0 = the PERSONS side, face 1 = the PROJECT side; lat/y in scan meters
const POSTER_TITLES = [
  { face: 0, lat: [-0.245, 0.323], y: [2.525, 2.659] }, // green banner name
  { face: 0, lat: [-0.185, 0.195], y: [2.453, 2.548] }, // red show title under it
  { face: 0, lat: [-0.311, 0.263], y: [1.582, 1.777] }, // large band name
  { face: 1, lat: [-0.305, 0.233], y: [2.285, 2.602] }, // two-line band name, top poster
  { face: 1, lat: [-0.275, 0.293], y: [1.376, 1.675] }, // red band name
  { face: 1, lat: [-0.144, 0.156], y: [1.256, 1.334] }, // singer's name
  { face: 1, lat: [-0.263, 0.293], y: [1.197, 1.262] }, // album line
];

// pieces of the scan to remove, as boxes in scan meters: the broken post beside the pillar
// (its column starts above the asphalt, which lies at 0.3–0.5 m there)
const CUT_BOXES = [
  { min: [-0.68, 0.52, 1.44], max: [-0.40, 2.70, 1.76] },
];

// drop every triangle whose centre falls inside one of the boxes (geometry is non-indexed)
function cutOut(obj, boxes) {
  obj.traverse((m) => {
    if (!m.isMesh || m.geometry.index) return;
    const g = m.geometry, P = g.attributes.position;
    const keep = [];
    for (let i = 0; i < P.count; i += 3) {
      const cx = (P.getX(i) + P.getX(i + 1) + P.getX(i + 2)) / 3;
      const cy = (P.getY(i) + P.getY(i + 1) + P.getY(i + 2)) / 3;
      const cz = (P.getZ(i) + P.getZ(i + 1) + P.getZ(i + 2)) / 3;
      const inside = boxes.some((b) =>
        cx > b.min[0] && cx < b.max[0] && cy > b.min[1] && cy < b.max[1] && cz > b.min[2] && cz < b.max[2]);
      if (!inside) keep.push(i);
    }
    if (keep.length * 3 === P.count) return;
    for (const [name, attr] of Object.entries(g.attributes)) {
      const s = attr.itemSize;
      const out = new Float32Array(keep.length * 3 * s);
      keep.forEach((i, k) => out.set(attr.array.subarray(i * s, (i + 3) * s), k * 3 * s));
      g.setAttribute(name, new THREE.BufferAttribute(out, s));
    }
    g.computeBoundingBox();
    g.computeBoundingSphere();
  });
}

// intro timing: the wordmark holds the screen at least this long before docking
const INTRO_MIN_MS = 1600;
const pageStart = performance.now();

const canvas = document.getElementById('scene');
const progressEl = document.getElementById('progress');
const fadeEl = document.getElementById('fade');

// --- renderer / scene / camera ---
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a); // INK

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.02, 100);
camera.position.set(3, 2, 4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false; // the scene stays centred on the pillar

// after the intro the camera rests on the SHOP flyer with a slow sway;
// the sway stops for good once the visitor moves the camera themselves
let userMoved = false;
let hovered = null;
let flight = null;
let intro = null;
let homeView;
let swayTime = 0;
let swayReady = false; // set once the intro has landed on the SHOP flyer
let lastFrame = performance.now();
controls.addEventListener('start', () => { userMoved = true; });

// --- loading ---
const progress = { obj: 0, tex: 0 };
function updateProgress() {
  // OBJ ~7MB, texture ~9.5MB
  progressEl.style.width = Math.round(progress.obj * 42 + progress.tex * 58) + '%';
}
const onProgress = (key) => (e) => {
  if (e.lengthComputable) { progress[key] = e.loaded / e.total; updateProgress(); }
};

const [scan, texture] = await Promise.all([
  new OBJLoader().loadAsync(MODEL_DIR + OBJ_FILE, onProgress('obj')),
  new THREE.TextureLoader().loadAsync(MODEL_DIR + TEXTURE_FILE, onProgress('tex')),
]);
texture.colorSpace = THREE.SRGBColorSpace;
texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
cutOut(scan, CUT_BOXES);

// scans already contain baked lighting, so render them unlit
const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
// blur the band names on the real posters, keep the rest of them sharp
smudgePosters(material, scan, {
  center: PILLAR,
  faces: [FLYERS[1].normal, FLYERS[2].normal],
  titles: POSTER_TITLES,
});
scan.traverse((child) => {
  if (child.isMesh) child.material = material;
});

const flyers = await createFlyers({ scan, center: PILLAR, specs: FLYERS });
for (const f of flyers) scan.add(f.group);
const flyerMeshes = flyers.map((f) => f.mesh);

fitToView(scan);
scene.add(scan);
progressEl.style.width = '100%';

// intro: the camera starts on a wide shot of the pillar and swings in on the SHOP flyer
// while the wordmark docks. Both shots orbit the pillar axis (spherical coordinates).
const deg = THREE.MathUtils.degToRad;
const shopTheta = Math.atan2(flyers[0].normal.x, flyers[0].normal.z);
const introShot = {
  sph: new THREE.Spherical(5.4, deg(68), shopTheta + deg(70)),
  target: new THREE.Vector3(0, 1.45, 0),
};
setCamera(introShot.sph, introShot.target);
controls.enabled = false;
setTimeout(startIntro, Math.max(250, INTRO_MIN_MS - (performance.now() - pageStart)));

function setCamera(sph, target) {
  controls.target.copy(target);
  camera.position.setFromSpherical(sph).add(target);
  camera.lookAt(target);
}

function startIntro() {
  document.body.classList.add('ready');
  intro = { t0: performance.now() + 250, dur: 3400 };
}

const introSph = new THREE.Spherical();
const introTarget = new THREE.Vector3();
function stepIntro(now) {
  const k = Math.min(1, Math.max(0, (now - intro.t0) / intro.dur));
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  const a = introShot.sph, b = homeView.sph;
  introSph.set(
    THREE.MathUtils.lerp(a.radius, b.radius, e),
    THREE.MathUtils.lerp(a.phi, b.phi, e),
    THREE.MathUtils.lerp(a.theta, b.theta, e),
  );
  introTarget.lerpVectors(introShot.target, homeView.target, e);
  setCamera(introSph, introTarget);
  if (k >= 1) {
    intro = null;
    swayTime = 0;
    swayReady = true;
    controls.enabled = true;
  }
}

// slow idle sway around the SHOP close-up; holds still while a flyer is under the pointer
const swaySph = new THREE.Spherical();
function stepSway(dt) {
  if (!hovered) swayTime += dt;
  const t = swayTime / 1000;
  const b = homeView.sph;
  swaySph.set(b.radius, b.phi + deg(1.2) * Math.sin(t * 0.31), b.theta + deg(4) * Math.sin(t * 0.2));
  setCamera(swaySph, homeView.target);
}

// put the pillar at the origin so everything rotates around it, then frame the SHOP flyer:
// close and slightly from the side, still orbiting the pillar axis at the flyer's height
function fitToView(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.set(-PILLAR.x, -box.min.y, -PILLAR.z);
  obj.updateMatrixWorld(true);

  const shop = flyers[0];
  const shopY = obj.localToWorld(shop.centerLocal.clone()).y;
  const theta = Math.atan2(shop.normal.x, shop.normal.z);
  const sph = new THREE.Spherical(1.65, THREE.MathUtils.degToRad(84), theta + THREE.MathUtils.degToRad(14));
  const target = new THREE.Vector3(0, shopY, 0);

  controls.target.copy(target);
  camera.position.setFromSpherical(sph).add(target);
  camera.updateProjectionMatrix();
  controls.minDistance = 0.7;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI * 0.55;
  controls.update();
  homeView = { sph, pos: camera.position.clone(), target: target.clone() };
}

// --- flyer interaction ---
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function pick(e) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  scan.updateMatrixWorld();
  const hit = raycaster.intersectObjects(flyerMeshes, false)[0];
  if (!hit) return null;
  const flyer = hit.object.userData.flyer;
  // ignore flyers on the far side of the pillar
  return camera.position.clone().sub(hit.point).dot(flyer.normal) > 0 ? flyer : null;
}

function setHovered(flyer) {
  if (flyer === hovered) return;
  hovered?.setHover(false);
  hovered = flyer;
  hovered?.setHover(true);
  canvas.style.cursor = hovered ? 'pointer' : '';
}

let downAt = null;
canvas.addEventListener('pointermove', (e) => {
  if (flight || intro || e.pointerType === 'touch') return;
  setHovered(pick(e));
});
canvas.addEventListener('pointerleave', () => setHovered(null));
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || flight || intro) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 6) return; // that was a drag, not a click
  const flyer = pick(e);
  if (flyer) flyTo(flyer);
});

// camera glides up to the flyer, screen fades, then the page opens
function flyTo(flyer) {
  const center = scan.localToWorld(flyer.centerLocal.clone());
  flight = {
    flyer,
    t0: performance.now(),
    dur: 1100,
    fromPos: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toPos: center.clone().addScaledVector(flyer.normal, 0.62),
    toTarget: center,
    faded: false,
    done: false,
  };
  controls.enabled = false;
}

function stepFlight(now) {
  const k = Math.min(1, (now - flight.t0) / flight.dur);
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
  controls.target.lerpVectors(flight.fromTarget, flight.toTarget, e);
  camera.lookAt(controls.target);
  if (k > 0.6 && !flight.faded) {
    flight.faded = true;
    fadeEl.classList.add('on');
  }
  if (k >= 1 && !flight.done) {
    flight.done = true;
    const href = flight.flyer.href;
    setTimeout(() => { location.href = href; }, 250);
  }
}

// coming back with the browser's Back button restores the page from cache
window.addEventListener('pageshow', (e) => {
  if (!e.persisted || !homeView) return;
  flight = null;
  fadeEl.classList.remove('on');
  camera.position.copy(homeView.pos);
  controls.target.copy(homeView.target);
  controls.enabled = true;
  userMoved = false;
  swayTime = 0;
  setHovered(null);
});

// --- resize & loop ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function frame(now) {
  const dt = Math.min(100, now - lastFrame);
  lastFrame = now;
  if (intro) stepIntro(now);
  else if (flight) stepFlight(now);
  else if (swayReady && !userMoved) stepSway(dt);
  else controls.update();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);
