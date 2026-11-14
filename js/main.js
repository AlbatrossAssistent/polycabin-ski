import * as THREE from 'three';
import { fetchBytes, decodeHeights, readHeader, clamp, lerp } from './util.js';
import { Ground, Terrain, Forest, buildBackdrop } from './terrain.js';
import { buildBuildings, Lifts, PisteIndex } from './world.js';
import { Player, Crowd, riderGeometry } from './skier.js';
import { ResortMap } from './map.js';

const $ = (id) => document.getElementById(id);
const touchDevice = matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------- renderer
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !touchDevice, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const HORIZON = new THREE.Color(0xc9dcef);
scene.fog = new THREE.Fog(HORIZON, 2500, 26000);
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 60000);

const quality = { high: !touchDevice };
function applyQuality() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality.high ? 1.75 : 1));
  renderer.shadowMap.enabled = quality.high;
  sun.castShadow = quality.high;
  if (terrain) terrain.lodScale = quality.high ? 1 : 0.6;
  if (forest) {
    forest.radius = quality.high ? 2400 : 1300; forest.nearRadius = quality.high ? 1000 : 500; forest.shadows = quality.high; forest.clear();
  }
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  resize();
}
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// sky dome
const sky = new THREE.Mesh(new THREE.SphereGeometry(50000, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { top: { value: new THREE.Color(0x2d6fc4) }, horizon: { value: HORIZON }, sunDir: { value: new THREE.Vector3() } },
  vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }',
  fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
    void main(){ float h = max(vDir.y, 0.0); vec3 c = mix(horizon, top, pow(h, 0.55));
      float s = max(dot(normalize(vDir), sunDir), 0.0); c += vec3(1.0,0.9,0.7) * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.18);
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
}));
sky.frustumCulled = false;
scene.add(sky);

const hemi = new THREE.HemisphereLight(0xdde9ff, 0x7d8696, 1.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0dc, 2.3);
const SUN_DIR = new THREE.Vector3(-0.45, 0.62, 0.64).normalize(); // from the south-west, afternoon
sky.material.uniforms.sunDir.value.copy(SUN_DIR);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 600 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const objMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

let ground, terrain, forest, lifts, pistes, player, crowd, rmap, features;

// ---------------------------------------------------------------- loading
async function load() {
  const files = [['data/height.bin.gz', 2.6e6], ['data/surface.bin.gz', 0.2e6], ['data/backdrop.bin.gz', 0.43e6], ['data/features.json', 0.66e6]];
  const total = files.reduce((a, f) => a + f[1], 0);
  let got = 0;
  const bar = $('loadbar').firstElementChild;
  const onBytes = (n) => { got += n; bar.style.width = `${Math.min(95, (got / total) * 95)}%`; };
  const [hb, sb, bb, fb] = await Promise.all(files.map(([u]) => fetchBytes(u, onBytes)));
  $('loadtext').textContent = 'Building the mountains…';
  await new Promise((r) => setTimeout(r, 20));
  const height = decodeHeights(hb);
  const surface = new Uint8Array(sb.slice(24));
  void readHeader(sb);
  const back = decodeHeights(bb);
  features = JSON.parse(new TextDecoder().decode(fb));
  ground = new Ground(height, surface);
  terrain = new Terrain(ground, scene, terrainMat);
  scene.add(buildBackdrop(back, ground, terrainMat));
  forest = new Forest(ground, scene, objMat);
  for (const m of buildBuildings(features.buildings, ground, objMat)) scene.add(m);
  lifts = new Lifts(features.lifts, ground, scene, objMat, riderGeometry());
  pistes = new PisteIndex(features.pistes, ground);
  player = new Player(scene, objMat, ground, forest);
  crowd = new Crowd(scene, objMat, pistes, ground, touchDevice ? 50 : 100);
  rmap = new ResortMap(ground, features, lifts);
  spawnAtLift(lifts.list.find((L) => L.name === 'Komperdellbahn') || lifts.list[0], 'top');
  applyQuality();
  camState.pos.copy(player.pos).add(new THREE.Vector3(0, 30, -60));
  // build what's around the start before the button lights up
  for (let k = 0; k < 40 && terrain.update(player.pos, 1e9) > 0; k++);
  forest.update(player.pos, terrain, 1e9);
  bar.style.width = '100%';
  $('loadtext').textContent = 'Ready.';
  $('go').disabled = false;
}

