// The summary and 넘기기-draft voices (PLAN D51): one Claude turn on the
// same SDK the sessions ride, cached against the diff it answered for.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { DiffFile, RepoHandoffDraft, RepoSummary } from "@colo-design/protocol";
import { readComments } from "./comments.js";
import { buildCommentsSection } from "./handoff-body.js";
import {
  HANDOFF_DRAFT_TIMEOUT_MS,
  MACHINE_MODEL,
  MEMO_TIMEOUT_MS,
  type RepoCore,
  SUMMARY_TIMEOUT_MS,
} from "./repo-core.js";
import { fallbackSummary } from "./repo-diff.js";
import {
  HANDOFF_BODY_MAX_CHARS,
  HANDOFF_FILE_LIMIT,
  HANDOFF_TITLE_MAX_CHARS,
  handoffPrompt,
  MEMO_MAX_CHARS,
  memoPrompt,
  renderSummaryFile,
  SUMMARY_MAX_LINES,
  summaryPrompt,
} from "./repo-prompts.js";

export class RepoSummarizer {
  constructor(private readonly core: RepoCore) {}

  /**
   * The summary's memory (PLAN D51): the diff hash its lines answer for.
   * One entry, in daemon memory on purpose — reopening the save review on
   * an unchanged diff must not pay for another Claude turn, and a moved
   * diff must not show yesterday's words.
   */
  private summaryCache: {
    hash: string;
    lines: string[];
    memo?: string;
    source: RepoSummary["source"];
  } | null = null;

  /**
   * The 넘기기 draft's memory (비개발자 넘기기): the cycle tip its title and
   * body answer for. Same rule as the summary's — reopening the dialog on an
   * unchanged cycle is free, and a save that moved the tip retires it.
   */
  private handoffDraftCache: {
    tip: string;
    draft: RepoHandoffDraft;
  } | null = null;

  // -------------------------------------------------------------------------
  // 되돌리기와 요약 (PLAN D51 · D52 · D53)
  // -------------------------------------------------------------------------

  /**
   * 저장 검토의 요약 (PLAN D51): what changed, in the planner's words. One
   * Claude turn — `maxTurns: 1`, no tools, three seconds — over the diff
   * itself; anywhere it cannot land (no CLI, timeout, refusal, empty answer)
   * falls back to grouping the changed paths. Answered from memory when the
   * diff has not moved since the last ask, so re-opening the review is free.
   */
  async summarize(
    screenTitles: Array<{ route: string; title: string }> = [],
  ): Promise<RepoSummary> {
    if (!this.core.isCloned()) return { lines: [], source: "fallback" };
    const files = await this.core.diff();
    if (files.length === 0) return { lines: [], source: "fallback" };
    const hash = createHash("sha256")
      .update(files.map(renderSummaryFile).join("\n"))
      .update("\0")
      .update(screenTitles.map((screen) => `${screen.route}=${screen.title}`).join(","))
      .digest("hex");
    if (this.summaryCache?.hash === hash) {
      return {
        lines: this.summaryCache.lines,
        ...(this.summaryCache.memo ? { memo: this.summaryCache.memo } : {}),
        source: this.summaryCache.source,
      };
    }
    const summary = (await this.claudeSummary(files, screenTitles).catch(() => null)) ?? {
      lines: fallbackSummary(files),
      source: "fallback" as const,
    };
    this.summaryCache = {
      hash,
      lines: summary.lines,
      ...(summary.memo ? { memo: summary.memo } : {}),
      source: summary.source,
    };
    return summary;
  }

