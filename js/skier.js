// The player's skier (jointed rig, physics, lift riding), ski tracks, snow spray and the AI crowd.
import * as THREE from 'three';
import { Builder, srgb, mat, clamp, lerp } from './util.js';

const SKIN = srgb(0.93, 0.76, 0.62), HELMET = srgb(0.12, 0.12, 0.14), GOGGLE = srgb(1.0, 0.62, 0.12), GLOVE = srgb(0.1, 0.1, 0.11);
const BOOT = srgb(0.16, 0.17, 0.2), POLE = srgb(0.75, 0.77, 0.8), WHITE = srgb(1, 1, 1);

function part(geo, color, m) { return new Builder().add(geo, color, m).geometry(); }
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

/**
 * Jointed low-poly skier. Origin between the feet on the snow, facing +z.
 * Pose: crouch 0..1, lean (angulation), plant (-1..1 pole plant side), tuck, seated.
 */
export class Rig {
  constructor(material, colors = {}) {
    const jacket = colors.jacket ?? srgb(0.1, 0.45, 0.85), pants = colors.pants ?? srgb(0.13, 0.14, 0.18), ski = colors.ski ?? srgb(0.9, 0.15, 0.1);
    const M = (geo, color, m, tag) => { const mesh = new THREE.Mesh(part(geo, color, m), material); mesh.castShadow = true; mesh.userData.tag = tag; return mesh; };
    this.root = new THREE.Group();
    this.body = new THREE.Group(); this.root.add(this.body);
    this.pelvis = new THREE.Group(); this.body.add(this.pelvis);
    this.pelvis.add(M(box(0.32, 0.16, 0.22), pants, null, 'pants'));
    this.legs = [-1, 1].map((s) => {
      const hip = new THREE.Group(); hip.position.set(s * 0.1, -0.04, 0); this.pelvis.add(hip);
      hip.add(M(box(0.15, 0.46, 0.17), pants, mat(0, -0.22, 0), 'pants'));
      const knee = new THREE.Group(); knee.position.set(0, -0.45, 0); hip.add(knee);
      knee.add(M(box(0.13, 0.44, 0.15), pants, mat(0, -0.2, 0.01), 'pants'));
      const foot = new THREE.Group(); foot.position.set(0, -0.44, 0); knee.add(foot);
      foot.add(M(box(0.14, 0.2, 0.3), BOOT, mat(0, -0.02, 0.03), 'boot'));
      const skiG = new THREE.Group(); skiG.position.set(0, -0.12, 0.04); foot.add(skiG);
      skiG.add(M(box(0.1, 0.04, 1.62), ski, mat(0, 0, -0.04), 'ski'));
      skiG.add(M(box(0.1, 0.04, 0.2), ski, mat(0, 0.04, 0.83, -0.45), 'ski'));
      skiG.add(M(box(0.1, 0.05, 0.22), BOOT, mat(0, 0.03, 0.0), 'binding'));
      return { s, hip, knee, foot, ski: skiG };
    });
    this.torso = new THREE.Group(); this.pelvis.add(this.torso);
    this.torso.add(M(box(0.4, 0.5, 0.25), jacket, mat(0, 0.27, 0), 'jacket'));
    this.torso.add(M(box(0.405, 0.06, 0.255), WHITE, mat(0, 0.36, 0), 'stripe'));
    this.torso.add(M(box(0.12, 0.08, 0.12), jacket, mat(0, 0.55, 0), 'jacket'));
    this.head = new THREE.Group(); this.head.position.set(0, 0.6, 0.02); this.torso.add(this.head);
    this.head.add(M(box(0.19, 0.2, 0.2), SKIN, mat(0, 0.1, 0), 'skin'));
    this.head.add(M(box(0.235, 0.15, 0.25), HELMET, mat(0, 0.2, -0.005), 'helmet'));
    this.head.add(M(box(0.21, 0.075, 0.05), GOGGLE, mat(0, 0.12, 0.105), 'goggle'));
    this.arms = [-1, 1].map((s) => {
      const sh = new THREE.Group(); sh.position.set(s * 0.25, 0.47, 0); this.torso.add(sh);
      sh.add(M(box(0.1, 0.32, 0.11), jacket, mat(0, -0.15, 0), 'jacket'));
      const el = new THREE.Group(); el.position.set(0, -0.3, 0); sh.add(el);
      el.add(M(box(0.09, 0.28, 0.1), jacket, mat(0, -0.13, 0), 'jacket'));
      el.add(M(box(0.09, 0.1, 0.1), GLOVE, mat(0, -0.3, 0), 'glove'));
      const pole = new THREE.Group(); pole.position.set(0, -0.3, 0); el.add(pole);
      pole.add(M(new THREE.CylinderGeometry(0.011, 0.011, 1.18, 5), POLE, mat(0, -0.55, 0), 'pole'));
      pole.add(M(new THREE.CylinderGeometry(0.05, 0.05, 0.012, 8), POLE, mat(0, -1.05, 0), 'pole'));
      return { s, sh, el, pole };
    });
    this.pose({});
  }
  /** Two-bone leg IK in the sagittal plane: hip at the pelvis, ankle above the binding. */
  legIK(leg, hipY, hipZ, edge) {
    const l1 = 0.45, l2 = 0.44;
    const fy = 0.12 - hipY, fz = 0.03 - hipZ;
    const L = clamp(Math.hypot(fy, fz), 0.3, l1 + l2 - 0.005);
    const theta = Math.atan2(fz, -fy);
    const alpha = Math.acos(clamp((l1 * l1 + L * L - l2 * l2) / (2 * l1 * L), -1, 1));
    const t1 = theta + alpha; // thigh angle from straight down; knee goes forward
    const ky = -Math.cos(t1) * l1, kz = Math.sin(t1) * l1;
    const t2 = Math.atan2(fz - kz, -(fy - ky));
    leg.hip.rotation.set(-t1, 0, 0);
    leg.knee.rotation.set(-(t2 - t1), 0, 0);
    leg.foot.rotation.set(t2, 0, 0); // boots stay level with the snow
    leg.ski.rotation.set(0, 0, edge);
  }
  pose({ crouch = 0.2, lean = 0, plant = 0, seated = false, tuck = 0, t = 0 }) {
    const P = this.pelvis;
    if (seated) {
      P.position.set(0, 0.5, -0.05); this.body.rotation.set(0, 0, 0);
      for (const leg of this.legs) {
        leg.hip.position.x = leg.s * 0.1;
        leg.hip.rotation.set(-1.45, 0, 0); leg.knee.rotation.set(1.35, 0, 0); leg.foot.rotation.set(0.2, 0, 0); leg.ski.rotation.set(0, 0, 0);
      }
      this.torso.rotation.set(-0.12, 0, 0);
      for (const a of this.arms) { a.sh.rotation.set(-0.5, 0, -a.s * 0.15); a.el.rotation.set(-0.9, 0, 0); a.pole.rotation.set(1.6, 0, 0); }
      this.head.rotation.set(0.1, 0, 0);
      return;
    }
    const c = clamp(crouch, 0, 1);
    const hipY = 0.98 - 0.36 * c - 0.1 * tuck, hipZ = -0.1 * c - 0.1 * tuck;
    P.position.set(0, hipY, hipZ);
    this.body.rotation.set(0, 0, lean);
    const edge = lean * 0.35;
    for (const leg of this.legs) {
      leg.hip.position.x = leg.s * (0.1 + Math.abs(lean) * 0.03);
      const inside = leg.s * lean < 0; // inside leg flexes more
      this.legIK(leg, hipY - (inside ? 0.06 : 0) * Math.abs(lean) * 2, hipZ, edge);
    }
    const pitch = 0.12 + 0.55 * c + 0.5 * tuck;
    this.torso.rotation.set(pitch, 0, -lean * 0.45);
    this.head.rotation.set(-pitch * 0.75, 0, -lean * 0.25);
    for (const a of this.arms) {
      const pl = plant * a.s < 0 ? Math.abs(plant) : 0; // plant the inside pole
      if (tuck > 0.5) {
        a.sh.rotation.set(-1.25 - pitch * 0.3, 0, -a.s * 0.3); a.el.rotation.set(-1.5, 0, 0); a.pole.rotation.set(2.6, 0, a.s * 0.15);
      } else {
        a.sh.rotation.set(-0.4 - 0.45 * pl - pitch * 0.45 + Math.sin(t * 2) * 0.02, 0, -a.s * 0.2);
        a.el.rotation.set(-0.8 + 0.25 * pl, 0, 0);
        a.pole.rotation.set(1.35 + pitch * 0.4 - 0.5 * pl, 0, a.s * 0.08);
      }
    }
  }
  /** Bake the current pose into geometry (jacket parts white for instance tinting, everything else coloured). */
  bake(offset = new THREE.Matrix4()) {
    this.root.updateMatrixWorld(true);
    const jacket = new Builder(), rest = new Builder();
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      const isJ = o.userData.tag === 'jacket';
      const g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(offset, o.matrixWorld));
      const b = isJ ? jacket : rest;
      const p = g.attributes.position.array, c = g.attributes.color.array;
      for (let k = 0; k < p.length; k++) { b.pos.push(p[k]); b.col.push(isJ ? 1 : c[k]); }
      g.dispose();
    });
    return { jacket: jacket.geometry(), rest: rest.geometry() };
  }
}

