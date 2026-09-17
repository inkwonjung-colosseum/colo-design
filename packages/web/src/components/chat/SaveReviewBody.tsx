/**
 * 저장 검토의 몸통 (구 panels/DiffPanel.tsx — docs/plan/states.md §2.1 "그릇
 * 바뀜, 내용 승계"): 요약(`summarizeDiff` — claude/fallback), 저장 메모
 * 프리필(AI 제안만), `자세히 보기` 폴드(파일·훈크), 저장의 세 걸음 레일,
 * push-stalled 재시도 문장. 검토만으로는 아무것도 나가지 않는다 — [저장] 버튼은
 * 살아있는 카드(§4.1)가 쥐고, 이 몸통은 읽을 거리만 운반한다. 메모 값은
 * 호출부(ChatColumn)가 소유해 저장 호출에 실어 보낸다.
 */
import { type DiffFile, fallbackSummary } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import type { Daemon, DiffSummary } from "../../lib/daemon-client";
import { ChevronRightIcon, MinusIcon, PlusIcon, SparkIcon } from "../icons";
import { FILE_STATUS_LABEL, RUNNING, SAVE_STEPS, saveStep, stageLine } from "../panels/DiffPanel";
import { Tip } from "../shell/Tip";

function FileRow({ file }: { file: DiffFile }) {
  // Even a single hunk stays folded until the row is pressed: the row —
  // status, name, how much moved — is the reading unit (비개발자 저장
  // 검토), and raw code is one click away, never the first thing shown.
  const [open, setOpen] = useState(false);
  const added = file.hunks.reduce(
    (total, hunk) =>
      total + hunk.lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    0,
  );
  const removed = file.hunks.reduce(
    (total, hunk) =>
      total + hunk.lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    0,
  );
  // The planner reads names, not paths: the file's own name leads and the
  // folder it lives in follows muted — the full path stays on the tooltip.
  const slash = file.path.lastIndexOf("/");
  const basename = slash === -1 ? file.path : file.path.slice(slash + 1);
  const dir = slash === -1 ? null : file.path.slice(0, slash);

  return (
    <li className={`diff__file${file.status === "deleted" ? " diff__file--deleted" : ""}`}>
      <button
        type="button"
        className="diff__filerow"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`ic ic--quiet ic--sm diff__chevron${open ? " diff__chevron--open" : ""}`}>
          <ChevronRightIcon />
        </span>
        <span className={`diff__badge diff__badge--${file.status}`}>
          {FILE_STATUS_LABEL[file.status]}
        </span>
        <span className="diff__path" title={file.path}>
          <span className="diff__basename">{basename}</span>
          {dir && <span className="diff__dir">{dir}</span>}
        </span>
        <Tip
          label={
            file.binary
              ? "내용을 글로 보여 줄 수 없는 파일입니다"
              : `${added}줄이 더해지고 ${removed}줄이 지워집니다`
          }
        >
          <span className="diff__count">
            {file.binary ? (
              "바이너리"
            ) : added === 0 && removed === 0 ? (
              "—"
            ) : (
              <>
                {added > 0 && (
                  <>
                    <span className="ic ic--ok ic--sm">
                      <PlusIcon />
                    </span>
                    {added}{" "}
                  </>
                )}
                {removed > 0 && (
                  <>
                    <span className="ic ic--danger ic--sm">
                      <MinusIcon />
                    </span>
                    {removed}
                  </>
                )}
              </>
            )}
          </span>
        </Tip>
      </button>
      {open && !file.binary && (
        <div className="diff__hunks">
          {file.hunks.map((hunk, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: hunk 의 index 가 곧 문서 순서다 — 매 렌더 전체가 다시 그려진다.
            <pre key={index} className="diff__hunk">
              <code>
                <span className="diff__line diff__line--head">{hunk.header}</span>
                {hunk.lines.map((line, lineIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 줄의 index 가 곧 hunk 안의 순서다.
                  <span key={lineIndex} className={`diff__line ${hunkLineClass(line)}`}>
                    {line}
                  </span>
                ))}
              </code>
            </pre>
          ))}
        </div>
      )}
    </li>
  );
}

