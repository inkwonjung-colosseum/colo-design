/**
 * AI 세션의 git 가드 (PLAN L5 · 단계 3) — 두 겹이다.
 *
 * 1. Claude 의 PreToolUse 훅 (`gitGuardHookDecision`): bypassPermissions 에서는
 *    canUseTool 이 Bash 에 불리지 않으므로, SDK 의 hooks 옵션이 그 자리를
 *    메운다 — 판정은 session.ts 의 gitWriteDenied 와 같은 함수를 읽는다.
 * 2. 모든 공급자의 git 수준 가드 (`gitGuardEnv` + `ensureGitGuardHooks`):
 *    AI CLI 프로세스의 환경에 core.hooksPath 를 심어, 참조를 바꾸는 git
 *    (commit · reset · checkout · merge · stash · push …)을 훅이 거절한다.
 *    Codex 의 BYPASS_APPROVAL_POLICY 처럼 권한을 아예 묻지 않는 공급자도
 *    이 겹은 지난다.
 *
 * 한계: 협조적인 AI 의 실수를 막는 장치다 — 환경 변수를 지우는 적대적
 * 명령(GIT_CONFIG_COUNT=0 git …)까지 막지는 않는다. 도구 자신의 git
 * (RepoCore.git)은 이 환경을 쓰지 않으므로 영향이 없다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 세션이 git 쓰기를 시도할 때 읽는 한 문장 — PreToolUse 훅의 deny 이유,
 * decidePermission 의 거절, git 가드 훅의 stderr 가 같은 말을 쓴다.
 */
export const GIT_WRITE_REFUSAL =
  "보관과 제출은 이 도구가 합니다 — git 명령 없이 파일만 고쳐 주세요. 정리가 끝나면 도구가 마무리합니다.";

/** 가드 훅 폴더의 기본 자리 — `~/.colo-design/tools/git-guard`. */
export function gitGuardHooksDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLO_DESIGN_GIT_GUARD_DIR ?? join(homedir(), ".colo-design", "tools", "git-guard");
}

// ---------------------------------------------------------------------------
// 세션의 git 쓰기 판정 — decidePermission 과 PreToolUse 훅이 함께 읽는다
// ---------------------------------------------------------------------------

/** 저장·워크트리·레퍼런스를 바꾸는 git 동사들 — status·log·diff·fetch 같은
 * 상태 읽기는 명단에 없다(README · PLAN D5). */
const GIT_WRITE_VERBS: Record<string, true> = {
  commit: true,
  push: true,
  reset: true,
  rebase: true,
  "update-ref": true,
  clean: true,
  checkout: true,
  restore: true,
  switch: true,
  am: true,
  "cherry-pick": true,
  revert: true,
  merge: true,
  pull: true,
  apply: true,
  rm: true,
  mv: true,
  init: true,
  // PLAN L5 · 단계 3: add · stage 도 도구의 몫이다 — 충돌 정리의 해결 표시는
  // 감독자의 finishToolOp 가 한다. 옛 MERGE_HEAD 예외가 열어 두던 문을 닫는다.
  add: true,
  stage: true,
};

/**
 * 셸 명령을 단어로 쪼갠다 — 따옴표 안은 한 단어로 남고, &&·||·;·|·(·)·` 는
 * 경계가 되어 그 뒤의 단어가 새 명령의 첫 단어임을 보인다.
 */
function tokenizeShellWords(command: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (word) tokens.push(word);
      word = "";
    } else if (ch === "&" || ch === ";" || ch === "|" || ch === "(" || ch === ")" || ch === "`") {
      if (word) tokens.push(word);
      word = "";
      tokens.push(ch); // 연산자 — 동사 자리가 될 수 없다
    } else {
      word += ch;
    }
  }
  if (word) tokens.push(word);
  return tokens;
}

