import { useState } from "react";
import type { Daemon } from "../../lib/daemon-client";

/**
 * 개발자 에스컬레이션 (슬라이스 5): AI 가 고칠 수 없는 환경 실패(토큰 만료 ·
 * 푸시 권한 · 첫 넘기기 실패)가 나면 개발자 채널로 알리는 Slack 연결.
 * GitHub 토큰 폼과 같은 규율 — 쓰기 전용: 값은 이 컴퓨터의 자격 증명 저장소에만
 * 살고 다시 보이지 않는다. 두 가지 붙는 법을 다 받는다: incoming webhook URL,
 * 또는 봇 토큰 + 채널. 상태(연결됨/끔) 한 줄만 늘 보이고 상세 폼은 기본
 * 접힘 — 연결할 손이 폼을 찾을 때만 펼쳐진다(F4).
 */
export function EscalationForm({
  daemon,
  disabled = false,
}: {
  daemon: Daemon;
  /** 설정은 데몬 없이도 그려진다 — 그 자리에서는 아무것도 못 한다. */
  disabled?: boolean;
}) {
  const [mode, setMode] = useState<"webhook" | "bot">("webhook");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const configured = daemon.status?.escalationConfigured === true;

  const save = async () => {
    setBusy(true);
    setError(null);
    setLine(null);
    try {
      await daemon.api.escalationSet(
        mode === "webhook"
          ? { kind: "webhook", url: url.trim() }
          : { kind: "bot", token: token.trim(), channel: channel.trim() },
      );
      setUrl("");
      setToken("");
      setChannel("");
      setLine("저장했습니다.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    setLine(null);
    try {
      await daemon.api.escalationTest();
      setLine("시험 메시지를 보냈습니다 — 슬랙에서 확인해 주세요.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    setBusy(true);
    setError(null);
    setLine(null);
    try {
      await daemon.api.escalationSet(null);
      setLine("끕니다 — 환경 실패 알림이 더는 나가지 않습니다.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSave =
    !busy &&
    !disabled &&
    (mode === "webhook"
      ? url.trim().length > 0
      : token.trim().length > 0 && channel.trim().length > 0);

  return (
    <div className="ghtoken">
      {/* 상태 한 줄은 접힘 밖에 — 열기 전에 연결됨/끔이 먼저 읽힌다. */}
      <p className="settings__statusline" aria-live="polite">
        {configured ? "연결됨" : "끔"}
      </p>
      {/* 상세 폼은 기본 접힘(F4) — 연결할 손이 있을 때만 펼쳐지는 길이다.
          설정(알림 방)의 고정 자리에서도 폼이 먼저 눈에 들이치지 않게. */}
      <details className="settings__fold">
        <summary>{configured ? "설정 바꾸기" : "연결하기"}</summary>
        <div className="ghtoken__row" role="radiogroup" aria-label="Slack 연결 방식">
          <button
            type="button"
            className={mode === "webhook" ? "primary" : "ghost"}
            aria-pressed={mode === "webhook"}
            onClick={() => setMode("webhook")}
          >
            웹훅 주소
          </button>
          <button
            type="button"
            className={mode === "bot" ? "primary" : "ghost"}
            aria-pressed={mode === "bot"}
            onClick={() => setMode("bot")}
          >
            봇 토큰
          </button>
        </div>
        {mode === "webhook" ? (
          <div className="ghtoken__row">
            <input
              type="password"
              value={url}
              spellCheck={false}
              autoComplete="off"
              placeholder="https://hooks.slack.com/services/…"
              aria-label="Slack 웹훅 주소"
              disabled={busy || disabled}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && url.trim() && !busy) void save();
              }}
            />
          </div>
        ) : (
          <div className="ghtoken__row">
            <input
              type="password"
              value={token}
              spellCheck={false}
              autoComplete="off"
              placeholder="xoxb-…"
              aria-label="Slack 봇 토큰"
              disabled={busy || disabled}
              onChange={(e) => setToken(e.target.value)}
            />
            <input
              type="text"
              value={channel}
              spellCheck={false}
              autoComplete="off"
              placeholder="#개발-알림"
              aria-label="알림 받을 슬랙 채널"
              disabled={busy || disabled}
              onChange={(e) => setChannel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSave) void save();
              }}
            />
          </div>
        )}
        <div className="ghtoken__row">
          <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? "보내는 중…" : "저장"}
          </button>
          <button
            type="button"
            disabled={!configured || busy || disabled}
            onClick={() => void test()}
          >
            시험 보내기
          </button>
          <button
            type="button"
            disabled={!configured || busy || disabled}
            onClick={() => void forget()}
          >
            끄기
          </button>
        </div>
        <p className="hint">
          저장한 순간부터 토큰 만료 · 넘기기 실패 같은 AI 도 고칠 수 없는 문제가 이 채널로 갑니다.
          웹훅은 Slack 앱의 Incoming Webhooks 에서, 봇 토큰은 chat:write 권한으로 만듭니다. 값은 이
          컴퓨터의 자격 증명 저장소에만 있고 다시 보이지 않습니다.
        </p>
        {line && (
          <p className="settings__statusline" aria-live="polite">
            {line}
          </p>
        )}
        {error && (
          <div className="notice notice--error">
            <span className="notice__text">{error}</span>
          </div>
        )}
      </details>
    </div>
  );
}
