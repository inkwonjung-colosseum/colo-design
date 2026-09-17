import type { SessionModelInfo } from "@colo-design/protocol";

type Wire = Record<string, unknown>;

/**
 * One omp catalog row — the live RPC's `get_available_models` and the CLI's
 * `omp models --json` speak the same shape, so one mapping serves both the
 * session's picker and the driver's session-less listing. The two sources
 * answering with different vocabularies would be the one way a pre-session
 * pick could miss the session that has to run it.
 */
export function ompModelRows(rows: Wire[]): SessionModelInfo[] {
  return rows.map((m) => {
    const provider = String(m.provider ?? "");
    const modelId = String(m.id ?? m.name ?? "");
    const value = provider && modelId ? `${provider}/${modelId}` : modelId;
    const thinking = (m.thinking ?? null) as Wire | null;
    const efforts = Array.isArray(thinking?.efforts)
      ? (thinking.efforts as unknown[]).map(String)
      : null;
    return {
      value,
      displayName: String(m.name ?? modelId),
      resolvedModel: modelId || null,
      // omp 의 목록은 설명 문장을 주지 않는다. omp 자체 picker 가 행마다
      // 보조 텍스트로 대는 것도 이 문자열 — 공급자까지 붙은 id 다. 표시
      // 이름만으로는 같은 이름이 공급자마다 겹치는 목록에서 행을 구별할
      // 수 없다.
      description: value,
      supportsEffort: m.reasoning === true,
      supportedEffortLevels: efforts as SessionModelInfo["supportedEffortLevels"],
      supportsFastMode: true,
    };
  });
}
