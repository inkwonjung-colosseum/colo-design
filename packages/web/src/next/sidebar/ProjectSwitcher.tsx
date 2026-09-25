import type { ProjectSummary } from "@colo-design/protocol";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { composing } from "../../lib/ime";
import { requestInvitePicker } from "../../lib/invite-bus";
import { openLink } from "../../lib/open-link";
import { L } from "../labels";
import { neverPrepared, projectCycle, projectStatus } from "../lib/project-note";
import { CheckIcon, ChevronDownIcon } from "../ui/icons";
import { Popover } from "../ui/Popover";
import { NoteMark, ProjectMark } from "../ui/ProjectMark";

/** 줄 앞 점의 색 — 한 번도 연 적 없는 프로젝트는 회색이다. */
export function cycleDotOf(project: ProjectSummary): string {
  return neverPrepared(project) ? "none" : projectCycle(project);
}

/**
 * 사이드바 머리의 전환기(U7) — 머리는 두 누름이다: 이름을 누르면 그 프로젝트의
 * 카드(아래 `ProjectInfo`), 셰브론을 누르면 프로젝트마다 상태 점 · 기다리는
 * 숫자 · `처음 열 때 준비해요` 가 선 목록이 떠 고르면 `project.activate` 한다.
 */
export function ProjectSwitcher({
  daemon,
  projects,
  active,
  onSwitch,
  onToast,
}: {
  daemon: Daemon;
  projects: ProjectSummary[];
  active: ProjectSummary | null;
  onSwitch: (slug: string) => void;
  onToast: (text: string) => void;
}) {
  const [pop, setPop] = useState<"list" | "info" | null>(null);
  const nameBtn = useRef<HTMLButtonElement>(null);
  const chevBtn = useRef<HTMLButtonElement>(null);
  if (!active) return null;
  const status = projectStatus(active, L);
  return (
    <div className="nx-proj nx-anchor">
      <div className="nx-proj-btn">
        <button
          ref={nameBtn}
          type="button"
          className="nx-proj-open"
          aria-haspopup="dialog"
          aria-expanded={pop === "info"}
          onClick={() => setPop((value) => (value === "info" ? null : "info"))}
        >
          <ProjectMark slug={active.slug} name={active.name} />
          <span className="nx-proj-nm">
            <b>{active.name}</b>
            <span>
              <NoteMark note={status} cycle={cycleDotOf(active)} />
              {status.text}
            </span>
          </span>
        </button>
        <button
          ref={chevBtn}
          type="button"
          className="nx-proj-chev"
          aria-haspopup="dialog"
          aria-expanded={pop === "list"}
          aria-label={L.shell.projectMenu}
          title={L.shell.projectMenu}
          onClick={() => setPop((value) => (value === "list" ? null : "list"))}
        >
          <ChevronDownIcon />
        </button>
      </div>
      {pop === "list" && (
        <Popover anchor={chevBtn} onClose={() => setPop(null)} className="nx-proj-pop">
          <div className="nx-mh">{L.sidebar.projects}</div>
          {projects.map((project) => {
            const row = projectStatus(project, L);
            const current = project.slug === active.slug;
            return (
              <button
                key={project.slug}
                type="button"
                className="nx-mi"
                onClick={() => {
                  setPop(null);
                  if (!current) onSwitch(project.slug);
                }}
              >
                <ProjectMark slug={project.slug} name={project.name} />
                <span className="nx-mt">
                  <b>{project.name}</b>
                  <small>
                    <NoteMark note={row} cycle={cycleDotOf(project)} />
                    {row.text}
                    {neverPrepared(project) && ` · ${L.sidebar.prepareOnFirstOpen}`}
                  </small>
                </span>
                {project.pendingCount > 0 ? (
                  <span className="nx-cnt nx-r">{project.pendingCount}</span>
                ) : current ? (
                  <span className="nx-ck nx-r">
                    <CheckIcon />
                  </span>
                ) : null}
              </button>
            );
          })}
        </Popover>
      )}
      {pop === "info" && (
        <ProjectInfo
          daemon={daemon}
          project={active}
          anchor={nameBtn}
          onClose={() => setPop(null)}
          onToast={onToast}
        />
      )}
    </div>
  );
}

