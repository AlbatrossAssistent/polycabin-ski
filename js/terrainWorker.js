// Builds terrain chunk meshes off the main thread.
// Heights are 10 m data; the finest LOD samples them at 5 m with Catmull-Rom (half-point formula),
// exactly as Ground.height() does for physics.
let G = null, strong = false;

const lin = (c) => Math.pow(c, 2.2);
const col = (r, g, b) => [lin(r), lin(g), lin(b)];
const C = {
  snow: col(0.87, 0.9, 0.96), groomed: col(0.985, 0.985, 1.0), forestNear: col(0.8, 0.84, 0.88), forestFar: col(0.36, 0.45, 0.39),
  scrub: col(0.8, 0.84, 0.86), rock: col(0.46, 0.44, 0.44), scree: col(0.68, 0.68, 0.7), water: col(0.66, 0.76, 0.86),
  built: col(0.86, 0.86, 0.89), road: col(0.56, 0.54, 0.53), glacier: col(0.84, 0.92, 0.99),
};
const EDGE = [null, col(0.35, 0.58, 1.0), col(1.0, 0.38, 0.38), col(0.3, 0.3, 0.33), col(1.0, 0.65, 0.2)];

function H(i, j) {
  i = i < 0 ? 0 : i >= G.nx ? G.nx - 1 : i;
  j = j < 0 ? 0 : j >= G.ny ? G.ny - 1 : j;
  return G.h[i * G.ny + j];
}
const cr = (a, b, c, d) => (-a + 9 * b + 9 * c - d) * 0.0625;
function H5(I, J) {
  const i = I >> 1, j = J >> 1;
  if (!(I & 1)) {
    if (!(J & 1)) return H(i, j);
    return cr(H(i, j - 1), H(i, j), H(i, j + 1), H(i, j + 2));
  }
  if (!(J & 1)) return cr(H(i - 1, j), H(i, j), H(i + 1, j), H(i + 2, j));
  const row = (ii) => cr(H(ii, j - 1), H(ii, j), H(ii, j + 1), H(ii, j + 2));
  return cr(row(i - 1), row(i), row(i + 1), row(i + 2));
}
function P5(I, J) {
  I = I < 0 ? 0 : I >= G.n5x ? G.n5x - 1 : I;
  J = J < 0 ? 0 : J >= G.n5y ? G.n5y - 1 : J;
  return G.piste[I * G.n5y + J];
}
function S10(I, J) {
  let i = I >> 1, j = J >> 1;
  i = i < 0 ? 0 : i >= G.nx ? G.nx - 1 : i;
  j = j < 0 ? 0 : j >= G.ny ? G.ny - 1 : j;
  return G.surf[i * G.ny + j];
}
function hash(i, j) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function mix(o, a, b, t) { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; }
function set(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; }

const out = [0, 0, 0], tmp = [0, 0, 0];
/** Colour at 5 m index (I,J); returns groomed weight for corduroy. */
function colour(I, J, st5, slope) {
  const s = S10(I, J), cover = s & 15;
  // coarse LODs: sample the piste layer a little wider so thin runs don't vanish
  let p = P5(I, J);
  if (st5 >= 4) { const q = Math.max(P5(I + 1, J), P5(I, J + 1), P5(I - 1, J), P5(I, J - 1)); if ((q & 31) > (p & 31)) p = q; }
  const kind = p >> 5, w = (p & 31) / 31;
  if (cover === 3 || slope > 1.05) mix(out, C.snow, C.rock, Math.min(1, 0.5 + (slope - 1.05) * 1.5));
  else if (cover === 1) {
    const far = st5 <= 2 ? 0 : st5 === 4 ? 0.55 : 1;
    mix(out, C.forestNear, C.forestFar, far);
  } else if (cover === 2) set(out, C.scrub);
  else if (cover === 4) set(out, C.scree);
  else if (cover === 5) set(out, C.water);
  else if (cover === 6) set(out, C.glacier);
  else if (cover === 7) set(out, C.built);
  else if (cover === 8) set(out, C.road);
  else { set(out, C.snow); if (slope > 0.75) mix(out, out, C.rock, (slope - 0.75) * 1.3); }
  let groom = 0;
  if (kind >= 1 && kind <= 4 && w > 0) {
    set(tmp, out);
    mix(out, tmp, C.groomed, Math.min(1, w * 1.4));
    if (slope > 1.2) mix(out, out, C.rock, 0.25);
    const edge = 1 - Math.abs(2 * w - 1);
    if (strong) mix(out, out, EDGE[kind], 0.5 * Math.min(1, w * 1.5));
    else mix(out, out, EDGE[kind], 0.22 * edge);
    groom = kind <= 3 ? w : 0;
  } else if (kind === 5 && w > 0) mix(out, out, C.road, Math.min(1, w * 1.3));
  const n = 0.975 + hash(I, J) * 0.05;
  out[0] *= n; out[1] *= n; out[2] *= n;
  return groom;
}

