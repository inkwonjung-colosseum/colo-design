import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * 첨부의 드라이버 공통 준비 (혼합 첨부). 어떤 SDK 도 임의 바이너리 콘텐츠
 * 블록은 받지 않으므로, 첨부는 세 갈래로 나뉜다:
 *
 * - `image/*` → 비전 블록 (각 드라이버의 기존 경로).
 * - 디코드되는 텍스트 → 턴의 말에 인라인 섹션으로.
 * - 그 밖의 것(PDF·zip·대용량 텍스트) → 디스크에 적고 경로를 말로 건넨다.
 *   에이전트는 어차피 파일 도구를 갖고 있으므로 이 길이 전 프로바이더에서
 *   동작한다.
 */

/** 인라인으로 실을 수 있는 텍스트 첨부의 상한 — 그 너머는 디스크로 간다. */
const MAX_INLINE_BYTES = 256 * 1024;
/** 디스크에 적은 첨부의 수명 — 다음 적을 때 함께 거둔다. */
const STAGED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TurnAttachment {
  name: string;
  mediaType: string;
  /** base64, without the data-url prefix. */
  data: string;
}

export interface PreparedAttachments {
  /** Vision blocks, in attach order — each driver maps these to its own shape. */
  images: TurnAttachment[];
  /**
   * Text sections to append to the turn's words: inlined text files and
   * the disk paths of staged binaries, one `<attachment>` block each.
   */
  sections: string[];
}

/** NUL 이 없고 UTF-8 로 온전히 디코드되는 것만 텍스트다 — PDF 의 %PDF 머리도 NUL 을 품는다. */
function looksText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * 첨부가 놓이는 곳. git 저장소라면 `.git` 안 — git status 가 보지 않는
 * 유일한 작업실 내부 공간이다(워크트리의 `.git` 파일은 파일이므로 폴백으로).
 * 그 밖의 cwd 는 숨김 `.colo-design/` 아래.
 */
function attachmentDir(cwd: string): string {
  try {
    const git = join(cwd, ".git");
    if (statSync(git).isDirectory()) return join(git, "colo-design-attachments");
  } catch {
    // .git 이 없거나 읽을 수 없다 — 폴백으로.
  }
  return join(cwd, ".colo-design", "attachments");
}

/** 파일명은 계획자가 붙인 이름을 닮되 경로 밖의 문자는 걸러낸다. */
function safeName(name: string): string {
  const cleaned = basename(name)
    .replace(/[^\w.\-가-힣]/gu, "_")
    .slice(0, 80);
  return cleaned || "attachment";
}

/** 지난 첨부를 거둔다 — 실패는 다음 적기로 미룬다(첨부 하나가 쓸모를 다한 뒤의 청소일 뿐). */
function prune(dir: string): void {
  try {
    const cutoff = Date.now() - STAGED_TTL_MS;
    for (const entry of readdirSync(dir)) {
      try {
        if (statSync(join(dir, entry)).mtimeMs < cutoff) rmSync(join(dir, entry), { force: true });
      } catch {
        // 한 파일의 청소 실패가 첨부 전체를 막지는 않는다.
      }
    }
  } catch {
    // 디렉터리 자체를 읽지 못하면 거둘 것도 없다.
  }
}

/** 바이너리 첨부를 디스크에 적고 절대 경로를 돌려준다. */
function stage(cwd: string, name: string, bytes: Buffer): string {
  const dir = attachmentDir(cwd);
  mkdirSync(dir, { recursive: true });
  prune(dir);
  const path = join(dir, `${Date.now()}-${safeName(name)}`);
  writeFileSync(path, bytes);
  return path;
}

/**
 * 첨부 목록을 비전 블록과 말 섹션으로 나눈다. 순서는 붙인 순서대로 —
 * 계획자가 나열한 것이 에이전트가 읽는 것이다.
 */
export function prepareAttachments(
  cwd: string,
  attachments: TurnAttachment[] | undefined,
): PreparedAttachments {
  const images: TurnAttachment[] = [];
  const sections: string[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.mediaType.startsWith("image/")) {
      images.push(attachment);
      continue;
    }
    const bytes = Buffer.from(attachment.data, "base64");
    const type = attachment.mediaType || "application/octet-stream";
    if (bytes.length <= MAX_INLINE_BYTES && looksText(bytes)) {
      const body = bytes.toString("utf8");
      sections.push(
        `<attachment name="${attachment.name}" type="${type}">\n${body}\n</attachment>`,
      );
      continue;
    }
    const path = stage(cwd, attachment.name, bytes);
    sections.push(
      `<attachment name="${attachment.name}" type="${type}" path="${path}">첨부 파일이 이 경로에 저장됐습니다 — 파일 도구로 읽어 주세요.</attachment>`,
    );
  }
  return { images, sections };
}

/** 턴의 말과 첨부 섹션을 한 문장으로 합친다 — 첨부만 있는 턴도 말이 비지 않는다. */
export function composeTurnText(text: string, prepared: PreparedAttachments): string {
  if (prepared.sections.length === 0) return text;
  const body = prepared.sections.join("\n\n");
  return text.trim() === "" ? body : `${text}\n\n${body}`;
}
