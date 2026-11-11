import * as THREE from 'three';

// Seasonal set dressing: grass and tree colours, falling snow, leaves or petals, birds, a jogger with a dog,
// a snowman in winter and a pumpkin in October.
const SEASONS = {
  winter: { grass: '#c7d3cc', cone: '#4f7d62', crowns: null, fall: { n: 320, speed: 1.1, colors: ['#ffffff'] }, birds: false, shirt: '#c0392b' },
  spring: { grass: '#8bd46c', cone: '#4a9a55', crowns: ['#f4b6c8', '#fbe3ea'], fall: { n: 50, speed: 0.55, colors: ['#f7c6d6', '#ffffff'] }, birds: true, shirt: '#2e86de' },
  summer: { grass: '#7cc66a', cone: '#3f8f4f', crowns: ['#3f8f3a', '#4c9c3f'], fall: null, birds: true, shirt: '#f5b700' },
  autumn: { grass: '#a9b56a', cone: '#3c7f48', crowns: ['#d9822b', '#c4452c', '#e8b43a'], fall: { n: 110, speed: 0.7, colors: ['#d9822b', '#c4452c', '#e8b43a', '#8a5a2b'] }, birds: true, shirt: '#7d3c98' },
};
const SEASON_OF = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];
const MAX_FALL = 320;
const rand = (a, b) => a + Math.random() * (b - a);

