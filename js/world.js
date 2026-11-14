// Buildings, lifts (with moving carriers) and the piste index.
import * as THREE from 'three';
import { Builder, srgb, mat, hash, clamp } from './util.js';

export const toWorld = (X, Y) => new THREE.Vector3(Y, 0, -X); // data (north, east) -> three

// ---------------------------------------------------------------- buildings
const WALLS = [srgb(0.55, 0.38, 0.24), srgb(0.62, 0.45, 0.3), srgb(0.9, 0.86, 0.78), srgb(0.95, 0.93, 0.88), srgb(0.82, 0.72, 0.58), srgb(0.45, 0.31, 0.2)];
const ROOF = srgb(0.96, 0.97, 1.0), ROOF_EDGE = srgb(0.35, 0.25, 0.2), WINDOW = srgb(0.25, 0.3, 0.38);

export function buildBuildings(list, ground, material) {
  const groups = new Map();
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  list.forEach(([, height, flat, flatPts], n) => {
    const pts = [];
    for (let k = 0; k < flatPts.length; k += 2) pts.push(toWorld(flatPts[k], flatPts[k + 1]));
    if (pts.length > 3 && pts[0].distanceTo(pts[pts.length - 1]) < 0.5) pts.pop();
    if (pts.length < 3) return;
    let lo = Infinity, hi = -Infinity, cx = 0, cz = 0, area = 0;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length];
      const h = ground.height(p.x, p.z);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
      cx += p.x; cz += p.z; area += p.x * q.z - q.x * p.z;
    }
    area = Math.abs(area) / 2;
    if (area < 12) return;
    cx /= pts.length; cz /= pts.length;
    const H = clamp(height || (area > 400 ? 11 : 7.5), 3.5, 30);
    const base = lo - 1.5, top = hi + H * 0.8;
    const key = `${Math.floor(cx / 1280)},${Math.floor(cz / 1280)}`;
    if (!groups.has(key)) groups.set(key, new Builder());
    const b = groups.get(key);
    const wall = WALLS[Math.floor(hash(n, 5) * WALLS.length)];
    const c = v(cx, 0, cz);
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length];
      const out = v((p.x + q.x) / 2 - cx, 0, (p.z + q.z) / 2 - cz);
      const A = v(p.x, base, p.z), B = v(q.x, base, q.z), Cq = v(q.x, top, q.z), D = v(p.x, top, p.z);
      b.triFacing(A, B, Cq, out, wall); b.triFacing(A, Cq, D, out, wall);
      // a dark window band on longer walls
      const len = p.distanceTo(q);
      if (len > 5 && top - hi > 4) {
        const y0 = hi + 1.2, y1 = y0 + 1.3, s = 0.15;
        const pp = p.clone().lerp(q, 0.2), qq = p.clone().lerp(q, 0.8), o = out.clone().normalize().multiplyScalar(s);
        const a2 = v(pp.x + o.x, y0, pp.z + o.z), b2 = v(qq.x + o.x, y0, qq.z + o.z), c2 = v(qq.x + o.x, y1, qq.z + o.z), d2 = v(pp.x + o.x, y1, pp.z + o.z);
        b.triFacing(a2, b2, c2, out, WINDOW); b.triFacing(a2, c2, d2, out, WINDOW);
      }
    }
    if (flat || area > 900 || pts.length > 10) {
      const contour = pts.map((p) => new THREE.Vector2(p.x, p.z));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      for (const [i, j, k] of tris) b.triFacing(v(pts[i].x, top, pts[i].z), v(pts[j].x, top, pts[j].z), v(pts[k].x, top, pts[k].z), v(0, 1, 0), ROOF);
    } else {
      // hip roof with overhang, snow on top
      const rise = Math.min(7, 0.45 * Math.sqrt(area));
      const apex = v(cx, top + rise, cz);
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k], q = pts[(k + 1) % pts.length];
        const ep = v(p.x + (p.x - cx) * 0.12, top - 0.4, p.z + (p.z - cz) * 0.12), eq = v(q.x + (q.x - cx) * 0.12, top - 0.4, q.z + (q.z - cz) * 0.12);
        b.triFacing(ep, eq, apex, v(0, 1, 0), ROOF);
        b.triFacing(ep, eq, v(eq.x, top - 0.8, eq.z), v((p.x + q.x) / 2 - cx, 0, (p.z + q.z) / 2 - cz), ROOF_EDGE);
      }
    }
    void c;
  });
  const meshes = [];
  for (const b of groups.values()) {
    const m = new THREE.Mesh(b.geometry(), material);
    m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false;
    meshes.push(m);
  }
  return meshes;
}