let lastTop = null;
function spawnAtLift(L, where) {
  if (where === 'top') {
    const p = L.top.clone().addScaledVector(L.topDir, L.surface ? 6 : 16);
    player.place(p, player.downhillYaw(p));
    lastTop = L;
  } else {
    const p = L.bottom.clone().addScaledVector(L.bottomDir, -12);
    player.place(p, Math.atan2(L.bottomDir.x, L.bottomDir.z));
  }
  camState.snap = true;
}

// ---------------------------------------------------------------- input
const keys = new Set();
const touch = { left: false, right: false, tuck: false, brake: false };
let mapOpen = false, helpOpen = false, started = false;
addEventListener('keydown', (e) => {
  if (!started) return;
  const k = e.key.toLowerCase();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
  if (e.repeat) { keys.add(k); return; }
  keys.add(k);
  if (k === 'm') toggleMap();
  else if (k === 'escape') { if (mapOpen) toggleMap(); if (helpOpen) toggleHelp(); }
  else if (k === 'h' || k === 'f1') { e.preventDefault(); toggleHelp(); }
  else if (k === 'c') camState.mode = (camState.mode + 1) % 3;
  else if (k === 'v') { terrain.strongTint = !terrain.strongTint; terrain.rebuildAll(); toast(terrain.strongTint ? 'Piste colours on' : 'Piste colours off'); }
  else if (k === 'g') { quality.high = !quality.high; applyQuality(); toast(quality.high ? 'Graphics: high' : 'Graphics: low'); }
  else if (k === 'e') tryRide();
  else if (k === 'r' && lastTop) spawnAtLift(lastTop, 'top');
  else if (k === ' ' && !player.ride) player.input.jump = true;
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

function bindTouch() {
  $('touch').classList.remove('hidden');
  for (const b of $('touch').querySelectorAll('button')) {
    const k = b.dataset.k;
    const down = (e) => {
      e.preventDefault(); b.classList.add('on');
      if (k in touch) touch[k] = true;
      if (k === 'jump') { if (player.ride) touch.fast = true; else player.input.jump = true; }
      if (k === 'ride') tryRide();
      if (k === 'map') toggleMap();
    };
    const up = (e) => { e.preventDefault(); b.classList.remove('on'); if (k in touch) touch[k] = false; if (k === 'jump') touch.fast = false; };
    b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
  }
}

function readInput() {
  const i = player.input;
  const left = keys.has('a') || keys.has('arrowleft') || touch.left, right = keys.has('d') || keys.has('arrowright') || touch.right;
  i.turn = (left ? -1 : 0) + (right ? 1 : 0);
  i.tuck = keys.has('w') || keys.has('arrowup') || touch.tuck;
  i.brake = keys.has('s') || keys.has('arrowdown') || touch.brake;
  i.fast = keys.has(' ') || !!touch.fast;
}

function tryRide() {
  if (player.ride) return;
  const L = lifts.nearestBottom(player.pos);
  if (L && player.speed < 9) { player.startRide(L); toast(L.name); lastTop = L; }
}

function toggleHelp() { helpOpen = !helpOpen; $('help').classList.toggle('hidden', !helpOpen); }

// ---------------------------------------------------------------- map
const bigmap = $('bigmap');
function toggleMap() {
  mapOpen = !mapOpen;
  $('mapview').classList.toggle('hidden', !mapOpen);
  if (mapOpen) {
    bigmap.width = rmap.W; bigmap.height = rmap.H;
    const ctx = bigmap.getContext('2d');
    ctx.drawImage(rmap.canvas, 0, 0);
    const [x, y] = rmap.toPx(player.pos);
    ctx.lineWidth = 3; ctx.strokeStyle = '#1f6fd1';
    ctx.beginPath(); ctx.arc(x, y, 22, 0, 6.283); ctx.stroke();
    rmap.arrow(ctx, x, y, player.yaw, 12);
  }
}
bigmap.addEventListener('click', (e) => {
  const r = bigmap.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * rmap.W, y = ((e.clientY - r.top) / r.height) * rmap.H;
  let best = null, bd = 14 * (rmap.W / r.width);
  for (const L of lifts.list) {
    const [bx, by] = rmap.toPx(L.bottom);
    const d = Math.hypot(bx - x, by - y);
    if (d < bd) { bd = d; best = L; }
  }
  if (best) { spawnAtLift(best, 'bottom'); toast(`${best.name}: press E to ride`); }
  else {
    const w = rmap.fromPx(x, y);
    const p = new THREE.Vector3(w.x, 0, w.z);
    if (!ground.inside(p.x, p.z, 200)) return;
    player.place(p, player.downhillYaw(p));
    camState.snap = true;
  }
  toggleMap();
});
$('mapview').addEventListener('click', (e) => { if (e.target === $('mapview') || e.target.classList.contains('close')) toggleMap(); });

// ---------------------------------------------------------------- HUD
let toastTimer = 0;
function toast(text) { const t = $('toast'); t.textContent = text; t.classList.add('show'); toastTimer = 2.2; }
const DOT = ['#888', '#2f6fe0', '#e03131', '#111', '#f08c00'];
const NAMES = ['', 'Blue', 'Red', 'Black', 'Ski route'];
let hudT = 0;
const miniCtx = $('minimap').getContext('2d');
function updateHud(dt) {
  if (toastTimer > 0 && (toastTimer -= dt) <= 0) $('toast').classList.remove('show');
  hudT -= dt;
  if (hudT > 0) return;
  hudT = 0.1;
  $('speed').firstElementChild.textContent = Math.round(player.speed * 3.6);
  $('alt').textContent = `${Math.round(player.pos.y)} m`;
  let where = '', prompt = '';
  if (player.ride) {
    const L = player.ride.lift;
    const left = Math.max(0, (L.up.length - player.ride.s) / L.speed);
    where = `🚡 ${L.name}`;
    prompt = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} to the top · hold Space to fast-forward`;
  } else {
    const P = pistes.at(player.pos);
    if (P) where = `<span class="dot" style="background:${DOT[P.d]}"></span>${P.ref ? P.ref + ' ' : ''}${P.name || NAMES[P.d]}`;
    else where = 'Off-piste';
    const L = lifts.nearestBottom(player.pos);
    if (L) prompt = touchDevice ? `Tap E to ride ${L.name}` : `Press E to ride ${L.name}`;
  }
  $('where').innerHTML = where;
  $('prompt').textContent = prompt;
  const sz = $('minimap').width;
  rmap.drawMini(miniCtx, player.pos, player.yaw, sz);
}

// ---------------------------------------------------------------- sound
const audio = { ctx: null, on: false };
function initAudio() {
  const ctx = new AudioContext();
  const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 4 + (Math.random() * 2 - 1) * 0.15; }
  const make = (type, freq, q) => {
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f).connect(g).connect(ctx.destination); src.start();
    return { f, g };
  };
  audio.wind = make('lowpass', 400, 0.7);
  audio.hiss = make('bandpass', 1800, 0.8);
  audio.ctx = ctx; audio.on = true;
  $('sound').textContent = '🔊';
}
$('sound').addEventListener('click', () => {
  if (!audio.ctx) initAudio();
  else { audio.on = !audio.on; audio.on ? audio.ctx.resume() : audio.ctx.suspend(); $('sound').textContent = audio.on ? '🔊' : '🔇'; }
});
function updateAudio() {
  if (!audio.on) return;
  const t = audio.ctx.currentTime, v = player.speed;
  const onSnow = !player.air && !player.ride;
  audio.wind.g.gain.setTargetAtTime(clamp(v / 30, 0, 1) * 0.35 + 0.03, t, 0.2);
  audio.wind.f.frequency.setTargetAtTime(250 + v * 25, t, 0.2);
  const carve = onSnow ? clamp(v / 15, 0, 1) * (player.input.brake ? 0.5 : 0.18) + Math.abs(player.lean) * 0.25 * clamp(v / 10, 0, 1) : 0;
  audio.hiss.g.gain.setTargetAtTime(carve, t, 0.08);
  audio.hiss.f.frequency.setTargetAtTime(player.input.brake ? 900 : 1600 + v * 30, t, 0.1);
}

// ---------------------------------------------------------------- camera
const camState = { mode: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), yaw: 0, snap: true };
function updateCamera(dt) {
  const p = player.pos;
  const vel = player.vel;
  const moveYaw = vel.lengthSq() > 4 ? Math.atan2(vel.x, vel.z) : player.yaw;
  let target = player.ride ? player.yaw : moveYaw;
  let dy = target - camState.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  camState.yaw += dy * (camState.snap ? 1 : 1 - Math.exp(-3 * dt));
  const f = new THREE.Vector3(Math.sin(camState.yaw), 0, Math.cos(camState.yaw));
  const want = new THREE.Vector3(), look = new THREE.Vector3();
  if (camState.mode === 2 && !(player.ride && player.ride.lift.gondola)) {
    want.copy(p).addScaledVector(f, 0.3); want.y += 1.65 - 0.4 * player.crouch;
    look.copy(want).addScaledVector(new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw)), 10); look.y -= 2.2;
    camState.pos.copy(want); camState.look.copy(look);
  } else {
    const aerial = player.ride && !player.ride.lift.surface;
    const far = camState.mode === 1 || aerial;
    const back = aerial ? 11 : far ? 16 : 5.5, up = aerial ? 2.5 : far ? 6 : 2.1;
    want.copy(p).addScaledVector(f, -back);
    if (player.ride) want.addScaledVector(new THREE.Vector3(-f.z, 0, f.x), aerial ? -6 : -2.5);
    want.y = Math.max(aerial ? p.y : Math.max(p.y, ground.height(want.x, want.z)), ground.height(want.x, want.z) + 1) + up;
    look.copy(p).addScaledVector(f, far ? 6 : 4); look.y = p.y + (far ? 0 : 0.6);
    const k = camState.snap ? 1 : 1 - Math.exp(-8 * dt);
    camState.pos.lerp(want, k); camState.look.lerp(look, k);
    const floor = ground.height(camState.pos.x, camState.pos.z) + 0.8;
    if (camState.pos.y < floor) camState.pos.y = floor;
  }
  camState.snap = false;
  camera.position.copy(camState.pos);
  camera.lookAt(camState.look);
  const fovTarget = 60 + clamp(player.speed - 12, 0, 25) * 0.5;
  camera.fov = lerp(camera.fov, fovTarget, 1 - Math.exp(-2 * dt));
  camera.updateProjectionMatrix();
  sky.position.copy(camera.position);
  sun.position.copy(p).addScaledVector(SUN_DIR, 300);
  sun.target.position.copy(p);
}

// ---------------------------------------------------------------- loop
let last = performance.now(), streamT = 0, fpsAcc = 0, fpsN = 0, autoLow = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (!started) { renderer.render(scene, camera); return; }
  readInput();
  if (!mapOpen && !helpOpen) {
    const sub = Math.ceil(dt / (1 / 120));
    for (let s = 0; s < sub; s++) player.step(dt / sub, lifts);
  }
  for (const ev of player.events.splice(0)) {
    if (ev.type === 'bump') toast(ev.text);
    else if (ev.type === 'top') { toast(`Top of ${ev.lift.name}`); lastTop = ev.lift; }
    else if (ev.type === 'land' && ev.t > 1.0) toast(`${ev.t.toFixed(1)} s air!`);
  }
  player.pose(dt);
  lifts.showMine(player.ride && player.ride.lift, player.ride ? player.ride.s : 0);
  lifts.update(dt, camera.position);
  crowd.update(dt, player.pos);
  updateCamera(dt);
  streamT -= dt;
  if (streamT <= 0) { streamT = 0.25; terrain.update(camera.position, 5); forest.update(camera.position, terrain, 4); }
  updateHud(dt);
  updateAudio();
  renderer.render(scene, camera);
  // drop to low graphics automatically if the first seconds are slow
  if (!autoLow) {
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 6) {
      autoLow = true;
      if (fpsN / fpsAcc < 28 && quality.high) { quality.high = false; applyQuality(); toast('Graphics: low (press G for high)'); }
    }
  }
}

$('go').addEventListener('click', () => {
  $('start').classList.add('hidden');
  $('hud').classList.remove('hidden');
  if (touchDevice) bindTouch();
  started = true;
  last = performance.now();
  try { initAudio(); } catch { /* sound stays off */ }
});

resize();
requestAnimationFrame(frame);
load().catch((e) => { console.error(e); $('loadtext').textContent = `Could not load: ${e.message}`; });
window.__game = () => ({ player, lifts, terrain, forest, ground, camState, renderer, toggleMap, spawnAtLift });
