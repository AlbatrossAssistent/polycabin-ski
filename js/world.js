// Buildings, lifts (with moving carriers) and the piste index.
import * as THREE from 'three';
import { Builder, srgb, mat, hash, clamp } from './util.js';

export const toWorld = (X, Y) => new THREE.Vector3(Y, 0, -X); // data (north, east) -> three

// ---------------------------------------------------------------- buildings
const PLASTER = [srgb(0.96, 0.95, 0.91), srgb(0.95, 0.91, 0.8), srgb(0.96, 0.9, 0.76), srgb(0.95, 0.87, 0.84), srgb(0.9, 0.92, 0.9)];
const WOOD = [srgb(0.42, 0.27, 0.16), srgb(0.5, 0.33, 0.2), srgb(0.33, 0.21, 0.13)];
const SHUTTER = [srgb(0.2, 0.4, 0.25), srgb(0.55, 0.15, 0.12), srgb(0.32, 0.22, 0.14)];
const SNOW = srgb(0.97, 0.98, 1.0), EAVE = srgb(0.3, 0.2, 0.13), GLASS = srgb(0.2, 0.27, 0.36), STONE = srgb(0.55, 0.54, 0.52), CHIMNEY = srgb(0.62, 0.6, 0.58);
const TILE = 640;

function polyArea(pts) {
  let a = 0;
  for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; a += p.x * q.z - q.x * p.z; }
  return Math.abs(a) / 2;
}
/** Minimum-area oriented rectangle from the polygon's edge directions. */
function orientedBox(pts) {
  let best = null;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k], q = pts[(k + 1) % pts.length];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 0.5) continue;
    const ux = (q.x - p.x) / len, uz = (q.z - p.z) / len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const r of pts) { const a = r.x * ux + r.z * uz, b = -r.x * uz + r.z * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) best = { area, ux, uz, a0, a1, b0, b1 };
  }
  if (!best) return { area: Infinity };
  const { ux, uz, a0, a1, b0, b1 } = best;
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  let hl = (a1 - a0) / 2, hw = (b1 - b0) / 2, u = new THREE.Vector3(ux, 0, uz), w = new THREE.Vector3(-uz, 0, ux);
  const c = new THREE.Vector3(ca * ux - cb * uz, 0, ca * uz + cb * ux);
  if (hw > hl) { [hl, hw] = [hw, hl]; const t = u; u = w; w = t.clone().negate(); }
  return { c, u, w, hl, hw, area: best.area };
}

