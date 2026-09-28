/**
 * 프리로드 산출물 마무리 — 개명과 이식.
 *
 * ① tsc 가 낸 preload · preview-preload 를 .cjs 로 개명한다(옛 package.json
 *    빌드의 한 줄이 여기로 왔다).
 * ② dist/element-identity.js 의 자기완결 함수를 preview-preload.cjs 꼬리에 이어
 *    붙인다 (PLAN-MCP §3.E-1): 샌드박스 preload 는 로컬 require 가 안 되므로,
 *    핀 봉투와 드라이버의 browser_inspect 가 **같은 소스 한 벌**을 쓰는 길이
 *    빌드 때 끼워 넣는 것뿐이다. preview-preload.ts 의 `declare function` 가
 *    이 함수를 가리킨다 — 내보내기가 사라지면 조용히 빠지는 대신 빌드가
 *    실패해야 드리프트가 눈에 잡힌다.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

// ① 개명 — preload 산출물은 CommonJS 로 읽혀야 한다(메인 번들은 ESM).
for (const name of ["preload", "preview-preload"]) {
  for (const ext of ["js", "js.map", "d.ts"]) {
    const from = join(dist, `${name}.${ext}`);
    const to = join(dist, `${name}.cjs${ext === "js" ? "" : `.${ext}`}`);
    if (existsSync(from)) renameSync(from, to);
  }
}

// ② 이식 — element-identity.js(tsconfig.json 의 ESM 산출물)에서 함수 몸을
// 뽑아 preview-preload.cjs 에 붙인다. 함수 선언은 끌어올아지므로 꼬리에 붙어도
// preload 어디서든 부를 수 있다.
const identityPath = join(dist, "element-identity.js");
if (!existsSync(identityPath)) {
  console.error(
    `[build-preloads] ${identityPath} 이(가) 없습니다 — element-identity.ts 의 내보내기가 사라졌는지 확인하세요.`,
  );
  process.exit(1);
}
const body = readFileSync(identityPath, "utf8")
  .replace(/^"use strict";\n/gm, "")
  .replace(/^\/\/# sourceMappingURL=.*$/gm, "")
  .replace(/^export function /gm, "function ")
  .replace(/^export \{[^}]*\};?\n?/gm, "")
  .trimEnd();
if (!body.includes("function describeElementInPage(")) {
  console.error(
    "[build-preloads] element-identity.js 에서 describeElementInPage 를 찾지 못했습니다 — preview-preload.ts 의 declare 와 어긋났습니다.",
  );
  process.exit(1);
}
const preloadPath = join(dist, "preview-preload.cjs");
writeFileSync(
  preloadPath,
  `${readFileSync(preloadPath, "utf8")}
// ── element-identity.ts 에서 이식(PLAN-MCP §3.E-1) — 아래는 그 파일의 함수
// 소스 그대로다(build-preloads.mjs 가 붙인다). 드라이버도 같은 소스를
// Runtime.callFunctionOn 으로 페이지에서 돌린다.
${body}
`,
);
