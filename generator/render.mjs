// Renders the profile artwork from my own commit history.
// Zero dependencies — needs Node 20+ and a GitHub token in GH_TOKEN.
//
//   GH_TOKEN=... node generator/render.mjs [outDir]
//
// With a token that can read my private repos, the artwork covers all of my
// work. Only aggregated numbers end up in the SVGs: no code, no commit
// messages, and no private repo names beyond the labels configured below.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOGIN = "XyzElias";
const TZ = "Europe/Zurich";
const OUT = process.argv[2] || "dist";
const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.RENDER_CACHE; // local iteration: reuse fetched data

// Projects shown as cards. `repo` drives the activity line on each card.
const PROJECTS = [
  { name: "Velro", repo: "Velro", url: "velro.ch", lang: "TypeScript",
    text: ["AI back office for Swiss SMEs: answers email,", "writes quotes, sends QR invoices."] },
  { name: "Prismatic", repo: "prismatic-claude-statusline", url: "open source", lang: "JavaScript",
    text: ["Gradient status line for Claude Code with a", "live config editor. One file, zero deps."] },
  { name: "StartIQ", repo: "startiq", url: "startiq.app", lang: "PHP",
    text: ["Browser start page with weather, Pomodoro,", "notes and Google Calendar built in."] },
  { name: "QR Create", repo: "swift-qr-designer", url: "qrcreate.app", lang: "TypeScript",
    text: ["QR codes with gradients, logos and custom", "shapes, in German and English."] },
];

// Public labels for the "where the year went" streams. First match wins.
const GROUPS = [
  ["Velro", (r) => r === "Velro"],
  ["School", (r) => r.startsWith("modul-")],
  ["Portfolio", (r) => r === "website"],
  ["Prismatic", (r) => r === "prismatic-claude-statusline"],
  ["Side projects", () => true],
];

// Launches, oldest first, for the trail.
const MILESTONES = [
  ["2024-09-01", "Ablaufdatum Manager"],
  ["2025-01-01", "QR Create"],
  ["2025-06-01", "StartIQ"],
  ["2026-04-07", "Portfolio v4"],
  ["2026-06-10", "Prismatic"],
  ["2026-09-25", "Velro"],
];

const STACK = [
  ["every day", ["TypeScript", "React", "Next.js", "Tailwind", "Node.js", "PostgreSQL", "Prisma"]],
  ["also", ["PHP", "MySQL", "Python", "Docker", "tRPC", "Figma"]],
  ["AI", ["Claude", "OpenAI", "prompt engineering", "agents", "MCP"]],
];

// ── palette ──────────────────────────────────────────────────────────────
const THEMES = {
  dark: {
    bg: "#0d1117", ink: "#f0f6fc", soft: "#c9d1d9", mute: "#7d8590", line: "#30363d",
    ember: "#f97316", rose: "#ec4899", violet: "#a855f7", glow: 0.13,
  },
  light: {
    bg: "#ffffff", ink: "#1f2328", soft: "#424a53", mute: "#6e7781", line: "#d0d7de",
    ember: "#ea580c", rose: "#db2777", violet: "#9333ea", glow: 0.08,
  },
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));
// t in [0,1] across ember → rose → violet
const ramp = (T, t) => (t < 0.5 ? mix(T.ember, T.rose, t * 2) : mix(T.rose, T.violet, (t - 0.5) * 2));

