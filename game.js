'use strict';

/* ================= 画布与常量 ================= */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = 960, H = 640;

const FLOOR_Y = 556;          // 娃娃站立的地板高度
const WALL_L = 86, WALL_R = 874;
const RAIL_Y = 96;            // 爪子滑轨
const HOLE_X1 = 86, HOLE_X2 = 196;   // 左侧出口洞
const GRAV = 1500;

function resize() {
  const s = Math.min(innerWidth / W, innerHeight / H) * 0.98;
  canvas.style.width = (W * s) + 'px';
  canvas.style.height = (H * s) + 'px';
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

/* ================= 音效（WebAudio 合成） ================= */
let AC = null;
function audio() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
function tone(f0, f1, dur, type, vol, when) {
  const ac = audio(); if (!ac) return;
  const t = ac.currentTime + (when || 0);
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
  g.gain.setValueAtTime(vol || 0.1, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(ac.destination);
  o.start(t); o.stop(t + dur + 0.03);
}
function noiseBurst(dur, vol, fc) {
  const ac = audio(); if (!ac) return;
  const t = ac.currentTime;
  const len = Math.max(1, (dur * ac.sampleRate) | 0);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource(); src.buffer = buf;
  const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = fc || 800;
  const g = ac.createGain(); g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f); f.connect(g); g.connect(ac.destination);
  src.start(t);
}
const sfx = {
  tick()    { tone(660, 0, 0.05, 'square', 0.025); },
  drop()    { tone(190, 320, 0.3, 'sawtooth', 0.045); },
  grab()    { noiseBurst(0.1, 0.18, 1200); tone(150, 95, 0.14, 'square', 0.07); },
  open()    { tone(520, 760, 0.1, 'sine', 0.05); },
  slip()    { tone(380, 130, 0.42, 'sawtooth', 0.06); },
  thud()    { noiseBurst(0.07, 0.1, 320); },
  success() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0, 0.16, 'triangle', 0.11, i * 0.09)); },
};

/* ================= 娃娃定义 ================= */
// 每个娃娃是「身体 + 头」两个碰撞圆组成的复合刚体，外形不规则
const TYPES = [
  { id: 'bear',    ear: 'round', circles: [[0, 0, 27], [0, -32, 19]],  size: 27,
    pal: { main: '#c9a27e', dark: '#a37d58', belly: '#f0e2c8', inner: '#f0e2c8', cheek: '#d8926f' } },
  { id: 'bunny',   ear: 'long',  circles: [[0, 0, 23], [2, -28, 16]],  size: 23,
    pal: { main: '#f2ece4', dark: '#d5c9ba', belly: '#fffdf8', inner: '#e8b7b0', cheek: '#e3a89a' } },
  { id: 'cat',     ear: 'tri',   circles: [[0, 0, 25], [0, -30, 18]],  size: 25,
    pal: { main: '#dd9a62', dark: '#b97a46', belly: '#f6e3c6', inner: '#eec39f', cheek: '#d68a7a' } },
  { id: 'pig',     ear: 'round', circles: [[0, 0, 26], [0, -30, 18]],  size: 26,
    pal: { main: '#eab4ad', dark: '#cd8f88', belly: '#f8dcd4', inner: '#cd8f88', cheek: '#d68f8a' } },
  { id: 'frog',    ear: 'none',  circles: [[0, 0, 26], [0, -29, 17]],  size: 26,
    pal: { main: '#a3b881', dark: '#7f955f', belly: '#e9edd2', inner: '#e9edd2', cheek: '#cf9a8a' } },
  { id: 'penguin', ear: 'none',  circles: [[0, 0, 25], [0, -30, 16]],  size: 25,
    pal: { main: '#6b7a8d', dark: '#525f70', belly: '#f2f0e8', inner: '#f2f0e8', cheek: '#d59a92' } },
];

const dolls = [];

function makeDoll(type, x, y, angle) {
  const circles = type.circles.map(c => ({ ox: c[0], oy: c[1], r: c[2] }));
  let m = 0, I = 0;
  for (const c of circles) {
    const cm = c.r * c.r;
    m += cm;
    I += 0.5 * cm * c.r * c.r + cm * (c.ox * c.ox + c.oy * c.oy);
  }
  return {
    type, x, y, vx: 0, vy: 0, angle, va: 0,
    circles, wc: circles.map(c => ({ x, y, r: c.r })),
    m, invM: 1 / m, I, invI: 1 / I,
    r: type.size, lastThud: 0,
  };
}

function worldCircles(d) {
  const c = Math.cos(d.angle), s = Math.sin(d.angle);
  for (let i = 0; i < d.circles.length; i++) {
    const lc = d.circles[i], wc = d.wc[i];
    wc.x = d.x + lc.ox * c - lc.oy * s;
    wc.y = d.y + lc.ox * s + lc.oy * c;
  }
}

function spawnPile() {
  dolls.length = 0;
  for (let i = 0; i < 14; i++) {
    const type = TYPES[(Math.random() * TYPES.length) | 0];
    const x = 400 + Math.random() * 430;
    const y = 110 + (i % 4) * 46 + Math.random() * 20;
    dolls.push(makeDoll(type, x, y, (Math.random() - 0.5) * 1.6));
  }
}
spawnPile();

/* ================= 爪子 ================= */
const HOME_X = 600, CHUTE_X = (HOLE_X1 + HOLE_X2) / 2 + 10;
const L_MIN = 64, L_MAX = FLOOR_Y - RAIL_Y - 34;
const ARM_LEN = 46, ARM_OPEN = 0.85, ARM_CLOSED = 0.12;

