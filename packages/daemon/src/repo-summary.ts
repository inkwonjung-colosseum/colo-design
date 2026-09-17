// The 넘기기-draft and save-memo voices: one agent turn on the same SDK the
// sessions ride, cached against the cycle tip they answered for.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiffFile, RepoHandoffDraft } from "@colo-design/protocol";
import { claudeOneShot } from "./agent/drivers/claude/one-shot.js";
import { readComments } from "./comments.js";
import { buildCommentsSection, buildFilesSection } from "./handoff-body.js";
import {
  HANDOFF_DRAFT_TIMEOUT_MS,
  MACHINE_MODEL,
  MEMO_TIMEOUT_MS,
  type RepoCore,
} from "./repo-core.js";
import {
  HANDOFF_BODY_MAX_CHARS,
  HANDOFF_FILE_LIMIT,
  HANDOFF_TITLE_MAX_CHARS,
  handoffPrompt,
  MEMO_MAX_CHARS,
  memoPrompt,
} from "./repo-prompts.js";

export class RepoSummarizer {
  constructor(private readonly core: RepoCore) {}

  /**
   * The 넘기기 draft's memory (비개발자 넘기기): the cycle tip its title and
   * body answer for. Reopening the dialog on an unchanged cycle is free, and
   * a save that moved the tip retires it.
   */
  private handoffDraftCache: {
    tip: string;
    draft: RepoHandoffDraft;
  } | null = null;

  // -------------------------------------------------------------------------
  // 넘기기 초안과 저장 메모 (비개발자 넘기기 · 비개발자 저장)
  // -------------------------------------------------------------------------

  /**
   * 개발자에게 넘기기의 초안 (비개발자 넘기기): the title and the paragraph a
   * developer reads first, written from what this cycle already said about
   * itself — its 저장 메모 and the files those saves moved, never the whole
   * diff. One agent turn on the same leash as the save memo's; anywhere it
   * cannot land the answer is empty, and the dialog keeps the browser's own
   * proposal, which is what it opened with before this existed.
   */
  async handoffDraft(
    options: { commentsFile?: string; shotCount?: number } = {},
  ): Promise<RepoHandoffDraft> {
    const empty: RepoHandoffDraft = { title: "", body: "", source: "fallback" };
    if (!this.core.isCloned() || !this.core.branch) return empty;
    const range = `origin/${this.core.baseBranch}..${this.core.branch}`;
    const tip = (await this.core.git(["rev-parse", this.core.branch]).catch(() => "")).trim();
    if (!tip) return empty;
    // The extras are the daemon's own appended sections, computed fresh every
    // time — the draft's cache is about the agent.s words, not the pin list's.
    const extras = await this.handoffExtras({ ...options, range });
    if (this.handoffDraftCache?.tip === tip) {
      return { ...this.handoffDraftCache.draft, extras };
    }

    const memos = (await this.core.git(["log", "--reverse", "--format=%s", range]).catch(() => ""))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const files = (await this.core.git(["diff", "--name-status", range]).catch(() => ""))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, HANDOFF_FILE_LIMIT);
    // Nothing saved on this cycle yet: there is no work to describe, and a
    // turn over an empty range would invent one. The extras still answer —
    // pins taken before the first 저장 ride the handoff too.
    if (memos.length === 0 && files.length === 0) return { ...empty, extras };