// ── fonts ────────────────────────────────────────────────────────────────
const font = (file) => readFileSync(join(HERE, "fonts", file)).toString("base64");
const FONTS = { serif: font("serif.woff2"), italic: font("serif-italic.woff2"), mono: font("mono.woff2") };
const fontFace = (which) => which.map((w) => {
  const style = w === "italic" ? "italic" : "normal";
  const family = w === "mono" ? "M" : "S";
  return `@font-face{font-family:${family};font-style:${style};src:url(data:font/woff2;base64,${FONTS[w]}) format("woff2")}`;
}).join("");
const SERIF = `S,Georgia,serif`;
const MONO = `M,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;
const BASE_CSS = `.s{font-family:${SERIF}}.i{font-family:${SERIF};font-style:italic}.m{font-family:${MONO}}`;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const pad2 = (n) => String(n).padStart(2, "0");

// ── GitHub data ──────────────────────────────────────────────────────────
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": LOGIN },
  });
  if (res.status === 409 || res.status === 404) return null; // empty or hidden repo
  if (res.status === 202) return { pending: true };          // stats still being computed
  if (res.status === 403 && path.includes("/commits"))
    throw new Error(`403 on ${path}. The token can see this repo but not its commits: give it "Contents: Read-only" on all repositories.`);
  if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
  return res.json();
}
async function paged(path, max = 20) {
  const all = [];
  for (let page = 1; page <= max; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}
// Weekly lines added/removed by me. GitHub computes these lazily (202).
async function churnOf(fullName) {
  for (let i = 0; i < 8; i++) {
    const stats = await gh(`/repos/${fullName}/stats/contributors`);
    if (Array.isArray(stats)) return stats.find((s) => s.author && s.author.login === LOGIN)?.weeks || [];
    if (!stats) return [];
    await sleep(3000);
  }
  return [];
}

async function collect(since) {
  // /user/repos includes private repos when the token belongs to me.
  let repos = await gh("/user").then((u) => u && u.login === LOGIN).catch(() => false)
    ? await paged("/user/repos?affiliation=owner")
    : await paged(`/users/${LOGIN}/repos?type=owner`);
  repos = repos.filter((r) => !r.fork && !r.archived && r.name !== LOGIN);

  const commits = [];
  const languages = {};
  const stars = {};
  const churn = {}; // week start (unix s) → { a, d }
  for (const r of repos) {
    stars[r.name] = r.stargazers_count;
    const langs = (await gh(`/repos/${r.full_name}/languages`)) || {};
    for (const [key, v] of Object.entries(langs)) languages[key] = (languages[key] || 0) + v;
    if (new Date(r.pushed_at) < since) continue;
    const list = await paged(`/repos/${r.full_name}/commits?author=${LOGIN}&since=${since.toISOString()}`);
    for (const c of list) commits.push({ repo: r.name, private: r.private, date: c.commit.author.date });
    for (const w of await churnOf(r.full_name)) {
      if (w.w * 1000 < since.getTime() - 7 * 864e5 || (!w.a && !w.d)) continue;
      churn[w.w] ||= { a: 0, d: 0 };
      churn[w.w].a += w.a; churn[w.w].d += w.d;
    }
  }
  return { commits, languages, stars, churn, repoCount: repos.length };
}

// ── time helpers (everything in Basel time) ──────────────────────────────
const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
}).formatToParts(d).map((p) => [p.type, p.value]));
const dayKey = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const fmtDate = (d) => { const p = parts(d); return `${+p.day} ${MONTHS[+p.month - 1]} ${p.year}`; };
// 0..51, the last index being the current week
const weekIndex = (now, d) => 51 - Math.floor((now - d) / (7 * 864e5));

function analyse(data, now) {
  const p = parts(now);
  const y = +p.year, m = +p.month - 1;
  // Twelve whole months, the current one last.
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    months.push({ y: d.getUTCFullYear(), m: d.getUTCMonth(), days: new Array(daysIn(d.getUTCFullYear(), d.getUTCMonth())).fill(0) });
  }
  const perDay = {};
  const weekdays = {};
  const perRepoWeek = {};
  const groupWeeks = Object.fromEntries(GROUPS.map(([g]) => [g, new Array(52).fill(0)]));
  for (const c of data.commits) {
    const d = new Date(c.date);
    const q = parts(d);
    const mo = months.find((x) => x.y === +q.year && x.m === +q.month - 1);
    if (!mo) continue;
    const key = `${q.year}-${q.month}-${q.day}`;
    mo.days[+q.day - 1]++;
    perDay[key] = (perDay[key] || 0) + 1;
    weekdays[q.weekday] = (weekdays[q.weekday] || 0) + 1;
    const w = weekIndex(now, d);
    if (w >= 0) {
      (perRepoWeek[c.repo] ||= new Array(52).fill(0))[w]++;
      groupWeeks[GROUPS.find(([, test]) => test(c.repo))[0]][w]++;
    }
  }

  // Streaks over the window, day by day in Basel time.
  const start = new Date(Date.UTC(months[0].y, months[0].m, 1, 12));
  let longest = 0, run = 0, current = 0;
  const today = dayKey(now);
  for (let t = start; dayKey(t) <= today; t = new Date(t.getTime() + 864e5)) {
    run = perDay[dayKey(t)] ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // Current streak may start today or yesterday (today isn't over yet).
  for (let t = new Date(now), first = true; ; t = new Date(t.getTime() - 864e5), first = false) {
    if (perDay[dayKey(t)]) current++;
    else if (!first) break;
  }

  // Last 60 days, oldest first.
  const recent = [];
  for (let i = 59; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 864e5);
    recent.push({ date: t, n: perDay[dayKey(t)] || 0 });
  }

  const churn = { a: new Array(52).fill(0), d: new Array(52).fill(0) };
  for (const [w, v] of Object.entries(data.churn || {})) {
    const i = weekIndex(now, new Date(+w * 1000 + 3.5 * 864e5));
    if (i >= 0 && i < 52) { churn.a[i] += v.a; churn.d[i] += v.d; }
  }

  const last = data.commits.map((c) => c.date).sort().pop();
  return {
    months, weekdays, perRepoWeek, groupWeeks, recent, churn,
    total: Object.values(perDay).reduce((a, b) => a + b, 0),
    activeDays: Object.keys(perDay).length,
    longest, current,
    lastCommit: data.commits.find((c) => c.date === last),
  };
}

// ── drawing helpers ──────────────────────────────────────────────────────
// Gaussian smoothing so single-day spikes become hills rather than needles.
function smooth(values, sigma = 1.3) {
  const r = Math.ceil(sigma * 3);
  return values.map((_, i) => {
    let s = 0, w = 0;
    for (let j = -r; j <= r; j++) {
      const v = values[i + j] ?? 0;
      const g = Math.exp(-(j * j) / (2 * sigma * sigma));
      s += v * g; w += g;
    }
    return s / w;
  });
}
const f1 = (n) => n.toFixed(1);
// Catmull-Rom through points → cubic Béziers (segments only, no initial M).
function segments(pts) {
  let d = "";
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)},${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)},${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])},${f1(p2[1])}`;
  }
  return d;
}
const curve = (pts) => `M${f1(pts[0][0])},${f1(pts[0][1])}` + segments(pts);

