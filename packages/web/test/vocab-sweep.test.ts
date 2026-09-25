import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

/**
 * U10 의 끝 조건(PLAN-UI 단계 7) — 개발 실행 밖 표면의 한국어 문장에 개발자의 말이 없다.
 * `packages/web/src/**` 의 한글이 든 문자열 리터럴과 JSX 텍스트를 훑는다. 주석은 걷는다.
 * `next/labels.ts` 는 `next-labels.test.ts` 가 `L`(금칙어) · `DEV`(허용)로 따로 지킨다.
 */
const FORBIDDEN: Array<{ word: string; pattern: RegExp }> = [
  // `패턴` · `리턴` 의 턴은 개발자의 턴이 아니다.
  { word: "턴", pattern: /(?<![패리])턴/ },
  { word: "경로", pattern: /경로/ },
  { word: "git", pattern: /git(?!hub)/i },
  { word: "데몬", pattern: /데몬/ },
  { word: "커밋", pattern: /커밋/ },
  { word: "브랜치", pattern: /브랜치/ },
  { word: "PR", pattern: /(?<![A-Za-z])PR(?![A-Za-z])/ },
];

/**
 * 사용자가 읽지 않는 파일 — 이유와 함께. 여기 없는 파일의 문장은 전부 사용자 면이다.
 */
const EXEMPT: Record<string, string> = {
  "next/labels.ts": "next-labels.test.ts 가 L 과 DEV 를 따로 검사한다",
  "ConnectScreen.tsx": "브라우저 개발 경로의 연결 화면 — 데몬 주소를 붙여넣는 개발자의 화면",
  "desktop-bridge.d.ts": "타입 선언 — 문장이 없다",
  "lib/preview-turns.ts":
    "AI 가 읽는 턴 본문(핀 · 오류 · 화면 보여 주기) — 대화록은 카드로 접어 그린다",
  "lib/transcript-export.ts": "내보낸 markdown 의 머리 — 파일을 받는 개발자가 읽는다",
};

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

/** 이 자리의 `/` 가 나눗셈이 아니라 정규식의 시작인가 — 앞선 코드의 마지막 글자로 판단한다. */
function regexStarts(code: string): boolean {
  const before = code.trimEnd();
  return before === "" || /[(,=:[!&|?{};+\-*%~^]$/.test(before) || /\breturn$/.test(before);
}

/**
 * 주석을 걷고 문자열 리터럴과 나머지 코드(JSX 텍스트가 여기 남는다)를 나눈다.
 * 정규식 리터럴은 통째로 건너뛴다 — 그 안의 따옴표가 문자열을 열지 않게.
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
    } else if (ch === "/" && regexStarts(code)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        if (source[j] === "\\") j += 1;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) break;
        j += 1;
      }
      code += " ";
      i = j + 1;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\") j += 1;
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

/** 한 파일의 걸린 문장 — 한글이 든 리터럴과 JSX 텍스트만 본다. */
function hitsIn(source: string): Array<{ word: string; text: string }> {
  const { literals, code } = splitSource(source);
  const texts = [...literals, ...code.split("\n")].filter((text) => HANGUL.test(text));
  return texts.flatMap((text) =>
    FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(({ word }) => ({
      word,
      text: text.trim(),
    })),
  );
}

test("hitsIn: 문장과 JSX 텍스트는 잡고, 주석 · 정규식 · 영어 문장 · 패턴은 지나간다", () => {
  const sample = [
    "// 턴이 끝나면 커밋한다 — 주석은 괜찮다",
    'const a = "커밋했어요";',
    "const b = <p>브랜치를 만들었어요</p>;",
    "const c = /['\"`]/g;",
    'const d = "open a PR";',
    'const e = "패턴이 맞아요";',
    'const f = "GitHub 에서 열기";',
  ].join("\n");
  assert.deepEqual(
    hitsIn(sample).map((hit) => hit.word),
    ["커밋", "브랜치"],
  );
});

test("vocab: 사용자 면의 한국어 문장에 턴 · 경로 · git · 데몬 · 커밋 · 브랜치 · PR 이 없다", () => {
  const root = join(import.meta.dirname, "../src");
  const files = sourceFiles(root).filter((file) => !(relative(root, file) in EXEMPT));
  assert.ok(files.length > 50, `검사할 파일이 너무 적다: ${files.length}`);
  const hits: string[] = [];
  for (const file of files) {
    for (const { word, text } of hitsIn(readFileSync(file, "utf8"))) {
      hits.push(`${relative(root, file)} — "${word}": ${text}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("vocab: 면제 목록의 파일이 모두 있다 — 지운 파일의 면제가 남지 않게", () => {
  const root = join(import.meta.dirname, "../src");
  const present = new Set(sourceFiles(root).map((file) => relative(root, file)));
  assert.deepEqual(
    Object.keys(EXEMPT).filter((file) => !present.has(file)),
    [],
  );
});
