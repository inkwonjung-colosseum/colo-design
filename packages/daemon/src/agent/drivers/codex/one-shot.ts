/**
 * Codex 의 기계 잔일 단답 턴 — `codex exec` 의 비대화형 길.
 *
 * 무도구는 codex CLI 가 내리지 못하는 보장이다. 대신 무해는 지킨다:
 * 읽기 전용 샌드박스(-s read-only — 쓰기도 네트워크도 막힌다) 에
 * 세션 기록도 남기지 않는다(--ephemeral). 프롬프트가 답의 전부이고
 * 답은 -o 파일의 마지막 메시지 하나 — 진행 출력은 stdout 에 섞이니
 * 파일이 유일한 답통로다. 시간 안에 못 내면 null (폴백).
 */

import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliOneShot } from "../../one-shot-cli.js";

/** 답이 적히는 임시 파일 — 원샷마다 하나, 읽고 나면 지운다. */
function answerFile(): string {
  return join(tmpdir(), `colo-design-one-shot-${process.pid}-${randomBytes(6).toString("hex")}`);
}

export async function codexOneShot(
  prompt: string,
  opts: { cwd: string; executable: string | null; timeoutMs: number },
): Promise<string | null> {
  if (!opts.executable) return null;
  const answer = answerFile();
  try {
    const done = await runCliOneShot(
      opts.executable,
      [
        "exec",
        "-s",
        "read-only",
        "--ephemeral",
        "--skip-git-repo-check",
        "-C",
        opts.cwd,
        // 요약 한 줄에 추론은 값싸게 — 목줄(8 초)이 이 보정을 믿는다.
        "-c",
        "model_reasoning_effort=low",
        "-o",
        answer,
        prompt,
      ],
      opts,
    );
    if (done === null) return null;
    const text = readFileSync(answer, "utf8").trim();
    return text || null;
  } catch {
    return null;
  } finally {
    rmSync(answer, { force: true });
  }
}
