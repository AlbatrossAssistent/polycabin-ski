// Terrain: height sampling, worker-built LOD chunks, snow shader, horizon backdrop and forests.
// World frame: three.js x = east (data Y), z = south (-data X), y = up. Metres.
import * as THREE from 'three';
import { hash, clamp, srgb, Builder, mat } from './util.js';

export const CHUNK = 64; // 10 m cells per chunk side (640 m)
export const COVER = { OPEN: 0, FOREST: 1, SCRUB: 2, ROCK: 3, SCREE: 4, WATER: 5, GLACIER: 6, BUILT: 7, ROAD: 8 };

const cr = (a, b, c, d) => (-a + 9 * b + 9 * c - d) * 0.0625;

export class Ground {
  constructor(height, surface, piste) {
    Object.assign(this, { nx: height.nx, ny: height.ny, x0: height.x0, y0: height.y0, cell: height.cell, h: height.h });
    this.surf = surface;
    this.piste = piste; // { n5x, n5y, data }
    this.n5x = (this.nx - 1) * 2 + 1; this.n5y = (this.ny - 1) * 2 + 1;
    this.minX = this.y0; this.maxX = this.y0 + (this.ny - 1) * this.cell;
    this.minZ = -(this.x0 + (this.nx - 1) * this.cell); this.maxZ = -this.x0;
  }
  gi(z) { return (-z - this.x0) / this.cell; }
  gj(x) { return (x - this.y0) / this.cell; }
  wx(j) { return this.y0 + j * this.cell; }
  wz(i) { return -(this.x0 + i * this.cell); }
  H(i, j) { return this.h[clamp(i, 0, this.nx - 1) * this.ny + clamp(j, 0, this.ny - 1)]; }
  S(i, j) { return this.surf[clamp(i, 0, this.nx - 1) * this.ny + clamp(j, 0, this.ny - 1)]; }
  /** Height at 5 m index (Catmull-Rom half points), matching the worker. */
  H5(I, J) {
    const i = I >> 1, j = J >> 1;
    if (!(I & 1)) {
      if (!(J & 1)) return this.H(i, j);
      return cr(this.H(i, j - 1), this.H(i, j), this.H(i, j + 1), this.H(i, j + 2));
    }
    if (!(J & 1)) return cr(this.H(i - 1, j), this.H(i, j), this.H(i + 1, j), this.H(i + 2, j));
    const row = (ii) => cr(this.H(ii, j - 1), this.H(ii, j), this.H(ii, j + 1), this.H(ii, j + 2));
    return cr(row(i - 1), row(i), row(i + 1), row(i + 2));
  }
  /** Height exactly on the finest (5 m) mesh triangles. */
  height(x, z) {
    const fi = clamp(this.gi(z) * 2, 0, this.n5x - 1.001), fj = clamp(this.gj(x) * 2, 0, this.n5y - 1.001);
    const I = fi | 0, J = fj | 0, v = fi - I, u = fj - J;
    const a = this.H5(I, J), b = this.H5(I, J + 1), c = this.H5(I + 1, J), d = this.H5(I + 1, J + 1);
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }
  normal(x, z, out = new THREE.Vector3(), e = 3) {
    const hx = this.height(x + e, z) - this.height(x - e, z), hz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }
  surface(x, z) { return this.S(Math.round(this.gi(z)), Math.round(this.gj(x))); }
  /** Piste kind (1-4) and coverage (0..1) at a point from the 5 m layer. */
  pisteAt(x, z) {
    const I = clamp(Math.round(this.gi(z) * 2), 0, this.n5x - 1), J = clamp(Math.round(this.gj(x) * 2), 0, this.n5y - 1);
    const p = this.piste[I * this.n5y + J];
    return { kind: p >> 5, w: (p & 31) / 31 };
  }
  inside(x, z, margin = 0) { return x > this.minX + margin && x < this.maxX - margin && z > this.minZ + margin && z < this.maxZ - margin; }
}

