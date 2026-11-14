// The player's skier (model, physics, lift riding) and the AI crowd.
import * as THREE from 'three';
import { Builder, srgb, mat, clamp, hash, lerp } from './util.js';

const SKIN = srgb(0.93, 0.76, 0.62), PANTS = srgb(0.12, 0.13, 0.17), HELMET = srgb(0.1, 0.1, 0.12), GOGGLE = srgb(0.95, 0.6, 0.15);
const SKI = srgb(0.9, 0.15, 0.1), POLE = srgb(0.7, 0.72, 0.75), WHITE = srgb(1, 1, 1);

/** Jacket parts are white so instance colours tint them. Facing +z, feet at y=0. */
function bodyParts(jacket, posed = 0) {
  const lower = new Builder(), upper = new Builder();
  for (const s of [-1, 1]) {
    lower.add(new THREE.BoxGeometry(0.09, 0.035, 1.75), SKI, mat(s * 0.13, 0.02, 0.05));
    lower.add(new THREE.BoxGeometry(0.13, 0.2, 0.26), HELMET, mat(s * 0.13, 0.12, 0));
    lower.add(new THREE.BoxGeometry(0.14, 0.75, 0.15), PANTS, mat(s * 0.13, 0.55, 0.03, -0.25 * posed));
  }
  upper.add(new THREE.BoxGeometry(0.42, 0.6, 0.26), jacket, mat(0, 1.18, 0, 0.25));
  upper.add(new THREE.BoxGeometry(0.2, 0.22, 0.22), SKIN, mat(0, 1.6, 0.08));
  upper.add(new THREE.BoxGeometry(0.24, 0.14, 0.26), HELMET, mat(0, 1.74, 0.07));
  upper.add(new THREE.BoxGeometry(0.2, 0.07, 0.04), GOGGLE, mat(0, 1.63, 0.2));
  for (const s of [-1, 1]) {
    upper.add(new THREE.BoxGeometry(0.1, 0.5, 0.11), jacket, mat(s * 0.26, 1.15, 0.12, -0.7));
    upper.add(new THREE.BoxGeometry(0.025, 1.2, 0.025), POLE, mat(s * 0.36, 0.62, 0.05, 0.35));
  }
  return { lower, upper };
}

export function crowdGeometries() {
  const { lower, upper } = bodyParts(WHITE);
  const all = new Builder();
  all.pos.push(...lower.pos, ...upper.pos); all.col.push(...lower.col, ...upper.col);
  return all.geometry();
}

export function riderGeometry() {
  const b = new Builder();
  b.add(new THREE.BoxGeometry(0.4, 0.55, 0.24), WHITE, mat(0, -1.95, -0.05));
  b.add(new THREE.BoxGeometry(0.2, 0.22, 0.22), SKIN, mat(0, -1.53, 0));
  b.add(new THREE.BoxGeometry(0.24, 0.14, 0.26), HELMET, mat(0, -1.39, 0));
  for (const s of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.14, 0.14, 0.55), PANTS, mat(s * 0.11, -2.22, 0.27));
    b.add(new THREE.BoxGeometry(0.12, 0.55, 0.14), PANTS, mat(s * 0.11, -2.5, 0.52));
    b.add(new THREE.BoxGeometry(0.08, 0.03, 1.6), SKI, mat(s * 0.11, -2.8, 0.75, 0.3));
  }
  return b.geometry();
}

// ---------------------------------------------------------------- player
const G = 9.81;
const v3 = () => new THREE.Vector3();

