import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSeasons } from './season.js';

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

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
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
  sunLight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunLight.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, far: 90 });
  scene.add(hemi, sunLight);

  const mat = (color, extra) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
  const add = (geo, material, x, y, z, parent = scene) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const box = (w, h, d, material, x, y, z, parent) => add(new THREE.BoxGeometry(w, h, d), material, x, y, z, parent);

  // Lot, street, driveway
  const grassMat = mat('#7cc66a');
  box(26, 0.5, 22, grassMat, 0, -0.25, 0);
  box(26, 0.06, 3, mat('#555b66'), 0, 0.03, 9.5);
  box(2.8, 0.06, 10.4, mat('#c9c4b8'), 6.3, 0.03, 3);
  box(1.4, 0.06, 6, mat('#c9c4b8'), -2, 0.03, 5);

  // House: x -6..2, z -4..2, front faces +z
  box(8, 3.2, 6, mat('#f2e6d0'), -2, 1.6, -1);
  const tri = new THREE.Shape([new THREE.Vector2(-3.4, 0), new THREE.Vector2(3.4, 0), new THREE.Vector2(0, 2.2)]);
  const roof = add(new THREE.ExtrudeGeometry(tri, { depth: 8.8, bevelEnabled: false }), mat('#b5533c'), -6.4, 3.2, -1);
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
  const panels = [];
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 9; col++)
      panels.push(box(0.88, 1.12, 0.06, panelMat, (col - 4) * 0.95, 0.85 + row * 1.2, 0.06, panelGroup));

  // Home battery with five charge LEDs
  box(0.5, 1.6, 1.1, mat('#e9edf2'), 2.3, 0.8, -2.6);
  const leds = [0, 1, 2, 3, 4].map((i) =>
    box(0.04, 0.18, 0.7, new THREE.MeshBasicMaterial({ color: '#333' }), 2.57, 0.35 + i * 0.26, -2.6));

  // Charger post and car
  box(0.25, 1.2, 0.25, mat('#e9edf2'), 4.6, 0.6, 1);
  const chargerLed = box(0.27, 0.08, 0.27, new THREE.MeshBasicMaterial({ color: '#444' }), 4.6, 1.1, 1);
  const car = new THREE.Group();
  scene.add(car);
  box(1.9, 0.65, 4.4, mat('#f4f5f7', { roughness: 0.3, metalness: 0.3 }), 0, 0.7, 0, car);
  box(1.7, 0.6, 2.5, mat('#1b2330', { roughness: 0.15 }), 0, 1.3, -0.3, car);
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.25, 16).rotateZ(Math.PI / 2);
  for (const [x, z] of [[-0.9, 1.4], [0.9, 1.4], [-0.9, -1.4], [0.9, -1.4]]) add(wheelGeo, mat('#16181c'), x, 0.36, z, car);
  const tailMat = new THREE.MeshBasicMaterial({ color: '#b3261e' });
  for (const x of [-0.7, 0.7]) box(0.35, 0.12, 0.05, tailMat, x, 0.85, -2.2, car);

  // Grid pole
  box(0.3, 6, 0.3, mat('#6b5846'), -9, 3, 7.2);
  box(2.4, 0.2, 0.2, mat('#6b5846'), -9, 5.4, 7.2);
  box(0.9, 1, 0.7, mat('#8b9199'), -9, 0.5, 6.5);

  // Trees
  const coneMat = mat('#3f8f4f');
  for (const [x, z, s] of [[-10, -6, 1.2], [-8.5, -1, 0.9], [9.5, -7, 1.3], [10.5, 4, 1]]) {
    add(new THREE.CylinderGeometry(0.2 * s, 0.26 * s, 1.4 * s, 8), mat('#6b4a2f'), x, 0.7 * s, z);
    add(new THREE.ConeGeometry(1.3 * s, 2.8 * s, 8), coneMat, x, 2.6 * s, z);
  }

  // Sun, moon, clouds
  const sun = new THREE.Mesh(new THREE.SphereGeometry(1.6, 24, 16), new THREE.MeshBasicMaterial({ color: '#ffd84a' }));
  const moon = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: '#dfe6f5' }));
  scene.add(sun, moon);
  const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 });
  const clouds = [[-9, 13, -8], [3, 15, -11], [11, 12, -5], [-3, 14, 3], [8, 16, 6], [-12, 15, 5]].map(([x, y, z]) => {
    const g = new THREE.Group();
    for (const [dx, s] of [[-1.3, 1], [0, 1.4], [1.4, 1.1]]) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(s, 12, 8), cloudMat);
      puff.position.set(dx, 0, 0);
      puff.scale.y = 0.6;
      g.add(puff);
    }
    g.position.set(x, y, z);
    scene.add(g);
    return g;
  });

  // Cables with moving particles
  const flows = {};
  const tube = (curve, color) => add(new THREE.TubeGeometry(curve, 48, 0.045, 6), mat(color), 0, 0, 0);
  const polyline = (pts) => {
    const path = new THREE.CurvePath();
    for (let i = 1; i < pts.length; i++) path.add(new THREE.LineCurve3(V(...pts[i - 1]), V(...pts[i])));
    return path;
  };
  let evCable;
  for (const [key, pts] of Object.entries(PATHS)) {
    const curve = polyline(pts);
    if (key === 'ev') {
      tube(polyline(pts.slice(0, 3)), '#2a2d33');
      evCable = tube(polyline(pts.slice(2)), '#2a2d33');
    } else tube(curve, '#2a2d33');
    const pm = new THREE.MeshBasicMaterial({ color: COLORS[key] });
    const dots = Array.from({ length: PARTICLES }, () => {
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), pm);
      scene.add(d);
      return d;
    });
    flows[key] = { curve, dots, phase: 0, len: curve.getLength() };
  }

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
  let clock = 0;

  // s: { t, month, rise, set, weather, kWp, solar, home, ev, batt, grid, battSoc, battOn, evOn, evAway (0 parked..1 gone), evPlugged }
  function update(s, dt) {
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
    panels.forEach((p, i) => (p.visible = i < Math.round(s.kWp / 0.45)));
    leds.forEach((l, i) => l.material.color.set(!s.battOn ? '#333' : s.battSoc > i / 5 + 0.02 ? COLORS.batt : '#333'));

    const ease = s.evAway * s.evAway * (3 - 2 * s.evAway);
    car.visible = s.evOn && s.evAway < 1;
    car.position.set(6.3, 0, 1 + ease * 12);
    evCable.visible = s.evOn && s.evPlugged;
    chargerLed.material.color.set(s.ev > 0.05 ? (Math.sin(clock * 6) > 0 ? COLORS.ev : '#0d4a35') : '#444');

    for (const [key, f] of Object.entries(flows)) {
      const p = s[key], mag = Math.abs(p);
      const n = mag < 0.03 ? 0 : Math.min(PARTICLES, 3 + Math.ceil(mag * 2));
      f.phase = (f.phase + (Math.sign(p) * (1.5 + 0.5 * Math.min(mag, 11)) * dt) / f.len + 1) % 1;
      f.dots.forEach((d, i) => {
        d.visible = i < n;
        if (d.visible) d.position.copy(f.curve.getPointAt((i / n + f.phase) % 1));
      });
    }

    seasons(s.month, day, dt, clock);

    controls.update();
    renderer.render(scene, camera);

    const { clientWidth: w, clientHeight: h } = container;
    for (const [key, el] of Object.entries(labels)) {
      tmp.set(...LABEL_AT[key]);
      if (key === 'ev' && car.visible) tmp.z = Math.min(car.position.z, 8);
      tmp.project(camera);
      el.style.transform = `translate(-50%,-100%) translate(${((tmp.x + 1) / 2) * w}px,${((1 - tmp.y) / 2) * h}px)`;
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
