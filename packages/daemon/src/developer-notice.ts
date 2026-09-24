/**
 * 개발자 알림 (PLAN L11 · 단계 4) — 도구도 AI 도 고칠 수 없는 문제가 개발자에게
 * 닿는 길. GitHub 가 먼저이고 Slack(escalation)은 보조다: 그 프로젝트에 열린
 * PR 이 있으면 그 PR 의 코멘트로, 없으면 저장소의 이슈로, GitHub 에 아예 닿지
 * 않을 때(인증 만료 · 권한 · 네트워크)만 Slack 으로 간다. 어느 길도 없으면
 * "none" 을 돌려준다 — 알리지 못한 것을 알렸다고 말하지 않는다(PLAN O9).
 *
 * 같은 문제 키의 갱신은 10분에 한 번(BUDGETS.noticeRefreshMs) — 문제가 지속되는
 * 동안 GitHub 이 도배되지 않는다. 상태(코멘트 id · 이슈 번호 · 횟수 · 시각)는
 * 프로젝트 알림이면 그 프로젝트의 cycle.json notices 에 적고, 기계 전체 알림
 * (slug null)은 메모리에 둔다 — 원장은 감독자가 들고 있으므로 여기서는
 * 접근자(deps.store)를 통해 읽고 쓴다.
 */

import type { AttentionNotice } from "@colo-design/protocol";
import { BUDGETS } from "./budgets.js";
import type { CycleLedger } from "./cycle-ledger.js";
import type { Escalation } from "./escalation.js";
import type { GitHubClient } from "./github.js";
import type { DaemonLogger } from "./log.js";
import { sanitizeText } from "./log.js";

export interface Problem {
  /** 문제 키 — 중복을 가르는 안정된 이름. `bring-up:port-undetected` · `push:auth` 처럼. */
  key: string;
  /** 프로젝트 슬러그 — null 이면 기계 전체의 문제(연결 코드 · 환경). */
  slug: string | null;
  /** 한 줄 제목. */
  title: string;
  /** 무엇이 막혔나. */
  what: string;
  /** 도구가 무엇을 해 봤나. */
  tried: string;
  /** 개발자에게 무엇을 부탁하나. */
  ask: string;
  /** 기록 — 생니타이저를 거치고 30줄 · 4000자에서 자른다. */
  detail?: string;
}

export type NoticeVia = "pr" | "issue" | "slack" | "none";

/** 원장 notices 의 값 — cycle-ledger 의 모양 그대로. */
export type NoticeEntry = CycleLedger["notices"][string];

/** 감독자가 주는 원장 접근자 — notices 를 읽고 한 항목을 쓰거나 지운다. */
export interface NoticeStore {
  notices(): Record<string, NoticeEntry>;
  setNotice(key: string, entry: NoticeEntry | null): void;
}

export interface DeveloperNoticeDeps {
  /** 기계 전체의 GitHub 손잡이 — 없으면(토큰 없음) GitHub 경로는 닫혀 있다. */
  github(): GitHubClient | null;
  /** GitHubBridge.authExpired — 만료가 확인된 토큰으로는 쓰러 가지 않는다. */
  githubAuthExpired(): boolean;
  /** 프로젝트 슬러그 → 저장소의 owner/repo — 없으면 GitHub 경로는 닫혀 있다. */
  repoSlug(slug: string): { owner: string; repo: string } | null;
  /** 프로젝트의 문맥 — 본문의 이름, 이슈의 담당자, 열린 PR 의 번호. */
  project(slug: string): { name: string; reviewers: string[]; openPr: number | null } | null;
  /** 넘긴 요청 본문의 `> 작성:` 줄과 같은 이름. */
  authorName(): string | null;
  /** Slack 보조 경로 — 없으면 그 길은 닫혀 있다. */
  slack: Escalation;
  /** 프로젝트 알림의 원장 — 감독자가 들고 있다. 없으면 메모리로 흘린다. */
  store(slug: string): NoticeStore | null;
  logger: DaemonLogger;
  /** 시험의 벽시계. */
  now?: () => number;
}