/** 브라우저가 여는 주소의 모양 — 개발 실행의 로컬 저장소는 자리가 다르다. */
const WEB_URL = /^https?:\/\//i;

/**
 * 프로젝트 카드 — 전환기 머리의 이름을 누르면 그 아래에 뜬다. 저장소 · 미리보기는
 * 링크의 규칙대로 열고(open-link), `지켜 줄 것` 은 흐림 · ⌘↵ 로 저장한다
 * (README 「프로젝트와 목록」 — 새로 시작하는 대화부터 끝에 붙는다). 바깥을 눌러
 * 닫혀도 적던 초안은 놓치지 않는다: 닫힘과 같은 커밋에서 저장한다.
 */
function ProjectInfo({
  daemon,
  project,
  anchor,
  onClose,
  onToast,
}: {
  daemon: Daemon;
  project: ProjectSummary;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  onToast: (text: string) => void;
}) {
  const stored = project.instructions ?? "";
  const [guide, setGuide] = useState(stored);
  const latest = useRef({ guide, stored });
  latest.current = { guide, stored };
  const sent = useRef<string>(stored);
  /** 저장 — 같은 값은 다시 쓰지 않고, 비우면 지운다(null). */
  const commit = useRef(() => {});
  commit.current = () => {
    const { guide: value, stored: now } = latest.current;
    if (value === now || value === sent.current) return;
    sent.current = value;
    void daemon.api
      .projectUpdate(project.slug, { instructions: value.trim() ? value : null })
      .then(() => onToast(L.projInfo.guideSavedToast))
      .catch(() => {
        sent.current = now;
        onToast(L.projInfo.guideSaveFailed);
      });
  };
  // 바깥 누름 · Esc 로 카드가 떼어지는 길도 저장과 같은 커밋으로 나간다.
  useEffect(() => () => commit.current(), []);
  const repoUrl = project.repoUrl ?? null;
  const repo = repoUrl !== null && WEB_URL.test(repoUrl) ? repoUrl : null;
  const preview = daemon.repo?.phase === "ready" ? daemon.repo.previewUrl : null;
  return (
    <Popover anchor={anchor} onClose={onClose} className="nx-proj-info">
      <div className="nx-pi-head">
        <ProjectMark slug={project.slug} name={project.name} />
        <b>{project.name}</b>
      </div>
      <div className="nx-pi-links">
        {repo && (
          <button type="button" className="nx-mi" onClick={() => openLink(repo)}>
            <b>{L.projInfo.openRepo}</b>
            <span className="nx-ext" aria-hidden="true">
              ↗
            </span>
          </button>
        )}
        {preview && (
          <button type="button" className="nx-mi" onClick={() => openLink(preview)}>
            <b>{L.projInfo.openPreview}</b>
            <span className="nx-ext" aria-hidden="true">
              ↗
            </span>
          </button>
        )}
        <button
          type="button"
          className="nx-mi"
          onClick={() => {
            onClose();
            requestInvitePicker();
          }}
        >
          <b>{L.projInfo.openInvite}</b>
        </button>
      </div>
      <div className="nx-pi-guide">
        <b>{L.projInfo.guide}</b>
        <p className="nx-pi-help">{L.projInfo.guideHelp}</p>
        <textarea
          className="nx-pi-box"
          rows={5}
          value={guide}
          placeholder={L.projInfo.guidePlaceholder}
          onChange={(event) => setGuide(event.target.value)}
          onBlur={() => commit.current()}
          onKeyDown={(event) => {
            // 한글이 조합 중이면 ⌘↵ 를 저장으로 읽지 않는다.
            if (composing(event)) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) commit.current();
          }}
        />
        <p className="nx-pi-note">{L.projInfo.guideNote}</p>
      </div>
    </Popover>
  );
}
