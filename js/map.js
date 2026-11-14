// Pre-rendered resort map (hillshade, pistes, lifts, names) shared by the minimap and the big map.
import { toWorld } from './world.js';

const PISTE_COL = ['#888', '#2f6fe0', '#e03131', '#111', '#f08c00'];

export class ResortMap {
  constructor(ground, features, lifts) {
    this.g = ground;
    const W = ground.ny, H = ground.nx; // 10 m per pixel; x east, y north-up
    this.W = W; this.H = H;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data, h = ground.h, ny = ground.ny;
    for (let i = 0; i < H; i++) {
      const py = H - 1 - i;
      for (let j = 0; j < W; j++) {
        const k = i * ny + j;
        const hx = (h[i * ny + Math.min(j + 1, W - 1)] - h[i * ny + Math.max(j - 1, 0)]) / 20;
        const hz = (h[Math.min(i + 1, H - 1) * ny + j] - h[Math.max(i - 1, 0) * ny + j]) / 20;
        // light from the north-west
        const nl = (hx * 0.5 - hz * 0.5 + 0.7) / Math.sqrt(hx * hx + hz * hz + 1);
        let shade = Math.max(0.35, Math.min(1.15, 0.55 + 0.55 * nl));
        const cover = ground.surf[k] & 15;
        let r = 244, g = 247, b = 252;
        if (cover === 1) { r = 120; g = 150; b = 128; }
        else if (cover === 2) { r = 200; g = 214; b = 206; }
        else if (cover === 3 || Math.hypot(hx, hz) > 1.0) { r = 165; g = 160; b = 158; }
        else if (cover === 5) { r = 150; g = 190; b = 225; }
        else if (cover === 7) { r = 215; g = 196; b = 178; }
        else if (cover === 8) { r = 190; g = 180; b = 172; }
        const e = (py * W + j) * 4;
        d[e] = r * shade; d[e + 1] = g * shade; d[e + 2] = b * shade; d[e + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const P = (X, Y) => this.toPx(toWorld(X, Y));
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const p of features.pistes) {
      ctx.strokeStyle = PISTE_COL[p.d] || '#888';
      ctx.lineWidth = p.d === 4 ? 2 : 3;
      ctx.setLineDash(p.d === 4 ? [6, 5] : []);
      ctx.beginPath();
      p.pts.forEach(([X, Y], k) => { const [x, y] = P(X, Y); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const L of lifts.list) {
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 2;
      ctx.beginPath();
      L.up.p.forEach((p, k) => { const [x, y] = this.toPx(p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      const [bx, by] = this.toPx(L.bottom);
      ctx.fillStyle = '#ffd43b'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(bx, by, 4.5, 0, 6.283); ctx.fill(); ctx.stroke();
    }
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const L of lifts.list) {
      if (L.up.length < 400 || !L.name) continue;
      const mid = L.up.at(L.up.length / 2);
      const [x, y] = this.toPx(mid);
      this.label(ctx, L.name, x, y - 6, '#222', 11);
    }
    for (const t of features.huts) if (t.kind !== 'church') {
      const [x, y] = P(t.x, t.y);
      ctx.fillStyle = '#c92a2a'; ctx.fillRect(x - 3, y - 3, 6, 6);
    }
    for (const pl of features.places) {
      const [x, y] = P(pl.x, pl.y);
      this.label(ctx, pl.name, x, y, '#0b2545', pl.kind === 'village' ? 20 : 12);
    }
    for (const pk of features.peaks) {
      const [x, y] = P(pk.x, pk.y);
      if (x < 0 || y < 0 || x > W || y > H) continue;
      ctx.fillStyle = '#5c3d2e';
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 4, y + 2); ctx.lineTo(x - 4, y + 2); ctx.fill();
      this.label(ctx, `${pk.name} ${Math.round(pk.ele)}`, x, y + 15, '#5c3d2e', 10);
    }
    this.canvas = c;
  }
  label(ctx, text, x, y, color, size) {
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }
  toPx(p) { return [this.g.gj(p.x), this.H - 1 - this.g.gi(p.z)]; }
  fromPx(x, y) { return { x: this.g.wx(x), z: this.g.wz(this.H - 1 - y) }; }
  drawMini(ctx, p, yaw, size, scale = 1.6) {
    const [px, py] = this.toPx(p);
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#e8eef5'; ctx.fillRect(0, 0, size, size);
    ctx.translate(size / 2, size / 2);
    ctx.scale(scale, scale);
    ctx.drawImage(this.canvas, -px, -py);
    ctx.restore();
    this.arrow(ctx, size / 2, size / 2, yaw, 9);
  }
  arrow(ctx, x, y, yaw, r) {
    // yaw 0 faces +z (south) -> screen down
    const a = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    ctx.save();
    ctx.translate(x, y); ctx.rotate(-a);
    ctx.fillStyle = '#1f6fd1'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, r); ctx.lineTo(r * 0.7, -r * 0.7); ctx.lineTo(0, -r * 0.3); ctx.lineTo(-r * 0.7, -r * 0.7); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}