// ---------------------------------------------------------------- lifts
const STEEL = srgb(0.55, 0.57, 0.6), STATION = srgb(0.32, 0.36, 0.42), STATION_ROOF = srgb(0.9, 0.92, 0.95), CABLE = 0x222831;
const SURFACE = new Set(['t-bar', 'platter', 'rope_tow', 'magic_carpet', 'j-bar', 'drag_lift']);

class Polyline {
  constructor(points) {
    this.p = points; this.s = [0];
    for (let k = 1; k < points.length; k++) this.s.push(this.s[k - 1] + points[k].distanceTo(points[k - 1]));
    this.length = this.s[this.s.length - 1];
  }
  at(s, out = new THREE.Vector3(), dir) {
    s = clamp(s, 0, this.length);
    let lo = 0, hi = this.s.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.s[m] <= s) lo = m; else hi = m; }
    const t = (s - this.s[lo]) / Math.max(this.s[hi] - this.s[lo], 1e-6);
    out.lerpVectors(this.p[lo], this.p[hi], t);
    if (dir) dir.subVectors(this.p[hi], this.p[lo]).normalize();
    return out;
  }
}

function carrierGeometries() {
  const gondola = new Builder();
  const body = srgb(0.85, 0.12, 0.12), glass = srgb(0.2, 0.25, 0.32), dark = srgb(0.2, 0.2, 0.22);
  gondola.add(new THREE.BoxGeometry(2.0, 1.1, 2.2), body, mat(0, -3.3, 0));
  gondola.add(new THREE.BoxGeometry(2.04, 0.9, 2.24), glass, mat(0, -2.3, 0));
  gondola.add(new THREE.BoxGeometry(1.9, 0.2, 2.1), body, mat(0, -1.8, 0));
  gondola.add(new THREE.BoxGeometry(0.08, 1.6, 0.08), dark, mat(0, -0.8, 0));
  const chair = new Builder();
  chair.add(new THREE.BoxGeometry(0.08, 2.3, 0.08), dark, mat(0, -1.15, 0));
  chair.add(new THREE.BoxGeometry(3.2, 0.12, 0.7), srgb(0.15, 0.3, 0.6), mat(0, -2.3, 0.1));
  chair.add(new THREE.BoxGeometry(3.2, 0.6, 0.1), srgb(0.15, 0.3, 0.6), mat(0, -2.0, -0.25));
  chair.add(new THREE.BoxGeometry(3.4, 0.08, 0.08), dark, mat(0, -1.4, 0));
  const drag = new Builder();
  drag.add(new THREE.BoxGeometry(0.06, 3.2, 0.06), dark, mat(0, -1.6, 0));
  drag.add(new THREE.BoxGeometry(1.0, 0.08, 0.08), dark, mat(0, -3.2, 0));
  return { gondola: gondola.geometry(), chair: chair.geometry(), drag: drag.geometry() };
}

