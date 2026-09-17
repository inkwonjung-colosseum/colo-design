import type { ChangedFileLite } from "@colo-design/protocol";
import { useState } from "react";
import { ChevronDownIcon, PencilIcon } from "../icons";
import { FILE_STATUS_LABEL } from "./DiffPanel";

/**
 * 변경 점 — the preview column's floor (mockup 03 · 분할): what a 저장 would
 * carry, listed under the stage it belongs to, so seeing the changes and
 * acting on them (the bar's 저장 · 넘기기) stay in one column. The rows are
 * the same recount that moves the chip's number — the count and the list
 * move in one emit, so they cannot disagree. The fold is the planner's
 * gesture; the strip itself only exists while there is something to list —
 * a clean tree draws nothing.
 */
export function ChangedFiles({ files }: { files: ChangedFileLite[] }) {
  const [open, setOpen] = useState(true);
  if (files.length === 0) return null;
  return (
    <section className="cstrip" aria-label="저장하지 않은 변경">
      <button
        type="button"
        className="cstrip__head"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="ic ic--warn">
          <PencilIcon />
        </span>
        <span className="cstrip__title">변경 점</span>
        <span className="cstrip__count">
          저장하지 않은 변경 <strong>{files.length}개</strong>
        </span>
        <span className={`cstrip__chevron${open ? "" : " cstrip__chevron--folded"}`}>
          <ChevronDownIcon />
        </span>
      </button>
      {open && (
        <ul className="cstrip__files">
          {files.map((file) => (
            <li className="dfile" key={file.path}>
              <span className={`dfile__tag dfile__tag--${file.status}`}>
                {FILE_STATUS_LABEL[file.status]}
              </span>
              <span className="dfile__name" title={file.path}>
                {file.path}
              </span>
              {(file.added !== null || file.removed !== null) && (
                <span className="discard__count">
                  {file.added !== null && file.added > 0 && (
                    <span className="plus">+{file.added}</span>
                  )}
                  {file.removed !== null && file.removed > 0 && (
                    <span className="minus">−{file.removed}</span>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