const svg = (w, h, body, fonts, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><style>${fontFace(fonts)}${BASE_CSS}${body.css || ""}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>${body.svg}</svg>`;

// Shared frame: hairline gradient border and a soft glow from one corner.
function panel(T, W, H, glow = { x: 0, y: 0, c: "rose" }) {
  return `<defs><linearGradient id="pb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${T.violet}" stop-opacity=".6"/><stop offset=".45" stop-color="${T.line}"/><stop offset=".55" stop-color="${T.line}"/><stop offset="1" stop-color="${T.ember}" stop-opacity=".6"/></linearGradient>` +
    `<radialGradient id="pg" cx="${glow.x}" cy="${glow.y}" r=".75"><stop offset="0" stop-color="${T[glow.c]}" stop-opacity="${T.glow}"/><stop offset="1" stop-color="${T[glow.c]}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="18" fill="${T.bg}"/>` +
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="18" fill="url(#pg)"/>` +
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="18" fill="none" stroke="url(#pb)"/>`;
}
const head = (T, x, title, sub, size = 30) =>
  `<text x="${x}" y="58" class="s" font-size="${size}" fill="${T.ink}">${esc(title)}</text>` +
  (sub ? `<text x="${x}" y="84" class="m" font-size="11.5" fill="${T.soft}">${esc(sub)}</text>` : "");

// ── hero: one ridge per month, oldest at the back ────────────────────────
function hero(T, A) {
  const W = 860, H = 470;
  const left = 30, right = W - 30;
  const front = 418, back = 236, amp = 92;
  const peak = Math.max(1, ...A.months.flatMap((mo) => smooth(mo.days)));
  const step = (front - back) / (A.months.length - 1);

  let defs = "", ridges = "";
  A.months.forEach((mo, i) => {
    const base = back + i * step;
    const depth = i / (A.months.length - 1); // 0 = far, 1 = near
    const color = ramp(T, 1 - depth);       // far ridges cool violet, near ridges ember
    // pad with quiet days so every ridge starts and ends flat
    const vals = [0, 0, 0, ...smooth(mo.days), 0, 0, 0];
    const pts = vals.map((v, j) => [left + ((right - left) * j) / (vals.length - 1), base - Math.sqrt(v / peak) * amp]);
    const line = curve(pts);
    defs += `<linearGradient id="g${i}" x1="0" y1="${base - amp}" x2="0" y2="${base}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${color}" stop-opacity=".30"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient>`;
    ridges += `<g class="r" style="animation-delay:${(i * 0.07).toFixed(2)}s">` +
      `<path d="${line}L${right},${H}L${left},${H}Z" fill="${T.bg}"/>` +
      `<path d="${line}L${right},${base}L${left},${base}Z" fill="url(#g${i})"/>` +
      `<path d="${line}" fill="none" stroke="${color}" stroke-width="${(1.1 + depth * 0.9).toFixed(2)}" stroke-linejoin="round"/>` +
      `<text x="${left - 4}" y="${base + 3.5}" text-anchor="end" class="m" font-size="8.5" fill="${T.mute}">${MONTHS[mo.m]}</text>` +
      `</g>`;
  });

  const sunX = 690, sunY = 236;
  const last = A.lastCommit;
  const lastText = last
    ? `last commit ${fmtDate(new Date(last.date))}${last.private ? "" : ` in ${last.repo}`}`
    : "no commits yet this year";

  return svg(W, H, {
    css: `.r{animation:rise 1.1s cubic-bezier(.2,.7,.2,1) both}@keyframes rise{from{transform:translateY(26px);opacity:0}}` +
      `.sun{animation:set 2.4s cubic-bezier(.2,.7,.2,1) both}@keyframes set{from{transform:translateY(-38px);opacity:0}}` +
      `.pulse{animation:p 2.4s ease-in-out infinite}@keyframes p{50%{opacity:.25}}`,
    svg: `<defs>${defs}<radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${T.ember}"/><stop offset=".55" stop-color="${mix(T.ember, T.rose, 0.6)}"/><stop offset="1" stop-color="${T.rose}" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="${T.bg}"/>` +
      `<g class="sun"><circle cx="${sunX}" cy="${sunY}" r="120" fill="url(#sun)" opacity=".22"/><circle cx="${sunX}" cy="${sunY}" r="54" fill="${T.ember}" opacity=".9"/></g>` +
      `<text x="30" y="96" class="s" font-size="78" fill="${T.ink}" letter-spacing="-1">Elias Felder</text>` +
      `<text x="32" y="134" class="i" font-size="23" fill="${T.soft}">builds web apps in Basel, sweats the pixels,</text>` +
      `<text x="32" y="162" class="i" font-size="23" fill="${T.soft}">and spends a lot of time talking to LLMs.</text>` +
      `<text x="${W - 30}" y="44" text-anchor="end" class="m" font-size="11" fill="${T.mute}">47.56° N  7.59° E</text>` +
      ridges +
      `<circle cx="34" cy="451" r="3.2" fill="${T.ember}" class="pulse"/>` +
      `<text x="44" y="455" class="m" font-size="10.5" fill="${T.soft}">${esc(lastText)}</text>` +
      `<text x="${W - 30}" y="455" text-anchor="end" class="m" font-size="10.5" fill="${T.mute}">each ridge is one month of my commits, newest in front</text>`,
  }, ["serif", "italic", "mono"], `Elias Felder. Ridgeline of ${A.total} commits over the last twelve months.`);
}