export class Player {
  constructor(scene, material, ground, forest) {
    this.g = ground; this.forest = forest;
    this.root = new THREE.Group();
    this.tilt = new THREE.Group(); // aligns to slope + lean
    this.root.add(this.tilt);
    const { lower, upper } = bodyParts(srgb(0.1, 0.45, 0.85));
    this.lower = new THREE.Mesh(lower.geometry(), material);
    this.upper = new THREE.Mesh(upper.geometry(), material);
    for (const m of [this.lower, this.upper]) { m.castShadow = true; this.tilt.add(m); }
    scene.add(this.root);
    this.pos = v3(); this.vel = v3(); this.yaw = 0; this.n = new THREE.Vector3(0, 1, 0);
    this.air = false; this.airTime = 0; this.lean = 0; this.crouch = 0; this.ride = null; this.bumpT = 0;
    this.input = { turn: 0, tuck: false, brake: false, jump: false, fast: false };
    this.events = [];
  }
  get speed() { return this.vel.length(); }
  get forward() { return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  place(p, yaw, speed = 0) {
    this.pos.copy(p); this.pos.y = this.g.height(p.x, p.z);
    this.yaw = yaw; this.vel.copy(this.forward).multiplyScalar(speed);
    this.air = false; this.ride = null; this.root.visible = true;
  }
  downhillYaw(p) {
    const n = this.g.normal(p.x, p.z, v3(), 10);
    return Math.hypot(n.x, n.z) < 0.02 ? this.yaw : Math.atan2(n.x, n.z);
  }
  startRide(lift) { this.ride = { lift, s: 0 }; this.vel.set(0, 0, 0); this.air = false; }
  step(dt, lifts) {
    if (this.ride) return this.stepRide(dt, lifts);
    const inp = this.input, g = this.g;
    const speed = this.vel.length();
    // steering: quicker at low speed, pivot when braking
    const turnRate = (inp.brake ? 2.4 : 1.9) / (1 + speed * 0.025);
    this.yaw -= inp.turn * turnRate * dt * (this.air ? 0.6 : 1);
    this.bumpT = Math.max(0, this.bumpT - dt);
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
        // landing with the skis across the slope scrubs speed
        const along = Math.abs(this.vel.clone().normalize().dot(fwd));
        if (into > 11 || along < 0.5) { this.vel.multiplyScalar(0.45); this.bump('Hard landing!'); }
        else if (this.airTime > 0.6) this.events.push({ type: 'land', t: this.airTime, into });
      }
    } else {
      const n = g.normal(this.pos.x, this.pos.z, this.n);
      const gt = v3().set(0, -G, 0).addScaledVector(n, G * n.y); // gravity along slope
      const f = fwd.clone().addScaledVector(n, -fwd.dot(n)).normalize();
      const side = v3().crossVectors(n, f).normalize();
      let vf = this.vel.dot(f), vs = this.vel.dot(side);
      // edges grip: sideways speed bleeds away (carving); braking skids
      const grip = inp.brake ? 2.2 : 8;
      vs *= Math.exp(-grip * dt);
      this.vel.copy(f).multiplyScalar(vf).addScaledVector(side, vs);
      this.vel.addScaledVector(gt, dt);
      if (inp.tuck && speed < 5 && !inp.brake) this.vel.addScaledVector(f, 2.6 * dt); // skating
      const mu = inp.brake ? 0.38 : 0.05;
      const k = inp.tuck ? 0.0042 : inp.brake ? 0.011 : 0.0075;
      const sp = this.vel.length();
      const decel = (mu * G * n.y + k * sp * sp) * dt;
      if (decel >= sp) this.vel.set(0, 0, 0); else this.vel.multiplyScalar(1 - decel / sp);
      // braking also stops slow drifting on gentle ground
      if (inp.brake && sp < 1.2) this.vel.multiplyScalar(Math.max(0, 1 - 3 * dt));
      vf = this.vel.dot(f);
      const prevY = this.pos.y;
      this.pos.addScaledVector(this.vel, dt);
      const h = g.height(this.pos.x, this.pos.z);
      const projected = prevY + this.vel.y * dt;
      if (inp.jump && sp > 0.5) {
        this.vel.addScaledVector(n, 4.2); this.air = true; this.airTime = 0; this.pos.y = Math.max(projected, h) + 0.05;
      } else if (projected - h > 0.35 && sp > 8) {
        this.air = true; this.airTime = 0; this.pos.y = projected; // took off over a lip
      } else {
        this.pos.y = h;
        const n2 = g.normal(this.pos.x, this.pos.z, v3());
        this.vel.addScaledVector(n2, -this.vel.dot(n2));
      }
      this.lean = lerp(this.lean, clamp(inp.turn * Math.min(sp / 12, 1) * 0.55 + vs * 0.02, -0.7, 0.7), 1 - Math.exp(-6 * dt));
    }
    inp.jump = false;
    // trees and the map edge
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
      this.pos.y -= L.gondola ? 3.9 : 3.15;
      this.yaw = Math.atan2(d.x, d.z);
    }
    if (R.s >= L.up.length - 2) {
      const exit = L.top.clone().addScaledVector(L.topDir, L.surface ? 6 : 14).addScaledVector(L.rightN, L.surface ? 4 : 0);
      this.place(exit, Math.atan2(L.topDir.x, L.topDir.z), 2.5);
      this.events.push({ type: 'top', lift: L });
      return;
    }
  }
  /** Drive the model from the physics state. */
  pose(dt) {
    const inp = this.input;
    this.root.position.copy(this.pos);
    const seated = this.ride && !this.ride.lift.surface;
    this.root.visible = !(this.ride && this.ride.lift.gondola);
    const up = this.air || seated ? new THREE.Vector3(0, 1, 0) : this.n;
    const f = this.forward;
    const fz = f.clone().addScaledVector(up, -f.dot(up)).normalize();
    const x = v3().crossVectors(up, fz).normalize();
    const m = new THREE.Matrix4().makeBasis(x, up, fz);
    this.root.quaternion.setFromRotationMatrix(m);
    const target = seated ? 1.0 : inp.tuck && this.speed > 4 ? 1 : inp.brake ? 0.35 : 0.15;
    this.crouch = lerp(this.crouch, target, 1 - Math.exp(-8 * dt));
    this.tilt.rotation.set(0, 0, -this.lean);
    this.upper.position.set(0, -0.35 * this.crouch, -0.05 * this.crouch);
    this.upper.rotation.set(0.5 * this.crouch, 0, 0);
    this.lower.scale.set(1, 1 - 0.18 * this.crouch, 1);
    if (seated) {
      this.upper.position.set(0, -0.08, -0.12); this.upper.rotation.set(-0.15, 0, 0);
      this.lower.position.set(0, 0.85, 0.92); this.lower.rotation.set(-Math.PI / 2 + 0.25, 0, 0); this.lower.scale.set(1, 1, 1);
    } else { this.lower.position.set(0, 0, 0); this.lower.rotation.set(0, 0, 0); }
  }
}

