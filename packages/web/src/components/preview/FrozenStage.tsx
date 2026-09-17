import type { HandoffPreviewInfo } from "@colo-design/protocol";
import { type ReactNode, useEffect, useState } from "react";
import type { Daemon } from "../../lib/daemon-client";

/**
 * 보낸 화면 동결 (preview.md §1-E): the stage's frozen face. The host —
 * `children` — always renders underneath so the native view's slot never
 * moves; what changes is what sits over it.
 *
 * - `mode: "sent"` + a shot: the committed capture covers the view —
 *   `data-cover-stage` is the existing z-order rule (`usePreviewCover`), so
 *   the native view hides and freezes behind it, and the iframe path just
 *   gets an `<img>` on top. The picture is '보낸 그대로': a later commit on
 *   the branch does not move it.
 * - `mode: "sent"` + 실제로 열기: 시점 빌드 재현 (§3 2단계) — the daemon
 *   serves the handoff branch's tip in a throwaway worktree on a second
 *   port, and an `<iframe>` rides ABOVE the capture in the same cover. The
 *   capture stays underneath the whole time: it paints while the build
 *   boots, and it stays if the build refuses to come up (the capture is
 *   this stage's floor, not its failure).
 * - `mode: "sent"` without a shot: nothing covers — the live view stays and
 *   the stamp alone says what was sent (`보낸 화면 캡처 없음` is a tooltip,
 *   not a button: 눌러도 없는 것은 버튼이 아니다).
 * - `mode: "live"`: the live view, with the stamp — and the `[보낸 화면 |
 *   지금 화면]` segment when a shot exists to walk back to.
 *
 * The bar sits above the stage inside the flex column, so the view's bounds
 * shrink honestly — the native view follows its slot, no cover needed for
 * the bar itself.
 */

/**
 * What the real build is doing. `on` carries the daemon's answer verbatim —
 * the port and the exact loopback url it probed (a port alone cannot say
 * which loopback family bound it) — and the commit it checked out.
 */
type RealBuild =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "on"; url: string; port: number; commit: string | null }
  | { phase: "failed"; detail: string };

