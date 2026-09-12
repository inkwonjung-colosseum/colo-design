/** Post-fix contrast gate: every painted pair must clear WCAG AA. */
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../packages/web/src/styles.css", import.meta.url), "utf8");
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
const mix = (a, b, weight) =>
  rgbToHex(hexToRgb(a).map((v, i) => Math.round(v * weight + hexToRgb(b)[i] * (1 - weight))));
const rgbToHex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

const PAIRS = [
  ["text", ["bg", "panel", "panel-2", "panel-3"], 4.5],
  ["text-2", ["panel", "panel-2"], 4.5],
  ["muted", ["panel", "panel-2"], 4.5],
  ["accent", ["bg", "panel"], 4.5],
  ["warn", ["panel", "panel-2"], 4.5],
  ["danger", ["panel", "panel-2"], 4.5],
  ["ok", ["panel", "panel-2"], 4.5],
];

const failures = [];
let pairs = 0;
for (const { 1: theme, 2: body } of css.matchAll(/\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) {
  const tokens = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[m[1]] = m[2];
  for (const [fg, surfaces, min] of PAIRS) {
    for (const surface of surfaces) {
      if (!tokens[fg] || !tokens[surface]) continue;
      pairs += 1;
      const r = ratio(tokens[fg], tokens[surface]);
      if (r < min) failures.push(`${theme} ${fg}/${surface} ${r.toFixed(2)}`);
    }
  }
  // 칩 saved tone = ok 68% + text-2 32% on panel (the merged/saved split)
  if (tokens.ok && tokens["text-2"] && tokens.panel) {
    pairs += 1;
    const savedTone = mix(tokens.ok, tokens["text-2"], 0.68);
    const r = ratio(savedTone, tokens.panel);
    if (r < 4.5) failures.push(`${theme} chip-saved(ok68+text2)/panel ${r.toFixed(2)}`);
  }
  // focus ring: opaque accent as non-text indicator, 3:1 on bg
  if (tokens.accent && tokens.bg) {
    pairs += 1;
    const r = ratio(tokens.accent, tokens.bg);
    if (r < 3) failures.push(`${theme} focus-ring accent/bg ${r.toFixed(2)}`);
  }
}
console.log(`${pairs} pairs checked, ${failures.length} failures`);
if (failures.length) {
  console.log(failures.join("\n"));
  process.exit(1);
}