/** 이슈 본문의 표식 — 같은 문제의 이슈를 다시 찾는 단서 (PLAN L11). */
export const ISSUE_MARKER = "<!-- colo-design:problem ";
/** 이슈에 붙이는 라벨 — 최선의 노력으로, 실패해도 이슈는 연다. */
export const ISSUE_LABEL = "colo-design";
/** `자세히` 의 상한 — 30줄 · 4000자. */
const DETAIL_MAX_LINES = 30;
const DETAIL_MAX_CHARS = 4000;

/** 문제 키의 문장 — 표에 없는 키는 접두어로 읽고, 그래도 모르면 키가 곧 제목이다. */
export function describeProblem(key: string, detail?: string): Omit<Problem, "key" | "slug"> {
  const known = PROBLEM_TEXT[key];
  const base: Omit<Problem, "key" | "slug" | "detail"> =
    known ??
    (key.startsWith("review:")
      ? PROBLEM_TEXT["review:*"]!
      : key.startsWith("bring-up:")
        ? {
            title: "화면 준비가 멈췄습니다",
            what: `화면 준비가 "${key.slice("bring-up:".length)}" 단계에서 멈췄습니다`,
            tried: "AI 가 두 번 고쳐 봤지만 같은 자리를 넘지 못했습니다",
            ask: "연결 레포의 명령과 환경을 확인해 주세요",
          }
        : key.startsWith("env:")
          ? {
              title: "이 컴퓨터의 환경에 문제가 있습니다",
              what: "데몬의 환경 검사가 문제를 보고했습니다",
              tried: "도구가 스스로 고칠 수 있는 자리가 아닙니다",
              ask: "아래 자세히의 안내를 따라 주세요",
            }
          : { title: key, what: key, tried: "—", ask: "확인해 주세요" });
  return detail !== undefined ? { ...base, detail } : base;
}

