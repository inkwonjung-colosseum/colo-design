// 치워둔 작업의 자동 꺼내기: 치워두기·꺼내기 단추는 v0.3.11 에서 사라졌지만
// v0.3.8~v0.3.10 에 그 단추로 치워 둔 작업이 슬롯(refs/colo-design/shelf)에
// 남아 있을 수 있다 — 꺼낼 길이 없는 채로. 시작 쓸기(recoverParkedWork 옆)가
// 그것을 조용히 되살린다.
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type RepoCore, SHELF_REF } from "./repo-core.js";

/** git 실행의 최소 계약 — RepoCore.git 과 테스트의 execFile 이 같은 몫을 한다. */
export type GitRun = (args: string[]) => Promise<string>;

/**
 * 자동 꺼내기의 본문 — git 실행 함수와 루트만 받는 순수한 모양(테스트가 진짜
 * git 레포로 돌린다). 절대 예외를 던지지 않는다: 시작 시점에는 이것을 들려줄
 * 대화가 없다.
 *
 *  - 슬롯이 없으면 `"none"`.
 *  - 병합 중이거나 · 충돌 파일이 있거나 · 작업 폴더가 깨끗하지 않으면 아무것도
 *    건드리지 않고 `"kept"`.
 *  - 슬롯의 패치(`SHELF_REF^..SHELF_REF`, 옛 unshelve 와 같은
 *    `--no-renames --full-index --binary`)가 `git apply --check` 를 통과하지
 *    못하면 역시 아무것도 바꾸지 않고 `"kept"` — 부분 적용도 표식도 없다.
 *  - 깨끗하면 얹고(--index 없이 작업 폴더에만 — 다음 턴의 자동 보관이
 *    커밋한다) ref 를 지우고 `"restored"`.
 */
export async function recoverShelfPatch(
  run: GitRun,
  root: string,
): Promise<"none" | "restored" | "kept"> {
  try {
    await run(["rev-parse", "-q", "--verify", SHELF_REF]);
  } catch {
    return "none";
  }
  // 내려앉을 자리의 확인 — 클론이 없는 경우는 호출자(ShelfStore)가 이미
  // 걸렀고, 여기는 병합 · 충돌 · 더러운 작업 폴더를 본다.
  try {
    await run(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return "kept"; // 병합이 정리를 기다리는 중
  } catch {
    /* 병합 아님 — 계속한다. */
  }
  const landable = await (async () => {
    if ((await run(["diff", "--name-only", "--diff-filter=U"])).trim() !== "") return false;
    return (await run(["status", "--porcelain"])).trim() === "";
  })().catch(() => false);
  if (!landable) return "kept";
  // 패치는 `.git/` 아래 파일로 — 슬롯 스스로가 untracked 화면이 되지 않게(옛
  // unshelve 와 같은 자리). `--full-index` 는 정확한 적용의 재료를,
  // `--binary` 는 화면 변경이 실고 온 그림을 싣는다.
  const patchFile = join(root, ".git", `colo-design-shelf-recover-${randomUUID()}.patch`);
  try {
    const patch = await run([
      "diff",
      "--no-renames",
      "--full-index",
      "--binary",
      `${SHELF_REF}^`,
      SHELF_REF,
    ]);
    writeFileSync(patchFile, patch);
    // --check 는 3way 없이: `--3way` 는 충돌을 병합 표식으로 "성공"시키는
    // 시도지 판정이 아니다. 깨끗하게 얹히는 문맥인지 이 한 번이 말한다.
    await run(["apply", "--check", patchFile]);
    await run(["apply", patchFile]);
    await run(["update-ref", "-d", SHELF_REF]);
    return "restored";
  } catch {
    // --check 를 통과한 뒤의 실패는 디스크 수준의 세계 — 슬롯은 그대로 두고
    // 다음 시작이 다시 시도한다.
    return "kept";
  } finally {
    rmSync(patchFile, { force: true });
  }
}

export class ShelfStore {
  constructor(private readonly core: RepoCore) {}

  /**
   * 치워둔 작업 자동 꺼내기 — 시작 쓸기(recoverParkedWork 다음)가 부른다.
   * 쓸기는 매 시작마다 돌므로 오늘 `"kept"` 인 슬롯은 작업 폴더가 깨끗해진
   * 다음 시작에 다시 시도된다. 대화가 없는 시점이므로 브리프도 예외도 없다 —
   * 결과는 서버의 로그 한 줄로만 남는다.
   */
  async recoverShelf(): Promise<"none" | "restored" | "kept"> {
    if (!this.core.isCloned()) return "none";
    // 꺼내기는 차선의 recover 칸에 선다(PLAN L1) — 패치 적용이 작업 트리와
    // refs 를 움직이므로 저장·최신화와 한 줄에 서고, 시작 쓸기의 이웃한
    // 복구(recoverParkedWork)와도 순서가 저절로 잡힌다. 옛 shelving 슬롯의
    // 손 기다림은 지운다.
    return await this.core.lane
      .run("recover", async () => {
        const outcome = await recoverShelfPatch((args) => this.core.git(args), this.core.root);
        if (outcome === "restored") {
          await this.core.refreshPendingChanges();
          this.core.emit();
        }
        return outcome;
      })
      .catch((): "kept" => "kept");
  }
}