const claw = {
  x: HOME_X, vx: 0, ax: 0,      // 滑车
  L: L_MIN,                      // 缆绳长度
  swing: 0, swingV: 0,           // 摆动偏移
  armA: ARM_OPEN,                // 爪臂张角
  grabA: ARM_CLOSED,             // 本次闭合的目标角（按夹到的娃娃自适应）
  state: 'idle', stateT: 0,
  hold: null,                    // { doll, grip, pins }
  hx: HOME_X, hy: RAIL_Y + L_MIN,
  tipVx: 0, tipVy: 0,            // 爪尖速度（供夹点弹簧阻尼）
};

function armTips() {
  const a = claw.armA, s = Math.sin(a), c = Math.cos(a);
  return {
    l: { x: claw.hx - 13 - ARM_LEN * s, y: claw.hy + 12 + ARM_LEN * c },
    r: { x: claw.hx + 13 + ARM_LEN * s, y: claw.hy + 12 + ARM_LEN * c },
  };
}

/* ================= 粒子 / 抖动 / 提示 ================= */
const particles = [];
let shake = 0, score = 0, attempts = 0;

const toastEl = document.getElementById('toast');
let toastTimer = 0;
function toast(msg, cls) {
  toastEl.textContent = msg;
  toastEl.className = 'show ' + (cls || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 1300);
}

function confetti(x, y) {
  const colors = ['#f2b950', '#c96f4a', '#a3b881', '#7a9db5', '#d99a8a', '#b89bd0'];
  for (let i = 0; i < 42; i++) {
    const a = Math.random() * Math.PI * 2, sp = 150 + Math.random() * 380;
    particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 260,
      life: 0.9 + Math.random() * 0.7, t: 0,
      size: 3 + Math.random() * 4, color: colors[(Math.random() * colors.length) | 0],
      rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 14,
    });
  }
}
function dust(x, y, n) {
  for (let i = 0; i < (n || 8); i++) {
    const a = Math.random() * Math.PI, sp = 30 + Math.random() * 110;
    particles.push({
      x: x + (Math.random() - 0.5) * 20, y,
      vx: Math.cos(a) * sp * (Math.random() < 0.5 ? -1 : 1), vy: -Math.sin(a) * sp * 0.5,
      life: 0.5 + Math.random() * 0.3, t: 0,
      size: 3 + Math.random() * 5, color: 'rgba(180,150,110,0.45)', rot: 0, vr: 0,
    });
  }
}

/* ================= 物理求解 ================= */
function resolvePair(a, ca, b, cb) {
  let dx = cb.x - ca.x, dy = cb.y - ca.y;
  const rr = ca.r + cb.r;
  let dist = Math.hypot(dx, dy);
  if (dist >= rr) return;
  if (dist < 0.001) { dx = 0.01; dy = -0.01; dist = 0.014; }
  const nx = dx / dist, ny = dy / dist, pen = rr - dist;
  // 接触点
  const px = ca.x + nx * (ca.r - pen * 0.5), py = ca.y + ny * (ca.r - pen * 0.5);
  const rax = px - a.x, ray = py - a.y, rbx = px - b.x, rby = py - b.y;
  // 相对速度（含旋转）
  const vax = a.vx - a.va * ray, vay = a.vy + a.va * rax;
  const vbx = b.vx - b.va * rby, vby = b.vy + b.va * rbx;
  const rvx = vbx - vax, rvy = vby - vay;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) {
    const raN = rax * ny - ray * nx, rbN = rbx * ny - rby * nx;
    const kn = a.invM + b.invM + a.invI * raN * raN + b.invI * rbN * rbN;
    const e = vn < -90 ? 0.22 : 0;
    const j = -(1 + e) * vn / kn;
    a.vx -= j * nx * a.invM; a.vy -= j * ny * a.invM; a.va -= a.invI * j * raN;
    b.vx += j * nx * b.invM; b.vy += j * ny * b.invM; b.va += b.invI * j * rbN;
    // 摩擦
    const tx = -ny, ty = nx;
    const vt = rvx * tx + rvy * ty;
    const raT = rax * ty - ray * tx, rbT = rbx * ty - rby * tx;
    const kt = a.invM + b.invM + a.invI * raT * raT + b.invI * rbT * rbT;
    let jt = -vt / kt;
    const mu = 0.85 * j;
    jt = Math.max(-mu, Math.min(mu, jt));
    a.vx -= jt * tx * a.invM; a.vy -= jt * ty * a.invM; a.va -= a.invI * jt * raT;
    b.vx += jt * tx * b.invM; b.vy += jt * ty * b.invM; b.va += b.invI * jt * rbT;
  }
  // 位置修正
  const corr = Math.max(pen - 0.5, 0) * 0.7 / (a.invM + b.invM);
  a.x -= nx * corr * a.invM; a.y -= ny * corr * a.invM;
  b.x += nx * corr * b.invM; b.y += ny * corr * b.invM;
}

// 与静态面碰撞，n 指向把娃娃推离表面的方向
function resolveStatic(d, c, nx, ny, pen) {
  const px = c.x - nx * c.r, py = c.y - ny * c.r;
  const rax = px - d.x, ray = py - d.y;
  const vcx = d.vx - d.va * ray, vcy = d.vy + d.va * rax;
  const vn = vcx * nx + vcy * ny;
  if (vn < 0) {
    const raN = rax * ny - ray * nx;
    const kn = d.invM + d.invI * raN * raN;
    const e = vn < -90 ? 0.2 : 0;
    const j = -(1 + e) * vn / kn;
    d.vx += j * nx * d.invM; d.vy += j * ny * d.invM; d.va += d.invI * j * raN;
    const tx = -ny, ty = nx;
    const vt = vcx * tx + vcy * ty;
    const raT = rax * ty - ray * tx;
    const kt = d.invM + d.invI * raT * raT;
    let jt = -vt / kt;
    const mu = 0.9 * j;
    jt = Math.max(-mu, Math.min(mu, jt));
    d.vx += jt * tx * d.invM; d.vy += jt * ty * d.invM; d.va += d.invI * jt * raT;
    return vn;
  }
  return 0;
}

