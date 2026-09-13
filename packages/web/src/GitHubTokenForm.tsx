import { useState } from "react";
import type { Daemon } from "./daemon-client";

/** GitHub's own form, with the name and `repo` scope this tool needs pre-filled. */
const TOKEN_URL = "https://github.com/settings/tokens/new?description=Colo%20Design&scopes=repo";

/**
 * The machine-wide GitHub token, as the wizard's `github` gate and 설정 both
 * ask for it. Write-only: the daemon stores it and never echoes it back, so
 * the field always starts empty — and a 연결 the gate refuses keeps the draft
 * for one more try, because re-pasting a 40-character token to fix a typo is
 * exactly the friction this form exists to remove.
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
      <div className="ghtoken__row">
        <input
          type="password"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder="ghp_…"
          aria-label="GitHub 개인 액세스 토큰"
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
        <a className="ghlink" href={TOKEN_URL} target="_blank" rel="noreferrer">
          토큰 만들기 ↗
        </a>
      </div>
      <p className="hint">
        값은 이 컴퓨터의 자격 증명 저장소에만 있고 다시 보이지 않습니다. 토큰에는 만료일이 있으니,
        만들 때 만료를 '없음'으로 두면 다시 연결할 일이 줄고, 끊기면 다시 연결하면 됩니다.
      </p>
      <p className="hint">
        GitHub 계정이 없다면{" "}
        <a className="ghlink" href="https://github.com/signup" target="_blank" rel="noreferrer">
          가입하기 ↗
        </a>{" "}
        — 가입은 1분이면 됩니다.
      </p>
      {error && (
        <div className="notice notice--error">
          <span className="notice__text">{error}</span>
        </div>
      )}
    </div>
  );
}
