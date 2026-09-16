import type { Block } from "../../lib/daemon-client";

export function preview(value: unknown, max = 240): string {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The one input field that best identifies what a tool call is about. */
export function toolHeadline(input: unknown): string {
  const i = input as Record<string, unknown> | null;
  if (!i || typeof i !== "object") return "";
  for (const key of ["command", "file_path", "path", "pattern", "url", "prompt", "description"]) {
    const value = i[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/**
 * The colo-preview 도구 이름은 `mcp__colo-preview__screen_*` 로 온다:
 * the server prefix is plumbing, so the recognisers key on the tool's
 * own name. The capture pattern itself lives beside the tape-visibility rule
 * — both the renderer and the filter must agree on what a capture is.
 */
export const SCREEN_LOOK_TOOL = /screen_(?:read|click|open)$/;

/**
 * The image a finished screen_screenshot carries, read defensively out of
 * the tool result: an MCP image content item (`{ type: "image", data,
 * mimeType }`) inside an array, or alone. Anything else — a running call, a
 * failure, a plain string — is not a capture.
 */
export function screenshotImage(result: unknown): { data: string; mimeType: string } | null {
  const items = Array.isArray(result) ? result : [result];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string" && record.data) {
      return {
        data: record.data,
        mimeType:
          typeof record.mimeType === "string" && record.mimeType ? record.mimeType : "image/jpeg",
      };
    }
  }
  return null;
}

export type ToolStatus = "running" | "done" | "error";

/** 도구 행이 스스로 그릴 수 있는 것 밖의, 작업을 다루는 손. */
export interface TaskControls {
  /** 턴을 붙잡은 작업을 뒤로 보낸다 — 인자는 그 도구 호출의 id. */
  onBackgroundTask?: (toolUseId: string) => void;
  /** 그 작업 하나만 세운다 — 인자는 작업 id. */
  onStopTask?: (taskId: string) => void;
}

export type TodoToolBlock = Extract<Block, { type: "tool" }>;
