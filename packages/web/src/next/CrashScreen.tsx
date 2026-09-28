import { type CSSProperties, type ReactNode, useState } from "react";
import { CopyButton } from "../components/CopyButton";
import type { CrashReport } from "../lib/crash";
import { DEV, L } from "./labels";

/** 한 장의 판 — 테마가 못 실린 경우도 읽혀야 하므로 토큰마다 폴백을 둔다. */
const PANEL: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  padding: 32,
  textAlign: "center",
  background: "var(--bg, #faf9f5)",
  color: "var(--text, #26241f)",
  fontFamily:
    "Pretendard Variable, Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

const HEADLINE: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 650,
};

const BODY: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: "var(--muted, #5c5749)",
};

const REOPEN: CSSProperties = {
  marginTop: 8,
  padding: "9px 22px",
  fontSize: 14,
  fontWeight: 600,
  borderRadius: 10,
  border: "1px solid var(--line, #d9d4c4)",
  background: "var(--panel-2, #eceadf)",
  color: "inherit",
  cursor: "pointer",
};

const FOLD: CSSProperties = {
  marginTop: 18,
  maxWidth: 640,
  width: "100%",
  fontSize: 12,
  color: "var(--muted, #5c5749)",
};

const DETAIL: CSSProperties = {
  margin: "8px 0 0",
  padding: "10px 12px",
  textAlign: "left",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  overflowWrap: "anywhere",
  maxHeight: 180,
  overflow: "auto",
  fontSize: 12,
  lineHeight: 1.5,
  borderRadius: 8,
  border: "1px solid var(--line-soft, #e8e4d6)",
  background: "var(--panel, #f5f4ee)",
};

/**
 * 전면 안내판(P-1 · 3.A 7) — 렌더 예외가 화면 전체를 삼킨 순간의 한 장.
 * 상태는 전부 데몬에 있으니 회복은 `다시 열기` 하나로 충분하다(계획 원칙 ①).
 * 색은 기존 토큰만 쓰되 폴백을 붙인다 — 크래시 순간에는 테마가 실리지
 * 않았을 수도 있기 때문이다. 개발자용 폴드가 message · stack ·
 * componentStack 를 보여 준다.
 */
export function CrashScreen({ report }: { report: CrashReport }): ReactNode {
  const [open, setOpen] = useState(false);
  // 첫 마운트를 마치기 전에 죽은 부팅 사고에는 "열리지 않아요" 가 정확한
  // 말이다 — 마운트 신호(markAppMounted)가 아직 서지 않았는지로 가른다.
  const booted = document.documentElement.dataset.appMounted === "1";
  const detail = [report.message, report.stack, report.componentStack]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
  return (
    <div style={PANEL} role="alertdialog" aria-live="assertive">
      <h1 style={HEADLINE}>{booted ? L.crash.title : L.crash.bootTitle}</h1>
      <p style={BODY}>{L.crash.body}</p>
      <button type="button" style={REOPEN} onClick={() => window.location.reload()}>
        {L.crash.reopen}
      </button>
      {open ? (
        <div style={FOLD}>
          <pre style={DETAIL}>{detail}</pre>
          <p style={{ margin: "8px 0 0" }}>
            <CopyButton value={detail} />
          </p>
        </div>
      ) : (
        <button
          type="button"
          style={{
            ...FOLD,
            width: "auto",
            cursor: "pointer",
            background: "none",
            border: "none",
            padding: 0,
          }}
          onClick={() => setOpen(true)}
        >
          {DEV.crash.details}
        </button>
      )}
    </div>
  );
}