// ── rhythm: when I code + what I code in ─────────────────────────────────
function rhythm(T, A, langs, now) {
  const W = 860, H = 400;
  const cx = 200, cy = 200, r0 = 56, r1 = 160;
  const weeks = A.groupWeeks[GROUPS[0][0]].map((_, w) => GROUPS.reduce((s, [g]) => s + A.groupWeeks[g][w], 0));
  const max = Math.max(1, ...weeks);
  const ang = (w) => ((w / 52) * 360 - 90) * (Math.PI / 180);
  const P = (rad, a) => `${f1(cx + rad * Math.cos(a))},${f1(cy + rad * Math.sin(a))}`;
  let bars = "";
  weeks.forEach((n, w) => {
    const a0 = ang(w) + 0.012, a1 = ang(w + 1) - 0.012;
    if (!n) { bars += `<circle cx="${P(r0 + 9, (a0 + a1) / 2).split(",")[0]}" cy="${P(r0 + 9, (a0 + a1) / 2).split(",")[1]}" r="1.1" fill="${T.line}"/>`; return; }
    const r = r0 + 4 + Math.sqrt(n / max) * (r1 - r0 - 4);
    // older weeks violet, recent weeks ember, like the ridges up top
    bars += `<path class="b" style="animation-delay:${(0.2 + w * 0.012).toFixed(3)}s" d="M${P(r0 + 4, a0)}L${P(r, a0)}A${r},${r} 0 0 1 ${P(r, a1)}L${P(r0 + 4, a1)}A${r0 + 4},${r0 + 4} 0 0 0 ${P(r0 + 4, a0)}Z" fill="${ramp(T, 1 - w / 51)}"/>`;
  });
  // month labels every quarter, placed where that month starts
  let ticks = "";
  const p = parts(now);
  for (let i = 11; i >= 0; i -= 3) {
    const d = new Date(Date.UTC(+p.year, +p.month - 1 - i, 1));
    const w = Math.max(0, weekIndex(now, d));
    const a = ang(w);
    ticks += `<text x="${f1(cx + (r1 + 16) * Math.cos(a))}" y="${f1(cy + (r1 + 16) * Math.sin(a) + 3.5)}" text-anchor="middle" class="m" font-size="9.5" fill="${T.mute}">${MONTHS[d.getUTCMonth()]}</text>`;
  }

  const best = weeks.indexOf(max);
  const bestStart = new Date(now.getTime() - (51 - best) * 7 * 864e5);
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const names = { Mon: "Mondays", Tue: "Tuesdays", Wed: "Wednesdays", Thu: "Thursdays", Fri: "Fridays", Sat: "Saturdays", Sun: "Sundays" };
  const peakDay = order.reduce((a, b) => ((A.weekdays[b] || 0) > (A.weekdays[a] || 0) ? b : a), "Mon");
  // Headline from the trend: last quarter against the nine months before.
  const recentRate = weeks.slice(39).reduce((a, b) => a + b, 0) / 13;
  const earlierRate = weeks.slice(0, 39).reduce((a, b) => a + b, 0) / 39;
  const verdict = recentRate > earlierRate * 1.5 ? "Picking up speed." : recentRate < earlierRate / 1.5 ? "Taking it a bit slower lately." : "Steady as it goes.";
  const activeWeeks = weeks.filter(Boolean).length;
  const bp = parts(bestStart);

  const X = 396;
  const stat = (x, n, label) =>
    `<text x="${x}" y="214" class="s" font-size="44" fill="${T.ink}">${n}</text><text x="${x + 1}" y="234" class="m" font-size="10.5" fill="${T.mute}">${label}</text>`;

  // languages: one bar, colours stepped through the palette
  const totalBytes = Object.values(langs).reduce((a, b) => a + b, 0) || 1;
  const sorted = Object.entries(langs).sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, 5);
  const rest = sorted.slice(5).reduce((a, [, v]) => a + v, 0);
  if (rest) shown.push(["Other", rest]);
  const barW = W - 36 - X;
  let bx = X, bar = "", legend = "", lx = X;
  shown.forEach(([name, bytes], i) => {
    const w = (bytes / totalBytes) * barW;
    const col = name === "Other" ? T.line : ramp(T, i / Math.max(1, shown.length - 2));
    bar += `<rect x="${f1(bx)}" y="294" width="${f1(Math.max(0, w - 2))}" height="8" rx="2" fill="${col}"/>`;
    bx += w;
    const pct = Math.round((bytes / totalBytes) * 100);
    const label = `${name} ${pct < 1 ? "<1" : pct}%`;
    legend += `<circle cx="${lx + 4}" cy="324" r="3.5" fill="${col}"/><text x="${lx + 12}" y="327.5" class="m" font-size="10" fill="${T.soft}">${esc(label)}</text>`;
    lx += 18 + label.length * 6;
  });

  return svg(W, H, {
    css: `.b{transform-origin:${cx}px ${cy}px;animation:grow .9s cubic-bezier(.2,.7,.2,1) both}@keyframes grow{from{transform:scale(.35);opacity:0}}`,
    svg: panel(T, W, H, { x: 0.1, y: 0.5, c: "violet" }) +
      `<circle cx="${cx}" cy="${cy}" r="${r1}" fill="none" stroke="${T.line}" stroke-dasharray="1 5"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r0}" fill="none" stroke="${T.line}"/>` +
      bars + ticks +
      `<text x="${cx}" y="${cy + 6}" text-anchor="middle" class="s" font-size="26" fill="${T.ink}">${max}</text>` +
      `<text x="${cx}" y="${cy + 21}" text-anchor="middle" class="m" font-size="8.5" fill="${T.mute}">best week</text>` +
      `<text x="${X}" y="68" class="s" font-size="34" fill="${T.ink}">${esc(verdict)}</text>` +
      `<text x="${X}" y="98" class="m" font-size="11.5" fill="${T.soft}">The ring is my year, one bar per week, clockwise.</text>` +
      `<text x="${X}" y="116" class="m" font-size="11.5" fill="${T.soft}">Best week: ${max} commits, starting ${+bp.day} ${MONTHS[+bp.month - 1]}. Busiest on ${names[peakDay]}.</text>` +
      `<text x="${X}" y="134" class="m" font-size="11.5" fill="${T.violet}">Committed something in ${activeWeeks} of the last 52 weeks.</text>` +
      `<line x1="${X}" y1="158" x2="${W - 36}" y2="158" stroke="${T.line}"/>` +
      stat(X, A.total, "commits, last 12 months") +
      stat(X + 168, A.activeDays, "days with commits") +
      stat(X + 310, A.longest, "day best streak") +
      `<line x1="${X}" y1="258" x2="${W - 36}" y2="258" stroke="${T.line}"/>` +
      `<text x="${X}" y="282" class="m" font-size="10.5" fill="${T.mute}">what my repos are written in, by size</text>` +
      bar + legend,
  }, ["serif", "mono"], `My year in commits: ${verdict} ${A.total} commits in twelve months, best week ${max}.`);
}

