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

/** 주석만 걷은 소스 — 템플릿의 `${…}` 안에서 부르는 문장도 세야 한다. */
function withoutComments(source: string): string {
  const { literals, code } = splitSource(source);
  return `${code}\n${literals.join("\n")}`;
}

/**
 * 칸을 통째로 건네는 자리(`updateRowCopy(…, L.update)`) — 받는 쪽이 그 칸의 이름을 어떻게
 * 읽는지. 파일이면 그 파일의 `.이름` 을 센다; `"*"` 는 칸 전체를 열쇠로 훑는다는 뜻이다
 * (`noticeKind` 가 `prefixes[kind]` 로 모든 머리를 읽는다). 새로 통째로 건네면 여기에 적는다.
 */
const WHOLE_GROUP: Record<string, string> = {
  update: "lib/update-row.ts",
  daemonNotice: "*",
};

/**
 * 죽은 문장이 쌓이지 않게 — `L` 의 칸마다(`L.<칸>.<이름>`) `next/` 어딘가가 `<칸>.<이름>`
 * 으로 부른다. 순수 판정은 `L` 을 인자로 받으므로(`words.invite.rowNew`) 앞의 이름은 보지
 * 않고, 칸을 풀어 받은 이름(`const { journey: J } = words` → `J.before`)도 센다. 함수 ·
 * 배열 칸은 칸 자체가 한 문장이다 — 그 안을 따로 세지 않는다.
 */
test("labels: L 의 칸은 모두 next/ 어딘가에서 불린다", () => {
  const root = join(import.meta.dirname, "../src/next");
  const files = sourceFiles(root)
    .filter((file) => relative(root, file) !== "labels.ts")
    .map((file) => ({
      name: relative(root, file),
      text: withoutComments(readFileSync(file, "utf8")),
    }));
  /** 한 파일에서 칸을 부르는 이름들 — 칸 이름 자신과, 풀어 받은 별명. */
  const namesFor = (text: string, group: string): string[] => {
    const names = [group];
    for (const match of text.matchAll(/\{([^{}]*)\}\s*=/g)) {
      for (const part of (match[1] ?? "").split(",")) {
        const [from, to] = part.split(":").map((word) => word.trim());
        if (from === group && to) names.push(to);
      }
    }
    // `const S = words.sidebar;` 의 S.
    for (const match of text.matchAll(
      new RegExp(`\\b(\\w+)\\s*=\\s*[\\w.]*\\.${group}\\s*;`, "g"),
    )) {
      if (match[1]) names.push(match[1]);
    }
    return names;
  };
  const access = (owner: string, name: string) =>
    new RegExp(`\\b${owner}\\s*\\??\\.\\s*${name}\\b`);
  const used = (group: string, name: string) => {
    const receiver = WHOLE_GROUP[group];
    if (receiver === "*") return true;
    // 열쇠로 고르는 칸(`words.cycle[cycle]`) — 칸 전체가 쓰인다.
    if (files.some(({ text }) => new RegExp(`\\.${group}\\s*\\[`).test(text))) return true;
    if (receiver) {
      const file = files.find((entry) => entry.name === receiver);
      if (file && new RegExp(`\\.\\s*${name}\\b`).test(file.text)) return true;
    }
    return files.some(({ text }) =>
      namesFor(text, group).some((alias) => access(alias, name).test(text)),
    );
  };
  const keys = Object.keys(L).flatMap((group) =>
    Object.keys(L[group as keyof typeof L]).map((name) => [group, name] as const),
  );
  assert.ok(keys.length > 100, `칸이 너무 적다: ${keys.length}`);
  const dead = keys.filter(([group, name]) => !used(group, name)).map((key) => key.join("."));
  assert.deepEqual(dead, []);

  // 통째로 건네는 자리가 표에 없으면 그 칸의 셈이 틀린다 — 표가 코드를 따라가게.
  const passed = new Set(
    files.flatMap(({ text }) =>
      [...text.matchAll(/\bL\.(\w+)\b(?!\s*\??\.)/g)].map((match) => match[1] ?? ""),
    ),
  );
  assert.deepEqual([...passed].filter((group) => !(group in WHOLE_GROUP)).sort(), []);
});
