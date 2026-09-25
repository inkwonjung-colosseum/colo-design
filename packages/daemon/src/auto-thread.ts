/**
 * 자동 대화 (PLAN I1 · I4) — 도구가 스스로 여는 대화(충돌 정리 · 리뷰 반영 ·
 * 준비 복구 · 반려 반영)의 자리와 공급자. 사람이 대화를 열어 두지 않은
 * 순간에도 문제는 AI 가 받는다 — 그래서 Claude 가 없는 기계(Codex 만)에서도
 * 열려야 한다. 전에는 claude 실행 파일이 있을 때만 열렸고, 없으면 네 흐름이
 * 모두 조용히 멈췄다.
 *
 * 고르는 순서:
 *   1. 그 클론의 살아 있는 보낼 수 있는 대화 — 가장 최근에 움직인 것.
 *   2. 새 대화의 공급자 — 그 클론의 가장 최근 대화의 공급자 → 프로젝트의
 *      defaults.provider(초대 v4) → 등록 순서(claude → codex; omp 는 개발
 *      실행에서만 등록된다 — registerAgentDrivers). 판정은 드라이버의
 *      isAvailable 이다: 설치되고(ok + executable) 로그인이 확인된 첫 것,
 *      없으면 설치만 된 첫 것. 로그아웃된 CLI 도 브리프를 받을 자리다 — 그
 *      턴은 로그인을 기다렸다가 스스로 다시 나간다(PLAN L12). 옛 길도 로그인을
 *      보지 않았다.
 *   3. 어느 것도 없으면 null — 호출자가 "대화를 열지 못함" 으로 읽는다.
 *
 * 새 대화는 dispatch 의 session.create 와 같은 모양으로 연다 — 공급자 ·
 * 실행 파일 · 프로젝트 지침, 그리고 defaults 의 모델 · 생각 시간(defaults.provider
 * 가 있으면 그 공급자에게만).
 */
import type { ProjectDefaults } from "@colo-design/protocol";
import type { Diagnostic } from "./agent/driver.js";
import type { DriverRegistry } from "./agent/registry.js";
import type { QueueDisk } from "./queue-store.js";
import type { Session } from "./session.js";
import type { SessionManager } from "./session-manager.js";
import { repoWritePolicy } from "./workspaces.js";

export interface AutoThreadDeps {
  manager: Pick<SessionManager, "all" | "list" | "create">;
  drivers: Pick<DriverRegistry, "get" | "all">;
  queueDiskFor: (sessionId: string) => QueueDisk;
}

export interface AutoThreadRequest {
  /** 그 클론의 실제 경로 — 세션의 cwd 와 같은 표기(realpath). */
  cwd: string;
  title: string;
  /** 초대 v4 의 처음 값 — 공급자의 선호이자 모델 · 생각 시간의 씨앗. */
  defaults?: ProjectDefaults;
  /** 공통 규칙 + 그 프로젝트의 지켜 줄 것 — appendSystemPrompt 로 실린다. */
  instructions: string;
}

/**
 * 새 자동 대화의 공급자 — 앞에서부터 설치 · 로그인된 첫 것, 없으면 설치만 된
 * 첫 것(모듈 머리). `preferred` 는 등록 순서보다 앞서 볼 후보들이다. 등록되지
 * 않은 이름(개발 실행 밖의 omp 등)은 건너뛴다.
 */
export async function pickAutoThreadProvider(
  drivers: Pick<DriverRegistry, "get" | "all">,
  preferred: Array<string | null | undefined>,
): Promise<{ provider: string; executable: string } | null> {
  const order = [
    ...new Set([
      ...preferred.filter((id): id is string => typeof id === "string" && id !== ""),
      ...drivers.all().map((driver) => driver.id),
    ]),
  ];
  // 한 번 고르는 동안 드라이버마다 한 번만 묻는다 — Claude 의 판정은 CLI 를 띄운다.
  const diagnoses = new Map<string, Diagnostic | null>();
  const diagnose = async (id: string): Promise<Diagnostic | null> => {
    const known = diagnoses.get(id);
    if (known !== undefined) return known;
    const driver = drivers.get(id);
    const diagnostic = driver ? await driver.isAvailable().catch(() => null) : null;
    diagnoses.set(id, diagnostic);
    return diagnostic;
  };
  for (const needLogin of [true, false]) {
    for (const id of order) {
      const diagnostic = await diagnose(id);
      if (!diagnostic?.ok || !diagnostic.executable) continue;
      if (needLogin && diagnostic.loggedIn === false) continue;
      return { provider: id, executable: diagnostic.executable };
    }
  }
  return null;
}

/**
 * 자동 대화 하나 — 살아 있는 대화가 있으면 그것(created false), 없으면 새로
 * 연다(created true). 쓸 수 있는 공급자가 없으면 null. 대화 목록의 갱신은
 * 호출자의 몫이다(fleet 의 refreshThreads).
 */
export async function openAutoThread(
  deps: AutoThreadDeps,
  request: AutoThreadRequest,
): Promise<{ session: Session; created: boolean } | null> {
  const live = [...deps.manager.all()]
    .filter((session) => session.cwd === request.cwd && session.sendable)
    .sort((a, b) => b.lastActivity - a.lastActivity)[0];
  if (live) return { session: live, created: false };
  // 목록은 최근 것이 앞이다 — 저장된 대화와 (보낼 수 없게 된) 살아 있는 대화를
  // 함께 본다. 한도는 사이드바의 새로 고침과 같은 값(기본 50)이라, 스캔이 돌아도
  // 캐시가 사이드바의 것과 같은 모양으로 남는다.
  const recent = (await deps.manager.list(request.cwd).catch(() => [])).find(
    (summary) => summary.provider !== undefined,
  )?.provider;
  const pick = await pickAutoThreadProvider(deps.drivers, [recent, request.defaults?.provider]);
  if (pick === null) return null;
  const defaults = request.defaults;
  const defaultsFit =
    defaults !== undefined && (!defaults.provider || defaults.provider === pick.provider);
  const model = defaultsFit ? defaults.model : undefined;
  const effort = defaultsFit ? defaults.effort : undefined;
  const session = deps.manager.create({
    cwd: request.cwd,
    provider: pick.provider,
    queueDiskFor: deps.queueDiskFor,
    writePolicy: repoWritePolicy(request.cwd),
    title: request.title,
    launch: {
      executable: pick.executable,
      ...(request.instructions ? { appendSystemPrompt: request.instructions } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    },
  });
  return { session, created: true };
}

/**
 * 클론마다 한 줄로 여는 자동 대화 — 공급자 고르기가 비동기라, 두 흐름(준비
 * 복구와 충돌 정리처럼)이 같은 순간에 열면 둘 다 "살아 있는 대화 없음" 을 보고
 * 대화를 둘 만든다 — 한 클론을 두 AI 가 동시에 고치게 된다. 줄을 세우면 뒤의
 * 것은 앞의 것이 연 대화를 살아 있는 대화로 찾아 거기에 싣는다(동기이던 옛 길과
 * 같은 결과다). 앞의 것이 던져도 줄은 이어진다.
 */
export class AutoThreads {
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: AutoThreadDeps) {}

  open(request: AutoThreadRequest): Promise<{ session: Session; created: boolean } | null> {
    const previous = this.queue.get(request.cwd) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => openAutoThread(this.deps, request));
    this.queue.set(request.cwd, run);
    void run
      .catch(() => undefined)
      .finally(() => {
        if (this.queue.get(request.cwd) === run) this.queue.delete(request.cwd);
      });
    return run;
  }
}