function physics(dt) {
  const steps = 2, sdt = dt / steps;
  for (let s = 0; s < steps; s++) {
    // 积分
    for (const d of dolls) {
      d.vy += GRAV * sdt;
      // 被抓取的娃娃：双夹点捏取——弹簧力作用在爪尖与娃娃表面的接触点上，
      // 力不在质心，娃娃会自然歪斜、晃动、旋转
      if (claw.hold && claw.hold.doll === d) {
        const tips = armTips();
        const ca = Math.cos(d.angle), sa = Math.sin(d.angle);
        for (const pin of claw.hold.pins) {
          const tgt = tips[pin.side];
          const rx = pin.lx * ca - pin.ly * sa, ry = pin.lx * sa + pin.ly * ca;
          const px = d.x + rx, py = d.y + ry;
          // 接触点速度 = 质心速度 + ω×r，阻尼按“相对爪尖速度”计算，避免跟随时滞后
          const pvx = d.vx - d.va * ry - claw.tipVx;
          const pvy = d.vy + d.va * rx - claw.tipVy;
          // 弹簧+阻尼（加速度形式）
          let fx = (tgt.x - px) * 320 - pvx * 30;
          let fy = (tgt.y - 4 - py) * 320 - pvy * 30;
          const fm = Math.hypot(fx, fy);
          if (fm > 6000) { fx *= 6000 / fm; fy *= 6000 / fm; }
          d.vx += fx * sdt; d.vy += fy * sdt;
          d.va += d.invI * (rx * fy - ry * fx) * d.m * sdt;
        }
      }
      d.vx *= Math.exp(-0.25 * sdt);
      d.va *= Math.exp(-1.2 * sdt);
      const sp = Math.hypot(d.vx, d.vy);
      if (sp > 1400) { d.vx *= 1400 / sp; d.vy *= 1400 / sp; }
      d.x += d.vx * sdt; d.y += d.vy * sdt;
      d.angle += d.va * sdt;
      worldCircles(d);
    }
    // 碰撞迭代
    for (let it = 0; it < 2; it++) {
      for (let i = 0; i < dolls.length; i++) {
        const a = dolls[i];
        for (const ca of a.wc) {
          // 墙
          if (ca.x - ca.r < WALL_L) {
            const vn = resolveStatic(a, ca, 1, 0, WALL_L - (ca.x - ca.r));
            a.x += (WALL_L - (ca.x - ca.r)) * 0.7; worldCircles(a);
            if (vn < -420) landFx(a, ca.x, ca.y, vn);
          }
          if (ca.x + ca.r > WALL_R) {
            const vn = resolveStatic(a, ca, -1, 0, (ca.x + ca.r) - WALL_R);
            a.x -= ((ca.x + ca.r) - WALL_R) * 0.7; worldCircles(a);
            if (vn < -420) landFx(a, ca.x, ca.y, vn);
          }
          // 地板（出口洞没有地板）
          if (ca.x < HOLE_X1 + 4 || ca.x > HOLE_X2 - 4) {
            if (ca.y + ca.r > FLOOR_Y) {
              const vn = resolveStatic(a, ca, 0, -1, (ca.y + ca.r) - FLOOR_Y);
              a.y -= ((ca.y + ca.r) - FLOOR_Y) * 0.7; worldCircles(a);
              if (vn < -420) landFx(a, ca.x, FLOOR_Y, vn);
            }
          }
        }
        for (let j = i + 1; j < dolls.length; j++) {
          const b = dolls[j];
          if (Math.abs(a.x - b.x) > a.r + b.r + 30 || Math.abs(a.y - b.y) > a.r + b.r + 60) continue;
          for (const ca of a.wc) for (const cb of b.wc) resolvePair(a, ca, b, cb);
          worldCircles(a); worldCircles(b);
        }
      }
    }
    // 爪子下压时推开娃娃
    if (claw.state === 'drop' || (claw.state === 'grab' && claw.stateT < 0.3)) {
      const tips = armTips();
      const kcircles = [
        { x: claw.hx, y: claw.hy + 6, r: 15 },
        { x: tips.l.x, y: tips.l.y, r: 8 },
        { x: tips.r.x, y: tips.r.y, r: 8 },
      ];
      for (const d of dolls) {
        if (claw.hold && claw.hold.doll === d) continue;
        for (const kc of kcircles) {
          for (const c of d.wc) {
            const dx = c.x - kc.x, dy = c.y - kc.y;
            const rr = c.r + kc.r, dist = Math.hypot(dx, dy);
            if (dist < rr && dist > 0.01) {
              const pen = rr - dist, nx = dx / dist, ny = dy / dist;
              d.x += nx * pen * 0.5; d.y += ny * pen * 0.5;
              d.vx += nx * 25; d.vy += ny * 12;
              worldCircles(d);
            }
          }
        }
      }
    }
  }
  // 出口收集检测
  for (let i = dolls.length - 1; i >= 0; i--) {
    const d = dolls[i];
    if (d.x > HOLE_X1 - 10 && d.x < HOLE_X2 + 10 && d.y > FLOOR_Y + 34) {
      dolls.splice(i, 1);
      score++;
      shake = Math.max(shake, 7);
      confetti(d.x, FLOOR_Y + 30);
      sfx.success();
      toast('抓到啦！+1', 'good');
    }
  }
}