const PROBLEM_TEXT: Record<string, Omit<Problem, "key" | "slug" | "detail">> = {
  "github:auth": {
    title: "연결 코드(GitHub)가 만료됐습니다",
    what: "GitHub 이 데몬의 읽기에 401 로 답하고 있습니다",
    tried: "토큰은 사용자의 열쇠라 도구가 대신 만들 수 없습니다",
    ask: "새 초대 파일을 사용자에게 보내 주세요",
  },
  "push:auth": {
    title: "푸시가 인증 · 권한으로 거절됐습니다",
    what: "저장한 작업을 원격에 올리지 못하고 있습니다",
    tried: "같은 푸시를 다시 시도했지만 같은 거절이 돌아왔습니다",
    ask: "연결 코드의 쓰기 권한을 확인해 주세요",
  },
  "submit:commit": {
    title: "제출을 마저 저장하지 못했습니다",
    what: "제출이 보관 단계에서 멈춰 있습니다",
    tried: "자동 보관을 다시 시도했지만 같은 실패가 돌아왔습니다",
    ask: "레포의 상태와 아래 자세히를 확인해 주세요",
  },
  "submit:pr": {
    title: "풀 리퀘스트를 열지 못했습니다",
    what: "제출이 PR 만들기 단계에서 멈췄습니다",
    tried: "커밋과 푸시는 끝났고 PR 열기만 거절됐습니다",
    ask: "저장소의 권한 · 브랜치 보호 규칙을 확인해 주세요",
  },
  "push:behind": {
    title: "저장한 작업을 1시간 넘게 올리지 못하고 있습니다",
    what: "커밋은 쌓였는데 원격에 올라가지 않고 있습니다",
    tried: "백오프를 두며 계속 다시 밀고 있습니다",
    ask: "원격 저장소의 상태를 확인해 주세요",
  },
  "conflict:stuck": {
    title: "충돌 정리가 두 번의 안내에도 끝나지 않았습니다",
    what: "도구가 시작한 병합 · 복원의 충돌 표식이 남아 있습니다",
    tried: "AI 가 두 번 정리를 시도했습니다",
    ask: "충돌 파일을 직접 봐 주세요",
  },
  "base-missing": {
    title: "베이스 브랜치가 원격에 없습니다",
    what: "사이클의 기준 가지를 찾지 못했고 GitHub 의 기본 가지도 알 수 없습니다",
    tried: "기본 가지 읽기까지 시도했습니다",
    ask: "저장소의 기본 가지를 확인해 주세요",
  },
  "review:*": {
    title: "코멘트 반영이 라운드 상한에 닿았습니다",
    what: "개발자 코멘트를 AI 가 여러 번 반영했지만 끝나지 않았습니다",
    tried: "PR 당 정해진 라운드까지 반영했습니다",
    ask: "PR 의 코멘트를 직접 확인해 주세요",
  },
  "turn:failed": {
    title: "대화가 같은 오류로 다섯 번 넘어졌습니다",
    what: "사용자의 요청이 일시 오류로 다섯 번 재시도 끝에 실패했습니다",
    tried: "4초에서 15분까지 스스로 다시 시도했습니다",
    ask: "아래 자세히의 오류 원문을 봐 주세요 — 로그에도 같은 문장이 있습니다",
  },
  "clone:corrupt": {
    title: "사용자의 작업 폴더(클론)가 손상됐습니다",
    what: "사용자 컴퓨터의 연결 레포 사본이 git 으로 읽히지 않습니다",
    tried:
      "하루 한 번의 다시 받기를 이미 썼거나, 사용자의 작업을 구해 두지 못해 다시 받지 않았습니다",
    ask: "아래 자세히의 오류를 보고 사용자의 작업 폴더를 확인해 주세요",
  },
  "clone:restore": {
    title: "다시 받은 작업 폴더에 사용자의 작업을 되살리지 못했습니다",
    what: "손상된 사본을 새로 받았지만 구해 둔 변경 · 커밋을 다시 얹지 못했습니다",
    tried: "변경을 그대로, 그리고 3-way 로 얹어 봤습니다 — 구해 둔 폴더는 그대로 남아 있습니다",
    ask: "자세히의 구해 둔 폴더에서 사용자의 작업을 옮겨 주세요",
  },
  "disk:low": {
    title: "사용자 컴퓨터의 저장 공간이 모자랍니다",
    what: "Colo Design 의 폴더가 든 디스크의 여유가 2GB 아래입니다",
    tried: "도구가 치울 수 있는 것(끝난 브랜치 · 7일 넘은 임시 파일 · git 정리)을 먼저 치웠습니다",
    ask: "사용자와 함께 디스크를 비워 주세요 — 도구가 더 치울 수 있는 것은 없습니다",
  },
  "revive:exhausted": {
    title: "AI 프로그램을 되살리지 못했습니다",
    what: "대화가 도는 중에 AI 프로그램이 죽고, 되살리기 상한(10분 안에 3회)을 넘겼습니다",
    tried: "같은 대화를 세 번 되살려 보았습니다",
    ask: "AI 프로그램(CLI) 의 상태를 확인해 주세요",
  },
};

/**
 * 화면의 주의로 서지 않는 기계 전체 알림 (PLAN O8 — 이번 결정) — 사용자
 * 기계의 일이라 개발자도 도구도 고칠 수 없는 문제(디스크 여유)는 개발자
 * 쪽(Slack · 로그)에만 가고 화면은 세 문장 중 아무것도 말하지 않는다. 네 번째
 * 문장(`저장 공간이 부족해요`)을 둘지는 열린 항목으로 남는다.
 */
const SCREEN_QUIET_KEYS = new Set(["disk:low"]);

/** 이슈 목록의 한 줄에서 이 문제의 표식을 찾는다 — 없으면 null. */
export function findIssueMarker(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const at = body.indexOf(ISSUE_MARKER);
  if (at < 0) return null;
  const rest = body.slice(at + ISSUE_MARKER.length);
  const end = rest.indexOf("-->");
  return end < 0 ? null : rest.slice(0, end).trim();
}

