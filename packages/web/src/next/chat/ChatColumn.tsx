import type { SessionPinHint } from "@colo-design/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PinAttachment } from "../../hooks/usePins";
import type { Attachment } from "../../lib/attachment";
import { koreanNoticeWords } from "../../lib/error-words";
import { pinsToTurn } from "../../lib/preview-turns";
import { isToolRunning } from "../../lib/progress";
import { openScreenPath, screenPath } from "../../lib/screen-link";
import { tailMoving } from "../../lib/tape-visibility";
import type { TurnScreen } from "../../lib/turn-screens";
import { L } from "../labels";
import { isPreparing } from "../lib/project-note";
import { dedupeScreens } from "../lib/thread";
import type { ChatColumnProps } from "../slots";
import { Elapsed } from "../status/Elapsed";
import { Composer, type ComposerHandle } from "./Composer";
import { AskCard } from "./cards";
import { ChevIcon, SparkIcon } from "./icons";
import { Thread } from "./Thread";

/**
 * 대화 칸(PLAN-UI 단계 2) — 문제 문장 · 대화록(카드 · `고친 화면` · 정산 줄) ·
 * 확인 카드 · 진행 시계 · 입력창. 훅은 셸이 한 번 부른 것을 받는다(`SlotProps`) —
 * 미리보기 칸과 같은 세션 · 같은 핀을 본다.
 *
 * 밖으로 나가는 신호 둘: `nx:history:open`(작업 기록 서랍 — 단계 3 이 듣는다),
 * `nx:pins:toggle`(좁은 창의 찍기 — 미리보기 탭을 앞에 세운 뒤 단계 3 이 찍기를 켠다).
 * 들어오는 신호 둘(입력창이 듣는다): `nx:pins:send`(말풍선의 지금 보내기) ·
 * `nx:composer:attach`(미리보기의 AI에게 이 화면 보여 주기).
 */