function landFx(d, x, y, vn) {
  const now = performance.now();
  if (now - d.lastThud < 200) return;
  d.lastThud = now;
  dust(x, y, 6);
  shake = Math.max(shake, Math.min(4, -vn / 300));
  sfx.thud();
}

/* ================= 抓取判定与滑脱 ================= */
function evaluateGrab() {
  const gx = claw.hx, gy = claw.hy + 46;
  let best = null, bq = 0.12;
  for (const d of dolls) {
    const dy = d.y - gy;
    if (dy < -50 || dy > 70) continue;
    const dist = Math.hypot(d.x - gx, dy * 0.8);
    // 对中程度
    let q = 1.05 - dist / 56;
    // 被压住的惩罚：上方有别的娃娃压着
    let buried = 0;
    for (const o of dolls) {
      if (o === d) continue;
      if (o.y < d.y - 6 && Math.abs(o.x - d.x) < (o.r + d.r) * 0.72) buried++;
    }
    q -= buried * 0.16;
    // 偏大娃娃更难夹
    q -= Math.max(0, d.r - 26) * 0.012;
    if (q > bq) { bq = q; best = d; }
  }
  if (best) {
    // 计算两个爪尖实际捏在娃娃表面的接触点（存局部坐标）
    const tips = armTips();
    const pins = [];
    const ca = Math.cos(-best.angle), sa = Math.sin(-best.angle);
    for (const side of ['l', 'r']) {
      const tip = tips[side];
      const dx = tip.x - best.x, dy = tip.y - best.y;
      const lx = dx * ca - dy * sa, ly = dx * sa + dy * ca;
      const onBody = best.circles.some(cc => Math.hypot(lx - cc.ox, ly - cc.oy) < cc.r + 14);
      if (onBody) pins.push({ lx, ly, side });
    }
    if (pins.length) {
      let grip = Math.min(1, Math.max(0.08, bq));
      if (pins.length === 1) grip *= 0.55;   // 单边捏住，明显不牢
      claw.hold = { doll: best, grip, pins };
    }
  }
}

function slip(msg) {
  const d = claw.hold.doll;
  claw.hold = null;
  d.vy += 40; d.vx += claw.swingV * 0.4 + (Math.random() - 0.5) * 60;
  d.va += (Math.random() - 0.5) * 5;
  dust(d.x, d.y - d.r, 6);
  sfx.slip();
  toast(msg || '哎呀，滑掉了…', 'bad');
}

/* ================= 输入 ================= */
const input = { left: false, right: false };
let moveSfxCool = 0;

addEventListener('keydown', e => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowDown', ' '].includes(e.key)) e.preventDefault();
  if (e.repeat) return;
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') input.left = true;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') input.right = true;
  if (e.key === ' ' || e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') tryDrop();
});
addEventListener('keyup', e => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') input.left = false;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') input.right = false;
});

function bindHold(id, key) {
  const el = document.getElementById(id);
  const on = e => { e.preventDefault(); input[key] = true; };
  const off = e => { e.preventDefault(); input[key] = false; };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointerleave', off);
  el.addEventListener('pointercancel', off);
}
bindHold('btnL', 'left');
bindHold('btnR', 'right');
document.getElementById('btnD').addEventListener('pointerdown', e => { e.preventDefault(); tryDrop(); });
document.getElementById('reset').addEventListener('click', () => {
  if (claw.state !== 'idle') return;
  spawnPile(); toast('重新摆放好了', 'bad');
});

function tryDrop() {
  if (claw.state !== 'idle') return;
  claw.state = 'drop'; claw.stateT = 0;
  attempts++;
  sfx.drop();
}

/* ================= 爪臂角度自适应 ================= */
// 扫描每个爪尖从张开到闭合的轨迹，找到刚接触目标娃娃表面的角度；
// 两臂取「贴住+轻微压进毛绒」的合拢角，夹不同大小/位置的娃娃角度都不同
function computeGripAngle() {
  const gx = claw.hx, gy = claw.hy + 46;
  let best = null, bd = 1e9;
  for (const d of dolls) {
    const dist = Math.hypot(d.x - gx, (d.y - gy) * 0.8);
    if (dist < bd) { bd = dist; best = d; }
  }
  if (!best || bd > 80) return ARM_CLOSED;
  let contactL = ARM_OPEN, contactR = ARM_OPEN;
  for (const s of [-1, 1]) {
    const pivX = claw.hx + s * 13, pivY = claw.hy + 12;
    for (let a = ARM_OPEN; a >= 0.04; a -= 0.015) {
      const tx = pivX + s * ARM_LEN * Math.sin(a);
      const ty = pivY + ARM_LEN * Math.cos(a);
      if (best.wc.some(c => Math.hypot(tx - c.x, ty - c.y) < c.r + 7)) {
        if (s < 0) contactL = a; else contactR = a;
        break;
      }
    }
  }
  const maxC = Math.max(contactL, contactR), minC = Math.min(contactL, contactR);
  // 贴合侧最多压进 0.2rad（≈9px 毛绒压缩），另一侧绝不悬空
  return Math.max(0.05, Math.min(Math.min(maxC - 0.2, minC), ARM_OPEN));
}

