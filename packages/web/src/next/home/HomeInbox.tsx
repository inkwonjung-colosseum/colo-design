import type { ProjectSummary } from "@nova-design/protocol";
import { useMemo, useState } from "react";
import { toolHeadline } from "../../components/transcript/shared";
import type { Daemon } from "../../lib/daemon-client";
import { timeAgo } from "../../lib/format";
import { type AskingItem, buildHomeFeed } from "../../lib/home-feed";
import { bashHeadline, toolLabel } from "../../lib/labels";
import { L } from "../labels";
import { connectionLock } from "../lib/connection-copy";
import { isPreparing } from "../lib/project-note";
import { agentUpdateEvents } from "../lib/update-row";
import { useFreshKeys } from "../lib/use-fresh-keys";
import { Elapsed } from "../status/Elapsed";
import { Count } from "../ui/Count";
import { CalmIcon, CheckIcon, ChevronRightIcon, SparkIcon, Spin } from "../ui/icons";
import { ProjectMark } from "../ui/ProjectMark";

type Commands = NonNullable<NonNullable<Daemon["repo"]>["commands"]>;

/**
 * 권한 카드의 한 줄 — 레포가 정한 명령이면 그 이름(`레포 검사`), 아니면 도구의
 * 한국어 이름. 날 명령줄은 홈에 세우지 않는다(대화의 `자세히 보기` 몫).
 */
function permissionWhat(item: Extract<AskingItem, { kind: "permission" }>, commands?: Commands) {
  if (item.toolName === "Bash") {
    const raw = toolHeadline(item.input).trim();
    const named = bashHeadline(raw, commands);
    if (named !== raw) return named;
  }
  return toolLabel(item.toolName);
}

/** 준비 단계의 이름 — 목업의 `내려받기 · 설치하기 · 미리보기 켜기`. */
function prepareStep(project: ProjectSummary): string {
  const [download, install, preview] = L.inbox.stepNames;
  if (project.phase === "installing") return install;
  if (project.phase === "starting") return preview;
  return download;
}

/** 다른 프로젝트의 마지막 사건 한 줄 — 폴러가 본 것(PLAN P3-2). */
function eventLine(kind: NonNullable<ProjectSummary["lastEventKind"]>): string {
  switch (kind) {
    case "merged":
      return L.inbox.eventMerged;
    case "closed":
      return L.inbox.eventClosed;
    case "replied":
      return L.inbox.eventReplied;
    case "comments":
    case "changes_requested":
      return L.inbox.eventComments;
  }
}

/**
 * 받은 편지함(U6) — `buildHomeFeed` 를 그대로 쓴다. 맨 위 `답을 기다려요`(확인
 * 카드 — 홈에서 바로 답한다), 한 단 아래 `지금 진행 중`(도는 대화 + 준비 중인
 * 프로젝트)과 `방금 있던 일`. 활성 프로젝트의 대화만 살아 있는 세션을 가지므로
 * 카드로 답할 수 있는 것도 활성 프로젝트의 것이다; 다른 프로젝트의 기다림은
 * 한 줄로 서고 누르면 그 프로젝트로 옮긴다.
 */