function build(a, b, step) {
  const CH = G.chunk, st5 = Math.round(step * 2);
  const n = Math.ceil((CH * 2) / st5), W = n + 3;
  const I0 = a * CH * 2, J0 = b * CH * 2, maxI = G.n5x - 1, maxJ = G.n5y - 1;
  const pos = new Float32Array(W * W * 3), nor = new Float32Array(W * W * 3), clr = new Float32Array(W * W * 3), groom = new Float32Array(W * W);
  const half = G.cell / 2;
  let k = 0;
  for (let r = 0; r < W; r++) {
    const I = Math.min(I0 + Math.min(Math.max(r - 1, 0), n) * st5, maxI);
    for (let c = 0; c < W; c++, k++) {
      const J = Math.min(J0 + Math.min(Math.max(c - 1, 0), n) * st5, maxJ);
      const skirt = r === 0 || c === 0 || r === W - 1 || c === W - 1;
      const h = H5(I, J);
      const e = st5;
      const dhdx = (H5(I, J + e) - H5(I, J - e)) / (2 * e * half);
      const dhdz = -(H5(I + e, J) - H5(I - e, J)) / (2 * e * half);
      const inv = 1 / Math.sqrt(dhdx * dhdx + dhdz * dhdz + 1);
      pos[k * 3] = G.y0 + J * half; pos[k * 3 + 1] = h - (skirt ? 3 + 4 * step : 0); pos[k * 3 + 2] = -(G.x0 + I * half);
      nor[k * 3] = -dhdx * inv; nor[k * 3 + 1] = inv; nor[k * 3 + 2] = -dhdz * inv;
      groom[k] = colour(I, J, st5, Math.sqrt(dhdx * dhdx + dhdz * dhdz));
      clr[k * 3] = out[0]; clr[k * 3 + 1] = out[1]; clr[k * 3 + 2] = out[2];
    }
  }
  const idx = new Uint32Array((W - 1) * (W - 1) * 6);
  let t = 0;
  for (let r = 0; r < W - 1; r++) for (let c = 0; c < W - 1; c++) {
    const A = r * W + c, B = A + 1, Cc = A + W, D = Cc + 1;
    idx[t++] = A; idx[t++] = B; idx[t++] = Cc; idx[t++] = B; idx[t++] = D; idx[t++] = Cc;
  }
  return { pos, nor, clr, groom, idx };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { G = m; strong = false; }
  else if (m.type === 'tint') strong = m.strong;
  else if (m.type === 'build') {
    const r = build(m.a, m.b, m.step);
    self.postMessage({ id: m.id, a: m.a, b: m.b, step: m.step, gen: m.gen, ...r }, [r.pos.buffer, r.nor.buffer, r.clr.buffer, r.groom.buffer, r.idx.buffer]);
  }
};
