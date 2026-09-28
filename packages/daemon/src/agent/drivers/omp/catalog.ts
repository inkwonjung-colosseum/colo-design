import { type EffortLevel, effortLevelSchema, type SessionModelInfo } from "@nova-design/protocol";

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
 * 베이스↔빠른 변종(`-fast` 접미어)의 짝 — 같은 프로바이더 안에서 `x` 와
 * `x-fast` 가 함께 오면 둘을 한 쌍으로 묶어 양방향으로 적는다.
 * `fusion-...-high-fast-sidekick-...` 처럼 이름 가운데 fast 가 들어간 행은
 * 이 규칙의 변종이 아니다(끝맺는 `-fast` 만 본다).
 */
export function fastPairs(rows: Wire[]): Map<string, string> {
  const selectors = new Set(
    rows
      .map((m) => {
        const provider = String(m.provider ?? "");
        const modelId = String(m.id ?? m.name ?? "");
        return provider && modelId ? `${provider}/${modelId}` : modelId;
      })
      .filter((value) => value !== ""),
  );
  const pairs = new Map<string, string>();
  for (const sel of selectors) {
    if (!sel.endsWith("-fast")) continue;
    const base = sel.slice(0, -"-fast".length);
    if (!selectors.has(base)) continue;
    pairs.set(sel, base);
    pairs.set(base, sel);
  }
  return pairs;
}

/**
 * One omp catalog row — two sources speak it. The CLI's `omp models --json`
 * answer is trimmed (`thinking` is the effort array itself), the live RPC's
 * `get_available_models` hands back whole Model objects (`thinking` is
 * `{mode, efforts, defaultLevel, …}`). One mapping serves both the session's
 * picker and the driver's session-less listing; the two sources answering
 * with different vocabularies would be the one way a pre-session pick could
 * miss the session that has to run it.
 *
 * 빠른 변종(`X Fast`) 행은 목록에서 접는다 — 빠르게는 모델이 아니라 ⚡ 칩의
 * 토글이므로, 행 하나 더가 같은 모듈을 두 번 세게 한다(2026-09-28).
 * `keepFastValue` 로 세션이 지금 도는 변종은 남긴다 — 칩의 앞말과 토글의
 * on 상태가 그 행을 읽으므로, 접으면 켜진 빠르게를 끌 버튼이 사라진다.
 */
export function ompModelRows(rows: Wire[], keepFastValue?: string): SessionModelInfo[] {
  const pairs = fastPairs(rows);
  return rows
    .filter((m) => {
      const provider = String(m.provider ?? "");
      const modelId = String(m.id ?? m.name ?? "");
      const value = provider && modelId ? `${provider}/${modelId}` : modelId;
      return !(modelId.endsWith("-fast") && pairs.has(value) && value !== keepFastValue);
    })
    .map((m) => {
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
        // 빠른 변종이 있는 모델(세션은 모델 바꿈으로 빠르게를 켠다 — devin 은
        // service tier 가족 밖이라 set_fast_mode 가 거절된다)이거나, tier 를
        // 받는 가족의 모델이 ⚡ 칩을 연다.
        supportsFastMode: supportsFastMode(m) || pairs.has(value),
      };
    });
}