// ---------------------------------------------------------------- snow material
const NOISE_GLSL = `
varying vec3 vWPos; varying vec3 vWN; varying float vGroom;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1,0)), f.x), mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), f.x), f.y); }
`;

/** Lambert with procedural snow detail: soft drifts, corduroy on groomed runs, sparkles up close. */
export function snowMaterial(opts = {}) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.userData.detail = { value: opts.detail ?? 1 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = m.userData.detail;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGroom;\nvarying vec3 vWPos; varying vec3 vWN; varying float vGroom;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normalize(mat3(modelMatrix) * objectNormal); vGroom = aGroom;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uDetail;' + NOISE_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float dist = length(vWPos - cameraPosition);
        float nfade = 1.0 - smoothstep(150.0, 1400.0, dist);
        float n = vnoise(vWPos.xz * 0.035) * 0.55 + vnoise(vWPos.xz * 0.21) * 0.3 + vnoise(vWPos.xz * 1.7) * 0.15 * nfade;
        diffuseColor.rgb *= 1.0 + (n - 0.5) * mix(0.05, 0.13, nfade) * uDetail;
        vec2 fall = vWN.xz; float fl = length(fall);
        if (vGroom > 0.2 && fl > 0.015 && uDetail > 0.5) {
          vec2 perp = vec2(-fall.y, fall.x) / fl;
          float sc = dot(vWPos.xz, perp) * 7.5;
          float s = sin(sc);
          float aa = 1.0 - smoothstep(0.6, 1.6, fwidth(sc));
          float cf = (1.0 - smoothstep(15.0, 90.0, dist)) * smoothstep(0.2, 0.7, vGroom) * aa;
          diffuseColor.rgb *= 1.0 + s * 0.045 * cf;
        }`)
      .replace('#include <opaque_fragment>', `
        if (uDetail > 0.5) {
          vec3 cellp = floor(vWPos * 14.0);
          float hs = fract(sin(dot(cellp, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          vec3 V = normalize(cameraPosition - vWPos);
          float tw = fract(hs * 31.0 + dot(V, vec3(9.1, 13.7, 7.3)));
          float sp = step(0.992, hs) * step(0.7, tw) * (1.0 - smoothstep(4.0, 22.0, dist)) * step(0.6, vWN.y);
          outgoingLight += vec3(sp * 0.9);
        }
        #include <opaque_fragment>`);
  };
  return m;
}

export class Terrain {
  constructor(ground, scene, material, workerUrl) {
    this.g = ground; this.scene = scene; this.mat = material;
    this.cx = Math.ceil((ground.nx - 1) / CHUNK); this.cy = Math.ceil((ground.ny - 1) / CHUNK);
    this.chunks = [];
    for (let a = 0; a < this.cx; a++) for (let b = 0; b < this.cy; b++) {
      const i = (a + 0.5) * CHUNK, j = (b + 0.5) * CHUNK;
      this.chunks.push({ a, b, x: ground.wx(j), z: ground.wz(i), step: 0, mesh: null, cache: new Map(), pending: 0 });
    }
    this.byKey = new Map(this.chunks.map((c) => [c.a * 1000 + c.b, c]));
    this.strongTint = false;
    this.lodScale = 1;
    this.gen = 0;
    this.inflight = 0;
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.postMessage({
      type: 'init', h: ground.h, nx: ground.nx, ny: ground.ny, x0: ground.x0, y0: ground.y0, cell: ground.cell,
      surf: ground.surf, piste: ground.piste, n5x: ground.n5x, n5y: ground.n5y, chunk: CHUNK,
    });
    this.worker.onmessage = (e) => this.receive(e.data);
  }
  receive(m) {
    this.inflight--;
    const ch = this.byKey.get(m.a * 1000 + m.b);
    ch.pending = 0;
    if (m.gen !== this.gen) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(m.clr, 3));
    geo.setAttribute('aGroom', new THREE.BufferAttribute(m.groom, 1));
    geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
    geo.computeBoundingSphere();
    ch.cache.set(m.step, geo);
    if (m.step >= 2 && ch.cache.has(0.5)) { ch.cache.get(0.5).dispose(); ch.cache.delete(0.5); }
    if (m.step >= 4 && ch.cache.has(1)) { ch.cache.get(1).dispose(); ch.cache.delete(1); }
  }
  setTint(strong) {
    this.strongTint = strong;
    this.worker.postMessage({ type: 'tint', strong });
    this.gen++;
    for (const ch of this.chunks) { for (const g of ch.cache.values()) if (!ch.mesh || g !== ch.mesh.geometry) g.dispose(); ch.cache.clear(); ch.pending = 0; ch.forceStep = true; }
  }
  wantStep(ch, cam) {
    const d = Math.hypot(ch.x - cam.x, ch.z - cam.z) / this.lodScale;
    return d < 750 ? 0.5 : d < 1700 ? 1 : d < 3800 ? 2 : d < 8000 ? 4 : 8;
  }
  /** Request missing LODs (nearest first) and swap in ready ones. Returns number of chunks still waiting. */
  update(cam) {
    const todo = [];
    for (const ch of this.chunks) {
      const s = this.wantStep(ch, cam);
      if (s !== ch.step || ch.forceStep) todo.push([Math.hypot(ch.x - cam.x, ch.z - cam.z), ch, s]);
    }
    todo.sort((p, q) => p[0] - q[0]);
    let waiting = 0;
    for (const [, ch, s] of todo) {
      const geo = ch.cache.get(s);
      if (geo) {
        if (!ch.mesh) {
          ch.mesh = new THREE.Mesh(geo, this.mat);
          ch.mesh.receiveShadow = true;
          ch.mesh.matrixAutoUpdate = false;
          this.scene.add(ch.mesh);
        } else {
          const old = ch.mesh.geometry;
          ch.mesh.geometry = geo;
          if (ch.forceStep && old !== geo && ![...ch.cache.values()].includes(old)) old.dispose();
        }
        ch.step = s; ch.forceStep = false;
        continue;
      }
      waiting++;
      if (!ch.pending && this.inflight < 3) {
        ch.pending = 1; this.inflight++;
        this.worker.postMessage({ type: 'build', a: ch.a, b: ch.b, step: s, gen: this.gen });
      }
    }
    return waiting;
  }
}

/** Distant mountains around the core, lowered under the core so they never poke through. */
export function buildBackdrop(back0, ground, material) {
  // halve the resolution (300 m): it is all beyond the playable area
  const nx = Math.ceil(back0.nx / 2), ny = Math.ceil(back0.ny / 2), cell = back0.cell * 2, x0 = back0.x0, y0 = back0.y0;
  const h = new Float32Array(nx * ny);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) h[i * ny + j] = back0.h[Math.min(i * 2, back0.nx - 1) * back0.ny + Math.min(j * 2, back0.ny - 1)];
  const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3);
  const c = new THREE.Color();
  const snow = srgb(0.87, 0.9, 0.96), forest = srgb(0.36, 0.45, 0.39), rock = srgb(0.46, 0.44, 0.44);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const k = i * ny + j, x = y0 + j * cell, z = -(x0 + i * cell);
    let y = h[k];
    if (ground.inside(x, z, 200)) y = ground.height(x, z) - 60;
    else if (ground.inside(x, z, -cell)) y = Math.min(y, ground.height(x, z)) - 6;
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    const hx = (h[i * ny + Math.min(j + 1, ny - 1)] - h[i * ny + Math.max(j - 1, 0)]) / (2 * cell);
    const hz = (h[Math.min(i + 1, nx - 1) * ny + j] - h[Math.max(i - 1, 0) * ny + j]) / (2 * cell);
    const slope = Math.hypot(hx, hz);
    if (y < 1500) c.copy(forest).lerp(snow, clamp((y - 1050) / 650, 0, 0.7)); else c.copy(snow);
    if (slope > 0.7) c.lerp(rock, clamp((slope - 0.7) * 1.5, 0, 0.8));
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
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, material);
  m.matrixAutoUpdate = false;
  return m;
}


