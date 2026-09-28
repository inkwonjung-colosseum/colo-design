import type { RepoHistoryEntry, RepoStatus } from "@nova-design/protocol";
import { Fragment, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { L } from "../labels";
import { entryScreens, entryTitle, historyRows, revertSummary } from "../lib/revert-summary";
import { CloseIcon, SmallCheckIcon, UndoIcon } from "./icons";

/** `nx:history:open` — 정산 줄의 메뉴(단계 2)와 `이번 작업`(단계 4)이 서랍을 연다. */
export const HISTORY_OPEN_EVENT = "nx:history:open";

const pad = (n: number) => String(n).padStart(2, "0");
/** 시각 한 마디 — `14:05`. */
export function clockOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** 날의 머리 — 오늘 · 어제 · 9월 23일. */
function dayOf(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(now) - start(date)) / 86_400_000);
  if (diff === 0) return L.history.today;
  if (diff === 1) return L.history.yesterday;
  return L.history.dayOf(date.getMonth() + 1, date.getDate());
}

/**
 * 작업 기록 서랍(PLAN-UI U9) — 미리보기 위로 미끄러져 들어온다. 항목은
 * `repo.history` 그대로(제목 = 사용자의 말), 둘째 줄은 그 차례의 화면
 * (`RepoStatus.cycleScreens`), 제출의 순간은 구분선이다. 맨 위(지금 서 있는
 * 곳)를 뺀 어느 줄이든 누르면 그 자리에 확인이 열리고, 확인은 시각이 아니라
 * 제목으로 묻는다 — 뒤의 변경 수와 코멘트 반영 여부는 `revertSummary` 가 센다.
 * 되돌리기는 `repo.restore { sha }` — 새 차례로 쌓여 역사는 지워지지 않는다.
 */