export function ChatColumn({
  daemon,
  settings,
  sessions,
  pins,
  project,
  nav,
  narrow,
}: ChatColumnProps) {
  const { api, pending, resolvePending } = daemon;
  const { active, activeId } = sessions;
  const blocks = active?.blocks ?? [];
  const chat = settings.chat;
  const preparing = project !== null && isPreparing(project);

  // 좁은 창이면 미리보기 탭을 앞에 세운 뒤 옮긴다 — 옮긴 곳이 보여야 한다.
  const openScreen = useCallback(
    (screen: TurnScreen) => {
      if (narrow) nav.showTab("preview");
      if (!openScreenPath(screen.path)) {
        void window.coloDesignDesktop?.preview?.navigate?.(screen.path);
      }
    },
    [narrow, nav],
  );

  // 보낸 핀의 회색 배지는 답이 끝나면 떠난다 — 답의 끝을 아는 것은 이 칸이다.
  const wasRunning = useRef(sessions.running);
  useEffect(() => {
    if (wasRunning.current && !sessions.running) pins.dismissGhosts();
    wasRunning.current = sessions.running;
  }, [sessions.running, pins]);

  // --- 멈추기 ----------------------------------------------------------
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!sessions.running) setStopping(false);
  }, [sessions.running]);
  const stop = () => {
    if (!activeId) return;
    setStopping(true);
    void api.interrupt(activeId).catch(() => setStopping(false));
  };

  // --- 보내기: 글 · 첨부 · 핀이 한 턴 ---------------------------------------
  const send = async (
    text: string,
    attachments: Attachment[],
    sent: PinAttachment[],
    shown: Array<{ screen: string }>,
  ) => {
    // 핀의 크롭은 그림으로 함께 간다 — 맨 앞에 세운다(데몬이 앞 여섯 장을 카드 썸네일로 쓴다).
    const pinImages: Attachment[] = sent.slice(0, 6).flatMap((pin) =>
      pin.shot
        ? [
            {
              kind: "image" as const,
              name: `pin-${pin.id}.jpg`,
              mediaType: pin.shot.mediaType,
              data: pin.shot.data,
              size: 0,
            },
          ]
        : [],
    );
    // 핀의 정체를 데이터로도 싣는다 — 데몬이 클론에서 `파일 후보:` 를 찾는다.
    const hints: SessionPinHint[] = sent.map((pin) => ({
      id: pin.id,
      screen: pin.screen,
      ...(pin.element.kind === "region"
        ? {}
        : {
            ...(pin.element.text ? { text: pin.element.text } : {}),
            ...(pin.element.owners?.length ? { owners: pin.element.owners } : {}),
            ...(pin.element.attrs?.testId ? { testId: pin.element.attrs.testId } : {}),
          }),
    }));
    // 핀으로 처음 여는 대화는 첫 핀의 화면 이름을 얻는다 — 화면 id(`index` ·
    // `member/list`)가 아니라 사람의 이름으로: 첫 화면, 아니면 이번 작업의 화면
    // 제목. 둘 다 모르면 데몬의 자리 표시(새 화면)에 맡긴다(단계 8 에서 봄).
    const first = !activeId ? sent[0] : undefined;
    const firstPath = first ? screenPath(first.screen) : null;
    const name =
      firstPath === null
        ? undefined
        : firstPath === "/"
          ? L.preview.homeScreen
          : (daemon.repo?.cycleScreens?.find(
              (s) => s.title.trim() && screenPath(s.route) === firstPath,
            )?.title ?? undefined);
    await sessions.submit(
      sent.length > 0 ? pinsToTurn(sent, text, () => null) : text,
      [...pinImages, ...attachments],
      { name },
      dedupeScreens([...sent.map((pin) => ({ screen: pin.screen })), ...shown]),
      sent.length > 0 ? hints : undefined,
    );
    if (sent.length > 0) void pins.markSent(sent);
  };

  // 다시 시도 — 같은 말을 한 번만(두 번 눌러도 두 번 가지 않게).
  const retrying = useRef(false);
  const retry = (text: string) => {
    if (retrying.current) return;
    retrying.current = true;
    void sessions
      .submit(text, [])
      .catch(() => undefined)
      .finally(() => {
        retrying.current = false;
      });
  };

  // 잃은 말의 다시 시도(W8) — 데몬의 방에서 통째로 되살려(입력창이 쓰던 길) 그
  // 말을 그대로 다시 보낸다. 방에서 꺼낸 말은 카드로 남지 않게 치운다.
  const retryDropped = (itemId: string) => {
    void sessions
      .takeDropped(itemId)
      .then((payload) => {
        if (!payload) return undefined;
        sessions.dismissDropped(itemId);
        return send(payload.text, payload.attachments, [], payload.pins ?? []);
      })
      .catch(() => undefined);
  };

  // --- 고쳐서 다시 보내기(U15) · 여기서 새 대화 ----------------------------
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const nonce = useRef(0);
  const fill = (text: string) => {
    nonce.current += 1;
    setPrefill({ text, nonce: nonce.current });
  };
  const editResend = (prompt: number, text: string) => {
    // k 번째 말 앞까지 = k-1 번째 답까지. 첫 말이면 이어받을 것이 없다 — 새 대화다.
    const branched =
      prompt > 1 ? sessions.branchFrom(prompt - 1) : Promise.resolve(sessions.fresh());
    void branched.then(() => {
      fill(text);
      nav.toast(L.transcript.editResendToast);
    });
  };
  const fork = (turn: number) => {
    void sessions.branchFrom(turn).then(() => nav.toast(L.transcript.forkToast));
  };
  const provider = sessions.selector.provider ?? sessions.chatProvider;
  const canBranch =
    daemon.status?.providers?.find((p) => p.id === provider)?.capabilities?.branch === true;

  // --- 스크롤: 맨 아래를 보고 있으면 따라간다 ---------------------------------
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [unpinned, setUnpinned] = useState(false);
  const remember = () => {
    const el = scroll.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    pinned.current = atBottom;
    setUnpinned(!atBottom);
  };
  const toBottom = () => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: 블록이 바뀔 때마다(흐르는 답 포함) 따라간다.
  useEffect(() => {
    if (pinned.current) toBottom();
  }, [blocks, pending.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 다른 대화는 새로 보는 것 — 맨 아래부터.
  useEffect(() => {
    pinned.current = true;
    setUnpinned(false);
    requestAnimationFrame(toBottom);
  }, [activeId]);

  // --- 진행 시계: 테이프가 조용한 동안만 ----------------------------------
  const tailLive = tailMoving(blocks, chat.showThinking, chat.showTools, isToolRunning);
  const awaiting = sessions.awaitingTurn?.sessionId === activeId ? sessions.awaitingTurn : null;
  const clockStart = active?.turnStartedAt ?? awaiting?.since ?? null;
  const showClock = (sessions.running || awaiting !== null) && !tailLive;

  // --- 끌어다 놓기: 칸 어디에 놓아도 입력창의 첨부로 ---------------------------
  const composer = useRef<ComposerHandle | null>(null);
  const registerHandle = useCallback((handle: ComposerHandle | null) => {
    composer.current = handle;
  }, []);
  const [dragDepth, setDragDepth] = useState(0);

  const visiblePending = pending.filter((request) => request.sessionId === activeId);
  const lockReason =
    daemon.connection === "closed" || daemon.connection === "error"
      ? L.chat.offline
      : daemon.connection !== "open"
        ? L.chat.connecting
        : null;
  const cycleMerged = daemon.repo?.handoff?.state === "merged";
  const placeholder = preparing
    ? L.composer.placeholderPreparing
    : pins.list.length > 0
      ? L.composer.placeholderPins
      : cycleMerged
        ? L.composer.placeholderMerged
        : L.composer.placeholder;
  const contextFull = sessions.usage !== null && Math.round(sessions.usage.percentage) >= 85;
  const empty = blocks.length === 0 && sessions.queue.length === 0 && !showClock;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 칸 전체가 파일을 놓는 자리다 — 드롭은 포인터의 일이고, 키보드는 입력창의 첨부 단추로 닿는다.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: 위와 같다.
    <section
      className={`nx-chat${dragDepth > 0 ? " nx-chat--drop" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragDepth((depth) => depth + 1);
      }}
      onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
      onDrop={(event) => {
        event.preventDefault();
        setDragDepth(0);
        if (event.dataTransfer.files.length > 0) composer.current?.attach(event.dataTransfer.files);
      }}
    >
      <div className="nx-transcript" ref={scroll} onScroll={remember}>
        {sessions.historyFailed && (
          <div className="nx-m-note nx-tone--red">
            <span>{L.chat.historyFailed}</span>
            <button type="button" className="nx-mlink" onClick={sessions.reopen}>
              {L.chat.reopen}
            </button>
          </div>
        )}
        {empty ? (
          <div className="nx-empty-chat">
            <span className="nx-empty-sp">
              <SparkIcon />
            </span>
            <h2>{L.transcript.emptyTitle}</h2>
            {project && (
              <p>
                {preparing
                  ? L.transcript.emptyPreparing(project.name)
                  : L.transcript.emptyBody(project.name)}
              </p>
            )}
          </div>
        ) : (
          <Thread
            key={activeId ?? "new"}
            blocks={blocks}
            live={sessions.running}
            showThinking={chat.showThinking}
            showTools={chat.showTools}
            previewUrl={daemon.repo?.previewUrl ?? null}
            handoff={daemon.repo?.handoff ?? null}
            projectWorking={project?.working === true}
            canBranch={canBranch}
            queue={sessions.queue}
            preparing={preparing}
            dropped={sessions.dropped}
            onFork={fork}
            onEditResend={editResend}
            onRetry={retry}
            onRetryDropped={retryDropped}
            onOpenScreen={openScreen}
            onOpenHistory={() => window.dispatchEvent(new CustomEvent("nx:history:open"))}
            onReply={async (id, text) => {
              await api.replyToReview(id, text);
            }}
            onNote={async (text) => {
              await api.noteToDeveloper(text);
            }}
            onToast={nav.toast}
            onQueueEdit={(itemId) => {
              void sessions
                .queueRemove(itemId)
                .then((payload) => payload && fill(payload.text))
                .catch(() => undefined);
            }}
            onQueueNow={(itemId) => void sessions.queueSendNow(itemId).catch(() => undefined)}
            onBackgroundTask={(toolUseId) => {
              if (activeId) void api.backgroundTask(activeId, toolUseId).catch(() => undefined);
            }}
            onStopTask={(taskId) => {
              if (activeId) void api.stopTask(activeId, taskId).catch(() => undefined);
            }}
          />
        )}
        {sessions.error && (
          <div className="nx-m-note nx-tone--red" role="alert">
            <span>
              {koreanNoticeWords(sessions.error) ? sessions.error : L.chat.somethingWrong}
            </span>
            <button type="button" className="nx-mlink" onClick={() => sessions.setError(null)}>
              {L.chat.dismiss}
            </button>
          </div>
        )}
        {visiblePending.map((request) => (
          <AskCard
            key={request.requestId}
            request={request}
            commands={daemon.repo?.commands}
            onQuestion={(answers) => {
              void api
                .respondQuestion(request.requestId, answers, {})
                .then(() => resolvePending(request.requestId))
                .catch(() => undefined);
            }}
            onPermission={(decision) => {
              void api
                .respondPermission(request.requestId, decision)
                .then(() => resolvePending(request.requestId))
                .catch(() => undefined);
            }}
          />
        ))}
        {showClock && (
          <div className="nx-m-run" role="status">
            <i className="nx-spin" aria-hidden="true" />
            <span>{L.chat.working}</span>
            {clockStart !== null && <Elapsed startedAt={clockStart} />}
          </div>
        )}
      </div>
      {unpinned && (
        <button
          type="button"
          className="nx-jump"
          onClick={() => {
            pinned.current = true;
            setUnpinned(false);
            toBottom();
          }}
        >
          {sessions.running ? L.chat.newContent : L.chat.toBottom}
          <ChevIcon />
        </button>
      )}
      <div className="nx-cmp-wrap">
        {contextFull && <div className="nx-cmp-hint">{L.chat.contextFull}</div>}
        <Composer
          daemon={daemon}
          sessions={sessions}
          variant="thread"
          draftKey={activeId ?? `new:${daemon.activeSlug ?? "none"}`}
          placeholder={placeholder}
          pins={pins.list}
          pinNumberStart={pins.ghosts.length + 1}
          onPinNote={pins.setNote}
          onPinRemove={pins.remove}
          onPinFocus={(id) => void window.coloDesignDesktop?.preview?.pinFlash?.(id)}
          narrow={narrow}
          onPinMode={() => {
            nav.showTab("preview");
            window.dispatchEvent(new CustomEvent("nx:pins:toggle"));
          }}
          disabledProviders={chat.disabledProviders}
          lockReason={lockReason}
          running={sessions.running}
          onStop={stop}
          stopping={stopping}
          prefill={prefill}
          listenPinsSend
          registerHandle={registerHandle}
          onSend={send}
        />
      </div>
    </section>
  );
}