// ---------------------------------------------------------------- forests
/** Spruce in three detail levels (about 80, 36 and 20 triangles). Unit height. */
function spruce(level) {
  const b = new Builder();
  const trunk = srgb(0.34, 0.24, 0.17), dark = srgb(0.12, 0.25, 0.18), mid = srgb(0.16, 0.31, 0.22), snow = srgb(0.93, 0.95, 1.0);
  const seg = [7, 6, 5][level];
  const tiers = [
    [[0.44, 0.32, 0.12], [0.36, 0.3, 0.3], [0.28, 0.27, 0.47], [0.19, 0.24, 0.63], [0.1, 0.2, 0.78]],
    [[0.42, 0.42, 0.14], [0.31, 0.4, 0.4], [0.18, 0.34, 0.64]],
    [[0.42, 0.6, 0.12], [0.25, 0.45, 0.55]],
  ][level];
  if (level === 0) b.add(new THREE.CylinderGeometry(0.035, 0.06, 0.3, 5, 1, true), trunk, mat(0, 0.15, 0));
  tiers.forEach(([r, hgt, y], t) => {
    const g = new THREE.ConeGeometry(r, hgt, seg, 1, true);
    if (level === 0) {
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) if (p.getY(k) < 0) {
        const a = Math.atan2(p.getZ(k), p.getX(k)), w = 1 + 0.12 * Math.sin(a * 5 + t * 2.1);
        p.setXYZ(k, p.getX(k) * w, p.getY(k) - 0.03, p.getZ(k) * w);
      }
    }
    b.add(g, (x, yy) => ((yy - y) / hgt > 0.55 ? snow : t % 2 ? mid : dark), mat(0, y + hgt / 2, 0));
  });
  // open cones are seen from below at the rim: render both sides via a doubled, flipped copy is too costly,
  // so the material for trees is double-sided instead.
  return b.geometry();
}