export class Lifts {
  constructor(data, ground, scene, material, riderGeo) {
    this.g = ground; this.list = [];
    const statics = new Builder(), cables = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const L of data) {
      if (L.kind === 'magic_carpet') { this.addCarpet(L, statics); continue; }
      const surface = SURFACE.has(L.kind);
      const gondola = L.kind === 'gondola' || L.kind === 'cable_car';
      const H = surface ? 5.5 : gondola ? 14 : 11;
      const gauge = surface ? 3 : gondola ? 6.5 : L.seats >= 6 ? 6 : 5;
      const ground3 = L.pts.map(([X, Y]) => { const p = toWorld(X, Y); p.y = ground.height(p.x, p.z); return p; });
      const n = ground3.length;
      const dirs = ground3.map((p, k) => new THREE.Vector3().subVectors(ground3[Math.min(k + 1, n - 1)], ground3[Math.max(k - 1, 0)]).setY(0).normalize());
      const right = dirs.map((d) => new THREE.Vector3().crossVectors(d, up).normalize());
      const ropeH = (k) => (k === 0 || k === n - 1 ? (surface ? 3.5 : 6) : H);
      const upRope = new Polyline(ground3.map((p, k) => p.clone().addScaledVector(right[k], gauge / 2).setY(p.y + ropeH(k))));
      const downRope = new Polyline(ground3.map((p, k) => p.clone().addScaledVector(right[k], -gauge / 2).setY(p.y + ropeH(k))).reverse());
      for (const rope of [upRope, downRope]) for (let k = 1; k < rope.p.length; k++) cables.push(rope.p[k - 1], rope.p[k]);
      // pylons
      for (let k = 1; k < n - 1; k++) {
        const p = ground3[k], yaw = Math.atan2(right[k].x, right[k].z);
        statics.add(new THREE.CylinderGeometry(surface ? 0.15 : 0.35, surface ? 0.2 : 0.5, H, 6), STEEL, mat(p.x, p.y + H / 2 - 0.5, p.z));
        statics.add(new THREE.BoxGeometry(0.4, 0.4, gauge + 1.2), STEEL, mat(p.x, p.y + H, p.z, 0, yaw, 0));
      }
      // stations
      for (const k of [0, n - 1]) {
        const p = ground3[k], d = dirs[k], yaw = Math.atan2(d.x, d.z);
        if (surface) {
          statics.add(new THREE.BoxGeometry(3, 2.6, 3), STATION, mat(p.x - right[k].x * 4, p.y + 1.1, p.z - right[k].z * 4, 0, yaw, 0));
          statics.add(new THREE.CylinderGeometry(0.25, 0.3, 4.2, 6), STEEL, mat(p.x, p.y + 1.9, p.z));
        } else {
          const len = gondola ? 22 : 16, w = gauge + 6;
          const o = k === 0 ? -0.35 : 0.35;
          statics.add(new THREE.BoxGeometry(w, 5, len), STATION, mat(p.x + d.x * len * o, p.y + 1.5, p.z + d.z * len * o, 0, yaw, 0));
          statics.add(new THREE.BoxGeometry(w + 1.5, 0.8, len + 2), STATION_ROOF, mat(p.x + d.x * len * o, p.y + 4.4, p.z + d.z * len * o, 0, yaw, 0));
          statics.add(new THREE.BoxGeometry(w - 1, 2.2, len * 0.8), STATION, mat(p.x + d.x * len * o, p.y + 6, p.z + d.z * len * o, 0, yaw, 0));
        }
      }
      const speed = L.speed || (gondola ? 6 : surface ? 3 : 5);
      const spacing = gondola ? 55 : surface ? 18 : L.seats >= 6 ? 34 : 26;
      const lift = {
        name: L.name || 'Lift', kind: L.kind, surface, gondola, speed, spacing, up: upRope, down: downRope, H, gauge,
        bottom: ground3[0], top: ground3[n - 1], topDir: dirs[n - 1], bottomDir: dirs[0], right0: right[0], rightN: right[n - 1],
        loop: upRope.length + downRope.length, phase: hash(this.list.length, 3) * 100, seats: L.seats || 1,
      };
      lift.count = Math.max(2, Math.floor(lift.loop / spacing));
      this.list.push(lift);
    }
    this.statics = new THREE.Mesh(statics.geometry(), material);
    this.statics.castShadow = true; this.statics.receiveShadow = true; this.statics.matrixAutoUpdate = false;
    scene.add(this.statics);
    const cg = new THREE.BufferGeometry().setFromPoints(cables);
    this.cables = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: CABLE }));
    this.cables.matrixAutoUpdate = false;
    scene.add(this.cables);
    // carriers
    const geos = carrierGeometries();
    const count = { gondola: 0, chair: 0, drag: 0 };
    for (const L of this.list) { L.type = L.gondola ? 'gondola' : L.surface ? 'drag' : 'chair'; count[L.type] += L.count; }
    this.inst = {};
    this.mine = {};
    for (const t of Object.keys(geos)) { const m = new THREE.Mesh(geos[t], material); m.visible = false; m.castShadow = true; scene.add(m); this.mine[t] = m; }
    for (const t of Object.keys(geos)) {
      const m = new THREE.InstancedMesh(geos[t], material, Math.max(count[t], 1));
      m.castShadow = true; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m); this.inst[t] = m;
    }
    // riders sitting on chairs (about half full)
    let riders = 0;
    for (const L of this.list) if (L.type === 'chair') riders += L.count * Math.min(L.seats, 4);
    this.riders = new THREE.InstancedMesh(riderGeo, material, Math.max(riders, 1));
    this.riders.frustumCulled = false; this.riders.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.Color();
    for (let k = 0; k < riders; k++) this.riders.setColorAt(k, col.setHSL(hash(k, 11), 0.65, 0.45));
    scene.add(this.riders);
    this.time = 0;
  }
  addCarpet(L, b) {
    if (L.pts.length < 2) return;
    const a = toWorld(L.pts[0][0], L.pts[0][1]), c = toWorld(L.pts[L.pts.length - 1][0], L.pts[L.pts.length - 1][1]);
    const len = a.distanceTo(c);
    if (len < 4) return;
    const steps = Math.ceil(len / 2), yaw = Math.atan2(c.x - a.x, c.z - a.z);
    for (let k = 0; k < steps; k++) {
      const p0 = a.clone().lerp(c, k / steps), p1 = a.clone().lerp(c, (k + 1) / steps);
      p0.y = this.g.height(p0.x, p0.z); p1.y = this.g.height(p1.x, p1.z);
      const p = p0.clone().add(p1).multiplyScalar(0.5), seg = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      const pitch = -Math.atan2(p1.y - p0.y, seg);
      b.add(new THREE.BoxGeometry(1.2, 0.12, Math.hypot(seg, p1.y - p0.y) + 0.05), srgb(0.25, 0.27, 0.3), mat(p.x, p.y + 0.04, p.z, pitch, yaw, 0));
    }
  }
  /** Position on the lift loop at distance s (0 = bottom, along the up rope). */
  loopAt(L, s, out, dir) {
    s = ((s % L.loop) + L.loop) % L.loop;
    if (s < L.up.length) return L.up.at(s, out, dir);
    return L.down.at(s - L.up.length, out, dir);
  }
  update(dt, cam) {
    this.time += dt;
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), d = new THREE.Vector3(), s1 = new THREE.Vector3(1, 1, 1);
    const s0 = new THREE.Vector3(0, 0, 0), up = new THREE.Vector3(0, 1, 0), e = new THREE.Euler();
    const idx = { gondola: 0, chair: 0, drag: 0 };
    let r = 0;
    const R = new THREE.Matrix4(), off = new THREE.Vector3();
    for (const L of this.list) {
      const near = Math.hypot(L.bottom.x - cam.x, L.bottom.z - cam.z) < 7000 || Math.hypot(L.top.x - cam.x, L.top.z - cam.z) < 7000;
      const m = this.inst[L.type];
      for (let k = 0; k < L.count; k++) {
        const s = this.time * L.speed + k * (L.loop / L.count) + L.phase;
        const i = idx[L.type]++;
        if (!near) { M.compose(p, q, s0); m.setMatrixAt(i, M); continue; }
        this.loopAt(L, s, p, d);
        e.set(0, Math.atan2(d.x, d.z), 0);
        q.setFromEuler(e);
        M.compose(p, q, L.surface ? this.dragScale(p) : s1);
        m.setMatrixAt(i, M);
        if (L.type === 'chair') {
          const going = ((s % L.loop) + L.loop) % L.loop < L.up.length;
          const seats = Math.min(L.seats, 4);
          for (let j = 0; j < seats; j++) {
            const filled = going && hash(k, j, L.count) < 0.45;
            if (!filled) { R.compose(p, q, s0); this.riders.setMatrixAt(r++, R); continue; }
            off.set((j - (seats - 1) / 2) * 0.75, 0, 0.1).applyQuaternion(q).add(p);
            R.compose(off, q, s1);
            this.riders.setMatrixAt(r++, R);
          }
        }
      }
    }
    for (const m of Object.values(this.inst)) m.instanceMatrix.needsUpdate = true;
    this.riders.instanceMatrix.needsUpdate = true;
    void up;
  }
  /** Drag-lift hanger stretched from the rope down to hip height. */
  dragScale(p) {
    const len = clamp(p.y - (this.g.height(p.x, p.z) + 0.85), 0.5, 8);
    return (this._ds || (this._ds = new THREE.Vector3())).set(1, len / 3.2, 1);
  }
  /** Show the player's own chair/cabin/bar at rope distance s, or hide it (L = null). */
  showMine(L, s) {
    for (const t in this.mine) this.mine[t].visible = false;
    if (!L) return;
    const m = this.mine[L.type], d = new THREE.Vector3();
    this.loopAt(L, s, m.position, d);
    m.rotation.set(0, Math.atan2(d.x, d.z), 0);
    if (L.surface) m.scale.copy(this.dragScale(m.position)); else m.scale.set(1, 1, 1);
    m.visible = true;
  }
  nearestBottom(p, maxDist = 28) {
    let best = null, bd = maxDist;
    for (const L of this.list) {
      const d = Math.hypot(L.bottom.x - p.x, L.bottom.z - p.z);
      if (d < bd) { bd = d; best = L; }
    }
    return best;
  }
}