// ── where the year went: streamgraph of weekly commits per project ───────
function focus(T, A, now) {
  const W = 860, H = 380;
  const x0 = 36, x1 = W - 36, mid = 236, maxH = 180;
  const groups = GROUPS.map(([g]) => g).filter((g) => A.groupWeeks[g].some(Boolean));
  const series = groups.map((g) => smooth(A.groupWeeks[g], 1.1));
  const totals = series[0].map((_, w) => series.reduce((s, ser) => s + ser[w], 0));
  const peak = Math.max(1, ...totals);
  const scale = maxH / peak;
  const X = (w) => x0 + ((x1 - x0) * w) / 51;

  // Silhouette layout: streams stacked around the centre line.
  let paths = "", labels = "", lx = 36;
  const floor = totals.map((t) => mid - (t * scale) / 2);
  series.forEach((ser, gi) => {
    const top = ser.map((v, w) => [X(w), floor[w]]);
    const bottom = ser.map((v, w) => [X(w), floor[w] + v * scale]);
    const color = groups[gi] === "Side projects" ? mix(T.line, T.mute, 0.5) : ramp(T, gi / Math.max(1, groups.length - 2));
    paths += `<path class="st" style="animation-delay:${(gi * 0.12).toFixed(2)}s" d="${curve(top)}L${f1(bottom.at(-1)[0])},${f1(bottom.at(-1)[1])}${segments(bottom.slice().reverse())}Z" fill="${color}" fill-opacity=".88"/>`;
    const share = Math.round((A.groupWeeks[groups[gi]].reduce((a, b) => a + b, 0) / Math.max(1, A.total)) * 100);
    const label = `${groups[gi]} ${share}%`;
    labels += `<circle cx="${f1(lx + 5)}" cy="114" r="4" fill="${color}"/><text x="${f1(lx + 14)}" y="117.5" class="m" font-size="10.5" fill="${T.soft}">${esc(label)}</text>`;
    lx += 30 + label.length * 6.3;
    floor.forEach((_, w) => { floor[w] += ser[w] * scale; });
  });

  // month ticks along the bottom
  let axis = "";
  for (let i = 11; i >= 0; i--) {
    const p = parts(now);
    const d = new Date(Date.UTC(+p.year, +p.month - 1 - i, 1));
    const w = weekIndex(now, d);
    if (w < 1) continue;
    axis += `<text x="${f1(X(w))}" y="${H - 28}" text-anchor="middle" class="m" font-size="9.5" fill="${T.mute}">${MONTHS[d.getUTCMonth()]}</text>`;
  }

  const lead = groups[0] && A.groupWeeks[groups[0]].reduce((a, b) => a + b, 0);
  const sub = `Commits per week, by project. ${groups[0]} took ${Math.round((lead / Math.max(1, A.total)) * 100)}% of them. Everything else got what was left.`;
  return svg(W, H, {
    css: `.st{animation:fade 1.2s ease-out both}@keyframes fade{from{opacity:0}}`,
    svg: panel(T, W, H, { x: 1, y: 0, c: "ember" }) + head(T, 36, "Where the year went", sub) + paths + labels + axis,
  }, ["serif", "mono"], `Where the year went: ${sub}`);
}