/** A Tyrolean chalet on an oriented rectangle. detail adds windows, shutters, balconies, eaves and a chimney. */
function chalet(b, box, lo, hi, floors, n, detail) {
  const { c, u, w, hl, hw } = box;
  const v = (al, aw, y) => new THREE.Vector3(c.x + u.x * al + w.x * aw, y, c.z + u.z * al + w.z * aw);
  const style = hash(n, 8);
  const plaster = PLASTER[Math.floor(hash(n, 6) * PLASTER.length)], wood = WOOD[Math.floor(hash(n, 7) * WOOD.length)];
  const allWood = style > 0.85, allPlaster = style < 0.25;
  const f0 = Math.max(lo, hi - 1.0), fh = 2.9;
  const eave = f0 + floors * fh;
  const sides = [[hl, -hw, hl, hw], [hl, hw, -hl, hw], [-hl, hw, -hl, -hw], [-hl, -hw, hl, -hw]];
  const quad = (A, B, C, D, out, col) => { b.triFacing(A, B, C, out, col); b.triFacing(A, C, D, out, col); };
  const outOf = (s) => { const [a1, w1, a2, w2] = sides[s]; return new THREE.Vector3(u.x * (a1 + a2) + w.x * (w1 + w2), 0, u.z * (a1 + a2) + w.z * (w1 + w2)); };
  for (let s = 0; s < 4; s++) { const [a1, w1, a2, w2] = sides[s]; quad(v(a1, w1, lo - 1.5), v(a2, w2, lo - 1.5), v(a2, w2, f0 + 0.3), v(a1, w1, f0 + 0.3), outOf(s), STONE); }
  for (let f = 0; f < floors; f++) {
    const y0 = f0 + f * fh + (f ? 0 : 0.3), y1 = f0 + (f + 1) * fh;
    const col = allWood ? wood : allPlaster ? plaster : f === 0 || (floors > 3 && f === 1) ? plaster : wood;
    for (let s = 0; s < 4; s++) {
      const [a1, w1, a2, w2] = sides[s], out = outOf(s);
      quad(v(a1, w1, y0), v(a2, w2, y0), v(a2, w2, y1), v(a1, w1, y1), out, col);
      if (!detail) continue;
      const len = Math.hypot(a2 - a1, w2 - w1);
      const nwin = Math.floor((len - 1.5) / 2.6);
      const o = out.clone().normalize().multiplyScalar(0.06);
      const da = (a2 - a1) / len, dw = (w2 - w1) / len;
      for (let k = 0; k < nwin; k++) {
        const t0 = (k + 0.5) / nwin;
        const ca = a1 + (a2 - a1) * t0, cw = w1 + (w2 - w1) * t0;
        const ww = 0.5, wy0 = f0 + f * fh + 0.95, wy1 = wy0 + 1.15;
        const P = (t, y) => v(ca + da * t, cw + dw * t, y).add(o);
        quad(P(-ww, wy0), P(ww, wy0), P(ww, wy1), P(-ww, wy1), out, GLASS);
        if (col === plaster && hash(n, 9) > 0.4) {
          const sh = SHUTTER[Math.floor(hash(n, 10) * SHUTTER.length)];
          quad(P(-ww - 0.45, wy0), P(-ww - 0.02, wy0), P(-ww - 0.02, wy1), P(-ww - 0.45, wy1), out, sh);
          quad(P(ww + 0.02, wy0), P(ww + 0.45, wy0), P(ww + 0.45, wy1), P(ww + 0.02, wy1), out, sh);
        }
      }
    }
    if (detail && f >= 1 && !allPlaster && hl > 3.5) {
      const yaw = Math.atan2(u.x, u.z), L = hl * 1.7;
      for (const sgn of [-1, 1]) {
        const bc = v(0, sgn * (hw + 0.6), f0 + f * fh);
        b.add(new THREE.BoxGeometry(1.2, 0.18, L), wood, mat(bc.x, bc.y, bc.z, 0, yaw, 0));
        const rc = v(0, sgn * (hw + 1.15), f0 + f * fh + 0.5);
        b.add(new THREE.BoxGeometry(0.08, 0.85, L), wood, mat(rc.x, rc.y, rc.z, 0, yaw, 0));
      }
    }
  }
  const pitch = 0.5 + hash(n, 11) * 0.15;
  const ov = detail ? 1.1 : 0.6, ovg = detail ? 0.9 : 0.5;
  const ridge = eave + hw * pitch, eY = eave - ov * pitch, L = hl + ovg, t = 0.32;
  for (const sgn of [-1, 1]) {
    const out = new THREE.Vector3(w.x * sgn, 1, w.z * sgn);
    quad(v(-L, sgn * (hw + ov), eY), v(L, sgn * (hw + ov), eY), v(L, 0, ridge), v(-L, 0, ridge), out, SNOW);
    if (detail) {
      quad(v(-L, sgn * (hw + ov), eY - t), v(L, sgn * (hw + ov), eY - t), v(L, 0, ridge - t), v(-L, 0, ridge - t), new THREE.Vector3(0, -1, 0), EAVE);
      quad(v(-L, sgn * (hw + ov), eY - t), v(L, sgn * (hw + ov), eY - t), v(L, sgn * (hw + ov), eY), v(-L, sgn * (hw + ov), eY), new THREE.Vector3(w.x * sgn, 0, w.z * sgn), EAVE);
    }
    const gout = new THREE.Vector3(u.x * sgn, 0, u.z * sgn);
    b.triFacing(v(sgn * hl, -hw, eave), v(sgn * hl, hw, eave), v(sgn * hl, 0, ridge - 0.05), gout, allPlaster && !detail ? plaster : wood);
    if (detail) for (const s2 of [-1, 1]) b.triFacing(v(sgn * L, s2 * (hw + ov), eY), v(sgn * L, 0, ridge), v(sgn * L, s2 * (hw + ov), eY - t), gout, EAVE);
  }
  if (detail && hash(n, 12) > 0.3) {
    const ch = v(hl * 0.4, hw * 0.35, 0), y = eave + (hw - hw * 0.35) * pitch, yaw = Math.atan2(u.x, u.z);
    b.add(new THREE.BoxGeometry(0.6, 1.6, 0.6), CHIMNEY, mat(ch.x, y + 0.5, ch.z, 0, yaw, 0));
    b.add(new THREE.BoxGeometry(0.75, 0.15, 0.75), SNOW, mat(ch.x, y + 1.35, ch.z, 0, yaw, 0));
  }
}

