import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(turn-screens.test.ts 와 같은 모양).
import { DEV, L } from "../src/next/labels.ts";

/** U10 의 끝 조건 — 사용자 면에 나오지 않는 개발자의 말. */
const FORBIDDEN = ["턴", "경로", "git", "데몬", "커밋", "브랜치", "PR"];

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

/** `L` 의 모든 문자열 — 함수는 표본 값으로 불러 그 결과를 잰다. */
function collect(value: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (typeof value === "string") {
    out.push({ path, text: value });
  } else if (typeof value === "function") {
    const fn = value as (...args: unknown[]) => unknown;
    // 숫자 자리에도 문자열 자리에도 들어갈 수 있는 표본 — 불리언 자리는 참으로 읽힌다.
    collect(fn(...Array.from({ length: fn.length }, () => 3)), `${path}()`, out);
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) collect(item, `${path}[${index}]`, out);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collect(item, `${path}.${key}`, out);
  }
}

test("labels: 어느 문장에도 금칙어가 없다", () => {
  const strings: Array<{ path: string; text: string }> = [];
  // DEV 는 여기 없다 — 개발자용 폴드의 진단 문장은 금칙어를 정당히 쓴다(아래 검사).
  collect(L, "L", strings);
  assert.ok(strings.length > 100, `문장이 너무 적다: ${strings.length}`);
  const hits = strings.flatMap(({ path, text }) =>
    FORBIDDEN.filter((word) => text.includes(word)).map((word) => `${path} — "${word}": ${text}`),
  );
  assert.deepEqual(hits, []);
});

/**
 * `DEV` 는 개발자용 폴드의 진단 문장(PLAN-UI U12 · J5) — 데몬 같은 개발자의
 * 어휘가 정당히 필요한 자리다. 위의 금칙어 검사는 `L` 만 본다(DEV 를 넣지
 * 않는다); `next/` 안의 한글 리터럴 검사는 그대로 labels.ts 안이므로 닿는다.
 */
test("DEV: 개발자용 폴드의 문장이 살아 있다 — 금칙어 검사에서 뺀다", () => {
  const strings: Array<{ path: string; text: string }> = [];
  collect(DEV, "DEV", strings);
  assert.ok(strings.length >= 3, `DEV 문장이 너무 적다: ${strings.length}`);
  assert.ok(
    strings.some(({ text }) => text.includes("데몬")),
    "진단 줄의 `데몬` 이 사라지면 이 검사의 이유도 사라진다",
  );
});

/**
 * 주석을 걷고, 문자열 리터럴과 나머지 코드(JSX 텍스트가 여기 남는다)를 나눈다.
 * 템플릿의 `${…}` 는 문자열의 일부로 읽는다 — 거기 한글이 있어도 잡혀야 한다.
 */
function splitSource(source: string): { literals: string[]; code: string } {
  const literals: string[] = [];
  let code = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\") j += 1;
        // 따옴표 문자열은 줄을 넘지 않는다 — JSX 텍스트의 홑따옴표가 파일을 삼키지 않게.
        if (ch !== "`" && source[j] === "\n") break;
        j += 1;
      }
      literals.push(source.slice(i + 1, j));
      i = j + 1;
    } else {
      code += ch;
      i += 1;
    }
  }
  return { literals, code };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

test("next/: labels.ts 밖에 한글 리터럴이 없다(린트 규칙)", () => {
  const root = join(import.meta.dirname, "../src/next");
  const files = sourceFiles(root).filter((file) => relative(root, file) !== "labels.ts");
  assert.ok(files.length > 0, "next/ 에 검사할 파일이 없다");
  const hits: string[] = [];
  for (const file of files) {
    const { literals, code } = splitSource(readFileSync(file, "utf8"));
    for (const literal of literals) {
      if (HANGUL.test(literal)) hits.push(`${relative(root, file)} 문자열: ${literal}`);
    }
    for (const line of code.split("\n")) {
      if (HANGUL.test(line)) hits.push(`${relative(root, file)} JSX 텍스트: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("splitSource: 주석은 걷고 문자열과 JSX 텍스트는 잡는다", () => {
  const sample = [
    "// 주석은 괜찮다",
    "/* 이것도 */",
    'const a = "문자열";',
    "const b = <p>본문</p>;",
    "const c = `틀 $\u007bx}`;",
  ].join("\n");
  const { literals, code } = splitSource(sample);
  assert.deepEqual(literals, ["문자열", "틀 $\u007bx}"]);
  assert.ok(code.includes("본문"));
  assert.ok(!code.includes("주석"));
});
