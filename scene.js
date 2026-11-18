import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSeasons } from './season.js';
import { sources } from './sim.js';

export const COLORS = { solar: '#c98500', home: '#3987e5', ev: '#199e70', batt: '#9085e9', grid: '#d95926' };

const V = (x, y, z) => new THREE.Vector3(x, y, z);
// Two layouts. Each path runs in the direction of positive power; the ev path ends with the plug cable.
const HUB_D = [3, 0.08, 1], HUB_T = [0.4, 0.08, 3];
const LAYOUTS = {
  // Detached house with a pitched roof, battery at the side, car on the driveway
  detached: {
    hub: HUB_D,
    paths: {
      solar: [[-2, 4, 1.4], [2.5, 4, 1.4], [2.5, 0.08, 1.4], HUB_D],
      grid: [[-9, 0.08, 7.2], [3, 0.08, 7.2], HUB_D],
      batt: [[2.7, 0.3, -2.6], [3, 0.08, -2.6], HUB_D],
      home: [HUB_D, [2.3, 0.08, 0.7], [2.3, 1.5, 0.7], [2.05, 1.5, 0.7]],
      ev: [HUB_D, [4.6, 0.08, 1], [4.6, 0.9, 1], [5.35, 0.75, 1]],
    },
    labels: { solar: [-2, 6.3, -1], home: [-4.4, 1.2, 2.6], batt: [2.6, 3.1, -3.6], grid: [-9, 6.6, 7.2], ev: [6.6, 2.5, 1] },
    camera: [16.5, 12.5, 20], target: [0, 1.6, 1.5],
    batt: { at: [2.3, -2.6], turn: 0 },
    charger: [4.6, 1],
    devices: [[-0.75, 0, 2.55], [1.25, 0, 2.55], [-5.3, 0, 2.55], [-3.5, 0, 2.55]], // along the front wall, clear of the door and path
  },
  // Narrow town house with a flat roof in a row, like an old Haarlem street: battery against the front wall, car parked at the curb
  terraced: {
    hub: HUB_T,
    paths: {
      solar: [[-1.5, 6.62, -1], [-0.4, 6.62, -1], [-0.4, 6.62, 2.06], [-0.4, 0.08, 2.06], [-0.4, 0.08, 3], HUB_T],
      grid: [[-5, 0.08, 3.6], [0.4, 0.08, 3.6], HUB_T],
      batt: [[1.6, 0.3, 2.78], [1.6, 0.08, 2.88], [0.4, 0.08, 2.88], HUB_T],
      home: [HUB_T, [0.4, 0.08, 2.1], [0.4, 1.3, 2.1], [0.4, 1.3, 1.97]],
      ev: [HUB_T, [0.4, 0.08, 3.12], [2.8, 0.08, 3.12], [2.8, 0.08, 3.7], [2.8, 0.9, 3.7], [3.4, 0.75, 4.35]],
    },
    labels: { solar: [0, 7.6, -2], home: [-1.8, 4.6, 2.1], batt: [1.6, 3, 2.5], grid: [-5, 2.3, 3.6], ev: [5.4, 2.4, 5.3] },
    camera: [5, 12, 27], target: [0, 2.6, 1], // from across the street, so the neighbours do not hide the front
    batt: { at: [1.6, 2.5], turn: -Math.PI / 2 },
    charger: [2.8, 3.7],
    devices: [[-2.2, 6.4, -5.5], [-0.75, 6.4, -5.5], [0.75, 6.4, -5.5], [2.2, 6.4, -5.5]], // on the roof behind the panels
  },
};
const PARTICLES = 16;
const DOT = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, new THREE.Color(c)]));