/** Seated rider for chairlifts; origin at the rope, seat 2.24 m below. */
export function riderGeometries(material) {
  const rig = new Rig(material, { jacket: WHITE });
  rig.pose({ seated: true });
  return rig.bake(mat(0, -2.68, 0.05));
}

// ---------------------------------------------------------------- tracks and spray
export class Trails {
  constructor(scene, max = 900) {
    this.max = max; this.n = 0; this.head = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 2 * 18);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x7f93b4, transparent: true, opacity: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.last = null;
  }
  reset() { this.last = null; }
  add(skis, side, width = 0.06) {
    if (this.last) {
      const d = this.last[0].distanceTo(skis[0]);
      if (d < 0.4) return;
      if (d > 4) { this.last = skis.map((p) => p.clone()); return; }
      for (let s = 0; s < 2; s++) {
        const a = this.last[s], b = skis[s], o = this.head * 2 + s, l = 0.025;
        this.pos.set([
          a.x - side.x * width, a.y + l, a.z - side.z * width, a.x + side.x * width, a.y + l, a.z + side.z * width, b.x + side.x * width, b.y + l, b.z + side.z * width,
          a.x - side.x * width, a.y + l, a.z - side.z * width, b.x + side.x * width, b.y + l, b.z + side.z * width, b.x - side.x * width, b.y + l, b.z - side.z * width,
        ], o * 18);
      }
      this.head = (this.head + 1) % this.max;
      this.n = Math.min(this.n + 1, this.max);
      this.mesh.geometry.setDrawRange(0, this.n * 12);
      this.mesh.geometry.attributes.position.needsUpdate = true;
    }
    this.last = skis.map((p) => p.clone());
  }
}

