import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSeasons } from './season.js';
import { sources } from './sim.js';

export const COLORS = { solar: '#c98500', home: '#3987e5', ev: '#199e70', batt: '#9085e9', grid: '#d95926' };

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const HUB = [3, 0.08, 1];
// Each path runs in the direction of positive power.
const PATHS = {
  solar: [[-2, 4, 1.4], [2.5, 4, 1.4], [2.5, 0.08, 1.4], HUB],
  grid: [[-9, 0.08, 7.2], [3, 0.08, 7.2], HUB],
  batt: [[2.7, 0.3, -2.6], [3, 0.08, -2.6], HUB],
  home: [HUB, [2.3, 0.08, 0.7], [2.3, 1.5, 0.7], [2.05, 1.5, 0.7]],
  ev: [HUB, [4.6, 0.08, 1], [4.6, 0.9, 1], [5.35, 0.75, 1]],
};
const LABEL_AT = { solar: [-2, 6.3, -1], home: [-4.4, 1.2, 2.6], batt: [2.6, 3.1, -3.6], grid: [-9, 6.6, 7.2], ev: [6.6, 2.5, 1] };
const PARTICLES = 16;
const DEVICE_X = [-0.75, 1.25, -5.3, -3.5]; // spots along the front wall, clear of the door and path
const DOT = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, new THREE.Color(c)]));