/* ================= 爪子状态机 ================= */
function updateClaw(dt) {
  claw.stateT += dt;
  const prevVx = claw.vx;

  // 爪臂张角动画
  let armTarget = ARM_OPEN;
  if (claw.state === 'grab' || claw.state === 'lift' || claw.state === 'carry') armTarget = claw.grabA;
  claw.armA += (armTarget - claw.armA) * Math.min(1, 10 * dt);

  // 水平移动
  if (claw.state === 'idle') {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const desired = dir * 280;
    claw.vx += (desired - claw.vx) * Math.min(1, 9 * dt);
    if (dir !== 0 && moveSfxCool <= 0) { sfx.tick(); moveSfxCool = 0.24; }
  } else if (claw.state === 'carry') {
    const desired = Math.max(-320, Math.min(320, (CHUTE_X - claw.x) * 3.2));
    claw.vx += (desired - claw.vx) * Math.min(1, 6 * dt);
  } else {
    claw.vx += (0 - claw.vx) * Math.min(1, 8 * dt);
  }
  moveSfxCool -= dt;
  claw.x += claw.vx * dt;
  claw.x = Math.max(130, Math.min(830, claw.x));
  claw.ax = (claw.vx - prevVx) / Math.max(dt, 0.001);

  // 摆动（单摆 + 惯性耦合）
  claw.swingV += (-claw.swing * 30 - claw.swingV * 3.4 - claw.ax * 0.055) * dt;
  claw.swing += claw.swingV * dt;
  claw.swing = Math.max(-26, Math.min(26, claw.swing));
  // 爪尖速度（供夹点弹簧阻尼）
  claw.tipVx = (claw.x + claw.swing - claw.hx) / Math.max(dt, 0.001);
  claw.tipVy = (RAIL_Y + claw.L + Math.abs(claw.swing) * 0.12 - claw.hy) / Math.max(dt, 0.001);
  claw.hx = claw.x + claw.swing;
  claw.hy = RAIL_Y + claw.L + Math.abs(claw.swing) * 0.12;

  // 状态转移
  switch (claw.state) {
    case 'drop': {
      claw.L += 330 * dt;
      // 碰到娃娃或到底就停
      let touch = claw.L >= L_MAX;
      if (!touch) {
        // 爪掌（hy+34）一碰到娃娃就停，避免把娃娃推开
        const px = claw.hx, py = claw.hy + 34;
        for (const d of dolls) {
          for (const c of d.wc) {
            if (Math.hypot(c.x - px, c.y - py) < c.r + 12) { touch = true; break; }
          }
          if (touch) break;
        }
      }
      if (touch) {
        claw.grabA = computeGripAngle();   // 按目标娃娃计算合拢角
        claw.state = 'grab'; claw.stateT = 0; sfx.grab();
      }
      break;
    }
    case 'grab': {
      if (claw.stateT > 0.55) {
        evaluateGrab();
        claw.state = 'lift'; claw.stateT = 0;
        // 起吊瞬间的“拔河”判定：夹得不牢直接脱出
        if (claw.hold && claw.hold.grip < 0.12 + Math.random() * 0.35) slip('没夹稳，脱钩了…');
        else if (!claw.hold) toast('什么也没夹到…', 'bad');
      }
      break;
    }
    case 'lift': {
      claw.L -= 230 * dt;
      slipCheck(dt, 1);
      if (claw.L <= L_MIN) {
        claw.L = L_MIN; claw.stateT = 0;
        // 抓到才去出口；抓空就收在上面原地待命
        claw.state = claw.hold ? 'carry' : 'idle';
      }
      break;
    }
    case 'carry': {
      slipCheck(dt, 1.6);
      // 途中掉光了就不再前往出口，直接交还操控权
      if (!claw.hold) { claw.state = 'idle'; claw.stateT = 0; break; }
      if (Math.abs(claw.x - CHUTE_X) < 5 && Math.abs(claw.vx) < 40) {
        claw.state = 'open'; claw.stateT = 0; sfx.open();
      }
      break;
    }
    case 'open': {
      if (claw.hold) {
        const d = claw.hold.doll;
        claw.hold = null;
        d.vx += claw.swingV * 0.5; d.va += (Math.random() - 0.5) * 3;
      }
      // 松爪后稍作停顿即交还操控权，不自动复位
      if (claw.stateT > 0.35) { claw.state = 'idle'; claw.stateT = 0; }
      break;
    }
    case 'return': {  // 兼容旧状态，直接结束
      claw.state = 'idle'; claw.stateT = 0;
      break;
    }
  }

  function slipCheck(dt, mul) {
    if (!claw.hold) return;
    const h = claw.hold, d = h.doll;
    // 物理性滑脱：夹点被拉离爪尖太远（被娃娃堆挂住、剧烈晃动）直接脱出
    const tips = armTips();
    const ca = Math.cos(d.angle), sa = Math.sin(d.angle);
    for (const pin of h.pins) {
      const px = d.x + pin.lx * ca - pin.ly * sa;
      const py = d.y + pin.lx * sa + pin.ly * ca;
      if (Math.hypot(tips[pin.side].x - px, tips[pin.side].y - 4 - py) > 36) {
        slip('被卡住拉脱了…');
        return;
      }
    }
    // 概率性滑脱：握力越差、移动越快越容易掉
    const g = h.grip;
    const rate = Math.pow(1 - g, 2) * 0.7 + (Math.abs(claw.vx) / 320) * 0.25 * (1 - g);
    if (Math.random() < rate * mul * dt) slip();
  }
}

