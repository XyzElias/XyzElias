// Renders the profile artwork from my own commit history.
// Zero dependencies — needs Node 20+ and a GitHub token in GH_TOKEN.
//
//   GH_TOKEN=... node generator/render.mjs [outDir]
//
// With a token that can read my private repos, the artwork covers all of my
// work. With the default Actions token it falls back to public repos only.
// Private repo names are never written into the output.

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

// ── palette ──────────────────────────────────────────────────────────────
const THEMES = {
  dark: {
    bg: "#0d1117", ink: "#f0f6fc", soft: "#c9d1d9", mute: "#7d8590", line: "#30363d",
    ember: "#f97316", rose: "#ec4899", violet: "#a855f7", sky0: "#0d1117",
  },
  light: {
    bg: "#ffffff", ink: "#1f2328", soft: "#424a53", mute: "#6e7781", line: "#d0d7de",
    ember: "#ea580c", rose: "#db2777", violet: "#9333ea", sky0: "#ffffff",
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

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── GitHub data ──────────────────────────────────────────────────────────
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": LOGIN },
  });
  if (res.status === 409 || res.status === 404) return null; // empty or hidden repo
  if (!res.ok) throw new Error(`${res.status} ${path}: ${await res.text()}`);
  return res.json();
}
async function paged(path, max = 20) {
  const all = [];
  for (let page = 1; page <= max; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
    if (!batch || !batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
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
  for (const r of repos) {
    stars[r.name] = r.stargazers_count;
    const langs = (await gh(`/repos/${r.full_name}/languages`)) || {};
    for (const [k, v] of Object.entries(langs)) languages[k] = (languages[k] || 0) + v;
    if (new Date(r.pushed_at) < since) continue;
    const list = await paged(`/repos/${r.full_name}/commits?author=${LOGIN}&since=${since.toISOString()}`);
    for (const c of list) commits.push({ repo: r.name, private: r.private, lang: r.language, date: c.commit.author.date });
  }
  return { commits, languages, stars, repoCount: repos.length };
}

// ── time helpers (everything in Basel time) ──────────────────────────────
const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
}).formatToParts(d).map((p) => [p.type, p.value]));
const dayKey = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

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
  const hours = new Array(24).fill(0);
  const weekdays = {};
  const perRepoDay = {};
  for (const c of data.commits) {
    const d = new Date(c.date);
    const q = parts(d);
    const key = `${q.year}-${q.month}-${q.day}`;
    const mo = months.find((x) => x.y === +q.year && x.m === +q.month - 1);
    if (!mo) continue;
    mo.days[+q.day - 1]++;
    perDay[key] = (perDay[key] || 0) + 1;
    hours[+q.hour]++;
    weekdays[q.weekday] = (weekdays[q.weekday] || 0) + 1;
    (perRepoDay[c.repo] ||= {})[key] = (perRepoDay[c.repo][key] || 0) + 1;
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

  const last = data.commits.map((c) => c.date).sort().pop();
  const lastCommit = data.commits.find((c) => c.date === last);
  return {
    months, hours, weekdays, perRepoDay,
    total: data.commits.length,
    activeDays: Object.keys(perDay).length,
    longest, current, lastCommit,
  };
}

