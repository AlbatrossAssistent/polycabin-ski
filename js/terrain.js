// Terrain: height sampling, LOD chunks, horizon backdrop and forests.
// World frame: three.js x = east (data Y), z = south (-data X), y = up. Metres.
import * as THREE from 'three';
import { hash, clamp, srgb, Builder, mat } from './util.js';

export const CHUNK = 64; // cells per chunk side (640 m)
export const COVER = { OPEN: 0, FOREST: 1, SCRUB: 2, ROCK: 3, SCREE: 4, WATER: 5, GLACIER: 6, BUILT: 7, ROAD: 8 };

export class Ground {
  constructor(height, surface) {
    Object.assign(this, { nx: height.nx, ny: height.ny, x0: height.x0, y0: height.y0, cell: height.cell, h: height.h });
    this.surf = surface;
    this.minX = this.y0; this.maxX = this.y0 + (this.ny - 1) * this.cell;
    this.minZ = -(this.x0 + (this.nx - 1) * this.cell); this.maxZ = -this.x0;
  }
  // grid coordinates of a world point
  gi(z) { return (-z - this.x0) / this.cell; }
  gj(x) { return (x - this.y0) / this.cell; }
  wx(j) { return this.y0 + j * this.cell; }
  wz(i) { return -(this.x0 + i * this.cell); }
  H(i, j) { return this.h[clamp(i, 0, this.nx - 1) * this.ny + clamp(j, 0, this.ny - 1)]; }
  S(i, j) { return this.surf[clamp(i, 0, this.nx - 1) * this.ny + clamp(j, 0, this.ny - 1)]; }
  /** Height exactly on the finest mesh triangles. */
  height(x, z) {
    const fi = clamp(this.gi(z), 0, this.nx - 1.001), fj = clamp(this.gj(x), 0, this.ny - 1.001);
    const i = fi | 0, j = fj | 0, v = fi - i, u = fj - j;
    const k = i * this.ny + j, a = this.h[k], b = this.h[k + 1], c = this.h[k + this.ny], d = this.h[k + this.ny + 1];
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }
  /** Smoothed normal for physics. */
  normal(x, z, out = new THREE.Vector3(), e = 4) {
    const hx = this.height(x + e, z) - this.height(x - e, z), hz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }
  surface(x, z) { return this.S(Math.round(this.gi(z)), Math.round(this.gj(x))); }
  inside(x, z, margin = 0) { return x > this.minX + margin && x < this.maxX - margin && z > this.minZ + margin && z < this.maxZ - margin; }
}

// ---------------------------------------------------------------- colours
const C = {
  snow: srgb(0.86, 0.89, 0.95), groomed: srgb(1.0, 1.0, 1.0), forest: srgb(0.42, 0.5, 0.44), scrub: srgb(0.74, 0.79, 0.78),
  rock: srgb(0.47, 0.45, 0.45), scree: srgb(0.66, 0.66, 0.67), water: srgb(0.62, 0.72, 0.82), built: srgb(0.85, 0.85, 0.88),
  road: srgb(0.58, 0.55, 0.53), glacier: srgb(0.82, 0.9, 0.98),
};
const PISTE_TINT = [null, srgb(0.86, 0.92, 1.0), srgb(1.0, 0.88, 0.88), srgb(0.8, 0.8, 0.82), srgb(1.0, 0.93, 0.8)];
const PISTE_STRONG = [null, srgb(0.25, 0.5, 1.0), srgb(0.95, 0.25, 0.25), srgb(0.2, 0.2, 0.22), srgb(1.0, 0.6, 0.15)];
const tmp = new THREE.Color();

