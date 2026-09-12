/**
 * One-shot palette AA repair for packages/web/src/styles.css (2026-09-12 review).
 *
 * Walks each [data-theme] block, measures the pairs the UI actually paints
 * (body/secondary/muted text and state colors on the surfaces they sit on),
 * and where WCAG 2.1 AA fails, slides the foreground's HSL lightness — hue and
 * saturation untouched — until it passes. Then rewrites the token values.
 */
import { readFileSync, writeFileSync } from "node:fs";

const cssPath = new URL("../packages/web/src/styles.css", import.meta.url);
const css = readFileSync(cssPath, "utf8");

const hexToRgb = (hex) =>
  hex
    .slice(1)
    .match(/\w\w/g)
    .map((x) => parseInt(x, 16));
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(hexToRgb(a)), lum(hexToRgb(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const rgbToHex = (rgb) =>
  `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const rgbToHsl = ([r, g, b]) => {
  const [rn, gn, bn] = [r, g, b].map((v) => v / 255);
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn
      ? ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
      : max === gn
        ? ((bn - rn) / d + 2) / 6
        : ((rn - gn) / d + 4) / 6;
  return [h, s, l];
};
const hslToRgb = ([h, s, l]) => {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map((v) => v * 255);
};

/** The pairs the app paints: token → surfaces it must read on (AA body text). */
const PAIRS = [
  ["text", ["bg", "panel", "panel-2", "panel-3"]],
  ["text-2", ["panel", "panel-2"]],
  ["muted", ["panel", "panel-2"]],
  ["accent", ["bg", "panel"]],
  ["warn", ["panel", "panel-2"]],
  ["danger", ["panel", "panel-2"]],
  ["ok", ["panel", "panel-2"]],
];

const changed = [];
const blockRe = /\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g;
let out = css;
const blocks = [...css.matchAll(blockRe)];
for (const { 1: theme, 2: body } of blocks) {
  const tokens = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[m[1]] = m[2];
  const needed = new Map();
  for (const [fg, surfaces] of PAIRS) {
    if (!tokens[fg]) continue;
    for (const surface of surfaces) {
      if (!tokens[surface]) continue;
      let r = ratio(tokens[fg], tokens[surface]);
      if (r >= 4.5) continue;
      const hsl = rgbToHsl(hexToRgb(tokens[fg]));
      const towardText = lum(hexToRgb(tokens[fg])) > lum(hexToRgb(tokens[surface]));
      let candidate = tokens[fg];
      for (let step = 0; step < 60 && r < 4.5; step += 1) {
        hsl[2] = Math.min(0.97, Math.max(0.03, hsl[2] + (towardText ? 0.01 : -0.01)));
        candidate = rgbToHex(hslToRgb(hsl));
        r = ratio(candidate, tokens[surface]);
      }
      if (r < 4.5) {
        changed.push(`${theme}: ${fg} on ${surface} UNRESOLVED (${r.toFixed(2)})`);
        continue;
      }
      if (!needed.has(fg) || ratio(candidate, tokens[surface]) > 4.5) needed.set(fg, candidate);
      changed.push(
        `${theme}: --${fg} ${tokens[fg]} → ${candidate} (${fg}/${surface} was ${ratio(tokens[fg], tokens[surface]).toFixed(2)})`,
      );
    }
  }
  if (needed.size === 0) continue;
  let newBody = body;
  for (const [token, value] of needed) {
    newBody = newBody.replace(new RegExp(`(--${token}:\\s*)#[0-9a-fA-F]{6}\\s*;`), `$1${value};`);
  }
  out = out.replace(body, newBody);
}

writeFileSync(cssPath, out);
console.log(changed.length ? changed.join("\n") : "no changes needed");
