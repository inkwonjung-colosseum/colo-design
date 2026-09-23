/**
 * 초대 파일(`*.colo-invite`)의 읽는 쪽 — 바깥 봉투 v3(앱 내장 키의 AES-256-GCM)을
 * 열어 안쪽 JSON 을 돌려주고(normalizeInvite), 정규화된 초대장 모양으로 묶는다.
 * 쓰는 쪽은 scripts/invite-format.mjs 와 그 복사본 docs/invite-format.mjs(sealInvite),
 * 화면 잇기는 packages/web/src/components/onboarding/StartFlow.tsx 의 parseInvite 다.
 * 봉투를 못 열면 이유("sealed")만 말한다 — 비밀은 다루지 않는다.
 */

/**
 * 봉투를 가리는 앱 내장 키(32바이트, base64). scripts/invite-format.mjs 의
 * INVITE_KEY 와 같은 값이어야 한다(데몬 테스트가 확인한다). 키가 공개 페이지
 * 소스와 앱에 함께 있으므로 비밀이 아니다 — 편집기로 파일을 열었을 때 내용이
 * 읽히지 않게 하는 가림이 목적이다.
 */
const INVITE_KEY = "8KX6pm1o64K4Vsg7z1uz0wi13POfvA8ddQmH3riPYHw=";

/** 초대 파일 텍스트를 읽은 결과 — 봉투/JSON 파싱 실패는 이유로만 말한다. */
export type InviteRead = { ok: true; value: unknown } | { ok: false; reason: "json" | "sealed" };

// ---------------------------------------------------------------------------
// 안쪽 형식의 정규화 — 초대장 하나가 프로젝트 여러 개를 싣는다(안쪽 v3).
// 옛 v1/v2(단일 프로젝트가 최상위에 펴져 있던 모양)도 프로젝트 하나짜리
// 목록으로 묶어 같은 모양으로 돌려준다.
// ---------------------------------------------------------------------------

/** 정규화된 초대장의 프로젝트 한 항 — 문자열은 모두 trim 돼 있다. */
export interface InviteProject {
  repoUrl: string;
  name: string;
  baseBranch: string;
  /** E4(초대 v2): 넘긴 요청의 리뷰를 부탁할 개발자들(GitHub 로그인). */
  reviewers?: string[];
  /** 프로젝트별 지침 — 세션의 시스템 프롬프트에 붙는다. */
  instructions?: string;
  /** 개발자가 이 레포의 설치 · 미리보기 명령 실행을 미리 허용했는가. */
  approveCommands: boolean;
}

/** 정규화된 초대장 — 토큰과 프로젝트 목록이 전부다. */
export interface NormalizedInvite {
  token: string;
  authorName?: string;
  readme?: string;
  projects: InviteProject[];
}

/** normalizeInvite 의 실패 이유 — 선로 한도("limit")까지 여기서 미리 가린다. */
export type NormalizeFailure = {
  ok: false;
  reason: "version" | "token" | "projects" | "limit";
  detail?: string;
};
export type NormalizeResult = { ok: true; invite: NormalizedInvite } | NormalizeFailure;

/** 선로(project.create)가 받아들이는 한도 — 적용 중간에 선로가 거절하는 일이
 *  없게 정규화 단계에서 미리 가린다. */
const LIMITS = {
  projects: 20,
  name: 64,
  baseBranch: 128,
  reviewers: 10,
  reviewerLogin: 80,
  instructions: 10_000,
} as const;

/**
 * 레포 주소 → 짝지음의 키. packages/daemon/src/github.ts 의 parseRepoSlug 규칙을
 * 그대로 옮겼다(스킴·사용자 정보 무시, 호스트 github.com/www.github.com, 끝의
 * .git 과 / 제거, owner/repo 두 조각). 키는 `github.com/<owner>/<repo>` 소문자.
 * 정규식이 맞지 않는 주소(로컬 절대 경로 · `file://` 스킴 등)에도 대체 키를
 * 준다 — trim → 끝의 / 들 제거 → 끝의 .git 제거 → 소문자. 다시 받기에서 로컬
 * 원격이 "새로 추가"로 두 번 생기는 일이 없게 하는 것이다. 두 조각이 아닌
 * GitHub 주소(경로가 더 길거나 글자가 이름 문자집합 밖)는 null.
 */
export function repoKey(url: string): string | null {
  const trimmed = url.trim();
  // file:// 스킴은 경로로 다룬다 — "file" 이 호스트 조각이 되는 일이 없게.
  const asPath = trimmed.replace(/^file:\/\//i, "");
  // scp 방식("git@github.com:org/repo.git")은 어떤 파서도 url 로 안 읽고, https
  // 원격은 userinfo 에 PAT 을 실을 수 있다 — 둘 다 여기서 손으로 host+path 로 줄인다.
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^/:]+)[/:]+(.+)$/i.exec(asPath);
  if (match) {
    const [, host, rest] = match;
    if (host && rest) {
      const normalizedHost = host.toLowerCase();
      const path = rest.replace(/\.git$/i, "").replace(/\/+$/, "");
      if (normalizedHost === "github.com" || normalizedHost === "www.github.com") {
        const segments = path.split("/");
        if (segments.length !== 2) return null;
        const owner = segments[0];
        const repo = segments[1];
        // GitHub 의 이름 문자집합 밖이라면 읽은 것은 레포가 아니라 경로다.
        if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
        return `github.com/${owner}/${repo}`.toLowerCase();
      }
      return `${normalizedHost}/${path}`.toLowerCase();
    }
  }
  // 정규식이 못 잡는 주소 — 경로가 첫 조각이다(로컬 절대 경로 · file:// 등).
  const fallback = asPath
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  return fallback === "" ? null : fallback;
}