export function HistoryDrawer({
  open,
  onClose,
  daemon,
  repo,
  submits,
  onRestored,
  toast,
  returnRef,
}: {
  open: boolean;
  onClose: () => void;
  daemon: Daemon;
  repo: RepoStatus | null;
  /** 이번 사이클의 제출 시각들(ISO) — 구분선의 자리. */
  submits: string[];
  /** 되돌리기가 끝났다 — 칸은 미리보기를 다시 읽는다. */
  onRestored: () => void;
  toast: (text: string) => void;
  /** 닫히면 초점이 되돌아가는 단추 — 서랍을 연 곳(시계). */
  returnRef?: RefObject<HTMLElement | null>;
}) {
  const { api } = daemon;
  const [entries, setEntries] = useState<RepoHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // 열 때마다, 그리고 새 차례가 쌓일 때마다(보관 수가 움직인다) 다시 읽는다.
  const saved = repo?.pendingChanges ?? 0;
  const branch = repo?.branch ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 여는 순간 · 새 차례 · 되돌린 뒤에 읽는다.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    api
      .saveHistory()
      .then((next) => !cancelled && setEntries(next.entries))
      .catch((cause) => {
        if (cancelled) return;
        console.error("[nova-design] history read", cause);
        setError(L.history.readFailed);
      });
    return () => {
      cancelled = true;
    };
  }, [open, api, tick, saved, branch, repo?.cycleScreens?.length]);
  useEffect(() => {
    if (!open) setConfirm(null);
  }, [open]);

  // 열리면 제목에 초점을 주고(화면 낭독기가 서랍의 이름부터 말하게), 닫히면
  // 서랍을 연 단추로 돌려 놓는다 — 초점이 문서 어딘가로 사라지게 두지 않는다.
  const title = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (open) {
      title.current?.focus();
      return;
    }
    // 닫힘으로 바뀐 때만 — 처음 그려질 때 닫힌 서랍이 초점을 가져가지 않게.
    const back = returnRef?.current;
    if (back?.isConnected) back.focus();
  }, [open, returnRef]);

  // Esc: 확인이 열려 있으면 확인을, 아니면 서랍을 닫는다 — 입력 중인 글자는 건드리지 않는다.
  const panel = useRef<HTMLElement>(null);
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, [contenteditable]") !== null;
      if (typing && !panel.current?.contains(target)) return;
      if (document.querySelector(".modal, .palette")) return;
      if (confirmRef.current === null) onClose();
      else {
        setConfirm(null);
        setError(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const restore = useCallback(
    async (entry: RepoHistoryEntry) => {
      setError(null);
      setRestoring(entry.sha);
      try {
        const result = await api.restore(entry.sha);
        if (result.stage === "failed") {
          setError(L.history.restoreFailed);
          return;
        }
        setConfirm(null);
        toast(L.history.revertedToast(clockOf(entry.at)));
        onRestored();
        await api.repoStatus().catch(() => undefined);
        setTick((n) => n + 1);
      } catch (cause) {
        console.error("[nova-design] restore", cause);
        setError(L.history.restoreFailed);
      } finally {
        setRestoring(null);
      }
    },
    [api, onRestored, toast],
  );

  const merged = repo?.handoff?.state === "merged";
  const list = entries ?? [];
  const rows = historyRows(list, submits);
  const now = new Date();
  let lastDay = "";

  return (
    <aside
      ref={panel}
      className={`nx-hist${open ? " nx-hist--open" : ""}`}
      aria-label={L.history.title}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="nx-hist-h">
        <h3 ref={title} tabIndex={-1}>
          {L.history.title}
        </h3>
        <span className="nx-grow" />
        <button
          type="button"
          className="nx-ibtn"
          title={L.history.close}
          aria-label={L.history.close}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="nx-hist-sub">{L.history.sub}</div>
      <div className="nx-hist-list">
        {entries === null && !error && <div className="nx-hist-empty">{L.history.loading}</div>}
        {entries !== null && list.length === 0 && (
          <div className="nx-hist-empty">{merged ? L.history.emptyMerged : L.history.empty}</div>
        )}
        {rows.map((row) => {
          if (row.kind === "submit") {
            return (
              <div className="nx-hsubmit" key={`submit-${row.at}`}>
                <SmallCheckIcon />
                {L.history.submittedAt(clockOf(row.at))}
                <span />
              </div>
            );
          }
          const entry = list[row.index];
          if (!entry) return null;
          const title = entryTitle(entry.message);
          const day = dayOf(entry.at, now);
          const dayHead = day !== lastDay ? day : null;
          lastDay = day;
          const current = row.index === 0;
          const screens = entryScreens(entry, repo?.cycleScreens);
          const summary = revertSummary(list, row.index, L.history.commentPrefix);
          const pick = () => {
            if (current || restoring !== null) return;
            setError(null);
            setConfirm((open) => (open === row.index ? null : row.index));
          };
          return (
            <Fragment key={entry.sha}>
              {dayHead && <div className="nx-hday">{dayHead}</div>}
              <div className={`nx-hitem${current ? " nx-hitem--cur" : ""}`}>
                <span className="nx-hd" />
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: 줄의 누름은 오른쪽 단추의 넓은 과녁이다 — 키보드는 그 단추로 닿는다. */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: 위와 같다. */}
                {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: 위와 같다. */}
                <div className="nx-hbody" onClick={pick}>
                  <div className="nx-ht">
                    <small>{clockOf(entry.at)}</small>
                    {title}
                  </div>
                  {screens.length > 0 && <div className="nx-hs">{screens.join(" · ")}</div>}
                </div>
                {!current && (
                  <button
                    type="button"
                    className="nx-btn nx-btn--sm nx-hb"
                    disabled={restoring !== null}
                    onClick={pick}
                  >
                    <UndoIcon />
                    {L.history.toHere}
                  </button>
                )}
                {confirm === row.index && (
                  <div className="nx-hconfirm" role="alertdialog" aria-label={L.history.revert}>
                    <p>{L.history.confirm(title, summary.count, summary.withComments)}</p>
                    <div className="nx-hconfirm-row">
                      <button
                        type="button"
                        className="nx-btn nx-btn--sm nx-btn--pri"
                        disabled={restoring !== null}
                        onClick={() => void restore(entry)}
                      >
                        {restoring === entry.sha ? L.history.restoring : L.history.revert}
                      </button>
                      <button
                        type="button"
                        className="nx-btn nx-btn--sm nx-btn--ghost"
                        disabled={restoring !== null}
                        // biome-ignore lint/a11y/noAutofocus: 엉뚱한 Enter 가 되돌리지 않게 기본 초점은 `그만두기` — 되돌리는 손이 직접 고른다.
                        autoFocus
                        onClick={() => {
                          setConfirm(null);
                          setError(null);
                        }}
                      >
                        {L.history.cancel}
                      </button>
                    </div>
                    {/* 되돌리기가 실패하면 그 자리에서 말한다 — 목록 바닥으로
                        흘리면 방금 누른 확인이 무엇을 말하는지 알 수 없다. */}
                    {error && <div className="nx-hist-error">{error}</div>}
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}
        {error && confirm === null && <div className="nx-hist-error">{error}</div>}
      </div>
      <div className="nx-hist-foot">{L.history.foot}</div>
    </aside>
  );
}