    const draft = (await this.claudeHandoffDraft(memos, files).catch(() => null)) ?? empty;
    this.handoffDraftCache = { tip, draft };
    return { ...draft, extras };
  }

  /**
   * The sections the daemon appends to the pull request body on its own —
   * the preview shows them so what the developer receives is never a
   * surprise. Both are best-effort: a store that will not read or a repo
   * that refuses captures simply leaves that line out.
   */
  private async handoffExtras(options: {
    commentsFile?: string;
    shotCount?: number;
    /** `origin/base..branch` — the cycle's own diff range, computed by the caller. */
    range: string;
  }): Promise<NonNullable<RepoHandoffDraft["extras"]>> {
    // The cycle's own numstat — the same read runHandoff makes when it
    // appends the section for real, so the preview is never a promise the
    // body does not keep.
    let filesSection: string | null = null;
    try {
      filesSection = buildFilesSection(
        await this.core.git(["diff", "--numstat", options.range]),
        HANDOFF_FILE_LIMIT,
      );
    } catch {
      // A range that will not diff costs only the preview line.
    }
    let commentsSection: string | null = null;
    try {
      // D93 후속: the anchor is the cycle's birth — project creation or the
      // previous request's landing. The pins that motivated this cycle's
      // changes are logged before the branch's first commit exists, so the
      // commit-time anchor read here before dropped the whole section.
      const since = await this.core.cycleAnchor();
      if (options.commentsFile && since) {
        commentsSection = buildCommentsSection(readComments(options.commentsFile), since);
      }
    } catch {
      // A history that will not read costs only the preview line.
    }
    return {
      commentsSection,
      filesSection,
      shotCount: options.shotCount ?? 0,
    };
  }

  /** The draft's one turn; an empty draft means "keep the browser's". */
  private async claudeHandoffDraft(
    memos: string[],
    files: string[],
  ): Promise<RepoHandoffDraft | null> {
    const answer = await this.oneTurn(handoffPrompt(memos, files), HANDOFF_DRAFT_TIMEOUT_MS);
    const lines = (answer ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*#+\s*/, "").trimEnd());
    const first = lines.findIndex((line) => line.trim() !== "");
    if (first === -1) return null;
    const title = (lines[first] ?? "")
      .replace(/^[-·•*]\s*/, "")
      .replace(/^(제목|title)\s*[:：]\s*/i, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim()
      .slice(0, HANDOFF_TITLE_MAX_CHARS);
    if (!title) return null;
    const body = lines
      .slice(first + 1)
      .join("\n")
      .replace(/^(내용|body)\s*[:：]\s*/i, "")
      .trim()
      .slice(0, HANDOFF_BODY_MAX_CHARS);
    return { title, body, source: "claude" };
  }

  /**
   * The machine turns' working directory — deliberately NOT the clone. The
   * CLI files every transcript under the project folder of its cwd, and the
   * session list offers every transcript in the clone's folder as a
   * resumable conversation: a batch turn's one machine prompt surfaced in the
   * tree as a thread, and opening it read as if the planner had typed a wall
   * of file paths. The prompt carries its own diff and runs with no tools,
   * so these turns never read the clone; a scratch folder beside it keeps
   * the transcript out of the conversation store.
   */
  private summaryCwd(): string {
    const dir = join(dirname(this.core.root), "summary");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * One machine turn (비개발자 저장): the same SDK entry the sessions use,
   * aimed at a single answer-nothing-else turn — no tools to run, no
   * settings to load, and haiku answering: reading a diff and saying what
   * it did is haiku's job, and its latency is what the leashes assume. The
   * prompt is everything this call may read; the transcript lands beside
   * the draft's, out of the conversation store. Null means "use the
   * fallback".
   */
  private async oneTurn(prompt: string, timeoutMs: number): Promise<string | null> {
    return claudeOneShot(prompt, {
      cwd: this.summaryCwd(),
      executable: this.core.claudeExecutable,
      model: MACHINE_MODEL,
      timeoutMs,
    });
  }

  /**
   * The save-time memo (비개발자 저장): when the planner saves without a
   * memo, this turn writes one — one Korean sentence from the diff, so
   * pressing 저장 alone is enough. Null means "use the default message".
   */
  async claudeMemo(files: DiffFile[]): Promise<string | null> {
    const answer = await this.oneTurn(memoPrompt(files), MEMO_TIMEOUT_MS);
    const line = (answer ?? "")
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^[-·•*#>\s]+/, "")
          .replace(/^["'`]+|["'`]+$/g, "")
          .trim(),
      )
      .filter(Boolean)[0];
    return line ? line.slice(0, MEMO_MAX_CHARS) : null;
  }
}