// ── drawing helpers ──────────────────────────────────────────────────────
// Gaussian smoothing so single-day spikes become hills rather than needles.
function smooth(values, sigma = 1.3) {
  const r = Math.ceil(sigma * 3);
  return values.map((_, i) => {
    let s = 0, w = 0;
    for (let k = -r; k <= r; k++) {
      const v = values[i + k] ?? 0;
      const g = Math.exp(-(k * k) / (2 * sigma * sigma));
      s += v * g; w += g;
    }
    return s / w;
  });
}
// Catmull-Rom through points → cubic Béziers.
function curve(pts) {
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}
const svg = (w, h, body, fonts, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><style>${fontFace(fonts)}${body.css || ""}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>${body.svg}</svg>`;

const fmtDate = (d) => { const p = parts(d); return `${+p.day} ${MONTHS[+p.month - 1]} ${p.year}, ${p.hour}:${p.minute}`; };

// ── hero: one ridge per month, oldest at the back ────────────────────────
function hero(T, A, now) {
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
    const pts = vals.map((v, k) => [left + ((right - left) * k) / (vals.length - 1), base - Math.sqrt(v / peak) * amp]);
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
    css: `.s{font-family:${SERIF}}.m{font-family:${MONO}}` +
      `.r{animation:rise 1.1s cubic-bezier(.2,.7,.2,1) both}@keyframes rise{from{transform:translateY(26px);opacity:0}}` +
      `.sun{animation:set 2.4s cubic-bezier(.2,.7,.2,1) both}@keyframes set{from{transform:translateY(-38px);opacity:0}}` +
      `.pulse{animation:p 2.4s ease-in-out infinite}@keyframes p{50%{opacity:.25}}`,
    svg: `<defs>${defs}<radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${T.ember}"/><stop offset=".55" stop-color="${mix(T.ember, T.rose, 0.6)}"/><stop offset="1" stop-color="${T.rose}" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="${T.bg}"/>` +
      `<g class="sun"><circle cx="${sunX}" cy="${sunY}" r="120" fill="url(#sun)" opacity=".22"/><circle cx="${sunX}" cy="${sunY}" r="54" fill="${T.ember}" opacity=".9"/></g>` +
      `<text x="30" y="96" class="s" font-size="78" fill="${T.ink}" letter-spacing="-1">Elias Felder</text>` +
      `<text x="32" y="134" class="s" font-style="italic" font-size="23" fill="${T.soft}">builds web apps in Basel, sweats the pixels,</text>` +
      `<text x="32" y="162" class="s" font-style="italic" font-size="23" fill="${T.soft}">and spends a lot of time talking to LLMs.</text>` +
      `<text x="${W - 30}" y="44" text-anchor="end" class="m" font-size="11" fill="${T.mute}">47.56° N  7.59° E</text>` +
      ridges +
      `<circle cx="34" cy="451" r="3.2" fill="${T.ember}" class="pulse"/>` +
      `<text x="44" y="455" class="m" font-size="10.5" fill="${T.soft}">${esc(lastText)}</text>` +
      `<text x="${W - 30}" y="455" text-anchor="end" class="m" font-size="10.5" fill="${T.mute}">each ridge is one month of my commits, newest in front</text>`,
  }, ["serif", "italic", "mono"], `Elias Felder. Ridgeline of ${A.total} commits over the last twelve months.`);
}

