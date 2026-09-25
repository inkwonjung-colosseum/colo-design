import type { ProjectSummary } from "@colo-design/protocol";
import { L } from "../labels";
import { projectNote } from "../lib/project-note";
import { NoteMark, ProjectMark } from "../ui/ProjectMark";
import { cycleDotOf } from "./ProjectSwitcher";

/**
 * 다른 프로젝트 줄(U7) — 활성이 아닌 프로젝트마다 한 줄, 이름과 가장 급한 것
 * 하나(`projectNote`). 누르면 그 프로젝트로 옮긴다.
 */
export function OtherProjects({
  projects,
  activeSlug,
  onSwitch,
}: {
  projects: ProjectSummary[];
  activeSlug: string | null;
  onSwitch: (slug: string) => void;
}) {
  const others = projects.filter((project) => project.slug !== activeSlug);
  if (others.length === 0) return null;
  return (
    <div className="nx-others">
      <div className="nx-side-label nx-side-label--tight">{L.sidebar.others}</div>
      {others.map((project) => {
        const note = projectNote(project, L);
        return (
          <button
            key={project.slug}
            type="button"
            className="nx-orow"
            title={L.sidebar.switchTo(project.name)}
            onClick={() => onSwitch(project.slug)}
          >
            <ProjectMark slug={project.slug} name={project.name} size="sm" />
            <span className="nx-orow-name">{project.name}</span>
            <span className={`nx-onote nx-tone--${note.tone}`}>
              <NoteMark note={note} cycle={cycleDotOf(project)} />
              {note.text}
            </span>
          </button>
        );
      })}
    </div>
  );
}
