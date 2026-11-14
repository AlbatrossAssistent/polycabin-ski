import * as THREE from 'three';

export function hash(i, j, k = 0) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(k | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** sRGB 0..1 triple -> linear THREE.Color */
export function srgb(r, g, b) { return new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace); }

/** Accumulates non-indexed triangles with per-vertex colour. */
export class Builder {
  constructor() { this.pos = []; this.col = []; }
  add(geo, color, matrix) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    const p = g.attributes.position.array;
    const fn = typeof color === 'function' ? color : null;
    const c = fn ? null : new THREE.Color(color);
    for (let i = 0; i < p.length; i += 3) {
      this.pos.push(p[i], p[i + 1], p[i + 2]);
      if (fn) { const k = fn(p[i], p[i + 1], p[i + 2]); this.col.push(k.r, k.g, k.b); }
      else this.col.push(c.r, c.g, c.b);
    }
    g.dispose();
    return this;
  }
  tri(a, b, c, color) {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < 3; i++) this.col.push(color.r, color.g, color.b);
  }
  /** Triangle whose winding is flipped if needed so its normal points along `out`. */
  triFacing(a, b, c, out, color) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.dot(out) < 0) this.tri(a, c, b, color); else this.tri(a, b, c, color);
  }
  get empty() { return this.pos.length === 0; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), E = new THREE.Euler();
export function mat(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  E.set(rx, ry, rz, 'YXZ');
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), Q.setFromEuler(E).clone(), S.set(sx, sy, sz).clone());
}

/** Fetch with byte progress, then gunzip if the bytes are gzip. */
export async function fetchBytes(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); n += value.length; onBytes?.(value.length);
  }
  let buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return buf.buffer;
}

export function readHeader(buf) {
  const dv = new DataView(buf);
  return { nx: dv.getInt32(4, true), ny: dv.getInt32(8, true), x0: dv.getFloat32(12, true), y0: dv.getFloat32(16, true), cell: dv.getFloat32(20, true) };
}

/** Decode planar-predictor int16 residuals (decimetres) into Float32 metres. */
export function decodeHeights(buf) {
  const h = readHeader(buf);
  const r = new Int16Array(buf.slice(24));
  const { nx, ny } = h;
  const dm = new Int32Array(nx * ny);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const k = i * ny + j;
      const up = i > 0 ? dm[k - ny] : 0, left = j > 0 ? dm[k - 1] : 0, ul = i > 0 && j > 0 ? dm[k - ny - 1] : 0;
      dm[k] = r[k] + up + left - ul;
    }
  }
  const out = new Float32Array(nx * ny);
  for (let k = 0; k < out.length; k++) out[k] = dm[k] * 0.1;
  h.h = out;
  return h;
}
