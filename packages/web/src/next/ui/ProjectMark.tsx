import type { ProjectNote } from "../lib/project-note";
import { Spin } from "./icons";

/** 목업의 프로젝트 색 — 슬러그마다 늘 같은 색이 서도록 해시로 고른다. */
const COLORS = ["#3552d8", "#8a5cf6", "#0f7f8c", "#c6613f", "#23865a", "#b86e12", "#46607e"];

function colorOf(slug: string): string {
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return COLORS[hash % COLORS.length] ?? COLORS[0] ?? "#3552d8";
}

/** 프로젝트의 네모 표식 — 이름의 첫 글자, 슬러그의 색(목업 `.pm`). */
export function ProjectMark({
  slug,
  name,
  size = "md",
}: {
  slug: string;
  name: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={`nx-pm nx-pm--${size}`}
      style={{ background: colorOf(slug) }}
      aria-hidden="true"
    >
      {Array.from(name.trim())[0] ?? "·"}
    </span>
  );
}

/** 사이클 점 · 도는 표식 · 기다림 점 — 줄의 한 단어 앞에 서는 작은 표식. */
export function NoteMark({ note, cycle }: { note: ProjectNote; cycle?: string }) {
  if (note.spin) return <Spin />;
  if (note.kind === "cycle") {
    return <i className={`nx-dot nx-dot--${cycle ?? "none"}`} aria-hidden="true" />;
  }
  if (note.kind === "merged") return null;
  return <i className={`nx-dot nx-dot--${note.tone}`} aria-hidden="true" />;
}