/** 열린 이슈 목록에서 이 문제 키의 이슈 번호 — 없으면 null. */
export function findNoticeIssue(rows: Array<Record<string, unknown>>, key: string): number | null {
  for (const row of rows) {
    if (findIssueMarker(row?.body) === key) {
      const number = Number(row.number);
      return Number.isFinite(number) ? number : null;
    }
  }
  return null;
}

/** `자세히` 의 내용 — 생니타이저를 거치고 줄 · 글자 상한에서 자른다. */
export function clipDetail(detail: string): string {
  const clean = sanitizeText(detail);
  const lines = clean.split("\n");
  const clipped =
    lines.length > DETAIL_MAX_LINES ? `${lines.slice(0, DETAIL_MAX_LINES).join("\n")}\n…` : clean;
  return clipped.length > DETAIL_MAX_CHARS ? `${clipped.slice(0, DETAIL_MAX_CHARS)}…` : clipped;
}

/**
 * 알림 본문의 네 줄 (PLAN L11) — 첫 줄에 프로젝트 이름과 작성자 이름, 그 뒤
 * 무엇이 · 해 본 것 · 부탁. `count` 가 둘을 넘으면 다시 울린 횟수와 시각이
 * 덧붙는다(PR 코멘트의 갱신).
 */
export function noticeBody(
  problem: Problem,
  context: { projectName: string; authorName: string | null },
  count: number,
  at: Date,
): string {
  const who = context.authorName ? `${context.authorName} 님의 ` : "";
  const lines = [
    `[Colo Design] ${context.projectName} · ${who}작업이 막혔습니다`,
    ``,
    `**무엇이** ${problem.what}`,
    `**해 본 것** ${problem.tried}`,
    `**부탁** ${problem.ask}`,
  ];
  if (count > 1) {
    lines.push(``, `_${count}번째 알림 · 마지막 ${at.toISOString()}_`);
  }
  if (problem.detail) {
    lines.push(
      ``,
      `<details><summary>자세히</summary>`,
      ``,
      "```",
      clipDetail(problem.detail),
      "```",
      ``,
      `</details>`,
    );
  }
  return lines.join("\n");
}

/** Slack 으로 나가는 한 덩이 — 마크다운 접힘 없이 같은 네 줄. */
function slackText(
  problem: Problem,
  context: { projectName: string; authorName: string | null },
): string {
  const who = context.authorName ? `${context.authorName} 님의 ` : "";
  const lines = [
    `[Colo Design] ${context.projectName} · ${who}작업이 막혔습니다`,
    `무엇이: ${problem.what}`,
    `해 본 것: ${problem.tried}`,
    `부탁: ${problem.ask}`,
  ];
  if (problem.detail) lines.push(`자세히: ${clipDetail(problem.detail)}`);
  return lines.join("\n");
}

export class DeveloperNotice {
  /**
   * 마지막으로 GitHub/Slack 에 실제로 쓴 시각 — 키(`${slug ?? ""}:${key}`)마다
   * 하나. 원장의 raisedAt 은 첫 알림의 시각이라 갱신 시각으로 쓰면 화면의
   * since 가 흔들리므로, 10분 창은 이 메모리가 잰다(재시작 뒤 한 번의 추가
   * 쓰기는 허용한다).
   */
  private readonly lastWriteAt = new Map<string, number>();
  /** 기계 전체 알림과 원장이 없는 프로젝트의 알림 — 메모리 상태. */
  private readonly memory = new Map<string, NoticeEntry>();
  /** 같은 키의 raise 가 겹치지 않게 — 진행 중인 배달의 약속. */
  private readonly inFlight = new Map<string, Promise<NoticeVia>>();

  constructor(private readonly deps: DeveloperNoticeDeps) {}

  private memoryKey(slug: string | null, key: string): string {
    // 구분자가 없으면 기계 전체 알림이 "github:auth" 로 서서 machineNotices 의
    // ":" 접두사 판정을 빗나가고, 슬러그·키가 붙어 다른 조합이 충돌한다.
    return `${slug ?? ""}:${key}`;
  }

  private entryOf(slug: string | null, key: string): NoticeEntry | undefined {
    const store = slug === null ? null : this.deps.store(slug);
    if (store) return store.notices()[key];
    return this.memory.get(this.memoryKey(slug, key));
  }

