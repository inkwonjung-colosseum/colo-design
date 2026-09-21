import { useState } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { KeyIcon } from "../icons";

/**
 * GitHub 의 fine-grained 토큰 만들기 페이지 — 개발자용 접힘 안의 링크가 쓴다.
 * 코드를 개발자가 발급해 주는 세계가 이 도구의 기본이므로 링크는 예비 길이다.
 */
const GITHUB_FINE_GRAINED_URL = "https://github.com/settings/personal-access-tokens/new";

/**
 * 기계 전체의 GitHub 연결 코드 — 마법사의 github 게이트와 설정이 같은 폼으로
 * 묻는다. 개발자가 발급해 준 코드를 붙여 넣는 칸이 본체고, 직접 만드는 길은
 * `개발자용` 접힘 뒤에 있다. Write-only: 데몬이 저장하고 다시 보여주지 않으므로
 * 칸은 항상 비어서 시작하고, 거절된 코드의 초안은 한 번 더 시도할 수 있게 살아
 * 남는다 — 긴 코드를 오타 때문에 다시 받아 적는 일이 이 폼이 지우려는 마찰이다.
 */
export function GitHubTokenForm({
  daemon,
  onDone,
  disabled = false,
}: {
  daemon: Daemon;
  /** Runs only after the daemon accepted the token (the gate passed). */
  onDone?: () => void;
  /** 설정 renders the form before any daemon exists; nothing can reach one. */
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      // The reply is the recomputed gate, so a refused token arrives as a
      // failed step, not as a thrown request.
      const step = await daemon.api.githubTokenSet(draft.trim());
      if (step.status !== "pass") {
        setError(step.detail);
      } else {
        setDraft("");
        onDone?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ghtoken">
      <p className="hint ghtoken__lead">개발자가 준 연결 코드를 붙여 넣으세요.</p>
      <div className="ghtoken__row">
        <span className="ic ic--quiet">
          <KeyIcon />
        </span>
        <input
          type="password"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder="붙여넣기"
          aria-label="GitHub 연결 코드"
          disabled={busy || disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim() && !busy) void connect();
          }}
        />
        <button
          type="button"
          className="primary"
          disabled={!draft.trim() || busy || disabled}
          onClick={() => void connect()}
        >
          {busy ? "연결하는 중…" : "연결"}
        </button>
      </div>
      <p className="hint">
        코드는 이 컴퓨터의 자격 증명 저장소에만 있고 다시 보이지 않습니다. 만료되면 개발자에게 새
        코드를 요청해 여기에 다시 붙여 넣으면 됩니다.
      </p>
      {/* 직접 발급은 개발자의 길이다 — 기본 눈길에서 치운다(P1-4). 링크를 살리는
          순간에도 classic scopes URL 이 아니라 fine-grained 만들기 페이지로. */}
      <details className="ghtoken__dev">
        <summary>개발자용 ▾</summary>
        <p className="hint">
          직접 발급:{" "}
          <a className="ghlink" href={GITHUB_FINE_GRAINED_URL} target="_blank" rel="noreferrer">
            fine-grained 토큰 만들기 ↗
          </a>{" "}
          — 대상 레포만 지정하고 Contents · Pull requests 쓰기 권한을 주세요. GitHub 계정이 없다면{" "}
          <a className="ghlink" href="https://github.com/signup" target="_blank" rel="noreferrer">
            가입하기 ↗
          </a>
          .
        </p>
      </details>
      {error && (
        <div className="notice notice--error">
          <span className="notice__text">{error}</span>
        </div>
      )}
    </div>
  );
}
