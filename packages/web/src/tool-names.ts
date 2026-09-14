import type { RepoStatus } from "@colo-design/protocol";

export { PLAN_TOOL, toolLabel } from "@colo-design/protocol";

/** The commands the clone resolved to, as RepoStatus carries them. */
type RepoCommands = NonNullable<RepoStatus["commands"]>;

/**
 * Korean object particle for a label whose ending we cannot control (PLAN
 * D37): 받침 있는 글자 뒤엔 `을`, 없으면 `를`. Non-hangul falls to `를`.
 */
export function objectParticle(word: string): string {
  const last = word.codePointAt(word.length - 1) ?? 0;
  const hangul = last >= 0xac00 && last <= 0xd7a3;
  return hangul && (last - 0xac00) % 28 !== 0 ? "을" : "를";
}

const GATE_LABEL: Record<keyof RepoCommands, string> = {
  install: "설치 실행",
  check: "레포 검사",
  build: "빌드 검사",
  preview: "미리보기 실행",
};

/**
 * The headline a Bash row leads with (PLAN D37): a command that IS one of the
 * repo's own resolved commands reads as that job; anything else keeps the raw
 * command, because `rm -rf` and `pnpm check` must never look alike.
 */
export function bashHeadline(command: string, commands?: RepoCommands): string {
  const trimmed = command.trim();
  if (commands) {
    for (const key of ["check", "build", "install", "preview"] as const) {
      const value = commands[key];
      if (value && trimmed === value.trim()) return GATE_LABEL[key];
    }
  }
  return trimmed;
}
