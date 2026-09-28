import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DriverHooks, LaunchConfig } from "../dist/agent/driver.js";
import { OmpAgentSession } from "../dist/agent/drivers/omp/session.js";

/**
 * 스텁 omp — `--mode rpc-ui` 가 말하는 JSONL command/response 를 stdin/stdout
 * 위에서 흉내 낸다. ready 프레임 하나로 악수를 열고, 명령에는 success 응답을
 * 돌린다. 변종 짝(catalog)과 부탁의 분기(setFastMode)가 이 테스트의 대상이다.
 */
function stubAgentScript(): string {
  return `
import { createInterface } from "node:readline";
let model = { provider: "devin", id: "claude-opus-5" };
const answer = (msg, data) =>
  process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: true, data }) + "\\n");
const refuse = (msg, error) =>
  process.stdout.write(JSON.stringify({ type: "response", id: msg.id, command: msg.type, success: false, error }) + "\\n");
process.stdout.write(JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  switch (msg.type) {
    case "negotiate_protocol": return answer(msg, {});
    case "get_state": return answer(msg, { sessionId: "stub-session", model, thinkingLevel: "medium" });
    case "get_available_models":
      return answer(msg, { models: [
        { provider: "devin", id: "claude-opus-5", name: "Claude Opus 5", reasoning: true, thinking: ["low","medium","high"] },
        { provider: "devin", id: "claude-opus-5-fast", name: "Claude Opus 5 Fast", reasoning: true, thinking: ["low","medium","high"] },
        { provider: "devin", id: "gpt-5-5", name: "GPT 5.5", reasoning: true, thinking: ["low","medium","high"] },
      ] });
    case "set_model": model = { provider: msg.provider, id: msg.modelId }; return answer(msg, {});
    case "set_fast_mode": return refuse(msg, "fast tier not available for devin");
    default: return answer(msg, {});
  }
});
`;
}

const hooks = (fast: { on: boolean | null }) =>
  ({
    onEvent: () => undefined,
    onTransportEnd: () => undefined,
    onTransportError: () => undefined,
    decidePermission: async () => "allow",
    onFastMode: (on) => {
      fast.on = on;
    },
  }) as unknown as DriverHooks;

function launch(cwd: string): LaunchConfig {
  return { cwd, sessionId: "s-test", model: null, effort: null, appendSystemPrompt: null };
}

test("⚡ 부탁은 `-fast` 변종으로의 모델 바꿈으로 답하고, 토글 상태가 그 몸을 따라간다", async () => {
  const dir = join(tmpdir(), `omp-stub-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "stub-omp.mjs");
  writeFileSync(script, stubAgentScript());
  const fast = { on: null as boolean | null };
  const session = new OmpAgentSession(process.execPath, launch(dir), hooks(fast), [script]);
  try {
    // 카탈로그를 한 번 읽어야 짝 지도가 선다 — 세션의 models() 가 채운다.
    const rows = await session.models();
    assert.equal(
      rows.some((r) => r.value === "devin/claude-opus-5-fast"),
      false,
    );
    assert.equal(rows.find((r) => r.value === "devin/claude-opus-5")?.supportsFastMode, true);

    // 켜기 — devin 은 티어 가족 밖이라 RPC 는 거절한다; 변종 바꿈이 대신 선다.
    await session.setFastMode(true);
    assert.equal(fast.on, true);
    // 변종으로 도는 몸은 목록에서 접히지 않는다 — 칩의 앞말과 ⚡ on 판독의 행이다.
    const running = await session.models();
    assert.equal(
      running.some((r) => r.value === "devin/claude-opus-5-fast"),
      true,
    );

    // 끄기 — 변종에서 베이스로 돌아오고 꺼짐을 보고한다.
    await session.setFastMode(false);
    assert.equal(fast.on, false);
    const back = await session.models();
    assert.equal(
      back.some((r) => r.value === "devin/claude-opus-5-fast"),
      false,
    );
  } finally {
    await session.close().catch(() => undefined);
  }
});