// ---------------------------------------------------------------- piste index
export class PisteIndex {
  constructor(pistes, ground) {
    this.cell = 100; this.buckets = new Map();
    this.pistes = pistes.map((P, id) => {
      let pts = P.pts.map(([X, Y]) => { const p = toWorld(X, Y); p.y = ground.height(p.x, p.z); return p; });
      if (pts[0].y < pts[pts.length - 1].y) pts = pts.reverse(); // downhill order
      const line = new Polyline(pts);
      const width = [0, 40, 34, 28, 22][P.d] || 30;
      return { id, name: P.name, ref: P.ref, d: P.d, line, width, mid: line.at(line.length / 2) };
    });
    for (const P of this.pistes) {
      const pts = P.line.p;
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1], b = pts[k];
        const steps = Math.ceil(a.distanceTo(b) / 50) + 1;
        for (let t = 0; t <= steps; t++) {
          const x = a.x + (b.x - a.x) * (t / steps), z = a.z + (b.z - a.z) * (t / steps);
          const key = `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
          let arr = this.buckets.get(key);
          if (!arr) this.buckets.set(key, (arr = []));
          const last = arr[arr.length - 1];
          if (!last || last[0] !== P.id || last[1] !== k) arr.push([P.id, k]);
        }
      }
    }
  }
  /** Piste under a point, or null. */
  at(p) {
    const key = `${Math.floor(p.x / this.cell)},${Math.floor(p.z / this.cell)}`;
    const arr = this.buckets.get(key);
    if (!arr) return null;
    let best = null, bd = Infinity;
    const ab = new THREE.Vector2(), ap = new THREE.Vector2();
    for (const [id, k] of arr) {
      const P = this.pistes[id], a = P.line.p[k - 1], b = P.line.p[k];
      ab.set(b.x - a.x, b.z - a.z); ap.set(p.x - a.x, p.z - a.z);
      const t = clamp(ap.dot(ab) / Math.max(ab.lengthSq(), 1e-6), 0, 1);
      const d = Math.hypot(ap.x - ab.x * t, ap.y - ab.y * t) - P.width / 2;
      if (d < bd) { bd = d; best = P; }
    }
    return bd < 6 ? best : null;
  }
}
