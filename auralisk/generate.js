#!/usr/bin/env node
/* Auralisk - a procedural pixel-art sky-serpent for your GitHub profile.
 *
 *  - Resets every January 1st (it only counts contributions from Jan 1 of this year)
 *  - Grows on a logarithmic scale as your contributions increase
 *  - Colors come from your top 3 programming languages
 *
 * Usage:
 *   GITHUB_TOKEN=xxx node generate.js --user yourname --out auralisk.svg
 *   node generate.js --contributions 500 --langs "TypeScript:#3178c6,Python:#3572A5,Go:#00ADD8"   (offline demo)
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- CLI / env
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const USER = opt('user', process.env.GH_USER || '');
const OUT = opt('out', 'auralisk.svg');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const YEAR = new Date().getUTCFullYear();

// ---------------------------------------------------------------- seeded RNG
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- colors
const hex2rgb = (h) => {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgb2hex = (a) => '#' + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const A = hex2rgb(a), B = hex2rgb(b); return rgb2hex(A.map((v, i) => v + (B[i] - v) * t)); };
const lighten = (c, t) => mix(c, '#ffffff', t);
const darken = (c, t) => mix(c, '#000000', t);
function toHsl(hex) {
  const [r, g, b] = hex2rgb(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function fromHsl([h, s, l]) {
  const f = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) { r = g = b = l; } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
  }
  return rgb2hex([r * 255, g * 255, b * 255]);
}
const tune = (hex, lmin, lmax, smin) => {
  const [h, s, l] = toHsl(hex);
  return fromHsl([h, Math.max(s, smin), Math.min(lmax, Math.max(lmin, l))]);
};

const FALLBACK = ['#4f8cff', '#ffb454', '#7cf0c9'];
function buildPalette(langs) {
  const cols = [0, 1, 2].map((i) => (langs[i] && langs[i].color) || FALLBACK[i]);
  const body = tune(cols[0], 0.32, 0.55, 0.45);
  const accent = tune(cols[1], 0.5, 0.68, 0.55);
  const glow = tune(cols[2], 0.55, 0.75, 0.6);
  return { body, accent, glow, belly: mix(lighten(body, 0.7), '#fff4e0', 0.4) };
}

// ---------------------------------------------------------------- growth model
const STAGES = [
  { name: 'Hatchling', min: 0 },
  { name: 'Whelp', min: 20 },
  { name: 'Drake', min: 100 },
  { name: 'Wyrm', min: 350 },
  { name: 'Elder Wyrm', min: 900 },
  { name: 'Celestial', min: 2000 },
];
const stageOf = (c) => { let s = 0; STAGES.forEach((st, i) => { if (c >= st.min) s = i; }); return s; };
// logarithmic: early contributions grow the creature fast, later ones more slowly
const growthOf = (c) => Math.min(1, Math.log(1 + c) / Math.log(1 + 3000));

// ---------------------------------------------------------------- GitHub data
async function fetchStats(user) {
  if (!TOKEN) throw new Error('No GITHUB_TOKEN found. Set it, or use --contributions and --langs for a demo.');
  if (!user) throw new Error('No user given. Use --user yourname or set GH_USER.');
  const query = `query($login:String!,$from:DateTime!){
    user(login:$login){
      contributionsCollection(from:$from){ contributionCalendar{ totalContributions } }
      repositories(first:100, ownerAffiliations:OWNER, isFork:false, orderBy:{field:PUSHED_AT, direction:DESC}){
        nodes{ languages(first:8, orderBy:{field:SIZE, direction:DESC}){ edges{ size node{ name color } } } }
      }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'auralisk' },
    body: JSON.stringify({ query, variables: { login: user, from: `${YEAR}-01-01T00:00:00Z` } }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('GitHub API error: ' + JSON.stringify(json.errors));
  const u = json.data.user;
  const map = new Map();
  for (const repo of u.repositories.nodes) {
    for (const e of repo.languages.edges) {
      const cur = map.get(e.node.name) || { name: e.node.name, color: e.node.color, size: 0 };
      cur.size += e.size;
      map.set(e.node.name, cur);
    }
  }
  const langs = [...map.values()].sort((a, b) => b.size - a.size).slice(0, 3);
  return { contributions: u.contributionsCollection.contributionCalendar.totalContributions, langs };
}
function parseLangs(s) {
  return s.split(',').map((p) => { const [name, color] = p.split(':'); return { name: name.trim(), color: (color || '').trim() || null }; });
}

// ---------------------------------------------------------------- pixel canvas
const GW = 96, GH = 56, PX = 8;
function makeCanvas() {
  const cv = { g: Array.from({ length: GH }, () => Array(GW).fill(null)) };
  const inb = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH;
  cv.set = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (inb(x, y)) cv.g[y][x] = c; };
  cv.get = (x, y) => { x = Math.round(x); y = Math.round(y); return inb(x, y) ? cv.g[y][x] : null; };
  return cv;
}

function drawCreature(cv, P, st, g) {
  const { set } = cv;
  const line = (x0, y0, x1, y1, c) => {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 1.5) + 1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      set(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, typeof c === 'function' ? c(t) : c);
    }
  };
  const polyFill = (pts, c) => {
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    pts.forEach(([x, y]) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); });
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      for (let x = Math.floor(minX); x <= Math.ceil(maxX); x++) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) set(x, y, typeof c === 'function' ? c(x, y) : c);
      }
    }
  };

  // ---- geometry
  const L = 20 + 50 * g;
  const headX = Math.round(44 + L / 2), headY = 33;
  const amp = 3 + 6 * g, waves = 1.2 + 0.5 * g, phase = 0.5;
  const rMax = 2.3 + 5.2 * g;
  const radius = (t) => Math.max(0.9, rMax * Math.pow(1 - t, 0.75) * (0.78 + 0.22 * Math.min(1, t * 7)) + 0.5);
  const N = Math.ceil(L * 2);
  const spine = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    spine.push({ t, x: headX - t * L, y: headY + amp * Math.sin(t * waves * Math.PI * 2 + phase) - (1 - t) * 2.5, r: radius(t) });
  }
  const at = (t) => spine[Math.min(N, Math.round(t * N))];
  const hx = spine[0].x, hy = spine[0].y;
  const hr = 0.85 * rMax + 0.9;
  const sn = Math.round(2 + hr * 0.9);

  const lo = darken(P.body, 0.35), hi = mix(P.body, '#ffffff', 0.28);
  const blob = (cx, cy, r, seg) => {
    const R = Math.ceil(r) + 1;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const px = Math.round(cx + dx), py = Math.round(cy + dy);
        const d = (py - cy) / Math.max(r, 1);
        let c;
        if (d > 0.32) c = Math.floor(seg) % 2 === 0 ? P.belly : mix(P.belly, lo, 0.22);
        else if (d > 0.12) c = lo;
        else if (d < -0.5) c = hi;
        else c = P.body;
        if (c === P.body && (px + py * 2) % 7 === 0) c = mix(P.body, P.accent, 0.4);
        set(px, py, c);
      }
    }
  };

  // ---- halo (stage 5+)
  if (st >= 5) {
    const R = hr + 8 + 2 * g;
    for (let a = 0; a < 360; a += 2) {
      if (Math.floor(a / 12) % 2) continue;
      const rad = (a * Math.PI) / 180;
      set(hx - 1 + Math.cos(rad) * R, hy - 1 + Math.sin(rad) * R * 0.9, mix(P.glow, '#ffffff', 0.4));
    }
  }

  // ---- wings (stage 3+)
  const wing = (sx, sy, span, far) => {
    const fingers = st >= 5 ? 5 : 4;
    const tips = [];
    for (let j = 0; j < fingers; j++) {
      const th = ((72 + j * (98 / (fingers - 1))) * Math.PI) / 180;
      const len = span * [0.85, 1, 0.92, 0.76, 0.6][j];
      tips.push([sx + Math.cos(th) * len, sy - Math.sin(th) * len]);
    }
    const dark = far ? 0.45 : 0.08;
    for (let j = 0; j < fingers - 1; j++) {
      const a = tips[j], b = tips[j + 1];
      const mx = ((a[0] + b[0]) / 2) * 0.78 + sx * 0.22, my = ((a[1] + b[1]) / 2) * 0.78 + sy * 0.22;
      polyFill([[sx, sy], a, [mx, my], b], (x, y) => {
        const d = Math.min(1, Math.hypot(x - sx, y - sy) / span);
        const base = j % 2 ? P.glow : mix(P.glow, '#ffffff', 0.28);
        return darken(mix(base, '#ffffff', 0.35 * (1 - d)), dark);
      });
    }
    tips.forEach((t) => line(sx, sy, t[0], t[1], darken(P.body, far ? 0.5 : 0.25)));
  };
  if (st >= 3) {
    const s1 = at(0.23), s2 = at(0.3);
    const span = 8 + 19 * g;
    wing(s2.x - 3, s2.y - s2.r * 0.4, span * 0.8, true);
    wing(s1.x, s1.y - s1.r * 0.4, span, false);
  }

  // ---- body (tail -> head so the head side overlaps)
  for (let i = N; i >= 0; i--) blob(spine[i].x, spine[i].y, spine[i].r, spine[i].x / 1.5);

  // ---- tail fin
  const tail = spine[N], fl = 4 + 9 * g;
  for (let a = -0.6; a <= 0.6; a += 0.06) {
    const ang = Math.PI + a, len = fl * 1.2 * (1 - 0.75 * Math.abs(a) / 0.6) + 2;
    line(tail.x, tail.y, tail.x + Math.cos(ang) * len, tail.y + Math.sin(ang) * len, (t) => mix(P.accent, P.glow, t));
  }

  // ---- back spikes (stage 2+)
  if (st >= 2) {
    const step = Math.max(4, Math.round(7 - 3 * g));
    for (let i = 3; i < N - 4; i += step) {
      const p = spine[i];
      if (st >= 3 && p.t > 0.08 && p.t < 0.4) continue; // keep the wing area clear
      const h = Math.max(1, Math.round(p.r * 0.45 * (0.6 + 0.4 * Math.sin(i))));
      for (let k = 1; k <= h; k++) set(p.x - k * 0.5, p.y - p.r - k * 0.8 + 0.8, k === h ? mix(P.accent, '#ffffff', 0.5) : P.accent);
    }
  }

  // ---- head
  blob(hx, hy, hr, 2);
  for (let i = 1; i <= sn; i++) blob(hx + i, hy + 0.6 + i * 0.05, Math.max(1.2, hr * (0.85 - 0.6 * (i / sn))), 0);
  set(hx + sn, hy - 0.3, lo); // nostril

  // ---- horns (stage 3+)
  if (st >= 3) {
    const n = st >= 5 ? 3 : 2;
    for (let h = 0; h < n; h++) {
      const bx = hx - 1 - h * 2.6, by = hy - hr * 0.85 + h * 0.4;
      const len = 3 + 7 * g + (h === 0 ? 1 : 0);
      for (let k = 0; k <= len; k++) {
        const x = bx - k * 0.7, y = by - k * 0.9 + 0.012 * k * k;
        set(x, y + 1, darken(P.accent, 0.25));
        set(x + 1, y + 1, darken(P.accent, 0.25));
        set(x, y, mix(P.accent, '#ffffff', (k / len) * 0.6));
      }
    }
  }

  // ---- whiskers (stage 4+)
  if (st >= 4) {
    [0, 1].forEach((w) => {
      const sx = hx + sn - 0.5, sy = hy - hr * 0.2 + w * 1.4;
      const len = 8 + 5 * g;
      for (let k = 0; k < len; k++) {
        const x = sx + k * 0.75, y = sy - 1 - k * 0.2 + Math.sin(k * 0.5 + w * 2) * 1.8;
        set(x, y, mix(P.glow, '#ffffff', k / len * 0.5));
      }
    });
  }

  // ---- eye
  const ex = Math.round(hx + hr * 0.35), ey = Math.round(hy - hr * 0.3);
  set(ex, ey, '#ffffff'); set(ex + 1, ey, P.glow);
  set(ex, ey + 1, P.glow); set(ex + 1, ey + 1, darken(P.glow, 0.55));
  if (st === 1) set(ex - 1, ey + 3, lighten(P.accent, 0.2)); // blush on the hatchling

  // ---- orb (stage 6)
  if (st >= 6) {
    const ox = Math.min(GW - 6, hx + sn + 6), oy = hy - hr - 7;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > 3.4) continue;
      set(ox + dx, oy + dy, d < 1.3 ? '#ffffff' : d < 2.4 ? lighten(P.glow, 0.5) : P.glow);
    }
  }

  return { hx, hy };
}

function outline(grid, color) {
  const out = grid.map((r) => r.slice());
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    if (grid[y][x]) continue;
    if ((y > 0 && grid[y - 1][x]) || (y < GH - 1 && grid[y + 1][x]) || (x > 0 && grid[y][x - 1]) || (x < GW - 1 && grid[y][x + 1])) out[y][x] = color;
  }
  return out;
}
function nearFilled(grid, x, y, r) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const yy = y + dy, xx = x + dx;
    if (yy >= 0 && yy < GH && xx >= 0 && xx < GW && grid[yy][xx]) return true;
  }
  return false;
}

// ---------------------------------------------------------------- SVG
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toSvg({ grid, P, st, contributions, langs, rng }) {
  const W = GW * PX, H = GH * PX, LABEL = 84, TOTAL = H + LABEL;
  const stage = STAGES[st - 1];

  // creature rows, run-length merged
  let rects = '';
  for (let y = 0; y < GH; y++) {
    let x = 0;
    while (x < GW) {
      const c = grid[y][x];
      if (!c) { x++; continue; }
      let x2 = x + 1;
      while (x2 < GW && grid[y][x2] === c) x2++;
      rects += `<rect x="${x * PX}" y="${y * PX}" width="${(x2 - x) * PX}" height="${PX}" fill="${c}"/>`;
      x = x2;
    }
  }

  // sky: faint dots + twinkling sparkles (only where the creature is not)
  let dots = '', sparkles = '';
  for (let i = 0; i < 70; i++) {
    const x = Math.floor(rng() * GW), y = Math.floor(rng() * GH), r = rng();
    if (nearFilled(grid, x, y, 1)) continue;
    dots += `<rect x="${x * PX}" y="${y * PX}" width="${PX / 2}" height="${PX / 2}" fill="#ffffff" opacity="${(0.15 + r * 0.35).toFixed(2)}"/>`;
  }
  const want = 5 + st * 4;
  let made = 0;
  for (let tries = 0; tries < 400 && made < want; tries++) {
    const x = 2 + Math.floor(rng() * (GW - 4)), y = 2 + Math.floor(rng() * (GH - 4));
    if (nearFilled(grid, x, y, 3)) continue;
    const col = [P.glow, P.accent, '#ffffff'][Math.floor(rng() * 3)];
    const big = rng() < 0.5;
    const px = x * PX, py = y * PX;
    let shape = `<rect x="${px}" y="${py}" width="${PX}" height="${PX}" fill="${col}"/>`;
    if (big) shape += `<rect x="${px - PX}" y="${py}" width="${PX}" height="${PX}" fill="${col}"/><rect x="${px + PX}" y="${py}" width="${PX}" height="${PX}" fill="${col}"/><rect x="${px}" y="${py - PX}" width="${PX}" height="${PX}" fill="${col}"/><rect x="${px}" y="${py + PX}" width="${PX}" height="${PX}" fill="${col}"/>`;
    sparkles += `<g>${shape}<animate attributeName="opacity" values="1;0.2;1" dur="${(2 + rng() * 2).toFixed(1)}s" begin="-${(rng() * 3).toFixed(1)}s" repeatCount="indefinite"/></g>`;
    made++;
  }

  // label area
  const next = STAGES[st];
  let frac = 1;
  if (next) frac = (Math.log(1 + contributions) - Math.log(1 + stage.min)) / (Math.log(1 + next.min) - Math.log(1 + stage.min));
  frac = Math.max(0.03, Math.min(1, frac));
  const barW = 260;
  const ty = H + 30;
  const langRows = langs.slice(0, 3).map((l, i) => {
    const c = l.color || FALLBACK[i];
    const y = H + 16 + i * 22;
    return `<rect x="${W - 250}" y="${y}" width="14" height="14" fill="${c}"/><text x="${W - 226}" y="${y + 12}" fill="#e8ebff" font-size="15">${esc(l.name)}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${TOTAL}" viewBox="0 0 ${W} ${TOTAL}" shape-rendering="crispEdges" font-family="'Courier New', Courier, monospace" font-weight="bold">
<title>Auralisk, stage ${st}: ${esc(stage.name)} - ${contributions} contributions in ${YEAR}</title>
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#090c22"/><stop offset="1" stop-color="#1e1245"/></linearGradient>
  <radialGradient id="aura" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${P.glow}" stop-opacity="0.30"/><stop offset="1" stop-color="${P.glow}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${W}" height="${TOTAL}" rx="14" fill="url(#sky)"/>
<ellipse cx="${W / 2}" cy="${H * 0.52}" rx="${W * 0.42}" ry="${H * 0.42}" fill="url(#aura)" shape-rendering="auto"/>
${dots}
${sparkles}
<g>
  <animateTransform attributeName="transform" type="translate" values="0 0;0 -${PX};0 0" keyTimes="0;0.5;1" calcMode="discrete" dur="3.2s" repeatCount="indefinite"/>
  ${rects}
</g>
<rect x="0" y="${H}" width="${W}" height="2" fill="${P.accent}" opacity="0.35"/>
<text x="24" y="${ty}" fill="${lighten(P.glow, 0.3)}" font-size="20">STAGE ${st}: ${esc(stage.name.toUpperCase())}</text>
<text x="24" y="${ty + 24}" fill="#ffffff" font-size="15">CONTRIBUTIONS ${YEAR}: ${contributions}</text>
<rect x="24" y="${ty + 34}" width="${barW}" height="10" fill="#2a2459"/>
<rect x="24" y="${ty + 34}" width="${Math.round(barW * frac)}" height="10" fill="${P.accent}"/>
<text x="${24 + barW + 12}" y="${ty + 44}" fill="#9aa0d4" font-size="12">${next ? 'NEXT: ' + esc(next.name.toUpperCase()) + ' @ ' + next.min : 'MAX STAGE'}</text>
${langRows}
</svg>
`;
}

// ---------------------------------------------------------------- main
async function main() {
  let stats;
  if (opt('contributions')) {
    stats = { contributions: parseInt(opt('contributions'), 10), langs: opt('langs') ? parseLangs(opt('langs')) : [] };
  } else {
    stats = await fetchStats(USER);
  }
  const { contributions, langs } = stats;
  const st = stageOf(contributions) + 1;
  const g = growthOf(contributions);
  const P = buildPalette(langs);
  const rng = mulberry32(hashStr(`${USER || 'demo'}-${YEAR}`));

  const cv = makeCanvas();
  drawCreature(cv, P, st, g);
  const grid = outline(cv.g, '#0b0d1a');

  const svg = toSvg({ grid, P, st, contributions, langs, rng });
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, svg);
  console.log(`Wrote ${OUT}: stage ${st} (${STAGES[st - 1].name}), ${contributions} contributions, growth ${g.toFixed(2)}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