// ── rhythm: when I code + what I code in ─────────────────────────────────
function rhythm(T, A, langs) {
  const W = 860, H = 330;
  const cx = 150, cy = 165, r0 = 46, r1 = 128;
  const max = Math.max(1, ...A.hours);
  // Hour colour follows the light outside: ember by day, violet at night.
  const hourColor = (h) => {
    const t = (Math.cos(((h - 13) / 24) * 2 * Math.PI) + 1) / 2; // 1 at 13:00, 0 at 01:00
    return ramp(T, 1 - t);
  };
  let bars = "";
  for (let h = 0; h < 24; h++) {
    const a0 = ((h / 24) * 360 - 90 + 1.6) * (Math.PI / 180);
    const a1 = (((h + 1) / 24) * 360 - 90 - 1.6) * (Math.PI / 180);
    const r = r0 + 4 + Math.sqrt(A.hours[h] / max) * (r1 - r0 - 4);
    const P = (rad, a) => `${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`;
    bars += A.hours[h]
      ? `<path class="b" style="animation-delay:${(0.4 + h * 0.025).toFixed(3)}s" d="M${P(r0 + 4, a0)}L${P(r, a0)}A${r},${r} 0 0 1 ${P(r, a1)}L${P(r0 + 4, a1)}A${r0 + 4},${r0 + 4} 0 0 0 ${P(r0 + 4, a0)}Z" fill="${hourColor(h + 0.5)}"/>`
      : `<circle cx="${P(r0 + 9, (a0 + a1) / 2).split(",")[0]}" cy="${P(r0 + 9, (a0 + a1) / 2).split(",")[1]}" r="1.2" fill="${T.line}"/>`;
  }
  const ticks = [0, 6, 12, 18].map((h) => {
    const a = ((h / 24) * 360 - 90) * (Math.PI / 180);
    const x = cx + (r1 + 14) * Math.cos(a), y = cy + (r1 + 14) * Math.sin(a) + 3.5;
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" class="m" font-size="9.5" fill="${T.mute}">${String(h).padStart(2, "0")}</text>`;
  }).join("");

  const peakHour = A.hours.indexOf(Math.max(...A.hours));
  const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const names = { Mon: "Mondays", Tue: "Tuesdays", Wed: "Wednesdays", Thu: "Thursdays", Fri: "Fridays", Sat: "Saturdays", Sun: "Sundays" };
  const peakDay = order.reduce((a, b) => ((A.weekdays[b] || 0) > (A.weekdays[a] || 0) ? b : a), "Mon");
  // Share of commits per part of the day decides the headline.
  const share = (from, to) => { let s = 0; for (let h = from; h !== to; h = (h + 1) % 24) s += A.hours[h]; return s / Math.max(1, A.total); };
  const night = share(22, 5), evening = share(17, 22), day = share(11, 17), morning = share(5, 11);
  const verdict = [[night, "Mostly a night owl."], [evening, "Does the real work after dark."], [day, "Writes code in daylight."], [morning, "An early riser, apparently."]]
    .sort((a, b) => b[0] - a[0])[0][1];

  // stats
  const X = 340;
  const stat = (x, n, label) =>
    `<text x="${x}" y="186" class="s" font-size="44" fill="${T.ink}">${n}</text><text x="${x + 1}" y="206" class="m" font-size="10.5" fill="${T.mute}">${label}</text>`;

  // languages: one bar, colours stepped through the palette
  const totalBytes = Object.values(langs).reduce((a, b) => a + b, 0) || 1;
  let top = Object.entries(langs).sort((a, b) => b[1] - a[1]);
  const shown = top.slice(0, 5);
  const rest = top.slice(5).reduce((a, [, v]) => a + v, 0);
  if (rest) shown.push(["Other", rest]);
  const barW = W - 30 - X;
  let bx = X, bar = "", legend = "", lx = X;
  shown.forEach(([name, bytes], i) => {
    const w = (bytes / totalBytes) * barW;
    const col = name === "Other" ? T.line : ramp(T, i / Math.max(1, shown.length - 2));
    bar += `<rect x="${bx.toFixed(1)}" y="252" width="${Math.max(0, w - 2).toFixed(1)}" height="8" rx="1.5" fill="${col}"/>`;
    bx += w;
    const pct = Math.round((bytes / totalBytes) * 100);
    const label = `${name} ${pct < 1 ? "<1" : pct}%`;
    legend += `<circle cx="${lx + 4}" cy="282" r="3.5" fill="${col}"/><text x="${lx + 12}" y="285.5" class="m" font-size="10.5" fill="${T.soft}">${esc(label)}</text>`;
    lx += 20 + label.length * 6.3;
  });

  return svg(W, H, {
    css: `.s{font-family:${SERIF}}.m{font-family:${MONO}}` +
      `.b{transform-origin:${cx}px ${cy}px;animation:grow .9s cubic-bezier(.2,.7,.2,1) both}@keyframes grow{from{transform:scale(.35);opacity:0}}`,
    svg: `<rect width="${W}" height="${H}" fill="${T.bg}"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r1}" fill="none" stroke="${T.line}" stroke-dasharray="1 5"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r0}" fill="none" stroke="${T.line}"/>` +
      bars + ticks +
      `<text x="${cx}" y="${cy + 6}" text-anchor="middle" class="s" font-size="26" fill="${T.ink}">${String(peakHour).padStart(2, "0")}h</text>` +
      `<text x="${cx}" y="${cy + 21}" text-anchor="middle" class="m" font-size="8.5" fill="${T.mute}">busiest</text>` +
      `<text x="${X}" y="62" class="s" font-size="34" fill="${T.ink}">${esc(verdict)}</text>` +
      `<text x="${X}" y="92" class="m" font-size="11.5" fill="${T.soft}">The ring shows when my commits land, in Basel time.</text>` +
      `<text x="${X}" y="110" class="m" font-size="11.5" fill="${T.soft}">Busiest around ${String(peakHour).padStart(2, "0")}:00, and on ${names[peakDay]}.</text>` +
      `<line x1="${X}" y1="132" x2="${W - 30}" y2="132" stroke="${T.line}"/>` +
      stat(X, A.total, "commits, last 12 months") +
      stat(X + 185, A.activeDays, "days with commits") +
      stat(X + 340, A.longest, "day best streak") +
      `<line x1="${X}" y1="228" x2="${W - 30}" y2="228" stroke="${T.line}"/>` +
      `<text x="${X}" y="244" class="m" font-size="10.5" fill="${T.mute}">what my repos are written in, by size</text>` +
      bar + legend,
  }, ["serif", "mono"], `Coding rhythm: ${verdict} ${A.total} commits in twelve months.`);
}

