/**
 * 저장 기록 카드: 대화 tape 의 `save` 블록(cycle.saved)이 대화 안에 남기는
 * 접힌 기록 — 살아있는 저장 제안은 컴포저 칩이, 실패는 실패 배너가 맡는다.
 */
import { CheckIcon } from "../icons";

/** `.frow` 한 행 — 이번 사이클에 얹힌 화면 하나. */
interface SaveCardFile {
  title: string;
  detail: string;
  /** "고침" · "새로 만듦" 같은 태그 글자; 없으면 태그를 그리지 않는다. */
  tag?: string;
  /** 태그에 강조 색을 입힌다 — "새로 만듦" 같은 새 것의 말. */
  tagAccent?: boolean;
}

export interface SaveCardProps {
  title: string;
  sub: string;
  tagLabel: string;
  tagTone: "ok";
  files?: SaveCardFile[];
}

export function SaveCard({ title, sub, tagLabel, tagTone, files = [] }: SaveCardProps) {
  return (
    <div className="savecard savecard--done">
      <div className="savecard__head">
        <span className="savecard__ic savecard__ic--ok">
          <CheckIcon />
        </span>
        <div className="savecard__tt">
          <strong>{title}</strong>
          <span className="savecard__sub">{sub}</span>
        </div>
        <span className={`tag tag--${tagTone}`}>{tagLabel}</span>
      </div>
      {files.length > 0 && (
        <div className="savecard__files">
          {files.map((file, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 같은 제목의 화면이 한 사이클에 둘일 수 있어 index 로만 식별한다 — 목록은 뒤에만 붙는다.
            <div className="frow" key={`${file.title}-${index}`}>
              <span className="frow__ic">▣</span>
              <div className="frow__tx">
                <strong>{file.title}</strong>
                <span className="frow__d">{file.detail}</span>
              </div>
              {file.tag && (
                <span className={`tag${file.tagAccent ? " tag--accent" : ""}`}>{file.tag}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
