/**
 * Phase 1b — split src/components.tsx into components/transcript/* plus the
 * two shared primitives (CopyButton, Fold) at components/ root.
 *
 * Each file below is a list of [firstLine, lastLine] spans (1-based,
 * inclusive) taken from components.tsx. Span starts were chosen at each
 * unit's doc comment so the prose travels with its code. components/index.ts
 * becomes the facade — existing `./components` / `../../components`
 * specifiers resolve to it untouched.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "packages/web/src";
const lines = readFileSync(join(SRC, "components.tsx"), "utf8").split("\n");

const FILES = {
  "components/transcript/shared.ts": {
    header: `import type { Block } from "../../lib/daemon-client";

`,
    spans: [
      [47, 92], // preview, toolHeadline, SCREEN_LOOK_TOOL, screenshotImage
      [121, 129], // ToolStatus, TaskControls
      [427, 427], // TodoToolBlock
    ],
    footer: `export type { TaskControls, TodoToolBlock };
`,
  },
  "components/transcript/blocks.tsx": {
    header: `import { useState } from "react";
import type { Block } from "../../lib/daemon-client";
import { isToolRunning } from "../../lib/progress";
import { toolLabel } from "../../lib/labels";
import { CheckIcon, ChevronRightIcon, CloseIcon, SparkIcon } from "../icons";
import { Tip } from "../shell/Tip";
import { preview, screenshotImage, toolHeadline, type TaskControls } from "./shared";

`,
    spans: [
      [94, 119], // CaptureCard (+doc)
      [131, 238], // ToolBlock
      [286, 306], // ThinkingBlock (+doc)
    ],
    footer: `export { CaptureCard, ThinkingBlock, ToolBlock };
`,
  },
  "components/transcript/activity.tsx": {
    header: `import { useState } from "react";
import type { Block } from "../../lib/daemon-client";
import { isToolRunning } from "../../lib/progress";
import { SCREEN_SHOT_TOOL } from "../../lib/tape-visibility";
import { CheckIcon, ChevronRightIcon } from "../icons";
import { Markdown } from "../Markdown";
import { ThinkingBlock, ToolBlock } from "./blocks";
import { SCREEN_LOOK_TOOL, type TaskControls, type TodoToolBlock } from "./shared";

`,
    spans: [
      [240, 284], // ACTIVITY_BUCKET, activityLine (+doc)
      [308, 425], // SubagentThread, ActivityStepRow, ActivitySummary, ActivityStep (+docs)
      [429, 496], // Row, groupActivity (+doc)
    ],
    footer: `export { ActivitySummary, groupActivity };
export type { ActivityStep, Row };
`,
  },
  "components/transcript/todo.tsx": {
    header: `import { useState } from "react";
import { ToolBlock } from "./blocks";
import type { TodoToolBlock } from "./shared";

`,
    spans: [[498, 583]], // TodoItem, todoItems, TodoList, TodoCard (+docs)
    footer: `export { TodoCard };
`,
  },
  "components/transcript/turn.tsx": {
    header: `import { useState } from "react";
import {
  type ColoDesignScreen,
  type TurnMarker,
  alignThumbs,
  readTurn,
} from "@colo-design/protocol";
import type { Block } from "../../lib/daemon-client";
import { waitedFor } from "../../lib/format";
import { CopyButton } from "../CopyButton";
import { ChevronRightIcon } from "../icons";
import { Tip } from "../shell/Tip";

`,
    spans: [
      [585, 758], // MachineTurn (+doc), TURN_SUBTYPE_WORDS
      [864, 1027], // FailedTurn+LIMIT_RESULT, ScreenChips, lastUserText, isLastFailedTurn, TurnDone (+docs)
    ],
    footer: `export { FailedTurn, isLastFailedTurn, lastUserText, MachineTurn, ScreenChips, TurnDone };
`,
  },
  "components/transcript/Transcript.tsx": {
    header: `import { useState } from "react";
import { type ColoDesignScreen, readTurn } from "@colo-design/protocol";
import type { Block } from "../../lib/daemon-client";
import { GENERIC_STARTERS } from "../../lib/suggestions";
import { blockOnTape, mergeThinking, SCREEN_SHOT_TOOL } from "../../lib/tape-visibility";
import {
  answerTurnNumbers,
  lastAnswerPerTurn,
  promptTotal,
  turnAnswerText,
} from "../../lib/turn-numbering";
import { CopyButton } from "../CopyButton";
import { ConfirmDialog } from "../dialogs/ConfirmDialog";
import { Markdown } from "../Markdown";
import { Tip } from "../shell/Tip";
import { ActivitySummary, groupActivity } from "./activity";
import { CaptureCard, ThinkingBlock, ToolBlock } from "./blocks";
import { TodoCard } from "./todo";
import {
  FailedTurn,
  isLastFailedTurn,
  lastUserText,
  MachineTurn,
  ScreenChips,
  TurnDone,
} from "./turn";

`,
    spans: [
      [29, 38], // TAPE_LINES (+doc)
      [1029, 1390], // Transcript
    ],
  },
  "components/transcript/cards.tsx": {
    header: `import { useState } from "react";
import type { AskQuestion, RepoStatus } from "@colo-design/protocol";
import type { PendingPermission, PendingQuestion } from "../../lib/daemon-client";
import { composing } from "../../lib/ime";
import { bashHeadline, objectParticle, toolLabel } from "../../lib/labels";
import { ShieldIcon, SparkIcon } from "../icons";
import { Markdown } from "../Markdown";
import { Tip } from "../shell/Tip";
import { preview, toolHeadline } from "./shared";

`,
    spans: [
      [41, 41], // RepoCommands
      [1392, 1691], // section header + PlanCard, PermissionCard, OptionPreview, QuestionCard
    ],
    footer: "",
  },
  "components/CopyButton.tsx": {
    header: `import { type ReactNode, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";
import { Tip } from "./shell/Tip";

`,
    spans: [[760, 807]], // CopyButton (+doc)
    footer: "",
  },
  "components/Fold.tsx": {
    header: `import { type ReactNode, useState } from "react";

`,
    spans: [[809, 862]], // Fold, useFoldNotice (+docs)
    footer: "",
  },
};

for (const [dest, spec] of Object.entries(FILES)) {
  const body = spec.spans.map(([a, b]) => lines.slice(a - 1, b).join("\n")).join("\n\n");
  const out = `${spec.header}${body}\n${spec.footer}`;
  const path = join(SRC, dest);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, out);
  console.log(`wrote ${dest} (${out.split("\n").length} lines)`);
}