export function HomeInbox({
  daemon,
  onOpenThread,
  onSwitch,
}: {
  daemon: Daemon;
  onOpenThread: (slug: string, threadId: string) => void;
  onSwitch: (slug: string) => void;
}) {
  const feed = useMemo(
    () => buildHomeFeed(daemon.pending, daemon.sessions, daemon.projects, daemon.activeSlug),
    [daemon.pending, daemon.sessions, daemon.projects, daemon.activeSlug],
  );
  const active = daemon.projects.find((project) => project.slug === daemon.activeSlug) ?? null;
  const others = daemon.projects.filter((project) => project.slug !== daemon.activeSlug);
  const otherWaiting = others.filter((project) => project.pendingCount > 0);
  const preparing = daemon.projects.filter(isPreparing);
  const otherWorking = others.filter((project) => project.working && !isPreparing(project));
  const otherEvents = others
    .filter((project) => project.lastEventKind !== undefined)
    .sort(
      (a, b) => (Date.parse(b.lastEventAt ?? "") || 0) - (Date.parse(a.lastEventAt ?? "") || 0),
    );
  const waitCount = feed.asking.length + otherWaiting.length;
  const runCount = feed.running.length + preparing.length + otherWorking.length;
  // 도구가 스스로 한 일(J6) — AI 프로그램 업데이트는 할 일이 아니라 한 줄 소식이다.
  const updateEvents = agentUpdateEvents(
    daemon.status?.agentUpdates,
    daemon.status?.providers,
    L.update.doneEvent,
  );
  const recentCount = feed.done.length + otherEvents.length + updateEvents.length;
  // 세 칸이 모두 비면 차분한 한 줄만 남는다 — 비었다는 말이 두 겹으로 서지 않게.
  const allCalm = waitCount === 0 && runCount === 0 && recentCount === 0;

  // 새로 들어온 줄만 내려앉는다 — 카드는 자리를 열며, 단추 줄은 내려앉기만. 열쇠에 목록
  // 이름을 붙여, 도는 대화가 끝나 `방금 있던 일` 로 옮겨 가는 것도 새 줄로 맞는다.
  const rowKeys = [
    ...feed.asking.map((item) =>
      item.kind === "review" ? `review-${item.sessionId}` : item.requestId,
    ),
    ...otherWaiting.map((project) => `wait-${project.slug}`),
    ...feed.running.map((item) => `run-${item.sessionId}`),
    ...preparing.map((project) => `prep-${project.slug}`),
    ...otherWorking.map((project) => `work-${project.slug}`),
    ...feed.done.map((item) => `done-${item.sessionId}`),
    ...otherEvents.map((project) => `event-${project.slug}`),
    ...updateEvents.map((event) => `update-${event.id}`),
  ];
  const fresh = useFreshKeys(rowKeys, daemon.activeSlug ?? "");
  const rowClass = (key: string) => (fresh.has(key) ? "nx-irow nx-row--new" : "nx-irow");

  // 답이 도착할 때까지 카드는 남는다 — 응답이 길에서 죽었는데 카드부터 거두면
  // 답하지 않은 확인이 사라진다(옛 홈과 같은 규칙). 누른 뒤에는 같은 카드를 두
  // 번 누르지 않게 잠근다.
  const [answering, setAnswering] = useState<ReadonlySet<string>>(() => new Set());
  /** 누른 버튼 — 카드마다 어느 답을 보내는 중인가(고른 모양과 도는 표시의 주인). */
  const [pressed, setPressed] = useState<ReadonlyMap<string, string>>(() => new Map());
  /** 보내기에 성공한 카드 — 접히는 동안을 두고 거둔다. */
  const [folding, setFolding] = useState<ReadonlySet<string>>(() => new Set());
  /** 전하지 못한 카드 — 접지 않고 한 줄을 세워 다시 눌리게 한다. */
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const respond = (requestId: string, mark: string, call: () => Promise<unknown>) => {
    setAnswering((prev) => new Set(prev).add(requestId));
    setPressed((prev) => new Map(prev).set(requestId, mark));
    setFailed((prev) => {
      const next = new Set(prev);
      next.delete(requestId);
      return next;
    });
    void call()
      .then(() => {
        setFolding((prev) => new Set(prev).add(requestId));
        // 접히는 동안만 카드를 남겨 둔다 — 갑자기 사라져 나머지가 튀지 않게.
        window.setTimeout(() => daemon.resolvePending(requestId), 220);
      })
      .catch(() => setFailed((prev) => new Set(prev).add(requestId)))
      .finally(() => {
        setAnswering((prev) => {
          const next = new Set(prev);
          next.delete(requestId);
          return next;
        });
        setPressed((prev) => {
          const next = new Map(prev);
          next.delete(requestId);
          return next;
        });
      });
  };

  const openHere = (sessionId: string) => active && onOpenThread(active.slug, sessionId);

  return (
    <div className="nx-inbox">
      {waitCount > 0 ? (
        <h3 className="nx-ih">
          {L.home.waiting} <Count n={waitCount} />
        </h3>
      ) : (
        <div className="nx-calm">
          <CalmIcon />
          {/* 연결이 열리기 전에는 「비었음」을 알 수 없다 — 낡은 「기다리는 일이 없어요」를 말하지 않는다. */}
          {connectionLock(daemon.connection, L) ?? L.home.calm}
        </div>
      )}
      {active &&
        feed.asking.map((item) => {
          const key = item.kind === "review" ? `review-${item.sessionId}` : item.requestId;
          const busy =
            (item.kind !== "review" && answering.has(item.requestId)) || folding.has(key);
          const mark = pressed.get(key);
          return (
            <div
              key={key}
              className={`nx-dfold${folding.has(key) ? " nx-dfold--gone" : ""}${fresh.has(key) ? " nx-item--new" : ""}`}
            >
              <div className="nx-dcard">
                <div className="nx-dmeta">
                  <ProjectMark slug={active.slug} name={active.name} size="sm" />
                  {active.name} · {item.title}
                  {item.kind !== "review" && item.requestedAt !== undefined && (
                    <span className="nx-time">{timeAgo(item.requestedAt)}</span>
                  )}
                </div>
                <div className="nx-dq">
                  <SparkIcon />
                  <span>
                    {item.kind === "question"
                      ? (item.quote ?? L.inbox.askMany)
                      : item.kind === "permission"
                        ? L.inbox.askPermission(permissionWhat(item, daemon.repo?.commands))
                        : L.inbox.reviewArrived}
                  </span>
                </div>
                <div className="nx-dopts">
                  {item.kind === "question" &&
                    item.quote !== null &&
                    item.options.map((label) => (
                      <button
                        key={label}
                        type="button"
                        className={`nx-btn${mark === label ? " nx-btn--picked" : ""}`}
                        disabled={busy}
                        onClick={() => {
                          const quote = item.quote;
                          if (quote === null) return;
                          respond(item.requestId, label, () =>
                            daemon.api.respondQuestion(item.requestId, { [quote]: label }, {}),
                          );
                        }}
                      >
                        {label}
                        {mark === label && <Spin />}
                      </button>
                    ))}
                  {item.kind === "permission" && (
                    <>
                      <button
                        type="button"
                        className={`nx-btn nx-btn--pri${mark === "allow" ? " nx-btn--picked" : ""}`}
                        disabled={busy}
                        onClick={() =>
                          respond(item.requestId, "allow", () =>
                            daemon.api.respondPermission(item.requestId, "allow"),
                          )
                        }
                      >
                        {L.inbox.allow}
                        {mark === "allow" && <Spin />}
                      </button>
                      <button
                        type="button"
                        className={`nx-btn${mark === "deny" ? " nx-btn--picked" : ""}`}
                        disabled={busy}
                        onClick={() =>
                          respond(item.requestId, "deny", () =>
                            daemon.api.respondPermission(item.requestId, "deny"),
                          )
                        }
                      >
                        {L.inbox.deny}
                        {mark === "deny" && <Spin />}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="nx-btn nx-btn--ghost"
                    onClick={() => openHere(item.sessionId)}
                  >
                    {L.inbox.openConv}
                  </button>
                </div>
                {failed.has(key) && (
                  <div className="nx-dfail nx-tone--red">{L.chat.somethingWrong}</div>
                )}
              </div>
            </div>
          );
        })}
      {otherWaiting.map((project) => (
        <button
          key={project.slug}
          type="button"
          className={rowClass(`wait-${project.slug}`)}
          onClick={() => onSwitch(project.slug)}
        >
          <ProjectMark slug={project.slug} name={project.name} size="sm" />
          <span className="nx-it">{project.name}</span>
          <span className="nx-ir nx-tone--amber">
            {L.sidebar.waitingAnswerCount(project.pendingCount)}
          </span>
        </button>
      ))}

      <details className="nx-fold" open>
        <summary>
          <ChevronRightIcon />
          {L.home.running} <Count n={runCount} className="nx-cnt--g" />
        </summary>
        {active &&
          feed.running.map((item) => (
            <button
              key={item.sessionId}
              type="button"
              className={rowClass(`run-${item.sessionId}`)}
              onClick={() => openHere(item.sessionId)}
            >
              <ProjectMark slug={active.slug} name={active.name} size="sm" />
              <span className="nx-it">
                {item.title} <span>· {active.name}</span>
              </span>
              <span className="nx-ir">
                <Spin />
                {item.line}
                {item.turnStartedAt !== null && (
                  <>
                    {" · "}
                    <Elapsed startedAt={item.turnStartedAt} />
                  </>
                )}
              </span>
            </button>
          ))}
        {preparing.map((project) => (
          <button
            key={`prep-${project.slug}`}
            type="button"
            className={rowClass(`prep-${project.slug}`)}
            onClick={() => onSwitch(project.slug)}
          >
            <ProjectMark slug={project.slug} name={project.name} size="sm" />
            <span className="nx-it">
              {L.inbox.firstPrepare} <span>· {project.name}</span>
            </span>
            <span className="nx-ir">
              <Spin />
              {prepareStep(project)}
            </span>
          </button>
        ))}
        {otherWorking.map((project) => (
          <button
            key={`work-${project.slug}`}
            type="button"
            className={rowClass(`work-${project.slug}`)}
            onClick={() => onSwitch(project.slug)}
          >
            <ProjectMark slug={project.slug} name={project.name} size="sm" />
            <span className="nx-it">{project.name}</span>
            <span className="nx-ir">
              <Spin />
              {L.journey.making}
            </span>
          </button>
        ))}
        {runCount === 0 && !allCalm && (
          <div className="nx-calm nx-calm--inner">{L.inbox.nothingRunning}</div>
        )}
      </details>

      <details className="nx-fold" open>
        <summary>
          <ChevronRightIcon />
          {L.home.recent} <Count n={recentCount} className="nx-cnt--g" />
        </summary>
        {active &&
          feed.done.map((item) => (
            <button
              key={item.sessionId}
              type="button"
              className={rowClass(`done-${item.sessionId}`)}
              onClick={() => openHere(item.sessionId)}
            >
              <ProjectMark slug={active.slug} name={active.name} size="sm" />
              <span className="nx-it">
                {item.title} <span>· {L.inbox.answered}</span>
              </span>
              <span className="nx-ir">{timeAgo(item.at)}</span>
            </button>
          ))}
        {otherEvents.map((project) => (
          <button
            key={`event-${project.slug}`}
            type="button"
            className={rowClass(`event-${project.slug}`)}
            onClick={() => onSwitch(project.slug)}
          >
            <ProjectMark slug={project.slug} name={project.name} size="sm" />
            <span className="nx-it">
              {project.lastEventKind && eventLine(project.lastEventKind)}{" "}
              <span>· {project.name}</span>
            </span>
            <span className="nx-ir">
              {project.lastEventAt ? timeAgo(Date.parse(project.lastEventAt)) : ""}
            </span>
          </button>
        ))}
        {updateEvents.map((event) => (
          <div key={`update-${event.id}`} className={rowClass(`update-${event.id}`)}>
            <CheckIcon />
            <span className="nx-it">{event.text}</span>
            <span className="nx-ir">{event.at ? timeAgo(event.at) : ""}</span>
          </div>
        ))}
        {recentCount === 0 && !allCalm && (
          <div className="nx-calm nx-calm--inner">{L.inbox.nothingRecent}</div>
        )}
      </details>
    </div>
  );
}