export function createSeasons({ scene, add, box, mat, grassMat, coneMat }) {
  // Two leafy trees whose crowns change most with the seasons
  const crowns = [[-11.3, 3.4, 1], [10.8, -1.8, 1.15]].map(([x, z, s]) => {
    const bark = mat('#6b4a2f');
    add(new THREE.CylinderGeometry(0.18 * s, 0.24 * s, 2 * s, 8), bark, x, s, z).castShadow = true;
    for (const [ry, rz] of [[0, 0.7], [2.1, 0.6], [4.2, 0.8], [1, -0.1]]) { // bare branches, hidden by the crown when in leaf
      const b = add(new THREE.CylinderGeometry(0.04 * s, 0.08 * s, 1.5 * s, 6).translate(0, 0.75 * s, 0), bark, x, 1.8 * s, z);
      b.rotation.set(0, ry, rz);
    }
    const crown = add(new THREE.IcosahedronGeometry(1.3 * s, 1), mat('#3f8f3a', { flatShading: true }), x, 2.6 * s, z);
    crown.castShadow = true;
    return crown;
  });

  // Falling snow, leaves or petals: one instanced mesh, recycled from the top when a flake lands
  const fall = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.17, 0.11), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), MAX_FALL);
  fall.frustumCulled = false;
  const flakes = Array.from({ length: MAX_FALL }, (_, i) => {
    fall.setColorAt(i, new THREE.Color('#fff'));
    return { x: rand(-13, 13), y: rand(0, 14), z: rand(-11, 11), spin: rand(0, 6) };
  });
  scene.add(fall);
  const dummy = new THREE.Object3D();

  // Birds: a small flock flapping across the sky
  const birdMat = mat('#2b2b2b');
  const birds = [[0, 0], [-1.2, 0.6], [-1.2, -0.6], [-2.4, 1.2], [-2.4, -1.2]].map(([dx, dz]) => {
    const g = new THREE.Group();
    const wings = [-1, 1].map((side) => {
      const pivot = new THREE.Group();
      box(0.55, 0.03, 0.2, birdMat, side * 0.28, 0, 0, pivot);
      g.add(pivot);
      return pivot;
    });
    box(0.3, 0.08, 0.12, birdMat, 0, 0, 0, g);
    g.userData = { dx, dz, wings, flap: rand(0, 6) };
    scene.add(g);
    return g;
  });

  // Jogger with a dog, running along the street
  const limb = (parent, w, h, d, material, x, y) => { // pivot at the hip or shoulder so the limb swings from the top
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    box(w, h, d, material, 0, -h / 2, 0, pivot);
    parent.add(pivot);
    return pivot;
  };
  const runner = new THREE.Group();
  const shirtMat = mat('#2e86de'), skin = mat('#e0ac69'), dark = mat('#2d3436');
  box(0.42, 0.6, 0.26, shirtMat, 0, 1.15, 0, runner);
  add(new THREE.SphereGeometry(0.17, 12, 10), skin, 0, 1.62, 0, runner);
  const hat = add(new THREE.ConeGeometry(0.17, 0.3, 10), mat('#c0392b'), 0, 1.85, 0, runner);
  const legs = [-0.11, 0.11].map((x) => limb(runner, 0.14, 0.85, 0.16, dark, x, 0.85));
  const arms = [-0.28, 0.28].map((x) => limb(runner, 0.1, 0.5, 0.12, skin, x, 1.4));
  const dog = new THREE.Group();
  const fur = mat('#a0522d');
  box(0.7, 0.28, 0.26, fur, 0, 0.45, 0, dog);
  box(0.28, 0.24, 0.22, fur, 0.42, 0.62, 0, dog);
  box(0.12, 0.08, 0.1, dark, 0.6, 0.6, 0, dog);
  const tail = new THREE.Group(); // points up and back, wags sideways
  tail.position.set(-0.35, 0.55, 0);
  tail.rotation.z = 0.6;
  box(0.06, 0.28, 0.06, fur, 0, 0.14, 0, tail);
  dog.add(tail);
  const paws = [[-0.25, -0.08], [-0.25, 0.08], [0.25, -0.08], [0.25, 0.08]].map(([x, z]) => {
    const p = limb(dog, 0.08, 0.32, 0.08, fur, x, 0.34);
    p.position.z = z;
    return p;
  });
  scene.add(runner, dog);
  const casters = (g) => g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  casters(runner);
  casters(dog);

  // Snowman in winter, pumpkin by the door in October
  const snowman = new THREE.Group();
  const snow = mat('#f7f9fb');
  for (const [r, y] of [[0.55, 0.5], [0.4, 1.25], [0.28, 1.8]]) add(new THREE.SphereGeometry(r, 16, 12), snow, 0, y, 0, snowman);
  add(new THREE.ConeGeometry(0.06, 0.3, 8).rotateX(Math.PI / 2), mat('#e67e22'), 0, 1.8, 0.38, snowman);
  box(0.36, 0.3, 0.36, dark, 0, 2.15, 0, snowman);
  for (const x of [-0.1, 0.1]) box(0.05, 0.05, 0.02, dark, x, 1.88, 0.26, snowman);
  snowman.position.set(-4.6, 0, 5);
  scene.add(snowman);
  casters(snowman);
  const pumpkin = add(new THREE.SphereGeometry(0.32, 14, 10).scale(1, 0.75, 1), mat('#e67e22', { emissive: '#ff8c00', emissiveIntensity: 0 }), -1.05, 0.24, 2.6);
  box(0.06, 0.14, 0.06, mat('#4e6b2f'), 0, 0.27, 0, pumpkin);

  let month = -1, season;
  const setMonth = (m) => {
    month = m;
    season = SEASONS[SEASON_OF[m]];
    grassMat.color.set(season.grass);
    coneMat.color.set(season.cone);
    crowns.forEach((c, i) => {
      c.visible = !!season.crowns;
      if (season.crowns) c.material.color.set(season.crowns[i % season.crowns.length]);
    });
    const colors = season.fall?.colors ?? ['#fff'];
    flakes.forEach((_, i) => fall.setColorAt(i, new THREE.Color(colors[i % colors.length])));
    fall.instanceColor.needsUpdate = true;
    shirtMat.color.set(season.shirt);
    hat.visible = SEASON_OF[m] === 'winter';
    snowman.visible = SEASON_OF[m] === 'winter';
    pumpkin.visible = m === 9;
  };

  // m: month 0..11, day: 0 night..1 full daylight
  return function update(m, day, dt, clock) {
    if (m !== month) setMonth(m);

    const f = season.fall;
    fall.count = f ? f.n : 0;
    for (let i = 0; i < fall.count; i++) {
      const p = flakes[i];
      p.y -= f.speed * dt;
      p.x += (Math.sin(clock * 0.9 + p.spin) * 0.5 + 0.25) * dt;
      if (p.y < 0.05 || p.x > 13) Object.assign(p, { x: rand(-13, 11), y: rand(11, 14), z: rand(-11, 11) });
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(clock * 1.7 + p.spin, clock * 1.1 + p.spin, p.spin);
      dummy.updateMatrix();
      fall.setMatrixAt(i, dummy.matrix);
    }
    fall.instanceMatrix.needsUpdate = true;

    // The flock crosses the sky about every 35 seconds, by day only
    const bx = ((clock * 1.8) % 64) - 32;
    birds.forEach((b) => {
      b.visible = season.birds && day > 0.5;
      b.position.set(bx + b.userData.dx, 6 + Math.sin(clock * 0.7) * 0.5, -6 + b.userData.dz);
      const a = Math.sin(clock * 9 + b.userData.flap) * 0.6;
      b.userData.wings[0].rotation.z = -a;
      b.userData.wings[1].rotation.z = a;
    });

    // Jogger loops along the street, by day, with the dog trotting just ahead
    const out = day < 0.6;
    runner.visible = dog.visible = !out;
    const rx = ((clock * 1.6) % 24) - 12.6, step = clock * 9;
    runner.position.set(rx, Math.abs(Math.sin(step)) * 0.07, 8.7);
    runner.rotation.y = Math.PI / 2;
    legs.forEach((l, i) => (l.rotation.x = Math.sin(step + i * Math.PI) * 0.7));
    arms.forEach((a, i) => (a.rotation.x = -Math.sin(step + i * Math.PI) * 0.6));
    dog.position.set(rx + 1.3, Math.abs(Math.sin(step * 1.3)) * 0.05, 9.3);
    paws.forEach((p, i) => (p.rotation.z = Math.sin(step * 1.3 + (i % 2) * Math.PI) * 0.6));
    tail.rotation.x = Math.sin(clock * 14) * 0.6;
    pumpkin.material.emissiveIntensity = (1 - day) * 0.9; // glows at night
  };
}