export function FrozenStage({
  shot,
  stamp,
  tone,
  mode,
  onMode,
  api = null,
  sessionId = null,
  children,
}: {
  /** The committed capture — `api.handoffShot`'s answer. Null: no shot. */
  shot: { mediaType: string; data: string } | null;
  /** The stamp's words — `{시각}에 보낸 화면`, `실제 앱 · 반영된 화면`, … */
  stamp: string;
  /** The stamp's color — `info` while waiting, `ok` for 반영됨, `warn` for 반려. */
  tone: "info" | "ok" | "warn";
  /** Which face the stage wears. `sent` without a shot still shows live. */
  mode: "sent" | "live";
  /** The segment's ask — absent when there is no shot to walk back to. */
  onMode?: (mode: "sent" | "live") => void;
  /**
   * The daemon api, for 시점 빌드 재현. Null (or a daemon without the
   * member yet) simply means the button is not there — the capture alone
   * still tells the frozen story.
   */
  api?: Daemon["api"] | null;
  /**
   * The conversation that owns this stage — the daemon ties the worktree
   * build's life to it: its close reaps the worktree and the port.
   */
  sessionId?: string | null;
  children: ReactNode;
}) {
  const covered = mode === "sent" && shot !== null;
  const [real, setReal] = useState<RealBuild>({ phase: "idle" });
  // 지금 화면으로 돌아오면 실제 빌드의 창도 같이 걷힌다 — 상태는 남겨 둔다:
  // 다시 보낸 화면으로 오면 이미 떠 있던 빌드의 포트가 즉시 다시 그려진다.
  useEffect(() => {
    if (mode !== "sent") setReal((prev) => (prev.phase === "on" ? prev : { phase: "idle" }));
  }, [mode]);

  const openReal = () => {
    if (!api || real.phase === "starting") return;
    // 이미 떠 있는 창을 닫는 누름이다 — 닫으면 캡처가 다시 얼굴이 된다.
    if (real.phase === "on") {
      setReal({ phase: "idle" });
      return;
    }
    setReal({ phase: "starting" });
    const ask: Promise<HandoffPreviewInfo> =
      "handoffPreview" in api && typeof api.handoffPreview === "function"
        ? api.handoffPreview(sessionId)
        : Promise.resolve({
            port: null,
            ready: false,
            commit: null,
            url: null,
            detail: "이 데몬은 넘긴 시점의 실제 빌드를 아직 지원하지 않습니다.",
          });
    void ask
      .then((info) => {
        if (info.ready && info.url !== null && info.port !== null) {
          setReal({ phase: "on", url: info.url, port: info.port, commit: info.commit });
        } else {
          setReal({
            phase: "failed",
            detail:
              info.detail ?? "실제 빌드를 띄우지 못했습니다 — 넘긴 시점의 캡처로 보여 드립니다.",
          });
        }
      })
      .catch((error: unknown) => {
        setReal({
          phase: "failed",
          detail:
            error instanceof Error && error.message !== ""
              ? `${error.message} — 넘긴 시점의 캡처로 보여 드립니다.`
              : "실제 빌드를 띄우지 못했습니다 — 넘긴 시점의 캡처로 보여 드립니다.",
        });
      });
  };

  return (
    <>
      <div className="frozenbar">
        <span
          className={`frozenbar__stamp frozenbar__stamp--${tone}`}
          title={
            mode === "sent" && !shot ? "보낸 화면 캡처 없음 — 지금 화면을 보고 있어요" : undefined
          }
        >
          {stamp}
        </span>
        {shot !== null && onMode && (
          <div className="frozenbar__seg" role="group" aria-label="보기 전환">
            <button
              type="button"
              className={
                mode === "sent" ? "frozenbar__segbtn frozenbar__segbtn--on" : "frozenbar__segbtn"
              }
              aria-pressed={mode === "sent"}
              onClick={() => onMode("sent")}
            >
              보낸 화면
            </button>
            <button
              type="button"
              className={
                mode === "live" ? "frozenbar__segbtn frozenbar__segbtn--on" : "frozenbar__segbtn"
              }
              aria-pressed={mode === "live"}
              onClick={() => onMode("live")}
            >
              지금 화면
            </button>
          </div>
        )}
        {api !== null && mode === "sent" && shot !== null && (
          <button
            type="button"
            className={
              real.phase === "on" ? "frozenbar__real frozenbar__real--on" : "frozenbar__real"
            }
            title={
              real.phase === "failed"
                ? real.detail
                : real.phase === "on"
                  ? "실제 빌드를 닫고 넘긴 시점의 캡처로 돌아갑니다"
                  : "넘긴 시점의 실제 빌드를 이 자리에 띄웁니다 — 준비는 몇십 초가 걸릴 수 있어요. 그동안은 캡처가 보입니다."
            }
            disabled={real.phase === "starting"}
            onClick={openReal}
          >
            {real.phase === "starting"
              ? "띄우는 중…"
              : real.phase === "on"
                ? "실제 앱 닫기"
                : "실제로 열기"}
          </button>
        )}
      </div>
      <div className="preview__viewwrap">
        {children}
        {covered && (
          <div className="frozenshot" data-cover-stage="">
            {/* 캡처는 늘 바닥에 깔린다 — 빌드가 뜨는 동안과 실패한 때의 얼굴. */}
            <img
              className="frozenshot__img"
              src={`data:${shot.mediaType};base64,${shot.data}`}
              alt="넘긴 시점의 화면"
            />
            {real.phase === "on" && (
              <iframe
                className="frozenshot__real"
                src={real.url}
                title={`넘긴 시점의 실제 빌드 (포트 ${real.port})`}
              />
            )}
            {real.phase === "starting" && (
              <div className="frozenshot__realwait" role="status">
                넘긴 시점의 실제 빌드를 띄우는 중… 캡처를 보여 드리고 있어요.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