export function gitWriteDenied(command: string): boolean {
  // 동사의 "자리"를 본다 — `git log --grep=stash`, `git log -S "git checkout"`
  // 은 stash·checkout 이 명사 위치에 있을 뿐인 읽기다.
  const tokens = tokenizeShellWords(command);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token !== "git" && !token.endsWith("/git")) continue;
    // git 다음의 동사 자리를 찾는다 — 전역 옵션은 동사가 아니고, 값을 따로
    // 받는 것(-C·-c·--git-dir)은 한 쌍으로 건너뛴다.
    let j = i + 1;
    while (j < tokens.length) {
      const tok = tokens[j];
      if (tok === undefined) break;
      if (
        tok === "-C" ||
        tok === "-c" ||
        tok === "--git-dir" ||
        tok === "--work-tree" ||
        tok === "--namespace" ||
        tok === "--super-prefix"
      ) {
        j += 2;
      } else if (tok.startsWith("-")) {
        j += 1;
      } else {
        break;
      }
    }
    const verb = tokens[j];
    if (verb === undefined) continue; // 맨 `git` — 사용법 출력이 전부인 읽기
    // 상태를 바꾸는 동사는 전부 막는다 — 커밋·푸시만이 아니라 reset·checkout·
    // merge 도 저장 검토가 읽는 상태를 흔든다.
    if (verb in GIT_WRITE_VERBS) return true;
    // config 도 읽기 형태가 있다 — --get·--list 같은 조회는 열어 두고(hooks
    // 경로를 읽는 일은 무해하다), 그 밖은 전부 쓰기로 본다: 값을 심는 기본형
    // 부터 --unset·--edit 까지.
    if (verb === "config") {
      const readForm = /^(--get(-all|-regexp|-urlmatch|-color|-colorbool)?|--list|-l)$/;
      if (!tokens.slice(j + 1).some((t) => readForm.test(t))) return true;
    }
    // stash·tag·branch 는 읽기 형태가 있다 — list·show·나열은 열어 두고,
    // 쓰기 형태(pop·drop·생성·삭제)만 막는다. 맨 `stash` 는 push 와 같다.
    if (verb === "stash" && tokens[j + 1] !== "list" && tokens[j + 1] !== "show") return true;
    if (verb === "tag") {
      const next = tokens[j + 1];
      if (next !== undefined && !/^-[ln]$/.test(next) && next !== "--list") return true;
    }
    if (verb === "branch") {
      const next = tokens[j + 1];
      if (
        next !== undefined &&
        !/^-[alrv]+$/.test(next) &&
        next !== "--list" &&
        next !== "--show-current"
      ) {
        return true;
      }
    }
    // 그 밖의 동사는 그대로 둔다 — 상태 읽기(status·log·diff·fetch)와 모르는 별명.
  }
  return false;
}

// ---------------------------------------------------------------------------
// 훅 파일 — POSIX sh (Windows 는 번들 MinGit 의 sh 가 돌린다)
// ---------------------------------------------------------------------------

/** reference-transaction: 첫 인자 prepared = 참조 변경이 막 닫히려는 순간. */
const REFERENCE_TRANSACTION = `#!/bin/sh
# Colo Design git guard — AI 세션의 참조 변경을 막는다 (PLAN L5).
# 커밋 · 리셋 · 브랜치 이동 · stash · merge · fetch 의 ref 갱신이 모두 여기를 지난다.
if [ "$1" = "prepared" ]; then
  echo '${GIT_WRITE_REFUSAL}' >&2
  exit 1
fi
exit 0
`;

/** pre-push: 푸시는 reference-transaction 이 보지 못하는 길이라 따로 막는다. */
const PRE_PUSH = `#!/bin/sh
# Colo Design git guard — AI 세션의 push 를 막는다 (PLAN L5).
echo '${GIT_WRITE_REFUSAL}' >&2
exit 1
`;

const GUARD_HOOKS: Record<string, string> = {
  "reference-transaction": REFERENCE_TRANSACTION,
  "pre-push": PRE_PUSH,
};

/**
 * 가드 훅 폴더를 만들고 내용이 다른 훅만 다시 쓴다 — 데몬 시작과 세션 기동이
 * 부른다(멱등). 반환은 훅 폴더의 경로 — gitGuardEnv 에 그대로 건넨다.
 */
export function ensureGitGuardHooks(dir = gitGuardHooksDir()): string {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(GUARD_HOOKS)) {
    const path = join(dir, name);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current !== content) writeFileSync(path, content, { mode: 0o755 });
  }
  return dir;
}

/**
 * AI CLI 를 띄우는 환경에 core.hooksPath 를 심는다 — 순수 함수
 * (environment.ts 의 bundledToolEnv 와 같은 자세). 기존 GIT_CONFIG_COUNT 가
 * 있으면 그 뒤에 이어 붙인다 — 도구의 gitAuthEnv 처럼 이미 GIT_CONFIG_* 를
 * 쓰는 환경과 섞여도 앞의 항목을 까먹지 않는다.
 */
export function gitGuardEnv(baseEnv: NodeJS.ProcessEnv, hooksDir: string): NodeJS.ProcessEnv {
  const existing = Number(baseEnv.GIT_CONFIG_COUNT);
  const index = Number.isInteger(existing) && existing >= 0 ? existing : 0;
  return {
    ...baseEnv,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${index}`]: hooksDir,
  };
}

// ---------------------------------------------------------------------------
// Claude PreToolUse 훅의 판정 — 순수 함수
// ---------------------------------------------------------------------------

/** 훅이 돌려주는 모양 — SDK 의 SyncHookJSONOutput 의 PreToolUse 부분. */
export interface GitGuardHookOutput {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/**
 * PreToolUse 훅의 판정 — Bash 의 git 쓰기만 deny 하고 나머지는 빈 객체로
 * 통과시킨다. bypassPermissions 에서 canUseTool 이 불리지 않으므로 이 훅이
 * Claude 의 git 게이트다 (단계 3).
 */
export function gitGuardHookDecision(
  toolName: string,
  input: Record<string, unknown>,
): GitGuardHookOutput {
  if (toolName !== "Bash") return {};
  const command = typeof input.command === "string" ? input.command : "";
  if (!gitWriteDenied(command)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: GIT_WRITE_REFUSAL,
    },
  };
}