// ---------------------------------------------------------------- crowd
export class Crowd {
  constructor(scene, material, pisteIndex, ground, count = 90) {
    this.pi = pisteIndex; this.g = ground; this.count = count;
    this.mesh = new THREE.InstancedMesh(crowdGeometries(), material, count);
    this.mesh.castShadow = true; this.mesh.frustumCulled = false; this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const c = new THREE.Color();
    const palette = [0xd62828, 0xf77f00, 0xfcbf49, 0x2a9d8f, 0x264653, 0x7b2cbf, 0x3a86ff, 0xff006e, 0x111111, 0xf1faee];
    for (let k = 0; k < count; k++) this.mesh.setColorAt(k, c.set(palette[k % palette.length]));
    scene.add(this.mesh);
    this.skiers = Array.from({ length: count }, (_, k) => ({ k, P: null, s: 0, v: 8, ph: 0, amp: 5, freq: 0.3, prev: new THREE.Vector3() }));
    this.center = new THREE.Vector3();
  }
  spawn(sk, center, fresh) {
    const near = this.pi.pistes.filter((P) => P.line.length > 200 && Math.hypot(P.mid.x - center.x, P.mid.z - center.z) < 2000);
    const pool = near.length ? near : this.pi.pistes;
    const P = pool[Math.floor(Math.random() * pool.length)];
    sk.P = P;
    sk.s = fresh ? Math.random() * P.line.length * 0.8 : Math.random() * Math.min(80, P.line.length * 0.2);
    sk.v = (P.d === 3 ? 11 : P.d === 2 ? 9 : 7) * (0.7 + Math.random() * 0.6);
    sk.amp = P.width * (0.15 + Math.random() * 0.22);
    sk.freq = 0.12 + Math.random() * 0.1;
    sk.ph = Math.random() * 6.28;
  }
  update(dt, center) {
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s1 = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3(), d = new THREE.Vector3(), side = new THREE.Vector3();
    for (const sk of this.skiers) {
      if (!sk.P || sk.s >= sk.P.line.length || Math.hypot(sk.prev.x - center.x, sk.prev.z - center.z) > 2600) this.spawn(sk, center, true);
      sk.s += sk.v * dt;
      sk.ph += sk.freq * 6.283 * dt;
      sk.P.line.at(sk.s, p, d);
      side.set(-d.z, 0, d.x).normalize();
      const off = Math.sin(sk.ph) * sk.amp, dOff = Math.cos(sk.ph) * sk.amp * sk.freq * 6.283;
      p.addScaledVector(side, off);
      p.y = this.g.height(p.x, p.z);
      const yaw = Math.atan2(d.x, d.z) - Math.atan2(dOff, sk.v) * 0.9;
      const lean = clamp(-Math.sin(sk.ph) * 0.5, -0.6, 0.6);
      e.set(0.12, yaw, lean, 'YXZ');
      q.setFromEuler(e);
      M.compose(p, q, s1);
      this.mesh.setMatrixAt(sk.k, M);
      sk.prev.copy(p);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    void hash;
  }
}