export function createScene(container, { maxPixelRatio = 2, devices = [], shadows = true, house = 'detached' } = {}) {
  const row = house === 'terraced', L = LAYOUTS[row ? 'terraced' : 'detached'];
  const { hub: HUB, paths: PATHS, labels: LABEL_AT } = L;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, maxPixelRatio));
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping; // softens bright highlights without shifting the colours much
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color();
  scene.fog = new THREE.Fog(scene.background, 40, 95); // far edges fade into the sky for depth
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  camera.position.set(...L.camera);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...L.target);
  controls.maxPolarAngle = Math.PI / 2 - 0.08;
  controls.minDistance = 14;
  controls.maxDistance = 60;
  controls.enablePan = false;
  controls.update();

  const hemi = new THREE.HemisphereLight('#ffffff', '#5a7a4a', 1);
  const sunLight = new THREE.DirectionalLight('#fff4dd', 2);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  Object.assign(sunLight.shadow, { bias: -0.0004, normalBias: 0.03 }); // no stripes on sunlit walls
  Object.assign(sunLight.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, far: 90 });
  scene.add(hemi, sunLight);

  const mat = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
  const add = (geo, material, x, y, z, parent = scene) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  // Boxes of the same size share one geometry
  const boxGeos = new Map();
  const box = (w, h, d, material, x, y, z, parent) => {
    const key = [w, h, d].join();
    if (!boxGeos.has(key)) boxGeos.set(key, new THREE.BoxGeometry(w, h, d));
    return add(boxGeos.get(key), material, x, y, z, parent);
  };
  const dummy = new THREE.Object3D(); // scratch transform for instanced meshes
  // Repeated small parts (bollards, bushes, road marks) are one instanced draw each
  const many = (geo, material, spots, parent = scene) => {
    const m = new THREE.InstancedMesh(geo, material, spots.length);
    spots.forEach(([x, y, z, s = 1], i) => {
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    });
    dummy.scale.setScalar(1);
    parent.add(m);
    return m;
  };
  // Small textures drawn once on a canvas, so there are no image files to load
  const paint = (size, draw, rx = 1, ry = 1) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.anisotropy = 4;
    return t;
  };
  const grid = (bg, line, cols, rows, offset = 0) => (g, n) => { // tiles or bricks: every other row shifts by offset
    g.fillStyle = bg;
    g.fillRect(0, 0, n, n);
    g.fillStyle = line;
    const w = n / cols, h = n / rows;
    for (let r = 0; r < rows; r++) {
      g.fillRect(0, r * h, n, 2);
      for (let c = 0; c <= cols; c++) g.fillRect(((c + (r % 2) * offset) * w) % n, r * h, 2, h);
    }
  };
  // Soft dark patch on the ground under things, a cheap stand-in for ambient occlusion
  const blobMat = new THREE.MeshBasicMaterial({
    map: paint(64, (g) => {
      const r = g.createRadialGradient(32, 32, 4, 32, 32, 32);
      r.addColorStop(0, 'rgba(0,0,0,0.42)');
      r.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, 64, 64);
    }),
    transparent: true, depthWrite: false,
  });
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const blob = (w, d, x, z, parent = scene, y = 0.09) => {
    const m = add(blobGeo, blobMat, x, y, z, parent);
    m.scale.set(w, 1, d);
    return m;
  };
  const trim = new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.6 });
  // Window with a white frame, a middle bar and a sill; the glass is the box that lights up at night
  const win = (w, h, x, y, z, glass) => {
    box(w + 0.18, h + 0.18, 0.08, trim, x, y, z - 0.02);
    box(w, h, 0.1, glass, x, y, z);
    box(0.06, h, 0.04, trim, x, y, z + 0.06);
    box(w + 0.34, 0.08, 0.24, trim, x, y - h / 2 - 0.1, z + 0.08);
  };
  const lampMat = mat('#fff3d6', { emissive: '#ffd27a', emissiveIntensity: 0 });
  const lamp = (x, z, turn) => { // street lamp, the head hangs over the road
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = turn;
    scene.add(g);
    const pole = mat('#3a3f47', { roughness: 0.5, metalness: 0.4 });
    cast(box(0.14, 4.4, 0.14, pole, 0, 2.2, 0, g));
    box(0.1, 0.1, 0.9, pole, 0, 4.35, 0.4, g);
    box(0.34, 0.14, 0.5, lampMat, 0, 4.25, 0.8, g);
  };

  // Lot, street, driveway
  const grassMat = mat('#7cc66a');
  // Small parts skip shadows: each caster adds a draw to the shadow pass, and they barely show up in it
  const receive = (m) => ((m.receiveShadow = true), m);
  const cast = (m) => ((m.castShadow = true), m);
  const concrete = mat('#c9c4b8'), asphalt = mat('#555b66');
  const windowMat = mat('#9cc7e8', { emissive: '#ffd27a', emissiveIntensity: 0, roughness: 0.3 });
  const panelGroup = new THREE.Group();
  scene.add(panelGroup);
  const cells = (g, n) => { // 6 by 10 cells in a silver frame
    g.fillStyle = '#c8ccd2';
    g.fillRect(0, 0, n, n);
    grid('#1d3461', '#33508a', 6, 10)(g, n);
    g.strokeStyle = '#c8ccd2';
    g.lineWidth = 6;
    g.strokeRect(0, 0, n, n);
  };
  const panelMat = mat('#ffffff', { map: paint(128, cells), emissive: '#4f8fff', emissiveIntensity: 0, roughness: 0.25, metalness: 0.4 });
  const panelCount = 27;
  const panels = new THREE.InstancedMesh(new THREE.BoxGeometry(0.88, 1.12, 0.06), panelMat, panelCount);
  if (!row) {
    receive(box(26, 0.5, 22, grassMat, 0, -0.25, 0));
    receive(box(26, 0.06, 3, asphalt, 0, 0.03, 9.5));
    const pavers = (w, d) => mat('#ffffff', { map: paint(64, grid('#cdc8bc', '#aaa496', 4, 4), w / 2, d / 2) });
    receive(box(2.8, 0.06, 10.4, pavers(2.8, 10.4), 6.3, 0.03, 3));
    receive(box(1.4, 0.06, 6, pavers(1.4, 6), -2, 0.03, 5));
    many(new THREE.BoxGeometry(1.2, 0.02, 0.14), trim, [-12, -8, -4, 0, 4, 8, 12].map((x) => [x, 0.07, 9.5])); // centre line

    // House: x -6..2, z -4..2, front faces +z
    cast(receive(box(8, 3.2, 6, mat('#f2e6d0'), -2, 1.6, -1)));
    box(8.1, 0.3, 6.1, mat('#d9cdb6'), -2, 0.15, -1); // plinth
    const tri = new THREE.Shape([new THREE.Vector2(-3.4, 0), new THREE.Vector2(3.4, 0), new THREE.Vector2(0, 2.2)]);
    const roof = cast(receive(add(new THREE.ExtrudeGeometry(tri, { depth: 8.8, bevelEnabled: false }), mat('#b5533c'), -6.4, 3.2, -1)));
    roof.rotation.y = Math.PI / 2;
    box(8.9, 0.16, 0.18, mat('#8e3c2b'), -2, 5.42, -1); // ridge
    cast(box(0.7, 1.9, 0.7, mat('#9c4a36'), -4.4, 4.95, -2.4)); // chimney on the back slope, clear of the panels
    box(0.86, 0.12, 0.86, mat('#3a3f47'), -4.4, 5.95, -2.4);
    box(8.9, 0.14, 0.16, trim, -2, 3.16, 2.46); // gutter
    box(1.3, 2.2, 0.08, trim, -2, 1.1, 2.0);
    box(1.1, 2.1, 0.1, mat('#7a4b2a'), -2, 1.05, 2.02);
    box(0.07, 0.07, 0.1, mat('#d4af37', { metalness: 0.8, roughness: 0.3 }), -1.62, 1.0, 2.1); // door handle
    box(1.6, 0.14, 0.5, concrete, -2, 0.07, 2.3); // step
    for (const x of [-4.6, 0.4]) win(1.5, 1.2, x, 1.9, 2.02, windowMat);
    box(0.1, 1.1, 1.2, windowMat, 2.02, 2.1, -0.7);
    box(0.25, 0.5, 0.4, mat('#e8e8e8'), 2.12, 1.5, 0.7); // meter cupboard
    blob(10.5, 8.5, -2, -1, scene, 0.01);

    // Bushes beside the path, a hedge along the back and side of the lot, a lamp at the road
    const leaf = mat('#4c9a52', { flatShading: true });
    const bush = new THREE.IcosahedronGeometry(0.42, 1);
    many(bush, leaf, [[-3.2, 0.3, 4.4, 0.8], [-0.8, 0.3, 4.4, 0.8], [-3.2, 0.25, 6.6, 0.8], [-0.8, 0.25, 6.6, 0.8], [8.3, 0.35, -3, 1.2], [8.7, 0.28, -2.1, 0.9]]);
    const hedge = mat('#356f3f');
    cast(box(25, 0.8, 0.5, hedge, 0, 0.4, -10.6));
    cast(box(0.5, 0.8, 16, hedge, -12.6, 0.4, -2.6));
    lamp(-12.5, 7.8, 0);

    // Solar panels on the south roof slope, 0.45 kWp each
    panelGroup.position.set(-2, 3.2, 2.4);
    panelGroup.rotation.x = -(Math.PI / 2 - Math.atan(2.2 / 3.4));
    for (let i = 0; i < panelCount; i++) {
      dummy.position.set((i % 9 - 4) * 0.95, 0.85 + Math.floor(i / 9) * 1.2, 0.06);
      dummy.updateMatrix();
      panels.setMatrixAt(i, dummy.matrix);
    }
  } else {
    // Sidewalk and a narrow street in front, back gardens behind
    receive(box(34, 0.5, 22, grassMat, 0, -0.25, 0));
    receive(box(34, 0.08, 2, mat('#ffffff', { map: paint(64, grid('#cfcac0', '#aea89b', 2, 2), 34 / 0.6, 2 / 0.6) }), 0, 0.04, 3));
    // Old town streets are paved with red-grey clay bricks
    receive(box(34, 0.06, 6, mat('#ffffff', { map: paint(64, grid('#9a8a80', '#7c6f68', 2, 8, 0.5), 34 / 0.5, 6 / 1) }), 0, 0.03, 7));
    box(34, 0.1, 0.12, mat('#9a968c'), 0, 0.05, 4.02); // curb

    // The user's house: brick, x -3..3, z -6..2, flat roof with a dark edge
    const brick = paint(128, grid('#b8674a', '#d8c7b4', 4, 16, 0.5), 6 / 1.6, 6.4 / 1.6);
    cast(receive(box(6, 6.4, 8, mat('#ffffff', { map: brick }), 0, 3.2, -2)));
    receive(box(6.2, 0.25, 8.2, mat('#4a4d52'), 0, 6.5, -2));
    box(6.2, 0.22, 0.2, trim, 0, 6.2, 2.06); // cornice under the roof edge
    box(6.05, 0.4, 0.12, mat('#5d4038'), 0, 0.2, 2.03); // dark plinth
    box(1.3, 2.25, 0.08, trim, -1.6, 1.12, 2.0);
    box(1.1, 2.1, 0.1, mat('#2f4a3a'), -1.6, 1.05, 2.02);
    box(0.07, 0.07, 0.1, mat('#d4af37', { metalness: 0.8, roughness: 0.3 }), -1.22, 1.0, 2.1);
    box(1.5, 0.16, 0.45, mat('#bdb6a8'), -1.6, 0.08, 2.25); // stoop
    win(1.5, 1.2, 1.1, 2.2, 2.02, windowMat);
    for (const y of [3.9, 5.4]) for (const x of [-1.4, 1.4]) win(1.4, 1.1, x, y, 2.02, windowMat);
    box(0.3, 0.45, 0.12, mat('#e8e8e8'), 0.4, 1.3, 2.05); // meter box
    // A facade garden: a narrow strip of plants against the wall, very Dutch
    box(0.6, 0.12, 0.4, mat('#6b5846'), -2.6, 0.12, 2.2);
    many(new THREE.IcosahedronGeometry(0.28, 0), mat('#4a9a4f', { flatShading: true }), [[-2.75, 0.32, 2.2, 0.8], [-2.45, 0.38, 2.2], [-2.6, 0.7, 2.16, 0.7]]);
    blob(34, 1.2, 0, 2.1, scene, 0.09); // shade along the foot of the facades
    // Bollards along the curb and a lamp, like a canal street
    many(new THREE.CylinderGeometry(0.1, 0.12, 0.8, 8), mat('#5b2a24', { roughness: 0.5 }), [-15, -12, -9, 8.5, 11.5, 14.5].map((x) => [x, 0.48, 3.75]));
    lamp(-10.5, 3.6, 0);

    // Grey neighbours on both sides, flat roofs at different heights
    const greyWall = mat('#c4c6c9'), greyEdge = mat('#8d9094'), greyGlass = mat('#9aa3ad', { roughness: 0.4 });
    for (const [cx, h] of [[-6, 5.6], [-12, 7], [6, 6.9], [12, 5.8]]) {
      cast(receive(box(6, h, 8, greyWall, cx, h / 2, -2)));
      box(6, 0.2, 8.1, greyEdge, cx, h + 0.05, -2);
      box(1.1, 2.1, 0.1, greyEdge, cx - 1.6, 1.05, 2.02);
      for (let y = 2.2; y < h - 0.8; y += 1.6) for (const x of [-1.4, 1.4]) if (y > 3 || x > 0) box(1.4, 1.1, 0.1, greyGlass, cx + x, y, 2.02);
    }
    box(0.8, 1, 0.5, mat('#8b9199'), -5, 0.5, 3.6); // street cabinet for the grid connection

    // Panels in tilted rows on the flat roof, facing the street
    panelGroup.position.set(0, 6.75, 0);
    for (let i = 0; i < panelCount; i++) {
      dummy.position.set((i % 5 - 2) * 0.95, 0.25, -4.6 + Math.floor(i / 5) * 1.25);
      dummy.rotation.set(-Math.PI / 2 + 0.35, 0, 0);
      dummy.updateMatrix();
      panels.setMatrixAt(i, dummy.matrix);
    }
    dummy.rotation.set(0, 0, 0);
  }
  box(0.5, 0.25, 0.5, mat('#3a3f47'), ...HUB);
  Object.assign(panels, { frustumCulled: false }); // bounds would be cached at count 0
  panelGroup.add(panels);

  // Home battery with five charge LEDs
  const white = mat('#e9edf2');
  const battery = new THREE.Group();
  battery.position.set(L.batt.at[0], 0, L.batt.at[1]);
  battery.rotation.y = L.batt.turn; // the LEDs face +x locally
  scene.add(battery);
  cast(box(0.5, 1.6, 1.1, white, 0, 0.8, 0, battery));
  box(0.54, 0.08, 1.14, mat('#3a3f47'), 0, 0.04, 0, battery); // feet
  box(0.54, 0.06, 1.14, mat('#c9cfd6'), 0, 1.6, 0, battery); // lid
  blob(1.2, 1.8, 0, 0, battery);
  const leds = [0, 1, 2, 3, 4].map((i) =>
    box(0.04, 0.18, 0.7, new THREE.MeshBasicMaterial({ color: '#333' }), 0.27, 0.35 + i * 0.26, 0, battery));

  // Charger post and car
  const [chx, chz] = L.charger;
  box(0.25, 1.2, 0.25, white, chx, 0.6, chz);
  const chargerLed = box(0.27, 0.08, 0.27, new THREE.MeshBasicMaterial({ color: '#444' }), chx, 1.1, chz);
  box(0.4, 0.06, 0.4, mat('#3a3f47'), chx, 0.03, chz); // base plate
  blob(0.9, 0.9, chx, chz);
  const car = new THREE.Group();
  scene.add(car);
  cast(box(1.9, 0.65, 4.4, mat('#f4f5f7', { roughness: 0.3, metalness: 0.3 }), 0, 0.7, 0, car));
  cast(box(1.7, 0.6, 2.5, mat('#1b2330', { roughness: 0.15 }), 0, 1.3, -0.3, car));
  box(1.94, 0.14, 4.44, mat('#2a2d33'), 0, 0.42, 0, car); // dark sill and bumpers
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.25, 16).rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.27, 12).rotateZ(Math.PI / 2);
  const tyre = mat('#16181c'), hub = mat('#b9bec6', { metalness: 0.7, roughness: 0.35 });
  for (const [x, z] of [[-0.9, 1.4], [0.9, 1.4], [-0.9, -1.4], [0.9, -1.4]]) { add(wheelGeo, tyre, x, 0.36, z, car); add(hubGeo, hub, x, 0.36, z, car); }
  const tailMat = new THREE.MeshBasicMaterial({ color: '#b3261e' });
  for (const x of [-0.7, 0.7]) box(0.35, 0.12, 0.05, tailMat, x, 0.85, -2.2, car);
  for (const x of [-0.65, 0.65]) box(0.4, 0.12, 0.05, lampMat, x, 0.85, 2.2, car); // headlights glow with the street lamps
  blob(2.6, 5.2, 0, 0, car);

  // Grid pole
  if (!row) {
    const wood = mat('#6b5846');
    cast(box(0.3, 6, 0.3, wood, -9, 3, 7.2));
    cast(box(2.4, 0.2, 0.2, wood, -9, 5.4, 7.2));
    many(new THREE.CylinderGeometry(0.07, 0.09, 0.25, 8), mat('#dfe6ea', { roughness: 0.3 }), [-10, -9.4, -8.6, -8].map((x) => [x, 5.62, 7.2])); // insulators
    blob(1.2, 1.2, -9, 7.2);
    box(0.9, 1, 0.7, mat('#8b9199'), -9, 0.5, 6.5);
  }

  // Trees
  const coneMat = mat('#3f8f4f', { flatShading: true });
  const bark = mat('#6b4a2f');
  for (const [x, z, s] of row ? [[-10, -9, 1.2], [9, -9.5, 1.3]] : [[-10, -6, 1.2], [-8.5, -1, 0.9], [9.5, -7, 1.3], [10.5, 4, 1]]) {
    cast(add(new THREE.CylinderGeometry(0.2 * s, 0.26 * s, 1.4 * s, 8), bark, x, 0.7 * s, z));
    cast(add(new THREE.ConeGeometry(1.3 * s, 2.8 * s, 8), coneMat, x, 2.6 * s, z));
    blob(3 * s, 3 * s, x, z, scene, 0.02);
  }

  // Sun, moon, clouds
  const sun = new THREE.Mesh(new THREE.SphereGeometry(1.6, 24, 16), new THREE.MeshBasicMaterial({ color: '#ffd84a', fog: false }));
  const moon = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: '#dfe6f5', fog: false }));
  scene.add(sun, moon);
  const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 });
  const puffGeo = new THREE.SphereGeometry(1, 12, 8); // unit sphere, sized by scale
  const clouds = [[-9, 13, -8], [3, 15, -11], [11, 12, -5], [-3, 14, 3], [8, 16, 6], [-12, 15, 5]].map(([x, y, z]) => {
    const g = new THREE.Group();
    for (const [dx, s] of [[-1.3, 1], [0, 1.4], [1.4, 1.1]]) {
      const puff = new THREE.Mesh(puffGeo, cloudMat);
      puff.position.set(dx, 0, 0);
      puff.scale.set(s, 0.6 * s, s);
      g.add(puff);
    }
    g.position.set(x, y, z);
    scene.add(g);
    return g;
  });

  // Cables with moving particles
  const flows = {};
  const cable = mat('#2a2d33');
  const tube = (curve) => add(new THREE.TubeGeometry(curve, 48, 0.045, 6), cable, 0, 0, 0);
  const polyline = (pts) => {
    const path = new THREE.CurvePath();
    for (let i = 1; i < pts.length; i++) path.add(new THREE.LineCurve3(V(...pts[i - 1]), V(...pts[i])));
    return path;
  };
  const dotGeo = new THREE.SphereGeometry(0.13, 10, 8);
  let evCable;
  for (const [key, pts] of Object.entries(PATHS)) {
    const curve = polyline(pts);
    if (key === 'ev') {
      tube(polyline(pts.slice(0, -1)));
      evCable = tube(polyline(pts.slice(-2))); // the plug cable, hidden while unplugged
    } else tube(curve);
    // One instanced mesh per flow; update() sets how many of its dots are shown and colours each by its source
    const dots = new THREE.InstancedMesh(dotGeo, new THREE.MeshBasicMaterial(), PARTICLES);
    for (let i = 0; i < PARTICLES; i++) dots.setColorAt(i, DOT[key]);
    dots.frustumCulled = false; // bounds would be cached while the dots move
    scene.add(dots);
    flows[key] = { curve, dots, phase: 0, len: curve.getLength() };
  }

  // Extra devices (heat pump, AC, boiler, washing machine) stand along the front of the house, clear of the door and path.
  // They show their power by spinning faster and glowing; the card lists their numbers in a corner.
  const devs = devices.slice(0, L.devices.length).map(({ type }, k) => {
    const g = new THREE.Group();
    g.position.set(...L.devices[k]);
    scene.add(g);
    const body = mat(type === 'heat_pump' ? '#c9ccd1' : '#eef0f2');
    const glow = new THREE.MeshBasicMaterial({ color: '#333' });
    let spinner = null;
    if (type === 'boiler') cast(add(new THREE.CylinderGeometry(0.3, 0.3, 1.3, 16), body, 0, 0.65, 0, g));
    else {
      const [w, h, d] = { heat_pump: [0.95, 0.75, 0.42], ac: [0.8, 0.55, 0.32], washing_machine: [0.6, 0.85, 0.55] }[type] ?? [0.5, 0.5, 0.4];
      cast(box(w, h, d, body, 0, h / 2, 0, g));
      if (type !== 'other') {
        spinner = new THREE.Group();
        spinner.position.set(type === 'washing_machine' ? 0 : -w * 0.15, h * 0.5, d / 2 + 0.02);
        add(new THREE.CylinderGeometry(h * 0.33, h * 0.33, 0.04, 20).rotateX(Math.PI / 2), mat('#2f3338'), 0, 0, 0, spinner);
        box(h * 0.6, h * 0.08, 0.05, mat('#9aa1a9'), 0, 0, 0.02, spinner); // fan blade or drum paddle, so the spin shows
        g.add(spinner);
      }
    }
    box(0.12, 0.06, 0.04, glow, type === 'boiler' ? 0 : 0.3, type === 'boiler' ? 1.1 : 0.1, 0.32, g);
    return { spinner, glow, type };
  });

  // HTML labels that follow the devices
  const labels = {};
  for (const key of Object.keys(LABEL_AT)) {
    const el = document.createElement('div');
    el.className = 'tag';
    el.style.setProperty('--c', COLORS[key]);
    container.append(el);
    labels[key] = el;
  }

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h);
    for (const el of Object.values(labels)) el._t = null; // narrow cards restyle the labels, so measure again
    camera.aspect = w / h;
    // Below aspect 1.2, widen the vertical view so narrow (portrait) screens still show the whole lot side to side.
    camera.fov = 2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(THREE.MathUtils.degToRad(16)) * Math.max(1, 1.2 / camera.aspect)));
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const seasons = createSeasons({ scene, add, box, mat, grassMat, coneMat, row });

  const NIGHT = new THREE.Color('#0b1026'), DAY = new THREE.Color('#8ecae6'), DUSK = new THREE.Color('#f79d5c'), GREY = new THREE.Color('#aab4bd');
  const tmp = V(0, 0, 0);
  let clock = 0, lastFlowKey = '', from = {};

  // s: { t, month, rise, set, weather, kWp, solar, home, ev, batt, grid, battSoc, battOn, evOn, evAway (0 parked..1 gone), evPlugged, devices: [kW], effects (false hides falling leaves, birds, jogger), still }
  function update(s, dt) {
    if (s.still) dt = 0; // reduced motion: everything keeps its place, only the time of day and the numbers change
    clock += dt;
    const dayLen = s.set - s.rise;
    const th = s.t >= s.rise && s.t <= s.set
      ? (Math.PI * (s.t - s.rise)) / dayLen
      : Math.PI + (Math.PI * ((s.t - s.set + 24) % 24)) / (24 - dayLen);
    const day = THREE.MathUtils.clamp((Math.sin(th) + 0.08) / 0.3, 0, 1);
    const clear = THREE.MathUtils.clamp(s.weather, 0.35, 1);
    sun.position.set(Math.cos(th) * 26, Math.sin(th) * 20, Math.sin(th) * 10 + 4);
    moon.position.set(-Math.cos(th) * 26, -Math.sin(th) * 20, -Math.sin(th) * 10 + 4);
    sunLight.position.copy(sun.position);
    sunLight.intensity = 2.4 * day * clear;
    hemi.intensity = 0.55 + 0.5 * day;
    scene.background.copy(NIGHT).lerp(s.weather < 0.6 ? GREY : DAY, day).lerp(DUSK, day * (1 - day) * 1.6);
    scene.fog.color.copy(scene.background);

    clouds.forEach((g, i) => {
      g.visible = s.weather < 0.6 || (s.weather < 1.3 && i < 2);
      g.position.x = ((g.position.x + dt * 0.25 + 15) % 30) - 15;
    });
    windowMat.emissiveIntensity = (1 - day) * (0.35 + Math.min(1.2, s.home));
    lampMat.emissiveIntensity = (1 - day) * 1.6;
    panelMat.emissiveIntensity = s.kWp ? 0.5 * (s.solar / s.kWp) : 0;
    panels.count = THREE.MathUtils.clamp(Math.round(s.kWp / 0.45), 0, panelCount);
    leds.forEach((l, i) => l.material.color.set(!s.battOn ? '#333' : s.battSoc > i / 5 + 0.02 ? COLORS.batt : '#333'));

    const ease = s.evAway * s.evAway * (3 - 2 * s.evAway);
    car.visible = s.evOn && s.evAway < 1;
    if (row) { car.position.set(5.4 + ease * 14, 0, 5.3); car.rotation.y = Math.PI / 2; } // parked along the curb past the charger, so the battery stays in view; drives off down the street
    else car.position.set(6.3, 0, 1 + ease * 12);
    evCable.visible = s.evOn && s.evPlugged;
    chargerLed.material.color.set(s.ev > 0.05 ? (Math.sin(clock * 6) > 0 ? COLORS.ev : '#0d4a35') : '#444');

    // Sources feed their own cable; the house, the car, a charging battery and export get a mix.
    // Readings change a few times a minute, so the split is only redone when they do.
    const flowKey = `${s.solar}|${s.grid}|${s.batt}|${s.ev}|${s.home}`;
    if (flowKey !== lastFlowKey) {
      lastFlowKey = flowKey;
      const mix = sources(s);
      from = { solar: { solar: 1 }, grid: s.grid > 0 ? { grid: 1 } : mix.grid, batt: s.batt > 0 ? { batt: 1 } : mix.batt, home: mix.home, ev: mix.ev };
    }
    for (const [key, f] of Object.entries(flows)) {
      const p = s[key], mag = Math.abs(p);
      const n = mag < 0.03 ? 0 : Math.min(PARTICLES, 3 + Math.ceil(mag * 2));
      f.phase = (f.phase + (Math.sign(p) * (1.5 + 0.5 * Math.min(mag, 11)) * dt) / f.len + 1) % 1;
      for (let i = 0; i < n; i++) {
        dummy.position.copy(f.curve.getPointAt((i / n + f.phase) % 1));
        dummy.updateMatrix();
        f.dots.setMatrixAt(i, dummy.matrix);
      }
      const colorKey = `${n}|${flowKey}`;
      if (f.colorKey !== colorKey) { // dot colours only depend on the split and the number of dots
        f.colorKey = colorKey;
        const m = from[key], total = (m.solar ?? 0) + (m.batt ?? 0) + (m.grid ?? 0);
        for (let i = 0; i < n; i++) {
          const u = ((i + 0.5) / n) * total;
          f.dots.setColorAt(i, !total ? DOT[key] : u < (m.solar ?? 0) ? DOT.solar : u < (m.solar ?? 0) + (m.batt ?? 0) ? DOT.batt : DOT.grid);
        }
        f.dots.instanceColor.needsUpdate = true;
      }
      f.dots.count = n;
      f.dots.instanceMatrix.needsUpdate = true;
    }

    devs.forEach((d, k) => {
      const p = Math.max(0, s.devices?.[k] ?? 0);
      if (d.spinner) d.spinner.rotation.z -= dt * Math.min(12, p * 6);
      d.glow.color.set(p > 0.02 ? COLORS.home : '#333');
    });

    seasons(s.month, day, dt, clock, s.effects !== false);

    controls.update();
    renderer.render(scene, camera);

    const { clientWidth: w, clientHeight: h } = container;
    const placed = [];
    for (const [key, el] of Object.entries(labels)) {
      tmp.set(...LABEL_AT[key]);
      if (key === 'ev' && car.visible) { if (row) tmp.x = Math.min(car.position.x, 9); else tmp.z = Math.min(car.position.z, 8); }
      tmp.project(camera);
      if (el._t !== el.textContent) { el._t = el.textContent; el._w = el.offsetWidth; el._h = el.offsetHeight; } // measure only when the text changes
      const x = THREE.MathUtils.clamp(((tmp.x + 1) / 2) * w, el._w / 2 + 4, w - el._w / 2 - 4); // keep labels inside narrow cards
      placed.push({ el, x, y: ((1 - tmp.y) / 2) * h }); // y is the bottom edge
    }
    // Zooming out brings labels together: push each one below any higher label it would cover
    placed.sort((a, b) => a.y - b.y);
    for (let i = 0; i < placed.length; i++) {
      const a = placed[i], hw = a.el._w / 2;
      for (let j = 0, tries = 0; j < i; j++) {
        const b = placed[j], gap = (a.el._w + b.el._w) / 2 + 5; // 1px more than the test needs, so rounding cannot loop
        if (Math.abs(a.x - b.x) < gap - 1 && a.y - a.el._h < b.y + 4 && b.y - b.el._h < a.y + 4) {
          // Take the smallest step: down below b, or beside it while it stays inside the card
          const down = b.y + 5 + a.el._h - a.y, left = a.x - (b.x - gap), right = b.x + gap - a.x;
          const canL = b.x - gap >= hw + 4 && tries < 8, canR = b.x + gap <= w - hw - 4 && tries < 8;
          if (canL && left <= right && left < down) a.x = b.x - gap;
          else if (canR && right < down) a.x = b.x + gap;
          else a.y += down;
          tries++;
          j = -1; // moved, so check the higher labels again
        }
      }
    }
    const glide = dt ? 1 - Math.exp(-dt * 12) : 1; // glide into the new spot instead of jumping
    for (const { el, x, y } of placed) {
      el._y = el._y === undefined ? y : el._y + (y - el._y) * glide;
      const tr = `translate(-50%,-100%) translate(${x.toFixed(1)}px,${el._y.toFixed(1)}px)`;
      if (el.dataset.tr !== tr) el.style.transform = el.dataset.tr = tr; // unchanged writes still cost a restyle; style.transform reads back reformatted
    }
  }

  // Frees the WebGL context; browsers allow only a few at once, and dashboards create and drop cards often.
  function dispose() {
    observer.disconnect();
    controls.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    for (const el of Object.values(labels)) el.remove();
  }

  return { update, labels, dispose };
}