// ── lines added and removed per week ─────────────────────────────────────
function lines(T, A) {
  const W = 420, H = 270;
  const x0 = 28, x1 = W - 28, mid = 172, up = 62, down = 50;
  const peak = Math.max(1, ...A.churn.a, ...A.churn.d);
  const bw = (x1 - x0) / 52;
  let bars = "";
  for (let i = 0; i < 52; i++) {
    const x = x0 + i * bw;
    const ha = Math.sqrt(A.churn.a[i] / peak) * up;
    const hd = Math.sqrt(A.churn.d[i] / peak) * up;
    if (ha) bars += `<rect x="${f1(x)}" y="${f1(mid - 2 - ha)}" width="${f1(bw - 2)}" height="${f1(ha)}" rx="1.5" fill="url(#ga)"/>`;
    if (hd) bars += `<rect x="${f1(x)}" y="${f1(mid + 2)}" width="${f1(bw - 2)}" height="${f1(Math.min(hd, down))}" rx="1.5" fill="${T.violet}" fill-opacity=".75"/>`;
  }
  const add = A.churn.a.reduce((a, b) => a + b, 0), del = A.churn.d.reduce((a, b) => a + b, 0);
  return svg(W, H, {
    svg: panel(T, W, H, { x: 0, y: 0, c: "ember" }) +
      `<defs><linearGradient id="ga" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${T.rose}"/><stop offset="1" stop-color="${T.ember}"/></linearGradient></defs>` +
      head(T, 28, "Lines of code", "added and deleted per week, last 12 months", 28) +
      `<text x="${x1}" y="58" text-anchor="end" class="s" font-size="28" fill="${T.ember}">+${k(add)}</text>` +
      `<text x="${x1}" y="84" text-anchor="end" class="m" font-size="11.5" fill="${T.violet}">−${k(del)}</text>` +
      bars +
      `<line x1="${x0}" y1="${mid}" x2="${x1}" y2="${mid}" stroke="${T.line}"/>` +
      `<text x="${x0}" y="${H - 22}" class="m" font-size="10" fill="${T.mute}">Deleting code counts too. Mostly.</text>`,
  }, ["serif", "mono"], `Lines of code: ${add} added and ${del} deleted in twelve months.`);
}

// ── the last 30 days, compared with the 30 before ────────────────────────
function recent(T, A) {
  const W = 420, H = 270;
  const x0 = 28, x1 = W - 28, base = 214, maxH = 96;
  const now30 = A.recent.slice(30), prev30 = A.recent.slice(0, 30);
  const sum = (a) => a.reduce((s, d) => s + d.n, 0);
  const cur = sum(now30), prev = sum(prev30);
  const peak = Math.max(1, ...now30.map((d) => d.n));
  const bw = (x1 - x0) / 30;
  let bars = "";
  now30.forEach((d, i) => {
    const h = d.n ? 4 + (d.n / peak) * maxH : 2;
    const today = i === 29;
    const col = d.n ? ramp(T, 1 - i / 29) : T.line;
    bars += `<rect class="d" style="animation-delay:${(i * 0.02).toFixed(2)}s" x="${f1(x0 + i * bw)}" y="${f1(base - h)}" width="${f1(bw - 3)}" height="${f1(h)}" rx="2" fill="${col}"${today ? ` stroke="${T.ink}" stroke-width="1"` : ""}/>`;
    if (d.n === peak && d.n > 0) bars += `<text x="${f1(x0 + i * bw + (bw - 3) / 2)}" y="${f1(base - h - 6)}" text-anchor="middle" class="m" font-size="9.5" fill="${T.soft}">${d.n}</text>`;
  });
  const delta = prev ? Math.round(((cur - prev) / prev) * 100) : 0;
  const trend = !prev ? "nothing to compare with yet" : delta >= 0 ? `up ${delta}% on the 30 days before` : `down ${-delta}% on the 30 days before`;
  const d0 = parts(now30[0].date), d1 = parts(now30[29].date);
  return svg(W, H, {
    css: `.d{transform-box:fill-box;transform-origin:bottom;animation:up .7s cubic-bezier(.2,.7,.2,1) both}@keyframes up{from{transform:scaleY(0)}}`,
    svg: panel(T, W, H, { x: 1, y: 0, c: "violet" }) +
      head(T, 28, "Last 30 days", trend, 28) +
      `<text x="${x1}" y="58" text-anchor="end" class="s" font-size="28" fill="${T.ink}">${cur}</text>` +
      `<text x="${x1}" y="84" text-anchor="end" class="m" font-size="11.5" fill="${T.mute}">commits</text>` +
      bars +
      `<text x="${x0}" y="${H - 22}" class="m" font-size="10" fill="${T.mute}">${+d0.day} ${MONTHS[+d0.month - 1]}</text>` +
      `<text x="${x1}" y="${H - 22}" text-anchor="end" class="m" font-size="10" fill="${T.mute}">today, ${+d1.day} ${MONTHS[+d1.month - 1]}</text>`,
  }, ["serif", "mono"], `Last 30 days: ${cur} commits, ${trend}.`);
}

