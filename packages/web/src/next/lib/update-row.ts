/**
 * 업데이트 줄 한 줄의 판정(PLAN-UI U12) — 앱 · Claude Code · Codex 가 같은
 * 판정을 지나 같은 모양으로 선다. 문장은 labels.ts(L.update)를 인자로 받는다:
 * 시험이 src 에서 곧장 읽는 순수 모듈이라 형제를 부르지 않기 때문이다
 * (journey.ts 와 같은 규칙). `최신이에요` 초록 표식은 문장이 아니라 그림이라
 * 부르는 쪽(state === "latest")이 단다.
 */
import { hasNewerVersion, plainDotted } from "./version.ts";

/** 상태 필드 — `DaemonStatus.providers[]` 한 행과 `agentUpdates` 한 칸을 합친 모양. */
export interface UpdateToolInput {
  /** 프로바이더 id — `claude` · `codex` (앱 줄은 부르는 쪽이 이름을 붙인다). */
  id: string;
  /** 현재 버전(모르면 null — 앱은 확인 전까지 모른다). */
  version: string | null;
  /** 확인해 둔 새 버전 — 모르면 null. */
  latestVersion: string | null;
  /** 이 실행의 업데이트 지금 — 없으면 키가 없다. */
  phase?: "pending" | "running" | "done" | "failed";
  /** 단계에 들어선 시각(ISO). */
  at?: string;
  /** 끝난 업데이트가 깐 버전. */
  versionAfter?: string;
  /** 실패의 한국어 한 줄. */
  detail?: string;
}

/** 줄의 상태 — 오른쪽 끝에 무엇이 서는지가 이 값으로 정해진다. */
export type UpdateRowState = "latest" | "available" | "pending" | "running" | "failed" | "unknown";

export interface UpdateRowCopy {
  state: UpdateRowState;
  /** 왼쪽의 판정 문장 — `2.1.4 → 2.2.0 있어요` · `2.1.4` · `현재 2.1.4`. */
  version: string;
  /** 판정 아래의 한 줄 — `11:27에 업데이트했어요` · 미루기 문장 · 실패의 이유. */
  note: string | null;
  /** 오른쪽 끝의 단추. */
  action: "update" | "retry" | "none";
}

/** 판정 문장에 쓰는 칸 — `L.update` 가 구조적으로 채운다. */
export interface UpdateRowLabels {
  available: (from: string, to: string) => string;
  doneAt: (time: string) => string;
  deferred: string;
  current: (version: string) => string;
}

/** `11:27` — 목업의 hhmm 과 같은 24시간 넉 자리. */
export function hhmm(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 한 도구의 줄 판정 — 상태에서만 나온다. */
export function updateRowCopy(tool: UpdateToolInput, t: UpdateRowLabels): UpdateRowCopy {
  const current = plainDotted(tool.version);
  const latest = plainDotted(tool.latestVersion);
  if (tool.phase === "running")
    return { state: "running", version: current ?? "", note: null, action: "none" };
  if (tool.phase === "pending")
    return { state: "pending", version: current ?? "", note: t.deferred, action: "none" };
  if (tool.phase === "failed")
    return { state: "failed", version: current ?? "", note: tool.detail ?? null, action: "retry" };
  if (tool.phase === "done") {
    const version = plainDotted(tool.versionAfter) ?? current ?? latest ?? "";
    const time = tool.at ? hhmm(tool.at) : "";
    return {
      state: "latest",
      version,
      note: time ? t.doneAt(time) : null,
      action: "none",
    };
  }
  if (current && latest && hasNewerVersion(tool.version, tool.latestVersion))
    return {
      state: "available",
      version: t.available(current, latest),
      note: null,
      action: "update",
    };
  if (current && latest) return { state: "latest", version: current, note: null, action: "none" };
  // 최신 버전을 아직 모르는 줄 — 「현재 2.1.4」 만 보인다(PLAN-UI P1).
  return {
    state: "unknown",
    version: current ? t.current(current) : "",
    note: null,
    action: "none",
  };
}

/** 홈의 `방금 있던 일` 한 줄 — 도구가 AI 프로그램을 새 버전으로 바꿨다(U12 · J6). */
export interface AgentUpdateEvent {
  id: string;
  text: string;
  /** 끝난 시각(ms) — 줄의 순서와 `n분 전` 이 읽는다. */
  at: number;
}

/**
 * `DaemonStatus.agentUpdates` 에서 끝난(done) 업데이트만 한 줄씩 — 이름은 프로바이더
 * 목록의 `label`(없으면 id), 버전을 모르는 끝은 줄이 서지 않는다. 최신이 맨 위.
 */
export function agentUpdateEvents(
  updates: Partial<Record<string, { phase: string; at: string; version?: string }>> | undefined,
  providers: ReadonlyArray<{ id: string; label: string }> | undefined,
  doneEvent: (name: string, version: string) => string,
): AgentUpdateEvent[] {
  if (!updates) return [];
  return Object.entries(updates)
    .flatMap(([id, state]) => {
      if (state?.phase !== "done" || !state.version) return [];
      const name = providers?.find((provider) => provider.id === id)?.label ?? id;
      return [
        {
          id,
          text: doneEvent(name, plainDotted(state.version) ?? state.version),
          at: Date.parse(state.at) || 0,
        },
      ];
    })
    .sort((a, b) => b.at - a.at);
}

/** `지금 확인` 이 남긴 문장의 상태(W5) — 찾은 새 버전의 수(0이면 「모두 최신이에요」). */
export interface CheckNote {
  text: string;
  found: number;
}

/**
 * 확인 문장이 제 자리를 비워야 하나(W5 · 콜드 리뷰 N7) — 「새 버전 N개 · 방금 확인」은
 * 끝난 일을 아직 있다고 말하는 문장이라, 업데이트가 끝났거나 새 버전이 더 없으면
 * 지운다. 「모두 최신이에요」(found 0)는 여전히 사실이므로 그대로 둔다.
 */
export function shouldClearCheckNote(
  note: CheckNote | null,
  agentUpdates: Partial<Record<string, { phase: string }>> | undefined,
  providers: ReadonlyArray<{ version?: string | null; latestVersion?: string | null }>,
): boolean {
  if (note === null || note.found === 0) return false;
  if (Object.values(agentUpdates ?? {}).some((state) => state?.phase === "done")) return true;
  return !providers.some((tool) => hasNewerVersion(tool.version, tool.latestVersion));
}