// ── project card with its own activity line ──────────────────────────────
function card(T, P, A, stars, now) {
  const W = 420, H = 186;
  // weekly commit counts over the last 52 weeks
  const days = A.perRepoDay[P.repo] || {};
  const weeks = new Array(52).fill(0);
  for (const [k, v] of Object.entries(days)) {
    const ago = Math.floor((now - new Date(k + "T12:00:00Z")) / 864e5);
    const w = 51 - Math.floor(ago / 7);
    if (w >= 0 && w < 52) weeks[w] += v;
  }
  const sm = smooth(weeks, 1.1);
  const peak = Math.max(1, ...sm);
  const x0 = 24, x1 = W - 24, base = 150, amp = 26;
  const pts = sm.map((v, i) => [x0 + ((x1 - x0) * i) / 51, base - Math.sqrt(v / peak) * amp]);
  const line = curve(pts);
  const total = weeks.reduce((a, b) => a + b, 0);
  const starTxt = stars ? `  ★ ${stars}` : "";
  return svg(W, H, {
    css: `.s{font-family:${SERIF}}.m{font-family:${MONO}}`,
    svg: `<defs><linearGradient id="h" x1="0" x2="1"><stop offset="0" stop-color="${T.violet}"/><stop offset=".5" stop-color="${T.rose}"/><stop offset="1" stop-color="${T.ember}"/></linearGradient>` +
      `<linearGradient id="f" x1="0" y1="${base - amp}" x2="0" y2="${base}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${T.rose}" stop-opacity=".22"/><stop offset="1" stop-color="${T.rose}" stop-opacity="0"/></linearGradient></defs>` +
      `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="10" fill="${T.bg}" stroke="${T.line}"/>` +
      `<text x="24" y="50" class="s" font-size="34" fill="${T.ink}">${esc(P.name)}</text>` +
      `<text x="${W - 24}" y="46" text-anchor="end" class="m" font-size="10.5" fill="${T.mute}">${esc(P.url)} ↗</text>` +
      `<text x="24" y="78" class="m" font-size="11.5" fill="${T.soft}">${esc(P.text[0])}</text>` +
      `<text x="24" y="95" class="m" font-size="11.5" fill="${T.soft}">${esc(P.text[1])}</text>` +
      `<path d="${line}L${x1},${base}L${x0},${base}Z" fill="url(#f)"/>` +
      `<path d="${line}" fill="none" stroke="url(#h)" stroke-width="1.6"/>` +
      `<line x1="${x0}" y1="${base}" x2="${x1}" y2="${base}" stroke="${T.line}"/>` +
      `<text x="24" y="170" class="m" font-size="10" fill="${T.mute}">${esc(P.lang + starTxt)}</text>` +
      `<text x="${W - 24}" y="170" text-anchor="end" class="m" font-size="10" fill="${T.mute}">${total ? `${total} commits in 12 months` : "quiet lately"}</text>`,
  }, ["serif", "mono"], `${P.name}: ${P.text.join(" ")}`);
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
for (const [name, T] of Object.entries(THEMES)) {
  writeFileSync(join(OUT, `hero-${name}.svg`), hero(T, A, now));
  writeFileSync(join(OUT, `rhythm-${name}.svg`), rhythm(T, A, data.languages));
  PROJECTS.forEach((P, i) => writeFileSync(join(OUT, `project-${i + 1}-${name}.svg`), card(T, P, A, data.stars[P.repo], now)));
}
console.log(`${A.total} commits, ${A.activeDays} active days, ${data.repoCount} repos → ${OUT}/`);