// ── project card with its own activity line ──────────────────────────────
function card(T, P, A, stars, i) {
  const W = 420, H = 206;
  const weeks = A.perRepoWeek[P.repo] || new Array(52).fill(0);
  const sm = smooth(weeks, 1.1);
  const peak = Math.max(1, ...sm);
  const x0 = 24, x1 = W - 24, base = 166, amp = 26;
  const pts = sm.map((v, j) => [x0 + ((x1 - x0) * j) / 51, base - Math.sqrt(v / peak) * amp]);
  const line = curve(pts);
  const total = weeks.reduce((a, b) => a + b, 0);
  const starTxt = stars ? `  ★ ${stars}` : "";
  return svg(W, H, {
    svg: panel(T, W, H, { x: i % 2 ? 1 : 0, y: 1, c: i % 2 ? "violet" : "ember" }) +
      `<defs><linearGradient id="h" x1="0" x2="1"><stop offset="0" stop-color="${T.violet}"/><stop offset=".5" stop-color="${T.rose}"/><stop offset="1" stop-color="${T.ember}"/></linearGradient>` +
      `<linearGradient id="f" x1="0" y1="${base - amp}" x2="0" y2="${base}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${T.rose}" stop-opacity=".22"/><stop offset="1" stop-color="${T.rose}" stop-opacity="0"/></linearGradient></defs>` +
      `<text x="24" y="50" class="s" font-size="34" fill="${T.ink}">${esc(P.name)}</text>` +
      `<text x="${W - 24}" y="46" text-anchor="end" class="m" font-size="10.5" fill="${T.mute}">${esc(P.url)} ↗</text>` +
      `<text x="24" y="78" class="m" font-size="11.5" fill="${T.soft}">${esc(P.text[0])}</text>` +
      `<text x="24" y="95" class="m" font-size="11.5" fill="${T.soft}">${esc(P.text[1])}</text>` +
      `<path d="${line}L${x1},${base}L${x0},${base}Z" fill="url(#f)"/>` +
      `<path d="${line}" fill="none" stroke="url(#h)" stroke-width="1.6"/>` +
      `<line x1="${x0}" y1="${base}" x2="${x1}" y2="${base}" stroke="${T.line}"/>` +
      `<text x="24" y="188" class="m" font-size="10" fill="${T.mute}">${esc(P.lang + starTxt)}</text>` +
      `<text x="${W - 24}" y="188" text-anchor="end" class="m" font-size="10" fill="${T.mute}">${total ? `${total} commits in 12 months` : "quiet lately"}</text>`,
  }, ["serif", "italic", "mono"], `${P.name}: ${P.text.join(" ")}`);
}

// ── trail: launches as a path up the mountain ────────────────────────────
function trail(T, now) {
  const W = 860, H = 300;
  const t0 = new Date(MILESTONES[0][0]).getTime() - 75 * 864e5;
  const t1 = now.getTime() + 75 * 864e5;
  const x0 = 50, x1 = W - 70, yLow = 238, yHigh = 132;
  const pts = MILESTONES.map(([d], i) => [
    x0 + ((x1 - x0) * (new Date(d) - t0)) / (t1 - t0),
    yLow - ((yLow - yHigh) * i) / (MILESTONES.length - 1),
  ]);
  // switchbacks between stops
  let path = `M${f1(pts[0][0] - 30)},${yLow + 14}L${f1(pts[0][0])},${f1(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const mx = (ax + bx) / 2;
    path += `C${f1(mx)},${f1(ay + 10)} ${f1(mx)},${f1(by - 4)} ${f1(bx)},${f1(by)}`;
  }
  const [lx, ly] = pts.at(-1);
  // the mountain behind the trail
  const hill = `M${x0 - 20},${H - 34}C${f1(lx - 260)},${H - 50} ${f1(lx - 120)},${ly + 10} ${f1(lx + 10)},${ly - 40}C${f1(lx + 60)},${ly - 10} ${W - 40},${H - 70} ${W - 18},${H - 34}Z`;
  let stops = "";
  pts.forEach(([x, y], i) => {
    const [d, name] = MILESTONES[i];
    const last = i === pts.length - 1;
    const above = i % 2 === 1 || last;
    const p = new Date(d);
    const date = `${MONTHS[p.getUTCMonth()]} ${p.getUTCFullYear()}`;
    const anchor = i === 0 ? "start" : "middle";
    const tx = i === 0 ? x - 8 : x;
    const ny = above ? y - 34 : y + 30, dy = above ? y - 18 : y + 46;
    stops += `<g class="n" style="animation-delay:${(0.3 + i * 0.18).toFixed(2)}s">` +
      (last ? `<circle cx="${f1(x)}" cy="${f1(y)}" r="14" fill="${T.ember}" fill-opacity=".18"/>` : "") +
      `<circle cx="${f1(x)}" cy="${f1(y)}" r="${last ? 6 : 4.5}" fill="${last ? T.ember : T.bg}" stroke="${ramp(T, 1 - i / (pts.length - 1))}" stroke-width="2"/>` +
      `<text x="${f1(tx)}" y="${f1(ny)}" text-anchor="${anchor}" class="s" font-size="${last ? 22 : 17}" fill="${T.ink}">${esc(name)}</text>` +
      `<text x="${f1(tx)}" y="${f1(dy)}" text-anchor="${anchor}" class="m" font-size="9.5" fill="${T.mute}">${date}</text></g>`;
  });
  const nx = x1 + 34, ny = ly - 30;
  return svg(W, H, {
    css: `.tr{stroke-dasharray:2000;animation:draw 2.2s cubic-bezier(.4,0,.2,1) both}@keyframes draw{from{stroke-dashoffset:2000}}` +
      `.n{animation:pop .5s ease-out both}@keyframes pop{from{opacity:0}}`,
    svg: panel(T, W, H, { x: 1, y: 0, c: "ember" }) +
      `<defs><linearGradient id="tg" x1="0" x2="1"><stop offset="0" stop-color="${T.violet}"/><stop offset=".55" stop-color="${T.rose}"/><stop offset="1" stop-color="${T.ember}"/></linearGradient>` +
      `<linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${T.rose}" stop-opacity=".10"/><stop offset="1" stop-color="${T.rose}" stop-opacity="0"/></linearGradient></defs>` +
      head(T, 36, "What I've shipped", `${MILESTONES.length} launches in two years, each one a bit further up the mountain.`) +
      `<path d="${hill}" fill="url(#hg)"/>` +
      `<path class="tr" d="${path}" fill="none" stroke="url(#tg)" stroke-width="2" stroke-linecap="round"/>` +
      `<path d="M${f1(lx)},${f1(ly)}Q${f1(lx + 20)},${f1(ly - 4)} ${f1(nx)},${f1(ny)}" fill="none" stroke="${T.mute}" stroke-width="1.5" stroke-dasharray="2 5" stroke-linecap="round"/>` +
      stops +
      `<text x="${f1(nx)}" y="${f1(ny - 10)}" text-anchor="middle" class="i" font-size="17" fill="${T.mute}">next?</text>`,
  }, ["serif", "italic", "mono"], `What I've shipped: ${MILESTONES.map(([d, n]) => `${n} (${d.slice(0, 7)})`).join(", ")}.`);
}