export function createScene(container, { maxPixelRatio = 2, devices = [], shadows = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, maxPixelRatio));
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  camera.position.set(16.5, 12.5, 20);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.6, 1.5);
  controls.maxPolarAngle = Math.PI / 2 - 0.08;
  controls.minDistance = 14;
  controls.maxDistance = 60;
  controls.enablePan = false;
  controls.update();

  const hemi = new THREE.HemisphereLight('#ffffff', '#5a7a4a', 1);
  const sunLight = new THREE.DirectionalLight('#fff4dd', 2);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
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

  // Lot, street, driveway
  const grassMat = mat('#7cc66a');
  // Small parts skip shadows: each caster adds a draw to the shadow pass, and they barely show up in it
  const receive = (m) => ((m.receiveShadow = true), m);
  const cast = (m) => ((m.castShadow = true), m);
  receive(box(26, 0.5, 22, grassMat, 0, -0.25, 0));
  receive(box(26, 0.06, 3, mat('#555b66'), 0, 0.03, 9.5));
  const concrete = mat('#c9c4b8');
  receive(box(2.8, 0.06, 10.4, concrete, 6.3, 0.03, 3));
  receive(box(1.4, 0.06, 6, concrete, -2, 0.03, 5));

  // House: x -6..2, z -4..2, front faces +z
  cast(receive(box(8, 3.2, 6, mat('#f2e6d0'), -2, 1.6, -1)));
  const tri = new THREE.Shape([new THREE.Vector2(-3.4, 0), new THREE.Vector2(3.4, 0), new THREE.Vector2(0, 2.2)]);
  const roof = cast(receive(add(new THREE.ExtrudeGeometry(tri, { depth: 8.8, bevelEnabled: false }), mat('#b5533c'), -6.4, 3.2, -1)));
  roof.rotation.y = Math.PI / 2;
  box(1.1, 2.1, 0.1, mat('#7a4b2a'), -2, 1.05, 2.02);
  const windowMat = mat('#9cc7e8', { emissive: '#ffd27a', emissiveIntensity: 0, roughness: 0.3 });
  for (const x of [-4.6, 0.4]) box(1.5, 1.2, 0.1, windowMat, x, 1.9, 2.02);
  box(0.1, 1.1, 1.2, windowMat, 2.02, 2.1, -0.7);
  box(0.25, 0.5, 0.4, mat('#e8e8e8'), 2.12, 1.5, 0.7); // meter cupboard
  box(0.5, 0.25, 0.5, mat('#3a3f47'), ...HUB);

  // Solar panels on the south roof slope, 0.45 kWp each
  const slope = Math.atan(2.2 / 3.4);
  const panelGroup = new THREE.Group();
  panelGroup.position.set(-2, 3.2, 2.4);
  panelGroup.rotation.x = -(Math.PI / 2 - slope);
  scene.add(panelGroup);
  const panelMat = mat('#1d3461', { emissive: '#4f8fff', emissiveIntensity: 0, roughness: 0.25, metalness: 0.4 });
  const panelCount = 27;
  const panels = new THREE.InstancedMesh(new THREE.BoxGeometry(0.88, 1.12, 0.06), panelMat, panelCount);
  for (let i = 0; i < panelCount; i++) {
    const row = Math.floor(i / 9), col = i % 9;
    dummy.position.set((col - 4) * 0.95, 0.85 + row * 1.2, 0.06);
    dummy.updateMatrix();
    panels.setMatrixAt(i, dummy.matrix);
  }
  Object.assign(panels, { frustumCulled: false }); // bounds would be cached at count 0
  panelGroup.add(panels);

  // Home battery with five charge LEDs
  const white = mat('#e9edf2');
  cast(box(0.5, 1.6, 1.1, white, 2.3, 0.8, -2.6));
  const leds = [0, 1, 2, 3, 4].map((i) =>
    box(0.04, 0.18, 0.7, new THREE.MeshBasicMaterial({ color: '#333' }), 2.57, 0.35 + i * 0.26, -2.6));

  // Charger post and car
  box(0.25, 1.2, 0.25, white, 4.6, 0.6, 1);
  const chargerLed = box(0.27, 0.08, 0.27, new THREE.MeshBasicMaterial({ color: '#444' }), 4.6, 1.1, 1);
  const car = new THREE.Group();
  scene.add(car);
  cast(box(1.9, 0.65, 4.4, mat('#f4f5f7', { roughness: 0.3, metalness: 0.3 }), 0, 0.7, 0, car));
  cast(box(1.7, 0.6, 2.5, mat('#1b2330', { roughness: 0.15 }), 0, 1.3, -0.3, car));
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.25, 16).rotateZ(Math.PI / 2);
  const tyre = mat('#16181c');
  for (const [x, z] of [[-0.9, 1.4], [0.9, 1.4], [-0.9, -1.4], [0.9, -1.4]]) add(wheelGeo, tyre, x, 0.36, z, car);
  const tailMat = new THREE.MeshBasicMaterial({ color: '#b3261e' });
  for (const x of [-0.7, 0.7]) box(0.35, 0.12, 0.05, tailMat, x, 0.85, -2.2, car);

  // Grid pole
  const wood = mat('#6b5846');
  cast(box(0.3, 6, 0.3, wood, -9, 3, 7.2));
  cast(box(2.4, 0.2, 0.2, wood, -9, 5.4, 7.2));
  box(0.9, 1, 0.7, mat('#8b9199'), -9, 0.5, 6.5);

  // Trees
  const coneMat = mat('#3f8f4f');
  const bark = mat('#6b4a2f');
  const sideTree = new THREE.Group(); // stands where a terraced neighbour goes
  scene.add(sideTree);
  for (const [x, z, s] of [[-10, -6, 1.2], [-8.5, -1, 0.9], [9.5, -7, 1.3], [10.5, 4, 1]]) {
    const parent = x === -8.5 ? sideTree : scene;
    cast(add(new THREE.CylinderGeometry(0.2 * s, 0.26 * s, 1.4 * s, 8), bark, x, 0.7 * s, z, parent));
    cast(add(new THREE.ConeGeometry(1.3 * s, 2.8 * s, 8), coneMat, x, 2.6 * s, z, parent));
  }

  // Terraced house: grey neighbours share the left wall, so the row runs out of view and the user's house stands out
  const row = new THREE.Group();
  row.visible = false;
  scene.add(row);
  receive(box(18, 0.5, 22, grassMat, -22, -0.25, 0, row));
  receive(box(18, 0.06, 3, mat('#555b66'), -22, 0.03, 9.5, row));
  const greyWall = mat('#c4c6c9'), greyRoof = mat('#8d9094'), greyGlass = mat('#9aa3ad', { roughness: 0.4 });
  const nTri = new THREE.Shape([new THREE.Vector2(-3.35, 0), new THREE.Vector2(3.35, 0), new THREE.Vector2(0, 2.17)]); // a hair lower, so the main roof covers the joint
  const nRoofGeo = new THREE.ExtrudeGeometry(nTri, { depth: 8, bevelEnabled: false });
  for (const cx of [-10, -18, -26]) {
    cast(receive(box(8, 3.2, 6, greyWall, cx, 1.6, -1, row)));
    const r = cast(receive(add(nRoofGeo, greyRoof, cx - 4, 3.2, -1, row)));
    r.rotation.y = Math.PI / 2;
    box(1.1, 2.1, 0.1, greyRoof, cx, 1.05, 2.02, row);
    for (const x of [cx - 2.6, cx + 2.4]) box(1.5, 1.2, 0.1, greyGlass, x, 1.9, 2.02, row);
    receive(box(1.4, 0.06, 6, concrete, cx, 0.03, 5, row));
  }

  // Sun, moon, clouds
  const sun = new THREE.Mesh(new THREE.SphereGeometry(1.6, 24, 16), new THREE.MeshBasicMaterial({ color: '#ffd84a' }));
  const moon = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: '#dfe6f5' }));
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
      tube(polyline(pts.slice(0, 3)));
      evCable = tube(polyline(pts.slice(2)));
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
  const devs = devices.slice(0, DEVICE_X.length).map(({ type }, k) => {
    const g = new THREE.Group(), x = DEVICE_X[k];
    g.position.set(x, 0, 2.55);
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
    camera.aspect = w / h;
    // Below aspect 1.2, widen the vertical view so narrow (portrait) screens still show the whole lot side to side.
    camera.fov = 2 * THREE.MathUtils.radToDeg(Math.atan(Math.tan(THREE.MathUtils.degToRad(16)) * Math.max(1, 1.2 / camera.aspect)));
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const seasons = createSeasons({ scene, add, box, mat, grassMat, coneMat });

  const NIGHT = new THREE.Color('#0b1026'), DAY = new THREE.Color('#8ecae6'), DUSK = new THREE.Color('#f79d5c'), GREY = new THREE.Color('#aab4bd');
  const tmp = V(0, 0, 0);
  let clock = 0, lastFlowKey = '', from = {};

  // s: { t, month, rise, set, weather, kWp, solar, home, ev, batt, grid, battSoc, battOn, evOn, evAway (0 parked..1 gone), evPlugged, devices: [kW], house: 'detached' | 'terraced', effects (false hides falling leaves, birds, jogger), still }
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

    clouds.forEach((g, i) => {
      g.visible = s.weather < 0.6 || (s.weather < 1.3 && i < 2);
      g.position.x = ((g.position.x + dt * 0.25 + 15) % 30) - 15;
    });
    windowMat.emissiveIntensity = (1 - day) * (0.35 + Math.min(1.2, s.home));
    panelMat.emissiveIntensity = s.kWp ? 0.5 * (s.solar / s.kWp) : 0;
    panels.count = THREE.MathUtils.clamp(Math.round(s.kWp / 0.45), 0, panelCount);
    leds.forEach((l, i) => l.material.color.set(!s.battOn ? '#333' : s.battSoc > i / 5 + 0.02 ? COLORS.batt : '#333'));

    const ease = s.evAway * s.evAway * (3 - 2 * s.evAway);
    car.visible = s.evOn && s.evAway < 1;
    car.position.set(6.3, 0, 1 + ease * 12);
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

    row.visible = s.house === 'terraced';
    sideTree.visible = !row.visible;

    devs.forEach((d, k) => {
      const p = Math.max(0, s.devices?.[k] ?? 0);
      if (d.spinner) d.spinner.rotation.z -= dt * Math.min(12, p * 6);
      d.glow.color.set(p > 0.02 ? COLORS.home : '#333');
    });

    seasons(s.month, day, dt, clock, s.effects !== false);

    controls.update();
    renderer.render(scene, camera);

    const { clientWidth: w, clientHeight: h } = container;
    for (const [key, el] of Object.entries(labels)) {
      tmp.set(...LABEL_AT[key]);
      if (key === 'ev' && car.visible) tmp.z = Math.min(car.position.z, 8);
      tmp.project(camera);
      const tr = `translate(-50%,-100%) translate(${(((tmp.x + 1) / 2) * w).toFixed(1)}px,${(((1 - tmp.y) / 2) * h).toFixed(1)}px)`;
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
