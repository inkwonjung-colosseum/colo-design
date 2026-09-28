// 쓰기 값 전부를 못 박는 시험 (RENAME-NOVA-PLAN §8.1 "nova-names") — 개명 뒤
// 무엇을 쓰는지, 그리고 옛 이름이 // read-legacy 줄(과 허용 목록) 밖에 남지
// 않았는지. 기대값의 옛 이름은 조각으로 잇는다 — 치환 스크립트가 기대값까지
// 바꾸지 않게.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { markTurn, readTurn } from "../../protocol/src/turn-marker.ts";
import { NOVA_DESIGN_DATA_DIR } from "../dist/environment.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// read-legacy — 조각으로 잇는 옛 이름.
const LEGACY = ["co", "lo"].join("");
// 데스크톱의 순수 모듈 — 상대 임포트가 없어 src 로 직접 들어온다.
const identity = await import(new URL("../../desktop/src/identity.ts", import.meta.url).href);

test("markTurn 은 nova-design 접두로 쓰고 readTurn 이 읽는다", () => {
  const text = markTurn({ kind: "gate", step: "보관" }, "본문");
  assert.ok(text.startsWith(`<!-- nova-design:gate `));
  const { marker } = readTurn(text);
  assert.deepEqual(marker, { kind: "gate", step: "보관" });
});

test("데이터 폴더는 ~/.nova-design — environment 상수와 표기가 일치한다", () => {
  assert.equal(NOVA_DESIGN_DATA_DIR, join(homedir(), ".nova-design"));
});

test("appId — electron-builder.yml 과 identity.ts 가 같은 문자열", () => {
  const yml = readFileSync(join(ROOT, "packages/desktop/electron-builder.yml"), "utf8");
  const appId = /^appId:\s*(\S+)\s*$/m.exec(yml)?.[1];
  assert.equal(appId, identity.APP_BUNDLE_ID);
  assert.equal(appId, "org.nova-design.desktop");
  assert.equal(identity.PRODUCT_NAME, "Nova Design");
  assert.equal(identity.userDataDir("/appdata"), join("/appdata", "Nova Design"));
  // 옛 이름의 철자도 못 박는다 — installer.nsh 와 짝이어야 병설이 생기지 않는다.
  assert.equal(identity.LEGACY_APP_BUNDLE_ID, `org.${LEGACY}-design.desktop`);
});

test("NSIS include — 옛 GUID 제거 분기가 있다(레지스트리 읽기 · ExecWait)", () => {
  const nsh = readFileSync(join(ROOT, "packages/desktop/build/installer.nsh"), "utf8");
  assert.ok(nsh.includes(identity.LEGACY_NSIS_GUID));
  assert.ok(nsh.includes("ReadRegStr"));
  assert.ok(nsh.includes("ExecWait"));
  assert.ok(nsh.includes("DeleteRegKey"));
});

test("Windows 교체 스크립트는 --force-run 을 넘기고 재실행은 조건부다", () => {
  const source = readFileSync(join(ROOT, "packages/desktop/src/win-self-update.ts"), "utf8");
  assert.ok(source.includes("'--force-run'"));
  assert.ok(source.includes("Get-Process -Name $name"));
});

// ---------------------------------------------------------------------------
// 잔여 검사(§8.2 F 뒤) — 허용 목록 밖의 옛 이름 줄이 0 인가.
// ---------------------------------------------------------------------------

/** 주석 줄 — 문서의 이름 이야기는 허용 목록에 든다. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("<!--") ||
    trimmed.startsWith(";") ||
    trimmed.startsWith("#")
  );
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    // 숨은 항목(.gitignore · .dev-userData 따위)과 빌드 산물(release ·
    // web-dist · resources — 포터블 런타임 번들)은 검사 밖 — 개발 흔적이지
    // 배포되는 코드가 아니다. 루트의 .github 은 호출자가 직접 건넨다.
    if (
      entry.startsWith(".") ||
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "release" ||
      entry === "web-dist" ||
      entry === "resources"
    ) {
      continue;
    }
    const path = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue; // readdir 과 stat 사이에 사라진 유령 파일
    }
    if (stat.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

test("잔여 검사 — 옛 이름은 read-legacy 줄 · 주석 · 허용 목록 안에만 있다", () => {
  const files = [
    ...walk(join(ROOT, "packages")),
    ...walk(join(ROOT, "site")),
    ...walk(join(ROOT, "scripts")),
    ...walk(join(ROOT, ".github")),
    join(ROOT, "README.md"),
    join(ROOT, "package.json"),
    join(ROOT, "AGENTS.md"),
    join(ROOT, "CLAUDE.md"),
  ];
  // 날짜가 박힌 기록(§1.4)과 이 시험 자신은 검사 밖이다.
  const excluded = (path: string): boolean =>
    path.endsWith("RESULT-2026-09-25.md") ||
    path.endsWith(join("packages", "daemon", "test", "nova-names.test.ts"));
  const pattern = new RegExp(`${LEGACY}(?!r|ur|sseum|nova|n\\b)`, "i");
  const offenders: string[] = [];
  for (const path of files) {
    if (excluded(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!pattern.test(line)) return;
      // 허용 목록 — read-legacy 표식(같은 줄 또는 바로 윗줄, // 와 ; 두 주석
      // 다), 주석 줄, 그리고 0.4.0 이 계속 쓰는 초대 확장자(.colo-invite,
      // 대소문자 판정 시험 포함). 포맷터(biome)가 줄을 다시 묶을 수 있어
      // 표식은 이웃 줄에도 둔다.
      if (line.includes("read-legacy") || (lines[index - 1] ?? "").includes("read-legacy")) {
        return;
      }
      if (isCommentLine(line)) return;
      if (/\.colo-invite/i.test(line) || line.includes("COLO-INVITE")) return;
      offenders.push(`${path.replace(ROOT, "")}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