const TREE_TILE = 32; // cells (320 m)

/** Deterministic trees: the same function places them for drawing and for collisions. */
export class Forest {
  constructor(ground, scene, material) {
    this.g = ground; this.scene = scene;
    this.mat = material.clone();
    this.mat.side = THREE.DoubleSide;
    this.geos = [spruce(0), spruce(1), spruce(2)];
    this.tiles = new Map();
    this.radius = 2600; this.nearRadius = 900; this.farDensity = 0.45; this.detailRadius = 420;
    this.shadows = true;
    this.ta = Math.ceil(ground.nx / TREE_TILE); this.tb = Math.ceil(ground.ny / TREE_TILE);
  }
  /** Tree k (0 or 1) in cell (i,j) or null: [x, y, z, height, rot, tint] */
  tree(i, j, k = 0) {
    const g = this.g;
    if (i < 0 || j < 0 || i >= g.nx - 1 || j >= g.ny - 1) return null;
    const s = g.S(i, j), cover = s & 15;
    if (s >> 4) return null;
    const r = hash(i, j, 7 + k * 13);
    let size;
    if (cover === COVER.FOREST) { if (r > (k ? 0.38 : 0.7)) return null; size = 8 + hash(i, j, 3 + k) * 11; }
    else if (cover === COVER.SCRUB) { if (k || r > 0.16) return null; size = 2.5 + hash(i, j, 3) * 4; }
    else if (cover === COVER.OPEN || cover === COVER.BUILT) { if (k || r > 0.005) return null; size = 6 + hash(i, j, 3) * 9; }
    else return null;
    const x = g.wx(j + (k ? 0.5 + hash(i, j, 21) * 0.5 : hash(i, j, 1) * 0.5)), z = g.wz(i + hash(i, j, 2 + k * 20));
    const p = g.pisteAt(x, z);
    if (p.kind && p.kind <= 5 && p.w > 0.05) return null;
    return [x, g.height(x, z) - 0.3, z, size, hash(i, j, 4 + k) * 6.283, hash(i, j, 5 + k)];
  }
  buildTile(a, b, level) {
    const list = [];
    const i0 = a * TREE_TILE, j0 = b * TREE_TILE;
    for (let i = i0; i < i0 + TREE_TILE; i++) for (let j = j0; j < j0 + TREE_TILE; j++) {
      for (let k = 0; k < 2; k++) {
        if (level === 2 && (k || hash(i, j, 9) >= this.farDensity)) continue;
        const t = this.tree(i, j, k);
        if (t) list.push(t);
      }
    }
    if (!list.length) return null;
    const m = new THREE.InstancedMesh(this.geos[level], this.mat, list.length);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3(), p = new THREE.Vector3();
    const c = new THREE.Color();
    list.forEach((t, k) => {
      const sc = level === 2 ? t[3] * 1.12 : t[3];
      const wd = sc * (0.8 + t[5] * 0.25);
      M.compose(p.set(t[0], t[1], t[2]), q.setFromAxisAngle(up, t[4]), s.set(wd, sc, wd));
      m.setMatrixAt(k, M);
      const v = 0.82 + t[5] * 0.3;
      m.setColorAt(k, c.setRGB(v, v * (0.97 + t[5] * 0.06), v));
    });
    m.computeBoundingSphere();
    m.castShadow = level === 0 && this.shadows;
    m.matrixAutoUpdate = false;
    return m;
  }
  update(cam, terrain, budgetMs = 4) {
    const t0 = performance.now(), g = this.g;
    const want = new Map();
    const ca = g.gi(cam.z) / TREE_TILE, cb = g.gj(cam.x) / TREE_TILE, rt = this.radius / (TREE_TILE * g.cell) + 1;
    for (let a = Math.max(0, Math.floor(ca - rt)); a <= Math.min(this.ta - 1, Math.ceil(ca + rt)); a++) {
      for (let b = Math.max(0, Math.floor(cb - rt)); b <= Math.min(this.tb - 1, Math.ceil(cb + rt)); b++) {
        const x = g.wx((b + 0.5) * TREE_TILE), z = g.wz((a + 0.5) * TREE_TILE);
        const d = Math.hypot(x - cam.x, z - cam.z);
        if (d > this.radius) continue;
        const level = d < this.detailRadius ? 0 : d < this.nearRadius ? 1 : 2;
        want.set(a * 10000 + b, [a, b, level, d]);
      }
    }
    for (const [key, e] of this.tiles) if (!want.has(key)) { if (e.mesh) { this.scene.remove(e.mesh); e.mesh.dispose(); } this.tiles.delete(key); }
    const missing = [...want.entries()].filter(([k, w]) => !this.tiles.has(k) || this.tiles.get(k).level !== w[2]).sort((p, q) => p[1][3] - q[1][3]);
    for (const [key, [a, b, level]] of missing) {
      if (performance.now() - t0 > budgetMs) break;
      const mesh = this.buildTile(a, b, level);
      const old = this.tiles.get(key);
      if (old && old.mesh) { this.scene.remove(old.mesh); old.mesh.dispose(); }
      if (mesh) this.scene.add(mesh);
      this.tiles.set(key, { mesh, level });
    }
    void terrain;
  }
  clear() { for (const [, e] of this.tiles) if (e.mesh) { this.scene.remove(e.mesh); e.mesh.dispose(); } this.tiles.clear(); }
  /** Push a body at (x,z) out of nearby trunks; returns true on a hit. */
  collide(p, radius = 0.5) {
    const g = this.g, ci = Math.round(g.gi(p.z)), cj = Math.round(g.gj(p.x));
    let hit = false;
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (let k = 0; k < 2; k++) {
      const t = this.tree(i, j, k);
      if (!t || p.y > t[1] + t[3] * 0.9) continue;
      const tr = 0.06 * t[3] + radius;
      const dx = p.x - t[0], dz = p.z - t[2], d = Math.hypot(dx, dz);
      if (d < tr && d > 1e-4) { p.x = t[0] + (dx / d) * tr; p.z = t[2] + (dz / d) * tr; hit = true; }
    }
    return hit;
  }
}