  private writeEntry(slug: string | null, key: string, entry: NoticeEntry | null): void {
    const store = slug === null ? null : this.deps.store(slug);
    if (store) {
      store.setNotice(key, entry);
      return;
    }
    const memKey = this.memoryKey(slug, key);
    if (entry === null) this.memory.delete(memKey);
    else this.memory.set(memKey, entry);
  }

  /**
   * 문제를 개발자에게 올린다 — 실제로 나간 경로를 돌려준다. "none" 은 어느
   * 채널도 닿지 못했다는 뜻이고, 호출자는 그 경우 `개발자에게 알렸어요` 를
   * 세우지 않는다(O9).
   */
  raise(problem: Problem): Promise<NoticeVia> {
    const memKey = this.memoryKey(problem.slug, problem.key);
    const pending = this.inFlight.get(memKey);
    if (pending) return pending;
    const run = this.raiseInner(problem).finally(() => this.inFlight.delete(memKey));
    this.inFlight.set(memKey, run);
    return run;
  }

  private async raiseInner(problem: Problem): Promise<NoticeVia> {
    const now = this.deps.now?.() ?? Date.now();
    const existing = this.entryOf(problem.slug, problem.key);
    const lastWrite = this.lastWriteAt.get(this.memoryKey(problem.slug, problem.key));
    if (
      existing !== undefined &&
      lastWrite !== undefined &&
      now - lastWrite < BUDGETS.noticeRefreshMs
    ) {
      // 10분 창 안의 다시 나기 — 쓰지 않고 서 있는 경로를 그대로 답한다.
      return existing.via;
    }
    const count = (existing?.count ?? 0) + 1;
    const via = await this.deliver(problem, existing, count, now);
    if (via.via === "none") {
      // 알리지 못했다 — 서 있던 기록도 거둬 화면이 알렸다고 말하지 않게 한다.
      if (existing) this.writeEntry(problem.slug, problem.key, null);
      return "none";
    }
    this.lastWriteAt.set(this.memoryKey(problem.slug, problem.key), now);
    this.writeEntry(problem.slug, problem.key, {
      via: via.via,
      ref: "ref" in via ? via.ref : undefined,
      raisedAt: existing?.raisedAt ?? new Date(now).toISOString(),
      count,
    });
    return via.via;
  }