/** 두 레포 주소가 같은 레포인가 — repoKey 로 판정한다(null 은 어떤 것과도 같지 않다). */
export function sameRepo(a: string, b: string): boolean {
  const keyA = repoKey(a);
  const keyB = repoKey(b);
  return keyA !== null && keyA === keyB;
}

/** 배열에서 문자열만 걷어 trim·빈값 제거 — reviewers 의 옛 규칙(parseInvite)과 같다. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((login): login is string => typeof login === "string")
    .map((login) => login.trim())
    .filter((login) => login !== "");
  return list.length > 0 ? list : undefined;
}

/** trim 한 뒤 비면 undefined — 선택 문자열 필드의 공통 규칙. */
function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 한도 검사 — 어느 프로젝트의 무엇이 문제인지 한국어 한 줄로 말한다. */
function limitDetail(project: { name: string }, what: string): string {
  return `프로젝트 '${project.name}'의 ${what}`;
}

/**
 * 이름이 비었을 때의 기본값 — repoKey 의 마지막 조각(레포 이름)이 먼저다. 긴
 * 주소 전체를 이름 삼으면 옛 v2 파일이 "이름이 64자를 넘습니다"로 거절되므로,
 * 그래도 없으면(키를 못 뽑는 주소) 주소를 64자로 잘라 쓴다.
 */
function fallbackName(repoUrl: string): string {
  const last = repoKey(repoUrl)?.split("/").at(-1);
  // 마디가 이름 한도를 넘으면 자른다 — 긴 주소의 옛 파일이 "이름이 64자를
  // 넘습니다"로 거절되는 일이 없게 한다.
  return (last && last !== "" ? last : repoUrl).slice(0, LIMITS.name);
}

/**
 * 봉투 안쪽 JSON(readInviteJson 의 value) → 정규화된 초대장.
 * - v1/v2(단일 프로젝트가 최상위에 펴진 옛 모양) → 프로젝트 하나짜리 목록으로.
 *   지금 StartFlow 의 parseInvite 규칙을 그대로: name 이 비면 레포 이름
 *   (fallbackName), approveCommands 는 `!== false`, reviewers·authorName 은
 *   v2 에서만, baseBranch 없으면 "main".
 * - v3 → projects 목록을 그대로 검증한다.
 * - v 가 1·2·3 이 아니면 "version", token 이 비면 "token", 목록이 비었거나
 *   repoUrl 없는 항목이 있으면 "projects", 선로 한도를 넘으면 "limit".
 * - 같은 레포(sameRepo)가 목록에 두 번 있으면 뒤의 것을 버린다 — 한도 검사보다
 *   먼저.
 */
