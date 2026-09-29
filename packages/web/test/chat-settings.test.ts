import assert from "node:assert/strict";
import { test } from "node:test";
// 순수 모듈 — src 에서 곧장 읽는다(next-thread.test.ts 와 같은 모양).
import { type ChatSettings, switchProviderPatch, withChatPick } from "../src/lib/settings.ts";

const chat: ChatSettings = {
  provider: "claude",
  model: "opus",
  effort: "medium",
  fastMode: false,
  disabledProviders: [],
  showTools: false,
  showThinking: false,
  midturn: "queue",
};

test("withChatPick: ⚡ 선택 — 같은 프로바이더는 몫으로, 다른 프로바이더는 곁으로", () => {
  // 같은 프로바이더 — 다음 세션의 선택(top-level)으로 남는다.
  const on = withChatPick(chat, "claude", { fast: true });
  assert.equal(on.fastMode, true);
  // 다른 프로바이더의 ⚡ 는 byProvider 에 격리된다 — claude 의 선택이 오염되지 않는다.
  const other = withChatPick(chat, "codex", { fast: true });
  assert.equal(other.fastMode, undefined);
  assert.equal(other.byProvider?.codex?.fast, true);
  // 이미 곁 행이 있으면 ⚡ 만 조용히 더해진다.
  const kept = withChatPick(
    { ...chat, byProvider: { codex: { model: "gpt-5.5", effort: null } } },
    "codex",
    { fast: true },
  );
  assert.equal(kept.byProvider?.codex?.model, "gpt-5.5");
  assert.equal(kept.byProvider?.codex?.fast, true);
  // 끄면 ⚡ 만 사라지고 모델 선택은 남는다.
  const off = withChatPick(kept, "codex", { fast: false });
  assert.equal(off.byProvider?.codex?.model, "gpt-5.5");
  assert.equal(off.byProvider?.codex?.fast, undefined);
});

test("switchProviderPatch: ⚡ 선택도 모델 · 생각 시간과 함께 자리를 바꿔 싣는다", () => {
  // claude 에서 ⚡ 를 켠 채 codex 로 옮기면 — codex 의 곁 행이 없으니 꺼진 채로
  // 시작하고, claude 의 선택은 곁에 남는다.
  const away = switchProviderPatch({ ...chat, fastMode: true }, "codex");
  assert.equal(away.provider, "codex");
  assert.equal(away.fastMode, false);
  assert.equal(away.byProvider?.claude?.fast, true);
  // 다시 claude 로 돌아오면 곁의 ⚡ 가 몫으로 돌아온다.
  const back = switchProviderPatch({ ...chat, ...away }, "claude");
  assert.equal(back.fastMode, true);
  assert.equal(back.byProvider?.claude, undefined);
});