export class Terrain {
  constructor(ground, scene, material) {
    this.g = ground; this.scene = scene; this.mat = material;
    this.cx = Math.ceil((ground.nx - 1) / CHUNK); this.cy = Math.ceil((ground.ny - 1) / CHUNK);
    this.chunks = [];
    for (let a = 0; a < this.cx; a++) for (let b = 0; b < this.cy; b++) {
      const i = (a + 0.5) * CHUNK, j = (b + 0.5) * CHUNK;
      this.chunks.push({ a, b, x: ground.wx(j), z: ground.wz(i), step: 0, mesh: null, cache: new Map() });
    }
    this.strongTint = false;
    this.lodScale = 1;
  }
  colorAt(i, j, step, out) {
    const g = this.g;
    const s = g.S(i, j), cover = s & 15, p = s >> 4;
    const e = Math.max(step, 1);
    const dx = (g.H(i, j + e) - g.H(i, j - e)) / (2 * e * g.cell), dz = (g.H(i + e, j) - g.H(i - e, j)) / (2 * e * g.cell);
    const slope = Math.sqrt(dx * dx + dz * dz);
    if (p >= 1 && p <= 4) {
      out.copy(C.groomed);
      if (this.strongTint) out.lerp(PISTE_STRONG[p], 0.55); else out.multiply(PISTE_TINT[p]);
      if (slope > 1.2) out.lerp(C.rock, 0.3);
    } else if (p === 5 || cover === COVER.ROAD) out.copy(C.road);
    else if (slope > 1.0 || cover === COVER.ROCK) out.copy(C.rock).lerp(C.snow, clamp(1.4 - slope, 0, 0.6));
    else if (cover === COVER.FOREST) out.copy(C.forest);
    else if (cover === COVER.SCRUB) out.copy(C.scrub);
    else if (cover === COVER.SCREE) out.copy(C.scree);
    else if (cover === COVER.WATER) out.copy(C.water);
    else if (cover === COVER.GLACIER) out.copy(C.glacier);
    else if (cover === COVER.BUILT) out.copy(C.built);
    else { out.copy(C.snow); if (slope > 0.75) out.lerp(C.rock, (slope - 0.75) * 1.2); }
    const n = 0.97 + hash(i, j) * 0.06;
    out.r *= n; out.g *= n; out.b *= n;
    return out;
  }
  build(ch, step) {
    const g = this.g, n = Math.ceil(CHUNK / step), W = n + 3;
    const i0 = ch.a * CHUNK, j0 = ch.b * CHUNK;
    const pos = new Float32Array(W * W * 3), col = new Float32Array(W * W * 3);
    let k = 0;
    for (let a = 0; a < W; a++) {
      const ii = Math.min(i0 + clamp(a - 1, 0, n) * step, g.nx - 1);
      for (let b = 0; b < W; b++, k += 3) {
        const jj = Math.min(j0 + clamp(b - 1, 0, n) * step, g.ny - 1);
        const skirt = a === 0 || b === 0 || a === W - 1 || b === W - 1;
        pos[k] = g.wx(jj); pos[k + 1] = g.H(ii, jj) - (skirt ? 4 + 5 * step : 0); pos[k + 2] = g.wz(ii);
        this.colorAt(ii, jj, step, tmp);
        col[k] = tmp.r; col[k + 1] = tmp.g; col[k + 2] = tmp.b;
      }
    }
    const idx = new (W * W > 65535 ? Uint32Array : Uint16Array)((W - 1) * (W - 1) * 6);
    let t = 0;
    for (let a = 0; a < W - 1; a++) for (let b = 0; b < W - 1; b++) {
      const A = a * W + b, B = A + 1, Cc = A + W, D = Cc + 1;
      idx[t++] = A; idx[t++] = B; idx[t++] = Cc; idx[t++] = B; idx[t++] = D; idx[t++] = Cc;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }
  wantStep(ch, cam) {
    const d = Math.hypot(ch.x - cam.x, ch.z - cam.z) / this.lodScale;
    return d < 900 ? 1 : d < 2200 ? 2 : d < 5000 ? 4 : 8;
  }
  rebuildAll() {
    for (const ch of this.chunks) { for (const geo of ch.cache.values()) geo.dispose(); ch.cache.clear(); ch.step = 0; }
  }
  /** Swap chunk LODs, building at most `budget` ms of new geometry. */
  update(cam, budgetMs = 6) {
    const t0 = performance.now();
    const todo = [];
    for (const ch of this.chunks) {
      const s = this.wantStep(ch, cam);
      if (s !== ch.step) todo.push([Math.hypot(ch.x - cam.x, ch.z - cam.z), ch, s]);
    }
    todo.sort((p, q) => p[0] - q[0]);
    for (const [, ch, s] of todo) {
      let geo = ch.cache.get(s);
      if (!geo) {
        if (performance.now() - t0 > budgetMs && ch.step !== 0) continue;
        geo = this.build(ch, s);
        ch.cache.set(s, geo);
        // keep memory bounded: drop the finest cached level when far
        if (s >= 4 && ch.cache.has(1)) { ch.cache.get(1).dispose(); ch.cache.delete(1); }
      }
      if (!ch.mesh) {
        ch.mesh = new THREE.Mesh(geo, this.mat);
        ch.mesh.receiveShadow = true;
        ch.mesh.matrixAutoUpdate = false;
        this.scene.add(ch.mesh);
      } else ch.mesh.geometry = geo;
      ch.step = s;
    }
    return todo.length;
  }
}

/** Distant mountains around the core, lowered under the core so they never poke through. */
export function buildBackdrop(back, ground, material) {
  const { nx, ny, x0, y0, cell, h } = back;
  const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3);
  const c = new THREE.Color();
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const k = i * ny + j, x = y0 + j * cell, z = -(x0 + i * cell);
    let y = h[k];
    const inside = ground.inside(x, z, -cell);
    if (ground.inside(x, z, 200)) y = ground.height(x, z) - 60;
    else if (inside) y = Math.min(y, ground.height(x, z)) - 6;
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    const hx = (h[i * ny + Math.min(j + 1, ny - 1)] - h[i * ny + Math.max(j - 1, 0)]) / (2 * cell);
    const hz = (h[Math.min(i + 1, nx - 1) * ny + j] - h[Math.max(i - 1, 0) * ny + j]) / (2 * cell);
    const slope = Math.hypot(hx, hz);
    if (y < 1500) c.copy(C.forest).lerp(C.snow, clamp((y - 1100) / 600, 0, 0.7));
    else c.copy(C.snow);
    if (slope > 0.7) c.lerp(C.rock, clamp((slope - 0.7) * 1.5, 0, 0.8));
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let t = 0;
  for (let i = 0; i < nx - 1; i++) for (let j = 0; j < ny - 1; j++) {
    const A = i * ny + j, B = A + 1, Cc = A + ny, D = Cc + 1;
    idx[t++] = A; idx[t++] = B; idx[t++] = Cc; idx[t++] = B; idx[t++] = D; idx[t++] = Cc;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, material);
  m.matrixAutoUpdate = false;
  return m;
}