/* ================= 绘制 ================= */
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawDoll(d) {
  const t = d.type, p = t.pal;
  const br = t.circles[0][2];
  const hxo = t.circles[1][0], hyo = t.circles[1][1], hr = t.circles[1][2];
  ctx.save();
  ctx.translate(d.x, d.y);
  ctx.rotate(d.angle);

  // 耳朵（头后面）
  ctx.fillStyle = p.main;
  if (t.ear === 'round') {
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.arc(hxo + s * hr * 0.62, hyo - hr * 0.66, hr * 0.36, 0, 6.29); ctx.fill();
      ctx.fillStyle = p.inner;
      ctx.beginPath(); ctx.arc(hxo + s * hr * 0.62, hyo - hr * 0.66, hr * 0.19, 0, 6.29); ctx.fill();
      ctx.fillStyle = p.main;
    }
  } else if (t.ear === 'long') {
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(hxo + s * hr * 0.34, hyo - hr * 0.8);
      ctx.rotate(s * 0.22);
      ctx.beginPath(); ctx.ellipse(0, -hr * 0.72, hr * 0.2, hr * 0.68, 0, 0, 6.29); ctx.fill();
      ctx.fillStyle = p.inner;
      ctx.beginPath(); ctx.ellipse(0, -hr * 0.66, hr * 0.1, hr * 0.44, 0, 0, 6.29); ctx.fill();
      ctx.restore();
      ctx.fillStyle = p.main;
    }
  } else if (t.ear === 'tri') {
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(hxo + s * hr * 0.85, hyo - hr * 0.25);
      ctx.lineTo(hxo + s * hr * 0.55, hyo - hr * 1.15);
      ctx.lineTo(hxo + s * hr * 0.1, hyo - hr * 0.7);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = p.inner;
      ctx.beginPath();
      ctx.moveTo(hxo + s * hr * 0.66, hyo - hr * 0.4);
      ctx.lineTo(hxo + s * hr * 0.52, hyo - hr * 0.92);
      ctx.lineTo(hxo + s * hr * 0.28, hyo - hr * 0.62);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = p.main;
    }
  }

  // 身体
  let g = ctx.createRadialGradient(-br * 0.35, -br * 0.45, br * 0.2, 0, 0, br * 1.15);
  g.addColorStop(0, p.main); g.addColorStop(1, p.dark);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, br, 0, 6.29); ctx.fill();

  // 肚皮
  ctx.fillStyle = p.belly;
  ctx.beginPath(); ctx.ellipse(0, br * 0.22, br * 0.55, br * 0.5, 0, 0, 6.29); ctx.fill();

  // 企鹅鳍 / 其他手
  ctx.fillStyle = p.dark;
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.translate(s * br * 0.92, br * 0.05);
    ctx.rotate(s * 0.5);
    ctx.beginPath(); ctx.ellipse(0, 0, br * 0.16, br * 0.4, 0, 0, 6.29); ctx.fill();
    ctx.restore();
  }

  // 头
  g = ctx.createRadialGradient(hxo - hr * 0.35, hyo - hr * 0.45, hr * 0.2, hxo, hyo, hr * 1.15);
  g.addColorStop(0, p.main); g.addColorStop(1, p.dark);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(hxo, hyo, hr, 0, 6.29); ctx.fill();

  // 脸部
  if (t.id === 'frog') {
    // 头顶眼泡
    for (const s of [-1, 1]) {
      ctx.fillStyle = p.main;
      ctx.beginPath(); ctx.arc(hxo + s * hr * 0.5, hyo - hr * 0.8, hr * 0.3, 0, 6.29); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(hxo + s * hr * 0.5, hyo - hr * 0.82, hr * 0.2, 0, 6.29); ctx.fill();
      ctx.fillStyle = '#4a3f33';
      ctx.beginPath(); ctx.arc(hxo + s * hr * 0.5, hyo - hr * 0.8, hr * 0.1, 0, 6.29); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(60,70,50,0.8)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(hxo, hyo - hr * 0.1, hr * 0.5, 0.35, Math.PI - 0.35); ctx.stroke();
  } else if (t.id === 'penguin') {
    ctx.fillStyle = p.belly;
    ctx.beginPath(); ctx.ellipse(hxo, hyo + hr * 0.05, hr * 0.62, hr * 0.55, 0, 0, 6.29); ctx.fill();
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#4a3f33';
      ctx.beginPath(); ctx.arc(hxo + s * hr * 0.32, hyo - hr * 0.12, hr * 0.11, 0, 6.29); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(hxo + s * hr * 0.32 + 1.5, hyo - hr * 0.16, hr * 0.04, 0, 6.29); ctx.fill();
    }
    ctx.fillStyle = '#f2a541';
    ctx.beginPath();
    ctx.moveTo(hxo - hr * 0.16, hyo + hr * 0.08);
    ctx.lineTo(hxo + hr * 0.16, hyo + hr * 0.08);
    ctx.lineTo(hxo, hyo + hr * 0.3);
    ctx.closePath(); ctx.fill();
  } else {
    // 通用脸：眼睛 + 鼻嘴 + 腮红
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#4a3f33';
      ctx.beginPath(); ctx.arc(hxo + s * hr * 0.36, hyo - hr * 0.1, hr * 0.11, 0, 6.29); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(hxo + s * hr * 0.36 + 1.5, hyo - hr * 0.14, hr * 0.04, 0, 6.29); ctx.fill();
      ctx.fillStyle = p.cheek; ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(hxo + s * hr * 0.62, hyo + hr * 0.22, hr * 0.14, 0, 6.29); ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (t.id === 'pig') {
      ctx.fillStyle = p.inner;
      ctx.beginPath(); ctx.ellipse(hxo, hyo + hr * 0.22, hr * 0.3, hr * 0.22, 0, 0, 6.29); ctx.fill();
      ctx.fillStyle = p.dark;
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.ellipse(hxo + s * hr * 0.11, hyo + hr * 0.22, hr * 0.05, hr * 0.08, 0, 0, 6.29); ctx.fill();
      }
    } else {
      ctx.fillStyle = p.dark;
      ctx.beginPath(); ctx.arc(hxo, hyo + hr * 0.16, hr * 0.1, 0, 6.29); ctx.fill();
      ctx.strokeStyle = p.dark; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(hxo - hr * 0.12, hyo + hr * 0.3, hr * 0.12, 0.2, Math.PI - 0.9); ctx.stroke();
      ctx.beginPath(); ctx.arc(hxo + hr * 0.12, hyo + hr * 0.3, hr * 0.12, 0.9, Math.PI - 0.2); ctx.stroke();
      if (t.id === 'cat') {
        ctx.strokeStyle = 'rgba(120,80,40,0.5)'; ctx.lineWidth = 1.2;
        for (const s of [-1, 1]) for (const o of [-0.08, 0.1]) {
          ctx.beginPath();
          ctx.moveTo(hxo + s * hr * 0.55, hyo + hr * (0.15 + o));
          ctx.lineTo(hxo + s * hr * 1.05, hyo + hr * (0.1 + o * 2));
          ctx.stroke();
        }
      }
    }
  }

  // 顶部柔光
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(hxo - hr * 0.15, hyo - hr * 0.15, hr * 0.6, Math.PI * 1.05, Math.PI * 1.5); ctx.stroke();

  ctx.restore();
}