  /**
   * 개발자에게 넘기기의 초안 (비개발자 넘기기): the title and the paragraph a
   * developer reads first, written from what this cycle already said about
   * itself — its 저장 메모 and the files those saves moved, never the whole
   * diff. One Claude turn on the same leash as the save memo's; anywhere it
   * cannot land the answer is empty, and the dialog keeps the browser's own
   * proposal, which is what it opened with before this existed.
   */
  async handoffDraft(
    options: {
      commentsFile?: string;
      screenTitles?: Array<{ route: string; title: string }>;
      shotCount?: number;
    } = {},
  ): Promise<RepoHandoffDraft> {
    const empty: RepoHandoffDraft = { title: "", body: "", source: "fallback" };
    if (!this.core.isCloned() || !this.core.branch) return empty;
    const range = `origin/${this.core.baseBranch}..${this.core.branch}`;
    const tip = (await this.core.git(["rev-parse", this.core.branch]).catch(() => "")).trim();
    if (!tip) return empty;
    // The extras are the daemon's own appended sections, computed fresh every
    // time — the draft's cache is about Claude's words, not the pin list's.
    const extras = await this.handoffExtras(options);
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
    screenTitles?: Array<{ route: string; title: string }>;
    shotCount?: number;
  }): Promise<NonNullable<RepoHandoffDraft["extras"]>> {
    let commentsSection: string | null = null;
    try {
      const since = (
        await this.core.git([
          "log",
          "--reverse",
          "--format=%cI",
          `origin/${this.core.baseBranch}..${this.core.branch}`,
        ])
      )
        .split("\n")[0]
        ?.trim();
      if (options.commentsFile && since) {
        commentsSection = buildCommentsSection(
          readComments(options.commentsFile),
          (screenId) =>
            options.screenTitles?.find((screen) => screen.route === `/${screenId}`)?.title ?? null,
          since,
        );
      }
    } catch {
      // A history that will not read costs only the preview line.
    }
    return { commentsSection, shotCount: options.shotCount ?? 0 };
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
   * The summarizer's working directory — deliberately NOT the clone. The CLI
   * files every transcript under the project folder of its cwd, and the
   * session list offers every transcript in the clone's folder as a
   * resumable conversation: a batch turn's one machine prompt surfaced in the
   * tree as a thread, and opening it read as if the planner had typed a wall
   * of file paths. The prompt carries its own diff and runs with no tools,
   * so the summary never reads the clone; a scratch folder beside it keeps
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
   * the summary's, out of the conversation store. Null means "use the
   * fallback".
   */
  private async oneTurn(prompt: string, timeoutMs: number): Promise<string | null> {
    if (!this.core.claudeExecutable) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const conversation = query({
        prompt,
        options: {
          cwd: this.summaryCwd(),
          pathToClaudeCodeExecutable: this.core.claudeExecutable,
          model: MACHINE_MODEL,
          maxTurns: 1,
          tools: [],
          settingSources: [],
          abortController: controller,
        },
      });
      let answer: string | null = null;
      for await (const message of conversation) {
        if (message.type === "result" && message.subtype === "success" && !message.is_error) {
          answer = message.result;
        }
      }
      return answer;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * The summarizer's one turn; null means "use the fallback". The answer is
   * the summary lines plus one `메모:` line — the marker is stripped into
   * `memo`, and a memo-only answer is no summary at all.
   */
  private async claudeSummary(
    files: DiffFile[],
    screenTitles: Array<{ route: string; title: string }>,
  ): Promise<RepoSummary | null> {
    const answer = await this.oneTurn(summaryPrompt(files, screenTitles), SUMMARY_TIMEOUT_MS);
    const lines: string[] = [];
    let memo: string | undefined;
    for (const raw of (answer ?? "").split(/\r?\n/)) {
      const line = raw.replace(/^[-·•*]\s*/, "").trim();
      if (!line) continue;
      const memoMatch = /^메모\s*[:：]\s*(.+)$/.exec(line);
      if (memoMatch?.[1]) {
        memo = memoMatch[1].replace(/^["'`]+|["'`]+$/g, "").trim();
        continue;
      }
      lines.push(line);
    }
    const summary = lines.slice(0, SUMMARY_MAX_LINES);
    if (summary.length === 0) return null;
    return {
      lines: summary,
      ...(memo ? { memo: memo.slice(0, MEMO_MAX_CHARS) } : {}),
      source: "claude",
    };
  }

  /**
   * The save-time memo (비개발자 저장): when the planner saves with the memo
   * left empty, this turn writes one — one Korean sentence from the same
   * diff the review's summary read, so pressing 저장 alone is enough. Null
   * means "use the default message".
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