export class Spray {
  constructor(scene, max = 400) {
    this.max = max;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.life = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const x = c.getContext('2d'), gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 32, 32);
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.32, map: new THREE.CanvasTexture(c), transparent: true, opacity: 0.85, depthWrite: false, color: 0xf4f8ff }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.k = 0;
    for (let i = 0; i < max; i++) this.p[i * 3 + 1] = -1e5;
  }
  emit(at, vel, n, spread = 1.5) {
    for (let i = 0; i < n; i++) {
      const k = this.k = (this.k + 1) % this.max;
      this.p[k * 3] = at.x + (Math.random() - 0.5) * 0.4; this.p[k * 3 + 1] = at.y + 0.05; this.p[k * 3 + 2] = at.z + (Math.random() - 0.5) * 0.4;
      this.v[k * 3] = vel.x + (Math.random() - 0.5) * spread; this.v[k * 3 + 1] = vel.y + Math.random() * spread; this.v[k * 3 + 2] = vel.z + (Math.random() - 0.5) * spread;
      this.life[k] = 0.4 + Math.random() * 0.6;
    }
  }
  update(dt) {
    const drag = Math.exp(-2.5 * dt);
    for (let k = 0; k < this.max; k++) {
      if (this.life[k] <= 0) continue;
      this.life[k] -= dt;
      if (this.life[k] <= 0) { this.p[k * 3 + 1] = -1e5; continue; }
      this.v[k * 3] *= drag; this.v[k * 3 + 2] *= drag; this.v[k * 3 + 1] = this.v[k * 3 + 1] * drag - 6 * dt;
      this.p[k * 3] += this.v[k * 3] * dt; this.p[k * 3 + 1] += this.v[k * 3 + 1] * dt; this.p[k * 3 + 2] += this.v[k * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

function blobTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(20,30,50,0.5)'); gr.addColorStop(1, 'rgba(20,30,50,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------- player
const G = 9.81;
const v3 = () => new THREE.Vector3();

export class Player {
  constructor(scene, material, ground, forest) {
    this.g = ground; this.forest = forest;
    this.rig = new Rig(material);
    this.root = this.rig.root;
    scene.add(this.root);
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
    scene.add(this.blob);
    this.trails = new Trails(scene);
    this.spray = new Spray(scene);
    this.pos = v3(); this.vel = v3(); this.yaw = 0; this.n = new THREE.Vector3(0, 1, 0);
    this.air = false; this.airTime = 0; this.lean = 0; this.crouch = 0.2; this.tuckAmt = 0; this.ride = null; this.bumpT = 0;
    this.plant = 0; this.lastTurn = 0; this.time = 0; this.skid = 0;
    this.input = { turn: 0, tuck: false, brake: false, jump: false, fast: false };
    this.events = [];
  }
  get speed() { return this.vel.length(); }
  get forward() { return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  place(p, yaw, speed = 0) {
    this.pos.copy(p); this.pos.y = this.g.height(p.x, p.z);
    this.yaw = yaw; this.vel.copy(this.forward).multiplyScalar(speed);
    this.air = false; this.ride = null; this.root.visible = true;
    this.trails.reset();
  }
  downhillYaw(p) {
    const n = this.g.normal(p.x, p.z, v3(), 10);
    return Math.hypot(n.x, n.z) < 0.02 ? this.yaw : Math.atan2(n.x, n.z);
  }
  startRide(lift) { this.ride = { lift, s: 0 }; this.vel.set(0, 0, 0); this.air = false; this.trails.reset(); }
  step(dt, lifts) {
    this.time += dt;
    if (this.ride) return this.stepRide(dt, lifts);
    const inp = this.input, g = this.g;
    const speed = this.vel.length();
    const turnRate = (inp.brake ? 2.4 : 1.9) / (1 + speed * 0.025);
    this.yaw -= inp.turn * turnRate * dt * (this.air ? 0.6 : 1);
    this.bumpT = Math.max(0, this.bumpT - dt);
    if (inp.turn && inp.turn !== this.lastTurn && speed > 3 && !this.air) this.plant = inp.turn;
    this.lastTurn = inp.turn;
    this.plant *= Math.exp(-3.5 * dt);
    const fwd = this.forward;
    if (this.air) {
      this.airTime += dt;
      this.vel.y -= G * dt;
      this.vel.multiplyScalar(1 - 0.0015 * speed * dt);
      this.pos.addScaledVector(this.vel, dt);
      const h = g.height(this.pos.x, this.pos.z);
      if (this.pos.y <= h) {
        g.normal(this.pos.x, this.pos.z, this.n);
        const into = -this.vel.dot(this.n);
        this.pos.y = h; this.air = false;
        this.vel.addScaledVector(this.n, Math.max(into, 0));
        const along = Math.abs(this.vel.clone().normalize().dot(fwd));
        this.spray.emit(this.pos, this.vel.clone().multiplyScalar(0.3).setY(1), Math.min(60, 10 + into * 6), 2.5);
        if (into > 11 || along < 0.5) { this.vel.multiplyScalar(0.45); this.bump('Hard landing!'); }
        else if (this.airTime > 0.6) this.events.push({ type: 'land', t: this.airTime, into });
        this.trails.reset();
      }
    } else {
      const n = g.normal(this.pos.x, this.pos.z, this.n);
      const gt = v3().set(0, -G, 0).addScaledVector(n, G * n.y);
      const f = fwd.clone().addScaledVector(n, -fwd.dot(n)).normalize();
      const side = v3().crossVectors(n, f).normalize();
      const vf = this.vel.dot(f);
      let vs = this.vel.dot(side);
      const grip = inp.brake ? 2.2 : 8;
      this.skid = lerp(this.skid, Math.abs(vs), 1 - Math.exp(-10 * dt));
      vs *= Math.exp(-grip * dt);
      this.vel.copy(f).multiplyScalar(vf).addScaledVector(side, vs);
      this.vel.addScaledVector(gt, dt);
      if (inp.tuck && speed < 5 && !inp.brake) this.vel.addScaledVector(f, 2.6 * dt);
      const mu = inp.brake ? 0.38 : 0.05;
      const k = inp.tuck ? 0.0042 : inp.brake ? 0.011 : 0.0075;
      const sp = this.vel.length();
      const decel = (mu * G * n.y + k * sp * sp) * dt;
      if (decel >= sp) this.vel.set(0, 0, 0); else this.vel.multiplyScalar(1 - decel / sp);
      if (inp.brake && sp < 1.2) this.vel.multiplyScalar(Math.max(0, 1 - 3 * dt));
      const prevY = this.pos.y;
      this.pos.addScaledVector(this.vel, dt);
      const h = g.height(this.pos.x, this.pos.z);
      const projected = prevY + this.vel.y * dt;
      if (inp.jump && sp > 0.5) {
        this.vel.addScaledVector(n, 4.2); this.air = true; this.airTime = 0; this.pos.y = Math.max(projected, h) + 0.05;
      } else if (projected - h > 0.35 && sp > 8) {
        this.air = true; this.airTime = 0; this.pos.y = projected;
      } else {
        this.pos.y = h;
        const n2 = g.normal(this.pos.x, this.pos.z, v3());
        this.vel.addScaledVector(n2, -this.vel.dot(n2));
      }
      this.lean = lerp(this.lean, clamp(inp.turn * Math.min(sp / 12, 1) * 0.6 + vs * 0.02, -0.75, 0.75), 1 - Math.exp(-6 * dt));
    }
    inp.jump = false;
    if (this.forest.collide(this.pos, 0.45)) {
      if (this.speed > 4) this.bump('Tree!');
      this.vel.multiplyScalar(0.3);
    }
    if (!g.inside(this.pos.x, this.pos.z, 150)) {
      this.pos.x = clamp(this.pos.x, g.minX + 150, g.maxX - 150);
      this.pos.z = clamp(this.pos.z, g.minZ + 150, g.maxZ - 150);
      this.vel.multiplyScalar(0.2);
    }
  }
  bump(text) { if (this.bumpT <= 0) { this.events.push({ type: 'bump', text }); this.bumpT = 1.2; } }
  stepRide(dt, lifts) {
    const R = this.ride, L = R.lift;
    R.s += L.speed * dt * (this.input.fast ? 8 : 1);
    const d = v3();
    if (L.surface) {
      L.up.at(R.s, this.pos, d);
      this.pos.y = this.g.height(this.pos.x, this.pos.z);
      this.yaw = Math.atan2(d.x, d.z);
      this.lean = 0;
    } else {
      lifts.loopAt(L, R.s, this.pos, d);
      this.pos.y -= L.gondola ? 3.9 : 2.68;
      this.yaw = Math.atan2(d.x, d.z);
    }
    if (R.s >= L.up.length - 2) {
      const exit = L.top.clone().addScaledVector(L.topDir, L.clear).addScaledVector(L.rightN, L.surface ? 4 : 0);
      this.place(exit, Math.atan2(L.topDir.x, L.topDir.z), 2.5);
      this.events.push({ type: 'top', lift: L });
    }
  }
  /** Drive the rig, tracks and spray from the physics state. */
  pose(dt) {
    const inp = this.input;
    this.root.position.copy(this.pos);
    const seated = this.ride && !this.ride.lift.surface;
    this.root.visible = !(this.ride && this.ride.lift.gondola);
    const up = this.air || seated ? new THREE.Vector3(0, 1, 0) : this.n;
    const f = this.forward;
    const fz = f.clone().addScaledVector(up, -f.dot(up)).normalize();
    const x = v3().crossVectors(up, fz).normalize();
    this.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, fz));
    const tucking = inp.tuck && this.speed > 4 && !inp.brake && !this.ride;
    this.tuckAmt = lerp(this.tuckAmt, tucking ? 1 : 0, 1 - Math.exp(-6 * dt));
    const target = this.ride ? 0.1 : this.air ? 0.45 : tucking ? 0.85 : inp.brake ? 0.45 : 0.2 + Math.abs(this.lean) * 0.45;
    this.crouch = lerp(this.crouch, target, 1 - Math.exp(-8 * dt));
    this.rig.pose({ seated, crouch: this.crouch, lean: this.lean, plant: this.plant, tuck: this.tuckAmt, t: this.time });
    const h = this.g.height(this.pos.x, this.pos.z);
    this.blob.visible = this.blobEnabled !== false && this.root.visible && !seated && this.pos.y - h < 6;
    this.blob.position.set(this.pos.x, h + 0.03, this.pos.z);
    this.blob.rotation.y = this.yaw;
    const sc = 1 / (1 + (this.pos.y - h) * 0.4);
    this.blob.scale.set(sc, 1, sc);
    if (!this.ride && !this.air && this.speed > 0.5) {
      const skis = [-1, 1].map((s) => this.pos.clone().addScaledVector(x, s * 0.11));
      for (const p of skis) p.y = this.g.height(p.x, p.z);
      this.trails.add(skis, x);
      const sp = this.speed;
      const amount = (inp.brake ? clamp(sp / 8, 0, 1) * 3 : 0) + clamp(this.skid - 1, 0, 3) + (Math.abs(this.lean) > 0.35 && sp > 10 ? 0.8 : 0);
      if (amount > 0.3 && Math.random() < amount * dt * 30) {
        const out = x.clone().multiplyScalar(-Math.sign(this.lean || 1) * (0.8 + sp * 0.1)).addScaledVector(this.vel, 0.35);
        out.y = 1 + sp * 0.05;
        this.spray.emit(this.pos.clone().addScaledVector(f, -0.4), out, Math.ceil(amount * 2), 0.8 + sp * 0.05);
      }
    } else if (this.ride) this.trails.reset();
    this.spray.update(dt);
  }
}

// ---------------------------------------------------------------- crowd
export class Crowd {
  constructor(scene, material, pisteIndex, ground, count = 90) {
    this.pi = pisteIndex; this.g = ground; this.count = count; this.active = count;
    const rig = new Rig(material, { jacket: WHITE });
    // two baked poses, carving left and right
    this.meshes = [0.35, -0.35].map((lean) => {
      rig.pose({ crouch: 0.35, lean });
      const { jacket, rest } = rig.bake();
      const mj = new THREE.InstancedMesh(jacket, material, count), mr = new THREE.InstancedMesh(rest, material, count);
      for (const m of [mj, mr]) { m.castShadow = true; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); }
      return [mj, mr];
    });
    const c = new THREE.Color();
    const palette = [0xd62828, 0xf77f00, 0xfcbf49, 0x2a9d8f, 0x264653, 0x7b2cbf, 0x3a86ff, 0xff006e, 0x222222, 0xf1faee, 0x8ecae6, 0x588157];
    this.colors = Array.from({ length: count }, (_, k) => new THREE.Color(palette[k % palette.length]));
    for (let k = 0; k < count; k++) for (const [mj] of this.meshes) mj.setColorAt(k, this.colors[k]);
    this.skiers = Array.from({ length: count }, (_, k) => ({ k, P: null, s: 0, v: 8, ph: 0, amp: 5, freq: 0.3, prev: new THREE.Vector3() }));
    this.zero = new THREE.Matrix4().makeScale(0, 0, 0);
  }
  spawn(sk, center) {
    const near = this.pi.pistes.filter((P) => P.line.length > 200 && Math.hypot(P.mid.x - center.x, P.mid.z - center.z) < 2000);
    const pool = near.length ? near : this.pi.pistes;
    const P = pool[Math.floor(Math.random() * pool.length)];
    sk.P = P;
    sk.s = Math.random() * P.line.length * 0.8;
    sk.v = (P.d === 3 ? 11 : P.d === 2 ? 9 : 7) * (0.7 + Math.random() * 0.6);
    sk.amp = P.width * (0.15 + Math.random() * 0.22);
    sk.freq = 0.12 + Math.random() * 0.1;
    sk.ph = Math.random() * 6.28;
  }
  update(dt, center) {
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s1 = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3(), d = new THREE.Vector3(), side = new THREE.Vector3();
    const n = [0, 0];
    for (const sk of this.skiers) {
      if (sk.k >= this.active) continue;
      if (!sk.P || sk.s >= sk.P.line.length || Math.hypot(sk.prev.x - center.x, sk.prev.z - center.z) > 2600) this.spawn(sk, center);
      sk.s += sk.v * dt;
      sk.ph += sk.freq * 6.283 * dt;
      sk.P.line.at(sk.s, p, d);
      side.set(-d.z, 0, d.x).normalize();
      const off = Math.sin(sk.ph) * sk.amp, dOff = Math.cos(sk.ph) * sk.amp * sk.freq * 6.283;
      p.addScaledVector(side, off);
      p.y = this.g.height(p.x, p.z);
      const yaw = Math.atan2(d.x, d.z) - Math.atan2(dOff, sk.v) * 0.9;
      // curving right (yaw decreasing) when the offset's rate is falling
      const right = Math.sin(sk.ph) < 0;
      e.set(0.0, yaw, 0, 'YXZ');
      q.setFromEuler(e);
      M.compose(p, q, s1);
      const i = right ? 0 : 1, [mj, mr] = this.meshes[i], slot = n[i]++;
      mj.setMatrixAt(slot, M); mr.setMatrixAt(slot, M); mj.setColorAt(slot, this.colors[sk.k]);
      sk.prev.copy(p);
    }
    this.meshes.forEach(([mj, mr], i) => {
      mj.count = mr.count = n[i];
      mj.instanceMatrix.needsUpdate = true; mr.instanceMatrix.needsUpdate = true;
      if (mj.instanceColor) mj.instanceColor.needsUpdate = true;
    });
  }
}