function drawClaw() {
  const tips = armTips();
  // 缆绳
  ctx.strokeStyle = '#8a7a5a'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(claw.x, RAIL_Y + 4); ctx.lineTo(claw.hx, claw.hy - 4); ctx.stroke();

  // 爪臂（在头后面）：黄铜
  for (const s of ['l', 'r']) {
    const piv = { x: claw.hx + (s === 'l' ? -13 : 13), y: claw.hy + 12 };
    const tip = tips[s];
    ctx.strokeStyle = '#a8854a'; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(piv.x, piv.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
    ctx.strokeStyle = '#e0c88f'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(piv.x, piv.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
    // 爪尖弯钩
    const inw = s === 'l' ? 1 : -1;
    ctx.strokeStyle = '#a8854a'; ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.quadraticCurveTo(tip.x, tip.y + 10, tip.x + inw * 9, tip.y + 12);
    ctx.stroke();
  }

  // 爪头
  const g = ctx.createLinearGradient(claw.hx - 20, claw.hy - 12, claw.hx + 20, claw.hy + 16);
  g.addColorStop(0, '#efe0b8'); g.addColorStop(0.5, '#c9a86a'); g.addColorStop(1, '#9c7c46');
  ctx.fillStyle = g;
  roundRect(claw.hx - 21, claw.hy - 13, 42, 27, 9); ctx.fill();
  ctx.strokeStyle = 'rgba(90,65,35,0.55)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#6e5836';
  ctx.beginPath(); ctx.arc(claw.hx, claw.hy, 5, 0, 6.29); ctx.fill();
  ctx.fillStyle = '#c96f4a';
  ctx.beginPath(); ctx.arc(claw.hx, claw.hy - 7, 2.5, 0, 6.29); ctx.fill();

  // 滑车
  const cg = ctx.createLinearGradient(claw.x - 26, RAIL_Y - 14, claw.x + 26, RAIL_Y + 10);
  cg.addColorStop(0, '#f0e3c2'); cg.addColorStop(1, '#c3a875');
  ctx.fillStyle = cg;
  roundRect(claw.x - 26, RAIL_Y - 13, 52, 20, 6); ctx.fill();
  ctx.strokeStyle = 'rgba(90,65,35,0.55)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#6e5836';
  ctx.beginPath(); ctx.arc(claw.x - 15, RAIL_Y - 12, 4, 0, 6.29); ctx.fill();
  ctx.beginPath(); ctx.arc(claw.x + 15, RAIL_Y - 12, 4, 0, 6.29); ctx.fill();
}

function drawMachine(time) {
  // 机柜背板：奶油内衬
  let g = ctx.createLinearGradient(0, 80, 0, FLOOR_Y);
  g.addColorStop(0, '#faf4e4'); g.addColorStop(1, '#efe3c9');
  ctx.fillStyle = g;
  ctx.fillRect(WALL_L - 14, 84, WALL_R - WALL_L + 28, FLOOR_Y - 84);

  // 背景波点
  ctx.fillStyle = 'rgba(160,125,80,0.10)';
  for (let i = 0; i < 24; i++) {
    const sx = WALL_L + ((i * 173) % (WALL_R - WALL_L));
    const sy = 100 + ((i * 97) % (FLOOR_Y - 140));
    ctx.beginPath(); ctx.arc(sx, sy, 1.5 + (i % 3), 0, 6.29); ctx.fill();
  }

  // 出口洞（左下竖井）
  g = ctx.createLinearGradient(0, FLOOR_Y, 0, H);
  g.addColorStop(0, '#4a3a28'); g.addColorStop(1, '#2a2016');
  ctx.fillStyle = g;
  ctx.fillRect(HOLE_X1, FLOOR_Y, HOLE_X2 - HOLE_X1, H - FLOOR_Y);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(HOLE_X1, FLOOR_Y, HOLE_X2 - HOLE_X1, 3);

  // 地板：浅木
  g = ctx.createLinearGradient(0, FLOOR_Y, 0, FLOOR_Y + 18);
  g.addColorStop(0, '#d9b98c'); g.addColorStop(1, '#b8946a');
  ctx.fillStyle = g;
  ctx.fillRect(WALL_L - 14, FLOOR_Y, (HOLE_X1) - (WALL_L - 14), 16);
  ctx.fillRect(HOLE_X2, FLOOR_Y, WALL_R + 14 - HOLE_X2, 16);

  // 出口标识
  ctx.fillStyle = 'rgba(120,90,55,0.65)';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('出口 ▼', (HOLE_X1 + HOLE_X2) / 2, FLOOR_Y - 8);

  // 滑轨
  ctx.fillStyle = '#c9b48a';
  ctx.fillRect(WALL_L, RAIL_Y - 4, WALL_R - WALL_L, 6);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(WALL_L, RAIL_Y - 4, WALL_R - WALL_L, 2);

  // 娃娃阴影
  for (const d of dolls) {
    const h = Math.max(0, Math.min(1, (FLOOR_Y - d.y) / 380));
    ctx.fillStyle = `rgba(90,65,35,${0.18 * (1 - h * 0.8)})`;
    ctx.beginPath();
    ctx.ellipse(d.x, FLOOR_Y + 5, d.r * (1.1 - h * 0.35), 5 * (1 - h * 0.4), 0, 0, 6.29);
    ctx.fill();
  }
}

function drawFrame(time) {
  // 外框：原木
  ctx.strokeStyle = '#b08954';
  ctx.lineWidth = 20;
  roundRect(WALL_L - 24, 74, WALL_R - WALL_L + 48, FLOOR_Y - 74 + 26, 14);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,250,235,0.5)';
  ctx.lineWidth = 3;
  roundRect(WALL_L - 24 + 8, 74 + 8, WALL_R - WALL_L + 48 - 16, FLOOR_Y - 74 + 26 - 16, 10);
  ctx.stroke();

  // 顶部 marquee：奶白招牌
  const g = ctx.createLinearGradient(0, 10, 0, 66);
  g.addColorStop(0, '#fffaf0'); g.addColorStop(1, '#f3e7cd');
  ctx.fillStyle = g;
  roundRect(WALL_L - 24, 10, WALL_R - WALL_L + 48, 56, 14); ctx.fill();
  ctx.strokeStyle = '#b08954'; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = '#7a5a33';
  ctx.font = 'bold 26px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🧸 欢 乐 娃 娃 机', (WALL_L + WALL_R) / 2, 38);
  // 暖黄小灯泡
  for (let i = 0; i < 18; i++) {
    const lx = WALL_L - 6 + i * ((WALL_R - WALL_L + 12) / 17);
    const on = Math.sin(time * 3 + i * 1.1) > -0.3;
    ctx.fillStyle = on ? '#ffcf6e' : '#d8c39a';
    ctx.beginPath(); ctx.arc(lx, 66, 3, 0, 6.29); ctx.fill();
  }

  // 玻璃反光
  ctx.save();
  roundRect(WALL_L - 14, 84, WALL_R - WALL_L + 28, FLOOR_Y - 84, 4);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.beginPath();
  ctx.moveTo(180, 84); ctx.lineTo(420, 84); ctx.lineTo(240, FLOOR_Y); ctx.lineTo(60, FLOOR_Y);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.moveTo(520, 84); ctx.lineTo(600, 84); ctx.lineTo(430, FLOOR_Y); ctx.lineTo(370, FLOOR_Y);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  // 底部控制面板装饰：奶油 + 黄铜
  ctx.fillStyle = '#efe2c6';
  roundRect(240, FLOOR_Y + 26, 690, 62, 12); ctx.fill();
  ctx.strokeStyle = '#b08954'; ctx.lineWidth = 2; ctx.stroke();
  // 摇杆
  ctx.strokeStyle = '#a8854a'; ctx.lineWidth = 6; ctx.lineCap = 'round';
  const jx = 320 + claw.swing * 0.4;
  ctx.beginPath(); ctx.moveTo(320, FLOOR_Y + 72); ctx.lineTo(jx, FLOOR_Y + 44); ctx.stroke();
  ctx.fillStyle = '#c96f4a';
  ctx.beginPath(); ctx.arc(jx, FLOOR_Y + 42, 10, 0, 6.29); ctx.fill();
  // 按钮
  const pressed = claw.state !== 'idle';
  ctx.fillStyle = pressed ? '#a8563a' : '#c96f4a';
  ctx.beginPath(); ctx.arc(430, FLOOR_Y + 56, 16, 0, 6.29); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath(); ctx.arc(425, FLOOR_Y + 51, 5, 0, 6.29); ctx.fill();
}

function drawParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += dt;
    if (p.t >= p.life) { particles.splice(i, 1); continue; }
    p.vy += 900 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.rot += p.vr * dt;
    const a = 1 - p.t / p.life;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
    ctx.restore();
  }
}

/* ================= 主循环 ================= */
const statsEl = document.getElementById('stats');
let lastStats = '';
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min((now - last) / 1000, 1 / 30);
  last = now;

  updateClaw(dt);
  physics(dt);

  // 画面
  ctx.clearRect(0, 0, W, H);
  shake *= Math.exp(-5 * dt);
  ctx.save();
  if (shake > 0.2) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

  drawMachine(now / 1000);
  // 娃娃按 y 排序画，下面的先画
  const sorted = [...dolls].sort((a, b) => a.y - b.y);
  for (const d of sorted) drawDoll(d);
  drawClaw();
  drawFrame(now / 1000);
  drawParticles(dt);
  ctx.restore();

  // HUD
  const rate = attempts ? Math.round(score / attempts * 100) + '%' : '--';
  const txt = `得分 ${score} · 尝试 ${attempts} · 成功率 ${rate}`;
  if (txt !== lastStats) { statsEl.textContent = txt; lastStats = txt; }
}
requestAnimationFrame(frame);