/** 한 줄이 입는 색 — 더해진 줄·지워진 줄·머리글·나머지(맥락·`\` 메모). */
function hunkLineClass(line: string): string {
  if (line.startsWith("+")) return "diff__line--add";
  if (line.startsWith("-")) return "diff__line--del";
  if (line.startsWith("\\")) return "diff__line--meta";
  return "";
}

/** What a diff was when its summary was written — path, kind, and how much moved. */
function diffKey(files: DiffFile[]): string {
  return files
    .map((file) => {
      const added = file.hunks.reduce(
        (total, hunk) =>
          total +
          hunk.lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
        0,
      );
      const removed = file.hunks.reduce(
        (total, hunk) =>
          total +
          hunk.lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
        0,
      );
      return `${file.status}:${file.path}:+${added}:-${removed}`;
    })
    .join("|");
}

/**
 * The summary is asked once per diff, not once per open of the review — the
 * card outlives the ask in the tape, so the cache lives beside the bodies.
 * agent-sourced answers only: the fallback is a local count, never worth
 * remembering over a real summary.
 */
const summaryCache = new Map<string, DiffSummary & { source: "claude" }>();

export interface SaveReviewBodyProps {
  daemon: Daemon;
  /** 저장 메모 — 호출부 소유(저장 호출에 실어 보낸다), 이 몸통은 채워 주기만 한다. */
  memo: string;
  onMemo: (text: string) => void;
}

