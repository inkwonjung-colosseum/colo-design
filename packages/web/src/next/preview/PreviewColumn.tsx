import { L } from "../labels";
import { isPreparing } from "../lib/project-note";
import type { PreviewColumnProps } from "../slots";

/**
 * 미리보기 칸의 자리(단계 1) — 단계 3 이 이 파일을 바꾼다(막대 · 찍기 · 말풍선 ·
 * 준비 화면 · 작업 기록 서랍). 셸은 이 칸을 홈에서도 마운트한 채 숨긴다 — 데스크톱
 * 의 `<webview>` 게스트는 요소가 철거되는 순간 죽고, 그러면 `돌아오면 보던 자리
 * 그대로` 의 약속이 무너진다. 단계 3 은 이 계약을 지켜 게스트를 여기 안에 둔다.
 */
export function PreviewColumn({ project }: PreviewColumnProps) {
  const text =
    project && isPreparing(project) ? L.slot.previewPreparing(project.name) : L.slot.previewWaiting;
  return (
    <section className="nx-preview">
      <div className="nx-pvbar" />
      <div className="nx-pvstage">
        <div className="nx-pv-placeholder">{text}</div>
      </div>
    </section>
  );
}