/** Any footprint: straight walls, flat or hipped roof. */
function genericBuilding(b, pts, lo, hi, H, flat, n, detail) {
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  let cx = 0, cz = 0;
  for (const p of pts) { cx += p.x; cz += p.z; }
  cx /= pts.length; cz /= pts.length;
  const area = polyArea(pts);
  const base = lo - 1.5, top = hi + H * 0.8;
  const wall = PLASTER[Math.floor(hash(n, 6) * PLASTER.length)];
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k], q = pts[(k + 1) % pts.length];
    const out = v((p.x + q.x) / 2 - cx, 0, (p.z + q.z) / 2 - cz);
    b.triFacing(v(p.x, base, p.z), v(q.x, base, q.z), v(q.x, top, q.z), out, wall);
    b.triFacing(v(p.x, base, p.z), v(q.x, top, q.z), v(p.x, top, p.z), out, wall);
    if (detail && p.distanceTo(q) > 4) {
      const o = out.clone().normalize().multiplyScalar(0.08);
      for (let y0 = hi + 1; y0 + 1.3 < top - 0.5; y0 += 3) {
        const pp = p.clone().lerp(q, 0.12).add(o), qq = p.clone().lerp(q, 0.88).add(o);
        b.triFacing(v(pp.x, y0, pp.z), v(qq.x, y0, qq.z), v(qq.x, y0 + 1.2, qq.z), out, GLASS);
        b.triFacing(v(pp.x, y0, pp.z), v(qq.x, y0 + 1.2, qq.z), v(pp.x, y0 + 1.2, pp.z), out, GLASS);
      }
    }
  }
  if (flat || area > 1500 || pts.length > 14) {
    const tris = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p.x, p.z)), []);
    for (const [i, j, k] of tris) b.triFacing(v(pts[i].x, top, pts[i].z), v(pts[j].x, top, pts[j].z), v(pts[k].x, top, pts[k].z), v(0, 1, 0), SNOW);
  } else {
    const apex = v(cx, top + Math.min(7, 0.45 * Math.sqrt(area)), cz);
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length];
      const ep = v(p.x + (p.x - cx) * 0.12, top - 0.4, p.z + (p.z - cz) * 0.12), eq = v(q.x + (q.x - cx) * 0.12, top - 0.4, q.z + (q.z - cz) * 0.12);
      b.triFacing(ep, eq, apex, v(0, 1, 0), SNOW);
      b.triFacing(ep, eq, v(eq.x, top - 0.8, eq.z), v((p.x + q.x) / 2 - cx, 0, (p.z + q.z) / 2 - cz), EAVE);
    }
  }
}

/** Buildings in 640 m tiles, each with a detailed and a simple mesh. */
export function buildBuildings(list, ground, material) {
  const tiles = new Map();
  list.forEach(([, height, flat, flatPts], n) => {
    const pts = [];
    for (let k = 0; k < flatPts.length; k += 2) pts.push(toWorld(flatPts[k], flatPts[k + 1]));
    if (pts.length > 3 && pts[0].distanceTo(pts[pts.length - 1]) < 0.5) pts.pop();
    if (pts.length < 3) return;
    const area = polyArea(pts);
    if (area < 12) return;
    let lo = Infinity, hi = -Infinity, cx = 0, cz = 0;
    for (const p of pts) { const h = ground.height(p.x, p.z); lo = Math.min(lo, h); hi = Math.max(hi, h); cx += p.x; cz += p.z; }
    cx /= pts.length; cz /= pts.length;
    const tx = Math.floor(cx / TILE), tz = Math.floor(cz / TILE), key = `${tx},${tz}`;
    let t = tiles.get(key);
    if (!t) tiles.set(key, (t = { near: new Builder(), far: new Builder(), x: (tx + 0.5) * TILE, z: (tz + 0.5) * TILE }));
    const box = orientedBox(pts);
    if (!flat && area / box.area > 0.78 && box.area < 2500 && box.hw > 2) {
      const floors = Math.max(1, clamp(height ? Math.round(height / 3) : area < 90 ? 2 : area < 260 ? 3 : area < 700 ? 4 : 5, 1, 7) - (hash(n, 13) < 0.2 ? 1 : 0));
      chalet(t.near, box, lo, hi, floors, n, true);
      chalet(t.far, box, lo, hi, floors, n, false);
    } else {
      const H = clamp(height || (area > 400 ? 11 : 7.5), 3.5, 30);
      genericBuilding(t.near, pts, lo, hi, H, flat, n, true);
      genericBuilding(t.far, pts, lo, hi, H, flat, n, false);
    }
  });
  const out = [];
  for (const t of tiles.values()) {
    const near = new THREE.Mesh(t.near.geometry(), material), far = new THREE.Mesh(t.far.geometry(), material);
    for (const m of [near, far]) { m.receiveShadow = true; m.matrixAutoUpdate = false; }
    near.castShadow = true;
    out.push({ x: t.x, z: t.z, near, far });
  }
  return out;
}