// ── stack ────────────────────────────────────────────────────────────────
function stack(T) {
  const W = 860, H = 214;
  let rows = "";
  STACK.forEach(([label, items], r) => {
    const y = 112 + r * 38;
    rows += `<text x="36" y="${y + 5}" class="i" font-size="18" fill="${T.soft}">${esc(label)}</text>`;
    let x = 150;
    items.forEach((item, j) => {
      const w = item.length * 6.9 + 26;
      const col = ramp(T, j / Math.max(1, items.length - 1));
      rows += `<rect x="${f1(x)}" y="${y - 13}" width="${f1(w)}" height="26" rx="13" fill="${col}" fill-opacity=".08" stroke="${col}" stroke-opacity=".45"/>` +
        `<text x="${f1(x + w / 2)}" y="${y + 4}" text-anchor="middle" class="m" font-size="11.5" fill="${T.ink}">${esc(item)}</text>`;
      x += w + 8;
    });
  });
  return svg(W, H, {
    svg: panel(T, W, H, { x: 0, y: 1, c: "rose" }) + head(T, 36, "What I reach for", "") + rows,
  }, ["serif", "italic", "mono"], `Stack: ${STACK.map(([l, i]) => `${l}: ${i.join(", ")}`).join(". ")}.`);
}

// ── main ─────────────────────────────────────────────────────────────────
const now = new Date();
const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1) - 864e5);
let data;
if (CACHE && existsSync(CACHE)) data = JSON.parse(readFileSync(CACHE, "utf8"));
else {
  if (!TOKEN) throw new Error("Set GH_TOKEN");
  data = await collect(since);
  if (CACHE) writeFileSync(CACHE, JSON.stringify(data));
}
const A = analyse(data, now);
mkdirSync(OUT, { recursive: true });
// Transparent margin around each panel so the README gets even gaps between
// them. Half-width panels are 430 wide in total so they scale like the 860s.
const GAP = 10;
function frame(svgText, side) {
  const [, w, h] = svgText.match(/viewBox="0 0 (\d+) (\d+)"/).map(Number);
  const l = side === "right" ? GAP : 0, r = side === "left" ? GAP : 0;
  const W = w + l + r, H = h + 2 * GAP;
  return svgText
    .replace(/viewBox="[^"]*" width="\d+" height="\d+"/, `viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"`)
    .replace("</style>", `</style><g transform="translate(${l},${GAP})">`)
    .replace(/<\/svg>$/, "</g></svg>");
}
for (const [name, T] of Object.entries(THEMES)) {
  const out = (file, body, side) => writeFileSync(join(OUT, `${file}-${name}.svg`), file === "hero" ? body : frame(body, side));
  out("hero", hero(T, A));
  out("rhythm", rhythm(T, A, data.languages, now));
  out("focus", focus(T, A, now));
  out("lines", lines(T, A), "left");
  out("recent", recent(T, A), "right");
  out("trail", trail(T, now));
  out("stack", stack(T));
  PROJECTS.forEach((P, i) => out(`project-${i + 1}`, card(T, P, A, data.stars[P.repo], i), i % 2 ? "right" : "left"));
}
console.log(`${A.total} commits, ${A.activeDays} active days, ${data.repoCount} repos → ${OUT}/`);