export function normalizeInvite(value: unknown): NormalizeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "version" };
  }
  const file = value as Record<string, unknown>;
  if (file.v !== 1 && file.v !== 2 && file.v !== 3) {
    return { ok: false, reason: "version" };
  }
  const token = trimmed(file.token);
  if (!token) return { ok: false, reason: "token" };

  // 옛 v1/v2 는 프로젝트 필드가 최상위에 펴져 있다 — 하나짜리 목록으로 묶는다.
  const rawProjects: unknown[] =
    file.v === 3 ? (Array.isArray(file.projects) ? file.projects : []) : [file];
  if (rawProjects.length === 0) {
    return { ok: false, reason: "projects", detail: "초대장에 프로젝트가 없습니다" };
  }

  const projects: InviteProject[] = [];
  for (const raw of rawProjects) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: "projects", detail: "프로젝트 항목이 올바르지 않습니다" };
    }
    const entry = raw as Record<string, unknown>;
    const repoUrl = trimmed(entry.repoUrl);
    if (!repoUrl) {
      return { ok: false, reason: "projects", detail: "레포 주소가 없는 프로젝트가 있습니다" };
    }
    const name = trimmed(entry.name) ?? fallbackName(repoUrl);
    const baseBranch = trimmed(entry.baseBranch) ?? "main";
    const reviewers =
      file.v === 1
        ? undefined // v1 은 리뷰어를 실은 적이 없다 — parseInvite 규칙 그대로.
        : stringList(entry.reviewers);
    const instructions = file.v === 3 ? trimmed(entry.instructions) : undefined;
    projects.push({
      repoUrl,
      name,
      baseBranch,
      ...(reviewers ? { reviewers } : {}),
      ...(instructions ? { instructions } : {}),
      approveCommands: entry.approveCommands !== false,
    });
  }

  // 같은 레포가 두 번 있으면 뒤의 것을 버린다 — 초대장은 레포 단위로 짝지는다.
  // 한도보다 먼저: 중복까지 세어 21개로 거절되는 일이 없게 한다.
  const seen = new Set<string>();
  const unique = projects.filter((project) => {
    const key = repoKey(project.repoUrl) ?? project.repoUrl;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 선로 한도 — 적용(project.create) 중간에 거절당하지 않게 여기서 가린다.
  if (unique.length > LIMITS.projects) {
    return {
      ok: false,
      reason: "limit",
      detail: `프로젝트는 최대 ${LIMITS.projects}개까지입니다`,
    };
  }
  for (const project of unique) {
    if (project.name.length > LIMITS.name) {
      return {
        ok: false,
        reason: "limit",
        detail: limitDetail(project, `이름이 ${LIMITS.name}자를 넘습니다`),
      };
    }
    if (project.baseBranch.length > LIMITS.baseBranch) {
      return {
        ok: false,
        reason: "limit",
        detail: limitDetail(project, `기본 가지가 ${LIMITS.baseBranch}자를 넘습니다`),
      };
    }
    if (project.reviewers) {
      if (project.reviewers.length > LIMITS.reviewers) {
        return {
          ok: false,
          reason: "limit",
          detail: limitDetail(project, `리뷰어가 ${LIMITS.reviewers}명을 넘습니다`),
        };
      }
      const tooLong = project.reviewers.find((login) => login.length > LIMITS.reviewerLogin);
      if (tooLong) {
        return {
          ok: false,
          reason: "limit",
          detail: limitDetail(project, `리뷰어 '${tooLong.slice(0, 20)}'가 80자를 넘습니다`),
        };
      }
    }
    if (project.instructions && project.instructions.length > LIMITS.instructions) {
      return {
        ok: false,
        reason: "limit",
        detail: limitDetail(project, `지침이 ${LIMITS.instructions}자를 넘습니다`),
      };
    }
  }

  return {
    ok: true,
    invite: {
      token,
      ...(file.v !== 1 && trimmed(file.authorName) ? { authorName: trimmed(file.authorName) } : {}),
      ...(trimmed(file.readme) ? { readme: trimmed(file.readme) } : {}),
      projects: unique,
    },
  };
}

/**
 * 초대장의 프로젝트마다 벌일 일을 정한다 — sameRepo 로 기존 프로젝트와 짝지어
 * 갱신(update)할지 새로 추가(add)할지를 가린다. 짝이 없으면 add, repoUrl 이
 * 없는 기존 프로젝트는 짝이 될 수 없다. 초대장의 순서를 지킨다.
 */
export type InviteRow =
  | { project: InviteProject; action: "add" }
  | { project: InviteProject; action: "update"; slug: string; currentName: string };

export function planInviteRows(
  invite: NormalizedInvite,
  projects: Array<{ slug: string; name: string; repoUrl?: string | null }>,
): InviteRow[] {
  return invite.projects.map((project) => {
    const match = projects.find(
      (existing) =>
        typeof existing.repoUrl === "string" && sameRepo(existing.repoUrl, project.repoUrl),
    );
    return match
      ? { project, action: "update", slug: match.slug, currentName: match.name }
      : { project, action: "add" };
  });
}

/** base64 → 바이트. atob 바이트 루프 — 브라우저와 Node 19+ 양쪽에서 돈다. */
function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** v3 봉투인가 — v 가 3 이면 봉투를 자임한다(iv·data 없으면 봉투가 깨진 것이다). */
function isSealedEnvelope(value: unknown): value is { v: 3; iv: string; data: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const envelope = value as { v?: unknown; iv?: unknown; data?: unknown };
  return envelope.v === 3;
}

/**
 * 초대 파일 한 장의 텍스트 → 안쪽 JSON 값.
 * - JSON.parse 실패 → reason "json".
 * - v3 봉투 → 복호화 → JSON.parse. 이 중 어떤 실패든 reason "sealed".
 * - v3 가 아니면 파싱한 값을 그대로 돌려준다 — 옛 평문 v1/v2 파일이 이미 보내진
 *   초대장으로 계속 열려야 하므로.
 */
export async function readInviteJson(text: string): Promise<InviteRead> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "json" };
  }
  if (!isSealedEnvelope(parsed)) return { ok: true, value: parsed };
  try {
    const envelope = parsed as { iv?: unknown; data?: unknown };
    if (typeof envelope.iv !== "string" || typeof envelope.data !== "string") {
      return { ok: false, reason: "sealed" };
    }
    const key = await crypto.subtle.importKey("raw", base64ToBytes(INVITE_KEY), "AES-GCM", false, [
      "decrypt",
    ]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.data),
    );
    return { ok: true, value: JSON.parse(new TextDecoder().decode(plain)) };
  } catch {
    return { ok: false, reason: "sealed" };
  }
}
