import { type EffortLevel, effortLevelSchema, type SessionModelInfo } from "@colo-design/protocol";

type Wire = Record<string, unknown>;

/**
 * 빠르게(service tier)를 받는 모델인가 — omp 의 `serviceTierFamily` 를 카탈로그
 * 행이 들고 있는 것만으로 다시 판정한다. omp 쪽 규칙: openai · openai-codex 는
 * openai 가족, `anthropic-messages` api 는 (Bedrock·Vertex 위의 Claude 까지)
 * anthropic 가족, google · google-vertex 는 google 가족, openrouter 는 id 의
 * 네임스페이스로 가른다. 가족이 없으면 `/fast` 가 "이 모델에서는 쓸 수 없다"로
 * 거절한다(실측) — 그 거절을 토글이 눌린 뒤에 보여 주지 않으려고 행이 미리
 * 말한다.
 *
 * `omp models --json` 행에는 `api` 도 `identity` 도 없으므로 provider 로만
 * 판정하고, 라이브 행(`get_available_models`)은 둘을 갖고 오므로 그대로 쓴다.
 */
function supportsFastMode(row: Wire): boolean {
  const provider = String(row.provider ?? "");
  const id = String(row.id ?? "");
  if (provider === "openrouter") return /^(anthropic|google|openai)\//.test(id);
  if (provider === "openai" || provider === "openai-codex") return true;
  if (row.api === "anthropic-messages" || provider === "anthropic") return true;
  if (provider === "google" || provider === "google-vertex") return true;
  // Bedrock·Vertex 위의 Claude 는 provider 가 아니라 api 가 가족을 정한다 —
  // 카탈로그 행에는 api 가 없으니 id 로 마지막 한 번 본다.
  return /^(amazon-bedrock|google-vertex)$/.test(provider) && /claude/.test(id);
}

/**
 * One omp catalog row — two sources speak it. The CLI's `omp models --json`
 * answer is trimmed (`thinking` is the effort array itself), the live RPC's
 * `get_available_models` hands back whole Model objects (`thinking` is
 * `{mode, efforts, defaultLevel, …}`). One mapping serves both the session's
 * picker and the driver's session-less listing; the two sources answering
 * with different vocabularies would be the one way a pre-session pick could
 * miss the session that has to run it.
 */
export function ompModelRows(rows: Wire[]): SessionModelInfo[] {
  return rows.map((m) => {
    const provider = String(m.provider ?? "");
    const modelId = String(m.id ?? m.name ?? "");
    const value = provider && modelId ? `${provider}/${modelId}` : modelId;
    const thinking = m.thinking as Wire | unknown[] | null | undefined;
    const raw = Array.isArray(thinking)
      ? thinking
      : Array.isArray((thinking as Wire | null)?.efforts)
        ? ((thinking as Wire).efforts as unknown[])
        : null;
    // omp 의 단계는 우리 어휘보다 넓다(off · minimal · auto). 고르개가 보낼 수
    // 없는 값을 목록에 세우면 누른 순간 거절당하는 줄이 된다.
    const efforts =
      raw === null
        ? null
        : (raw
            .map(String)
            .filter((level) => effortLevelSchema.safeParse(level).success) as EffortLevel[]);
    return {
      value,
      displayName: String(m.name ?? modelId),
      resolvedModel: modelId || null,
      // omp 의 목록은 설명 문장을 주지 않는다. omp 자체 picker 가 행마다
      // 보조 텍스트로 대는 것도 이 문자열 — 공급자까지 붙은 id 다. 표시
      // 이름만으로는 같은 이름이 공급자마다 겹치는 목록에서 행을 구별할
      // 수 없다.
      description: value,
      supportsEffort: m.reasoning === true && (efforts === null || efforts.length > 0),
      supportedEffortLevels: efforts,
      supportsFastMode: supportsFastMode(m),
    };
  });
}
