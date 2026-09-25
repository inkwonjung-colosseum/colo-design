import type { ProjectSummary } from "@colo-design/protocol";
import { useMemo, useState } from "react";
import { toolHeadline } from "../../components/transcript/shared";
import type { Daemon } from "../../lib/daemon-client";
import { timeAgo } from "../../lib/format";
import { type AskingItem, buildHomeFeed } from "../../lib/home-feed";
import { bashHeadline, toolLabel } from "../../lib/labels";
import { L } from "../labels";
import { isPreparing } from "../lib/project-note";
import { agentUpdateEvents } from "../lib/update-row";
import { Elapsed } from "../status/Elapsed";
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

  // 답이 도착할 때까지 카드는 남는다 — 응답이 길에서 죽었는데 카드부터 거두면
  // 답하지 않은 확인이 사라진다(옛 홈과 같은 규칙). 누른 뒤에는 같은 카드를 두
  // 번 누르지 않게 잠근다.
  const [answering, setAnswering] = useState<ReadonlySet<string>>(() => new Set());
  const respond = (requestId: string, call: () => Promise<unknown>) => {
    setAnswering((prev) => new Set(prev).add(requestId));
    void call()
      .then(() => daemon.resolvePending(requestId))
      .catch(() => undefined)
      .finally(() =>
        setAnswering((prev) => {
          const next = new Set(prev);
          next.delete(requestId);
          return next;
        }),
      );
  };

  const openHere = (sessionId: string) => active && onOpenThread(active.slug, sessionId);

  return (
    <div className="nx-inbox">
      {waitCount > 0 ? (
        <h3 className="nx-ih">
          {L.home.waiting} <span className="nx-cnt">{waitCount}</span>
        </h3>
      ) : (
        <div className="nx-calm">
          <CalmIcon />
          {L.home.calm}
        </div>
      )}
      {active &&
        feed.asking.map((item) => {
          const key = item.kind === "review" ? `review-${item.sessionId}` : item.requestId;
          const busy = item.kind !== "review" && answering.has(item.requestId);
          return (
            <div key={key} className="nx-dcard">
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
                      className="nx-btn"
                      disabled={busy}
                      onClick={() => {
                        const quote = item.quote;
                        if (quote === null) return;
                        respond(item.requestId, () =>
                          daemon.api.respondQuestion(item.requestId, { [quote]: label }, {}),
                        );
                      }}
                    >
                      {label}
                    </button>
                  ))}
                {item.kind === "permission" && (
                  <>
                    <button
                      type="button"
                      className="nx-btn nx-btn--pri"
                      disabled={busy}
                      onClick={() =>
                        respond(item.requestId, () =>
                          daemon.api.respondPermission(item.requestId, "allow"),
                        )
                      }
                    >
                      {L.inbox.allow}
                    </button>
                    <button
                      type="button"
                      className="nx-btn"
                      disabled={busy}
                      onClick={() =>
                        respond(item.requestId, () =>
                          daemon.api.respondPermission(item.requestId, "deny"),
                        )
                      }
                    >
                      {L.inbox.deny}
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
            </div>
          );
        })}
      {otherWaiting.map((project) => (
        <button
          key={project.slug}
          type="button"
          className="nx-irow"
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
          {L.home.running} <span className="nx-cnt nx-cnt--g">{runCount}</span>
        </summary>
        {active &&
          feed.running.map((item) => (
            <button
              key={item.sessionId}
              type="button"
              className="nx-irow"
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
            className="nx-irow"
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
            className="nx-irow"
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
        {runCount === 0 && <div className="nx-calm nx-calm--inner">{L.inbox.nothingRunning}</div>}
      </details>

      <details className="nx-fold" open>
        <summary>
          <ChevronRightIcon />
          {L.home.recent} <span className="nx-cnt nx-cnt--g">{recentCount}</span>
        </summary>
        {active &&
          feed.done.map((item) => (
            <button
              key={item.sessionId}
              type="button"
              className="nx-irow"
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
            className="nx-irow"
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
          <div key={`update-${event.id}`} className="nx-irow">
            <CheckIcon />
            <span className="nx-it">{event.text}</span>
            <span className="nx-ir">{event.at ? timeAgo(event.at) : ""}</span>
          </div>
        ))}
        {recentCount === 0 && <div className="nx-calm nx-calm--inner">{L.inbox.nothingRecent}</div>}
      </details>
    </div>
  );
}