// ---------------------------------------------------------------- forests
function treeGeometry() {
  const b = new Builder();
  const trunk = srgb(0.36, 0.26, 0.18), dark = srgb(0.13, 0.27, 0.2), snow = srgb(0.93, 0.95, 1.0);
  b.add(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 5), trunk, mat(0, 0.15, 0));
  const tiers = [[0.42, 0.45, 0.2], [0.33, 0.4, 0.45], [0.22, 0.35, 0.68]];
  for (const [r, hgt, y] of tiers) {
    const top = y + hgt;
    b.add(new THREE.ConeGeometry(r, hgt, 7), (x, yy) => (yy > top - hgt * 0.35 ? snow : dark), mat(0, y + hgt / 2, 0));
  }
  return b.geometry();
}

/** Deterministic trees: the same function places them for drawing and for collisions. */
export class Forest {
  constructor(ground, scene, material) {
    this.g = ground; this.scene = scene; this.mat = material;
    this.geo = treeGeometry();
    this.chunks = new Map();
    this.radius = 2400;
    this.nearRadius = 1000;
    this.shadows = true;
  }
  /** Tree in cell (i,j) or null: [x, y, z, height, rot] */
  tree(i, j) {
    const g = this.g;
    if (i < 0 || j < 0 || i >= g.nx - 1 || j >= g.ny - 1) return null;
    const s = g.S(i, j), cover = s & 15;
    if (s >> 4) return null;
    const r = hash(i, j, 7);
    let size;
    if (cover === COVER.FOREST) { if (r > 0.62) return null; size = 9 + hash(i, j, 3) * 9; }
    else if (cover === COVER.SCRUB) { if (r > 0.14) return null; size = 3 + hash(i, j, 3) * 4; }
    else if (cover === COVER.OPEN || cover === COVER.BUILT) { if (r > 0.004) return null; size = 6 + hash(i, j, 3) * 8; }
    else return null;
    const x = g.wx(j + hash(i, j, 1)), z = g.wz(i + hash(i, j, 2));
    return [x, g.height(x, z) - 0.3, z, size, hash(i, j, 4) * 6.283];
  }
  buildChunk(a, b, near) {
    const list = [];
    const i0 = a * CHUNK, j0 = b * CHUNK;
    for (let i = i0; i < i0 + CHUNK; i++) for (let j = j0; j < j0 + CHUNK; j++) {
      const t = this.tree(i, j);
      if (t && (near || hash(i, j, 9) < 0.4)) list.push(t);
    }
    if (!list.length) return null;
    const m = new THREE.InstancedMesh(this.geo, this.mat, list.length);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3(), p = new THREE.Vector3();
    list.forEach((t, k) => {
      const sc = near ? t[3] : t[3] * 1.15;
      M.compose(p.set(t[0], t[1], t[2]), q.setFromAxisAngle(up, t[4]), s.set(sc * 0.9, sc, sc * 0.9));
      m.setMatrixAt(k, M);
    });
    m.computeBoundingSphere();
    m.castShadow = near && this.shadows;
    m.matrixAutoUpdate = false;
    return m;
  }
  update(cam, terrain, budgetMs = 4) {
    const t0 = performance.now();
    const want = new Map();
    for (const ch of terrain.chunks) {
      const d = Math.hypot(ch.x - cam.x, ch.z - cam.z);
      if (d < this.radius) want.set(ch.a * 1000 + ch.b, [ch, d < this.nearRadius, d]);
    }
    for (const [key, entry] of this.chunks) {
      const w = want.get(key);
      if (!w || w[1] !== entry.near) {
        if (w && performance.now() - t0 > budgetMs) continue;
        if (entry.mesh) { this.scene.remove(entry.mesh); entry.mesh.dispose(); }
        this.chunks.delete(key);
      }
    }
    const missing = [...want.entries()].filter(([k]) => !this.chunks.has(k)).sort((p, q) => p[1][2] - q[1][2]);
    for (const [key, [ch, near]] of missing) {
      if (performance.now() - t0 > budgetMs) break;
      const mesh = this.buildChunk(ch.a, ch.b, near);
      if (mesh) this.scene.add(mesh);
      this.chunks.set(key, { mesh, near });
    }
  }
  clear() { for (const [, e] of this.chunks) if (e.mesh) { this.scene.remove(e.mesh); e.mesh.dispose(); } this.chunks.clear(); }
  /** Push a body at (x,z) out of nearby trunks; returns true on a hit. */
  collide(p, radius = 0.5) {
    const g = this.g, ci = Math.round(g.gi(p.z)), cj = Math.round(g.gj(p.x));
    let hit = false;
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      const t = this.tree(i, j);
      if (!t || p.y > t[1] + t[3] * 0.9) continue;
      const tr = 0.08 * t[3] * 0.9 + radius;
      const dx = p.x - t[0], dz = p.z - t[2], d = Math.hypot(dx, dz);
      if (d < tr && d > 1e-4) { p.x = t[0] + (dx / d) * tr; p.z = t[2] + (dz / d) * tr; hit = true; }
    }
    return hit;
  }
}