export function SaveReviewBody({ daemon, memo, onMemo }: SaveReviewBodyProps) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  /** The memo on screen is the agent.s suggestion until the planner types. */
  const [memoAi, setMemoAi] = useState(false);
  /** Once the planner edits the note, the summary stops filling it. */
  const memoTouched = useRef(false);
  const diffStatus = daemon.diffStatus;
  /**
   * The calls ride the STABLE `api` object, not the `daemon` prop: the client
   * hands out a fresh wrapper every render, and a websocket message landing
   * while this card is open would otherwise cancel an in-flight summarize —
   * a real agent turn, paid for again — and ask it from scratch.
   */
  const { api } = daemon;
  const running = diffStatus !== null && RUNNING.includes(diffStatus.stage);
  const failed = diffStatus?.stage === "failed";

  // The list is a snapshot of what a 저장 would write; reload it whenever one
  // settles, because a success means the worktree is clean now.
  useEffect(() => {
    if (running) return;
    let cancelled = false;
    void api
      .diff()
      .then((next) => !cancelled && setFiles(next))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [api, running]);

  // The summary follows the diff: one `repo.summarize` ask, cached by what the
  // diff was. Three seconds in, the planner reads the local fallback — a slow
  // answer still replaces it when it lands (the 폴백 is a display
  // floor, not a cancel).
  useEffect(() => {
    if (!files || files.length === 0) {
      setSummary(null);
      setSummarizing(false);
      return;
    }
    const key = diffKey(files);
    const cached = summaryCache.get(key);
    if (cached) {
      setSummary(cached);
      setSummarizing(false);
      return;
    }
    let cancelled = false;
    setSummary(null);
    setSummarizing(true);
    const fallbackTimer = window.setTimeout(() => {
      if (!cancelled) setSummary({ lines: fallbackSummary(files), source: "fallback" });
    }, 3_000);
    api
      .summarizeDiff()
      .then((next) => {
        if (cancelled) return;
        setSummary(next);
        if (next.source === "claude") {
          summaryCache.set(key, {
            lines: next.lines,
            ...(next.memo ? { memo: next.memo } : {}),
            source: "claude",
          });
          // A save review is read, not surfed; a bounded cache is enough.
          if (summaryCache.size > 16) {
            const oldest = summaryCache.keys().next().value;
            if (oldest !== undefined) summaryCache.delete(oldest);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setSummary({ lines: fallbackSummary(files), source: "fallback" });
      })
      .finally(() => {
        clearTimeout(fallbackTimer);
        if (!cancelled) setSummarizing(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
    };
  }, [api, files]);

  // The note opens filled with the memo the summary turn proposed (비개발자
  // 저장 검토) — a sentence written to be a memo, not the summary's first
  // line borrowed into the job. An answer without one still opens on the
  // first line, the pre-memo behaviour. Only the agent.s words fill it: a
  // fallback grouping (`screens: 수정 1`) is a count, not a memo, and an
  // empty note means the agent writes the memo at 저장. Their own keystrokes
  // win from then on. A settled save clears the field from the caller —
  // an empty field re-arms the prefill for the next cycle.
  useEffect(() => {
    if (memo !== "") return;
    memoTouched.current = false;
    setMemoAi(false);
  }, [memo]);
  useEffect(() => {
    if (memoTouched.current) return;
    if (summary?.source !== "claude") return;
    const suggestion = summary.memo ?? summary.lines[0];
    if (suggestion) {
      onMemo(suggestion);
      setMemoAi(true);
    }
  }, [summary, onMemo]);
  /** 폴백 요약은 숫자 묶음일 뿐 메모가 못 된다 — 프리필은
   *  하지 않는 현 규칙 그대로, 대신 커서를 직접 메모로 옮긴다. 사람의 한
   *  줄이 기본 문약("화면 변경")보다 낫다. */
  const memoRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (summary?.source === "fallback" && !memoTouched.current) memoRef.current?.focus();
  }, [summary]);

  // The rail only tells a save's story — 넘기기 stages belong to the other
  // card, and a settled save reads better as the tape's 저장했어요 card than
  // as a rail with every light lit.
  const step = diffStatus ? saveStep(diffStatus) : { index: -1, failed: false };
  const showRail = step.index >= 0 && diffStatus?.stage !== "published";
  /** 삭제는 되돌리기 어려운 변경 — 요약이 말하지 않아도 검토가 말한다. */
  const deletedCount = files?.filter((file) => file.status === "deleted").length ?? 0;
  /** commit·push 실패는 대화로 넘어간다 — 멈춘 게 아니라 고쳐지는 중. */
  const handedToAgent =
    failed &&
    diffStatus?.reason !== "push-auth" &&
    (diffStatus?.gate === "commit" || diffStatus?.gate === "push");
  /**
   * 묶기는 끝났고 올리기에서 멈춘 저장 (비개발자 저장 검토): the commit
   * landed, so the worktree is clean and the diff is empty — and the empty
   * review's own line ("저장할 변경사항이 없습니다") would tell the planner
   * their finished work never happened. 저장 is a push retry in that state
   * (repo.ts runSave), so the card's 다시 시도 stays pressable.
   */
  const pushStalled = failed && files !== null && files.length === 0;

  return (
    <div className="savereview">
      {showRail && diffStatus && (
        <div className="progress__rail diff__rail" role="status" aria-label={stageLine(diffStatus)}>
          {SAVE_STEPS.map((label, index) => (
            <span
              key={label}
              className={`progress__step${
                step.failed && index === step.index
                  ? " progress__step--failed"
                  : index < step.index || (step.failed && index < step.index)
                    ? " progress__step--done"
                    : index === step.index
                      ? " progress__step--now"
                      : ""
              }`}
            >
              <span className="progress__dot">
                {step.failed && index === step.index ? "✕" : index < step.index ? "✓" : ""}
              </span>
              {label}
            </span>
          ))}
        </div>
      )}
      {failed && (
        <div className="diff__stage" role="status">
          <span className="notice__text">{stageLine(diffStatus)}</span>
        </div>
      )}
      {/* A push refused over credentials will never fix itself in a turn —
          the next move is the planner's token, so the review names it
          instead of ending at "멈췄습니다". */}
      {failed && diffStatus?.reason === "push-auth" && (
        <div className="notice notice--error" data-testid="push-auth-failure">
          <span className="notice__text">
            변경사항 정리까지 끝냈고, 올리기에서 멈췄습니다 — 설정에서 GitHub 토큰을 확인한 뒤 다시
            저장해 주세요.
          </span>
        </div>
      )}
      {/* 멈춘 게 아니라 넘어간 것 (비개발자 저장 검토): commit·push 실패는
          이미 대화의 다음 과제다 — 검토가 "멈췄습니다"로 끝내면 기획자는
          아무도 고치지 않는 줄 안다. */}
      {handedToAgent && (
        <p className="hint">
          문제는 대화로 넘겼습니다 — AI가 고치는 모습을 대화에서 볼 수 있습니다.
        </p>
      )}
      {/* The gate's own output is a developer's text: the rail above already
          says where it stopped, the raw transcript waits. */}
      {failed && diffStatus?.detail && (
        <details className="settings__fold">
          <summary>자세히</summary>
          <pre className="diff__fail">
            <code>{diffStatus.detail}</code>
          </pre>
        </details>
      )}

      {/* 요약은 검토의 본문이다 — 각주가 아니라 카드 (비개발자 저장
          검토). AI가 쓰는 동안은 자리만 흐리게 채운다. */}
      {files !== null && files.length > 0 && (
        <div className="diff__summary" data-testid="diff-summary">
          <p className="diff__summarycap">
            <span className="ic ic--sm">
              <SparkIcon />
            </span>
            {summary?.source === "claude"
              ? "AI가 바뀐 점을 읽고 적었습니다"
              : summary
                ? "바뀐 파일을 묶어 적었습니다"
                : "AI가 바뀐 점을 읽는 중…"}
          </p>
          {summary && summary.lines.length > 0 ? (
            <ul className="diff__summarylines">
              {summary.lines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 렌더마다 전체를 다시 그리는 정적 줄 목록이다.
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : (
            summarizing && (
              // 뼈대는 요약의 줄이 아니다 — 같은 선택자를 쓰면 "요약이
              // 떴다"는 판정이 기다림에 걸려 참이 된다(검사까지 속는다).
              <ul className="diff__summaryskel" aria-hidden="true">
                <li className="diff__skel" />
                <li className="diff__skel diff__skel--short" />
              </ul>
            )
          )}
        </div>
      )}

      {deletedCount > 0 && (
        <div className="notice notice--warn">
          <span className="notice__text">
            이번 저장에서 파일 {deletedCount}개가 삭제됩니다 — 아래 자세히 보기에서 확인해 주세요.
          </span>
        </div>
      )}

      {files === null && !error && <p className="hint">변경사항을 읽어 오는 중…</p>}
      {/* 묶기는 끝난 저장에게 "저장할 변경사항이 없습니다" 는
          거짓말이다 (비개발자 저장 검토): 바뀐 점은 이번 작업에 이미
          묶였고, 남은 것은 올리기뿐이다. */}
      {pushStalled && (
        <p className="hint">
          바뀐 점은 이번 작업에 묶었습니다 — 남은 것은 회사 GitHub에 올리는 일이니, 다시 저장을
          누르면 그 한 걸음만 다시 시도합니다.
        </p>
      )}
      {files !== null && files.length === 0 && !pushStalled && (
        <p className="hint">저장할 변경사항이 없습니다. 먼저 화면을 만들거나 고쳐 주세요.</p>
      )}
      {/* Paths and +/- lines live behind the fold — the first screen of the
          review reads as sentences, not as a diff. The fold stays shut until
          the planner asks, at every size: even one file of raw code read as
          noise (비개발자 저장 검토), and the summary above is the review. */}
      {files !== null && files.length > 0 && (
        <details className="settings__fold">
          <summary>자세히 보기 (파일 {files.length}개)</summary>
          <ul className="diff__files">
            {files.map((file) => (
              <FileRow key={file.path} file={file} />
            ))}
          </ul>
        </details>
      )}

      {error && (
        <div className="notice notice--error">
          <span className="notice__text">{error}</span>
        </div>
      )}

      {/* 메모 칸은 저장이 그것을 쓸 수 있을 때만 선다: 올리기의 재시도는
          커밋을 쓰지 않고(repo.ts runSave), 끝난 저장의 메모는 이미
          커밋에 실려 기록 카드의 `저장 메모:` 줄로 읽힌다 — 어느 쪽이든 고쳐도
          닿을 곳이 없는 칸이다. */}
      {!pushStalled && (
        <label className="setting setting--wide diff__memo">
          <span className="setting__text">
            <span className="setting__label">저장 메모</span>
            <span className="setting__hint">
              {memoAi
                ? "AI가 제안한 메모입니다 — 그대로 저장하거나 고쳐 주세요"
                : '비워 두면 AI가 바뀐 점을 읽고 저장 메모를 씁니다 — 못 쓰면 "화면 변경"으로 저장됩니다'}
            </span>
          </span>
          <span className="setting__control">
            <input
              ref={memoRef}
              value={memo}
              placeholder="예: 회원 관리 화면 추가"
              aria-label="저장 메모"
              disabled={running}
              onChange={(e) => {
                memoTouched.current = true;
                setMemoAi(false);
                onMemo(e.target.value);
              }}
            />
          </span>
        </label>
      )}
    </div>
  );
}