// ---------------------------------------------------------------- lifts
const STEEL = srgb(0.55, 0.57, 0.6), STATION = srgb(0.74, 0.75, 0.76), STATION_GLASS = srgb(0.42, 0.52, 0.62), STATION_WOOD = srgb(0.45, 0.3, 0.18), STATION_ROOF = srgb(0.96, 0.97, 1.0), CABLE = 0x222831;
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
      const ropeH = (k) => (k === 0 || k === n - 1 ? (surface ? 3.5 : 4.4) : H);
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
          const sx = p.x + d.x * len * o, sz = p.z + d.z * len * o;
          statics.add(new THREE.BoxGeometry(w, 1.6, len), STATION, mat(sx, p.y - 0.2, sz, 0, yaw, 0));
          statics.add(new THREE.BoxGeometry(w - 0.4, 3.8, len - 0.4), STATION_GLASS, mat(sx, p.y + 2.5, sz, 0, yaw, 0));
          for (const e of [-1, 1]) statics.add(new THREE.BoxGeometry(0.5, 4.0, len), STATION_WOOD, mat(sx + Math.cos(yaw) * e * (w / 2 - 0.25), p.y + 2.5, sz - Math.sin(yaw) * e * (w / 2 - 0.25), 0, yaw, 0));
          statics.add(new THREE.BoxGeometry(w + 2, 0.5, len + 3), STATION_WOOD, mat(sx, p.y + 4.65, sz, 0, yaw, 0));
          statics.add(new THREE.BoxGeometry(w + 2.1, 0.35, len + 3.1), STATION_ROOF, mat(sx, p.y + 5.05, sz, 0, yaw, 0));
          statics.add(new THREE.CylinderGeometry(gauge / 2 + 0.3, gauge / 2 + 0.3, 0.4, 16), STEEL, mat(p.x, p.y + ropeH(k) - 0.3, p.z));
        }
      }
      const speed = L.speed || (gondola ? 6 : surface ? 3 : 5);
      const spacing = gondola ? 55 : surface ? 18 : L.seats >= 6 ? 34 : 26;
      const lift = {
        name: L.name || 'Lift', kind: L.kind, surface, gondola, speed, spacing, up: upRope, down: downRope, H, gauge,
        bottom: ground3[0], top: ground3[n - 1], topDir: dirs[n - 1], bottomDir: dirs[0], right0: right[0], rightN: right[n - 1],
        clear: surface ? 6 : (gondola ? 22 : 16) * 0.85 + 7, loop: upRope.length + downRope.length, phase: hash(this.list.length, 3) * 100, seats: L.seats || 1,
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
    this.riders = new THREE.InstancedMesh(riderGeo.jacket, material, Math.max(riders, 1));
    this.ridersRest = new THREE.InstancedMesh(riderGeo.rest, material, Math.max(riders, 1));
    for (const m of [this.riders, this.ridersRest]) { m.frustumCulled = false; m.castShadow = true; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); }
    const col = new THREE.Color();
    for (let k = 0; k < riders; k++) this.riders.setColorAt(k, col.setHSL(hash(k, 11), 0.7, 0.42));
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
      if (!near) continue;
      for (let k = 0; k < L.count; k++) {
        const s = this.time * L.speed + k * (L.loop / L.count) + L.phase;
        this.loopAt(L, s, p, d);
        const i = idx[L.type]++;
        e.set(0, Math.atan2(d.x, d.z), 0);
        q.setFromEuler(e);
        M.compose(p, q, L.surface ? this.dragScale(p) : s1);
        m.setMatrixAt(i, M);
        if (L.type === 'chair' && Math.hypot(p.x - cam.x, p.z - cam.z) < 1400) {
          const going = ((s % L.loop) + L.loop) % L.loop < L.up.length;
          const seats = Math.min(L.seats, 4);
          for (let j = 0; j < seats; j++) {
            const filled = going && hash(k, j, L.count) < 0.45;
            if (!filled) continue;
            off.set((j - (seats - 1) / 2) * 0.75, 0, 0.1).applyQuaternion(q).add(p);
            R.compose(off, q, s1);
            this.riders.setMatrixAt(r, R); this.ridersRest.setMatrixAt(r++, R);
          }
        }
      }
    }
    for (const t in this.inst) { this.inst[t].count = idx[t]; this.inst[t].instanceMatrix.needsUpdate = true; }
    this.riders.count = this.ridersRest.count = r;
    this.riders.instanceMatrix.needsUpdate = true;
    this.ridersRest.instanceMatrix.needsUpdate = true;
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
  nearestBottom(p, maxDist = 36) {
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
