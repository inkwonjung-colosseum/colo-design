import type { ProjectSummary } from "@colo-design/protocol";
import { useRef, useState } from "react";
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
 * 사이드바 머리의 전환기(U7) — 누르면 프로젝트마다 상태 점 · 기다리는 숫자 ·
 * `처음 열 때 준비해요` 가 선 목록이 뜬다. 고르면 `project.activate`.
 */
export function ProjectSwitcher({
  projects,
  active,
  onSwitch,
}: {
  projects: ProjectSummary[];
  active: ProjectSummary | null;
  onSwitch: (slug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!active) return null;
  const status = projectStatus(active, L);
  return (
    <div className="nx-proj nx-anchor">
      <button
        ref={anchor}
        type="button"
        className="nx-proj-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={L.shell.projectMenu}
        onClick={() => setOpen((value) => !value)}
      >
        <ProjectMark slug={active.slug} name={active.name} />
        <span className="nx-proj-nm">
          <b>{active.name}</b>
          <span>
            <NoteMark note={status} cycle={cycleDotOf(active)} />
            {status.text}
          </span>
        </span>
        <ChevronDownIcon />
      </button>
      {open && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} className="nx-proj-pop">
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
                  setOpen(false);
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
    </div>
  );
}