  /** GitHub 경로의 배달 — 실패하면 null 을 돌려 Slack 으로 흘린다. */
  private async deliver(
    problem: Problem,
    existing: NoticeEntry | undefined,
    count: number,
    now: number,
  ): Promise<{ via: "pr" | "issue"; ref: number } | { via: "slack" } | { via: "none" }> {
    const client = problem.slug === null ? null : this.deps.github();
    const repoSlug = problem.slug === null ? null : this.deps.repoSlug(problem.slug);
    const project = problem.slug === null ? null : this.deps.project(problem.slug);
    if (client !== null && repoSlug !== null && !this.deps.githubAuthExpired()) {
      const context = {
        projectName: project?.name ?? problem.slug ?? "이 컴퓨터",
        authorName: this.deps.authorName(),
      };
      try {
        // 열린 PR 이 있으면 그 PR 의 코멘트 — 문제 키마다 하나, 다시 나면
        // 같은 코멘트를 고쳐 횟수와 시각을 갱신한다.
        const pr = project?.openPr ?? null;
        if (pr !== null) {
          const body = noticeBody(problem, context, count, new Date(now));
          if (existing?.via === "pr" && typeof existing.ref === "number") {
            await client.updateIssueComment({ ...repoSlug, commentId: existing.ref, body });
            return { via: "pr", ref: existing.ref };
          }
          const ref = await client.commentOnIssue({ ...repoSlug, number: pr, body });
          return { via: "pr", ref };
        }
        // PR 이 없다 — 이슈. 표식이 같은 열린 이슈가 있으면 코멘트만 덧붙인다.
        const who = await client.whoAmI();
        if (who.ok) {
          const marked = `<!-- colo-design:problem ${problem.key} -->\n`;
          if (existing?.via === "issue" && typeof existing.ref === "number") {
            await client.commentOnIssue({
              ...repoSlug,
              number: existing.ref,
              body: `같은 문제가 계속됩니다 — ${count}번째 알림 · ${new Date(now).toISOString()}`,
            });
            return { via: "issue", ref: existing.ref };
          }
          const open = await client.listOpenIssues({ ...repoSlug, creator: who.login });
          const found = findNoticeIssue(open, problem.key);
          if (found !== null) {
            await client.commentOnIssue({
              ...repoSlug,
              number: found,
              body: `같은 문제가 계속됩니다 — ${count}번째 알림 · ${new Date(now).toISOString()}`,
            });
            return { via: "issue", ref: found };
          }
          const number = await client.createIssue({
            ...repoSlug,
            title: `[Colo Design] ${context.projectName}: ${problem.title}`,
            body: marked + noticeBody(problem, context, count, new Date(now)),
            labels: [ISSUE_LABEL],
            assignees: project?.reviewers.slice(0, 1) ?? [],
          });
          return { via: "issue", ref: number };
        }
      } catch (error) {
        this.deps.logger.warn("개발자 알림의 GitHub 경로 실패", {
          key: problem.key,
          err: error,
        });
      }
    }
    // GitHub 에 닿지 않는다 — Slack 보조 경로. 그것도 없으면 "none".
    const sent = await this.deps.slack
      .notify(
        slackText(problem, {
          projectName: project?.name ?? problem.slug ?? "이 컴퓨터",
          authorName: this.deps.authorName(),
        }),
      )
      .catch(() => false);
    return sent ? { via: "slack" } : { via: "none" };
  }

  /**
   * 문제가 풀렸다 — 서 있는 알림을 거둔다. PR 코멘트는 첫 줄을 해결 표식으로
   * 고치고, 이슈는 "해결됐습니다" 코멘트 뒤 닫는다. Slack 으로 나간 것은
   * 거둘 길이 없어 기록만 지운다. 원격 갱신은 최선의 노력 — 실패해도 기록은
   * 지워 다음 raise 가 새로 쓴다.
   */
  async resolve(key: string, slug: string | null): Promise<void> {
    const entry = this.entryOf(slug, key);
    if (entry === undefined) return;
    this.writeEntry(slug, key, null);
    this.lastWriteAt.delete(this.memoryKey(slug, key));
    const client = slug === null ? null : this.deps.github();
    const repoSlug = slug === null ? null : this.deps.repoSlug(slug);
    if (client === null || repoSlug === null || typeof entry.ref !== "number") return;
    try {
      if (entry.via === "pr") {
        const old = await client.getIssueComment({ ...repoSlug, commentId: entry.ref });
        const oldBody = typeof old?.body === "string" ? old.body : "";
        await client.updateIssueComment({
          ...repoSlug,
          commentId: entry.ref,
          body: `[OK] 해결됨 — ${oldBody}`,
        });
      } else if (entry.via === "issue") {
        await client.commentOnIssue({ ...repoSlug, number: entry.ref, body: "해결됐습니다" });
        await client.updateIssue({ ...repoSlug, number: entry.ref, state: "closed" });
      }
    } catch (error) {
      this.deps.logger.warn("개발자 알림의 해결 갱신 실패", { key, err: error });
    }
  }

  /** 기계 전체로 서 있는 알림 — status 의 주의 재료가 읽는다(화면에 서지 않는 키는 뺀다). */
  machineNotices(): Record<string, AttentionNotice> {
    const out: Record<string, AttentionNotice> = {};
    for (const [memKey, entry] of this.memory) {
      // 기계 전체 알림의 키는 ":<key>" — 슬러그가 앞에 서는 프로젝트 것은 뺀다.
      if (!memKey.startsWith(":")) continue;
      if (SCREEN_QUIET_KEYS.has(memKey.slice(1))) continue;
      out[memKey.slice(1)] = { via: entry.via, raisedAt: entry.raisedAt };
    }
    return out;
  }
}
