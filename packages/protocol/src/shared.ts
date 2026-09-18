import { z } from "zod";

/** Wire enums both message directions share. */
export const PROTOCOL_VERSION = 16;

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const permissionModeSchema = z.enum([
  "default",
  "plan",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const effortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

export type SessionState =
  | "starting"
  | "idle"
  | "running"
  | "waiting_permission"
  | "waiting_question"
  | "error"
  | "closed";
