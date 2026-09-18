// Self-update orchestration: the releases feed poll, the swap report the
// next run delivers, and the install itself. A running session defers an
// install until every turn lands — the daemon tells us through
// `sessionsBusy`, and quitting cleanly mid-update needs `allowQuit`.
// 내려받기·검증이 끝나도 교체는 사용자가 재시작을 고를 때까지 기다린다 —
// 준비된 설치는 `prepared` 에 서고, 알림 클릭(또는 설치 재요청)이 마지막 걸음.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, rm, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { COLO_DESIGN_DIR } from "@colo-design/daemon/environment";
import { checkForUpdate, RELEASES_FEED_URL, type UpdateCheckResult } from "@colo-design/protocol";
import { app, net, shell } from "electron";
import { buildSwapScript as buildMacSwapScript } from "./mac-self-update.js";
import {
  parseSwapResult,
  planSelfUpdate,
  requireDiskSpace,
  type SelfUpdatePlan,
  verifyDownload,
} from "./self-update.js";
import { buildSwapScript as buildWinSwapScript } from "./win-self-update.js";

const UPDATE_MIN_FREE_BYTES = 1024 ** 3;
const UPDATE_FIRST_CHECK_DELAY_MS = 15_000;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_MIN_CHECK_GAP_MS = 60 * 60 * 1000;
// 멈춰 선 연결이 확인 버튼·연기된 설치를 영원히 잡아두지 않게 하는 마감.
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** 진행 중인 install — 빠른 재호출은 첫 호출에 합류한다(SelfUpdates 는 앱에 하나). */
let installFlight: Promise<Record<string, unknown>> | null = null;
/** 진행 중인 교체 스크립트 띄우기 — 알림 클릭과 설정 버튼이 겹쳐도 한 번만. */
let swapFlight: Promise<Record<string, unknown>> | null = null;

function updateResultPath(): string {
  return join(COLO_DESIGN_DIR, "update-result.json");
}

/** The feed carries both platforms' assets — this side picks its own. */
function platformAsset(feed: UpdateCheckResult): { url: string | null; sha256: string | null } {
  if (process.platform === "darwin") return { url: feed.url, sha256: feed.sha256 };
  if (process.platform === "win32") return { url: feed.winUrl, sha256: feed.winSha256 };
  return { url: null, sha256: null };
}

/** Electron net 모듈을 fetch 처럼 쓴다(프록시·인증서 정책을 앱이 따른다). */
async function netFetch(
  feedUrl: string,
): Promise<{ ok: boolean; status: number; json?: Record<string, unknown> }> {
  const request = net.request(feedUrl);
  // net.request 는 AbortSignal 을 받지 않는다 — 멈춰 선 연결은 스스로 끊는다.
  let timer: NodeJS.Timeout | undefined;
  const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    // 청크마다 디코드하면 UTF-8 다중 바이트가 청크 경계에서 갈라진다 — 한국어
    // 릴리스 노트의 latest.json 이 간헐적으로 깨진다. 버퍼로 모아 한 번에 디코드한다.
    const chunks: Buffer[] = [];
    request.on("response", (incoming) => {
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () =>
        resolve({ statusCode: incoming.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    request.once("error", reject);
    timer = setTimeout(() => {
      request.abort();
      reject(new Error("업데이트 확인이 시간 안에 끝나지 않았습니다"));
    }, UPDATE_CHECK_TIMEOUT_MS);
    request.end();
  }).finally(() => clearTimeout(timer));
  // json 은 파싱된 값이다(FetchLike 계약). 몸통이 JSON 이 아니면 undefined 로
  // 둔다 — fetchLatest 의 "형식이 올바르지 않습니다" 가 그 모양을 말하게.
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  const statusCode = response.statusCode;
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    json,
  };
}

/** zip 내려받기 — net.fetch 로 받아 파일로 흘려보낸다(큰 zip 도 메모리에 올리지 않는다). */
async function downloadFile(url: string, destPath: string): Promise<void> {
  // 릴리스 에셋 → CDN 넘겨주기는 net 이 기본으로 따라간다.
  const response = await net.fetch(url, {
    signal: AbortSignal.timeout(UPDATE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`업데이트 파일을 내려받지 못했습니다 (HTTP ${response.status})`);
  }
  // Electron 의 body 는 DOM 계열 ReadableStream — Node 스트림으로 다리를 놓는다.
  const body = Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
  await pipeline(body, createWriteStream(destPath));
}

interface UpdateDeps {
  /** OS 알림 — notices.show 와 같은 시그니처. */
  notify(
    title: string,
    body: string,
    onClick: () => void,
  ): Promise<{ shown: boolean; error?: string }> | undefined;
  /** 알림 클릭이 창을 앞으로 데려온다. */
  focusMain(): void;
  /** 한 턴이라도 돌고 있으면 설치는 연기다(P0#6). */
  sessionsBusy(): boolean;
  /** 확인된 설치의 마지막 걸음 — 종료 가드가 다시 묻지 않게 한다. */
  allowQuit(): void;
}

export class SelfUpdates {
  /** 연기된 자가 교체 — 실행 중 세션이 있는 동안의 설치는 그들이 내려앉는 순간으로 미룬다(P0#6). */
  private pending: { url: string; sha256: string; version: string } | null = null;
  /**
   * 내려받고 검증까지 끝난 설치 — 사용자가 재시작을 고를 때까지 기다린다.
   * 교체 스크립트는 아직 띄우지 않는다: 띄운 스크립트는 앱이 죽기만 하면
   * 돌기 때문에, 먼저 띄워 두면 일반 종료도 업데이트로 바뀌어 버린다.
   */
  private prepared: { plan: SelfUpdatePlan; version: string } | null = null;
  /** 준비된 설치에 사용자가 재시작을 골랐지만 세션이 아직 돌고 있다 — 모두 내려앉으면 설치한다. */
  private installOnIdle = false;
  /** 마지막으로 피드를 물은 시각 — 포커스 확인의 스로틀 기준. */
  private lastCheckAt = 0;
  /** 이미 알림을 띄운 버전 — 확인이 거듭돼도 한 번만 부른다. */
  private notifiedVersion: string | null = null;
  /** 진행 중인 준비(내려받기·검증) — 연기분과 직접 요청이 겹쳐도 한 번만 돈다. */
  private prepareFlight: Promise<{ prepared: true; version: string } | { error: string }> | null =
    null;

  constructor(private readonly deps: UpdateDeps) {}

  /**
   * 자동 업데이트 확인: 새 버전이 있으면 알림을 띄워 설정까지 찾아가게
   * 하지 않는다 — 버전마다 한 번만. 실패는 언제나 조용히: 자동으로 떠드는 오류는
   * 없고 다음 확인이 다시 온다. 개발 실행은 피드를 묻지 않는다.
   *
   * 확인의 순간은 셋이다 — 시작 직후 한 번, 하루 한 번, 그리고 **사용자가 앱으로
   * 돌아올 때**. 마지막 것 없이는 하루 주기가 벽시계를 모른다: 뚜껑을 닫아 둔
   * 동안 타이머는 뛰지 않고 깨어나서 늦게 뛰며 못 뛴 회차를 따라잡지 않는다. 앱을
   * 끄지 않는 사람에게 그 늦음은 "껐다 켜야 보이는 알림"이었다. 포커스는 사람이
   * 설치를 누를 수 있는 순간이기도 하다.
   *
   * 대신 포커스마다 피드를 묻지는 않는다(UPDATE_MIN_CHECK_GAP_MS). 같은 버전으로
   * 두 번 부르지도 않으니 창을 왕복해도 재촉은 생기지 않는다.
   */
  schedule(): void {
    if (!app.isPackaged) return;
    const check = async (): Promise<void> => {
      // 실패도 물어본 것으로 센다 — 끊긴 망에서 포커스마다 다시 걸지 않는다.
      this.lastCheckAt = Date.now();
      try {
        const feed = await checkForUpdate(app.getVersion(), RELEASES_FEED_URL, netFetch);
        if (!feed.updateAvailable || feed.version === this.notifiedVersion) return;
        this.notifiedVersion = feed.version;
        void this.deps.notify(
          "새 버전이 있습니다",
          `Colo Design ${feed.version} — 설정 → 문제 해결의 업데이트 확인에서 설치할 수 있습니다.`,
          this.deps.focusMain,
        );
      } catch {
        // 자동 확인의 실패는 조용히 넘어간다 — 수동 확인 버튼이 오류를 보여준다.
      }
    };
    const checkIfStale = (): void => {
      if (Date.now() - this.lastCheckAt < UPDATE_MIN_CHECK_GAP_MS) return;
      void check();
    };
    setTimeout(checkIfStale, UPDATE_FIRST_CHECK_DELAY_MS);
    setInterval(checkIfStale, UPDATE_CHECK_INTERVAL_MS);
    // 배지를 지우는 리스너와 나란히 달리지만, 이 자리는 패키징된 앱에만 생긴다.
    app.on("browser-window-focus", checkIfStale);
  }

  /**
   * 지난 번 자가 교체의 결과를 보고한다: 교체 스크립트는 앱이 죽은 뒤에 돌기
   * 때문에 성공·실패를 말할 창이 없다. 다음 실행(=지금)이 결과 파일을 읽어
   * 알림으로 대신 말하고 지운다. 성공은 현재 버전과 일치할 때만 — 어긋나면 오래
   * 된 흔적이니 조용히 지운다. 실패의 클릭은 로그 파일을 연다.
   */
  async reportSwapResult(): Promise<void> {
    const path = updateResultPath();
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return; // 결과 파일이 없으면 보고할 교체가 없었다
    }
    await rm(path, { force: true });
    const result = parseSwapResult(raw);
    if (!result) return;
    if (result.outcome === "done") {
      if (result.version !== app.getVersion()) return;
      void this.deps.notify(
        "업데이트 완료",
        `Colo Design ${result.version}으로 갈아입었습니다.`,
        this.deps.focusMain,
      );
      return;
    }
    void this.deps.notify(
      "업데이트하지 못했습니다",
      `${result.reason ?? "알 수 없는 실패"} — 클릭하면 기록을 보여줍니다.`,
      () => {
        void shell.openPath(result.logPath);
      },
    );
  }

  /** desktop:update-check — 수동 확인. */
  async check(): Promise<Record<string, unknown>> {
    try {
      const feed = await checkForUpdate(app.getVersion(), RELEASES_FEED_URL, netFetch);
      // 렌더러는 플랫폼을 모른 채 url·sha256 한 쌍만 본다 — 여기서 고른다.
      return { ...feed, ...platformAsset(feed) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * desktop:self-update — 설치 요청. 무엇을 내려받고 무엇으로 검증할지는
   * 피드가 정한다 — 렌더러가 건넨 url·sha256 은 받지 않는다. 이 다리는 침해된
   * 렌더러가 앱을 제 zip 으로 바꾸는 통로가 되어서는 안 된다: 요청은 요청일
   * 뿐, 출처는 피드다. 준비(내려받기·검증)가 끝나면 재시작 동의를 기다린다 —
   * 준비된 설치가 있는 상태의 재요청이 그 동의다.
   */
  async install(): Promise<Record<string, unknown>> {
    // 두 번째 클릭은 첫 준비에 합류한다 — 같은 downloadPath 로 pipeline 이
    // 겹치면 깨진 zip 이 sha256 검증에서 죽는다.
    installFlight ??= this.runInstall().finally(() => {
      installFlight = null;
    });
    return await installFlight;
  }

  private async runInstall(): Promise<Record<string, unknown>> {
    // 이미 준비된 설치가 있으면 이 클릭이 곧 재시작 동의다 — 피드를 다시
    // 묻지 않고 바로 교체로 간다(알림을 놓친 사용자의 두 번째 경로).
    if (this.prepared) return await this.installPrepared();
    let feed: UpdateCheckResult;
    try {
      feed = await checkForUpdate(app.getVersion(), RELEASES_FEED_URL, netFetch);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    // 이 플랫폼의 에셋이 없으면(자가 교체가 없는 OS 이거나 피드가 한쪽만
    // 실었으면) 설치할 것이 없다.
    const asset = platformAsset(feed);
    if (!feed.updateAvailable || !asset.url || !asset.sha256) {
      return {
        error: "설치할 업데이트가 확인되지 않았습니다 — 업데이트 확인을 다시 눌러 주세요.",
      };
    }
    // 실제 교체는 패키징된 앱에서만 — 개발 실행에서는 계획만 돌려준다.
    if (!app.isPackaged) {
      return {
        planned: planSelfUpdate({
          url: asset.url,
          sha256: asset.sha256,
          downloadsDir: app.getPath("downloads"),
          version: "0",
          platform: process.platform,
          // Windows 는 교체 대상이 필수다 — 개발 실행도 지금 도는 exe 를 건넨다.
          target: process.platform === "win32" ? process.execPath : undefined,
        }),
        guarded: "개발 실행에서는 교체를 실행하지 않습니다",
      };
    }
    // mac 한정: DMG 안에서 실행 중이면 교체 대상이 읽기 전용 볼륨이다 — 헛돌고
    // 롤백으로 끝나기 전에 막고 옮기라고 먼저 말한다.
    if (process.platform === "darwin" && process.execPath.startsWith("/Volumes/")) {
      return {
        error:
          "앱이 디스크 이미지(DMG)에서 실행 중입니다 — 응용 프로그램 폴더로 옮긴 뒤 다시 시도해 주세요.",
      };
    }
    // 실행 중 세션이 있으면 설치를 연기한다(P0#6) — 돌아가는 턴을 업데이트가
    // 끊지 않는다. 모든 세션이 내려앉는 순간 준비(내려받기·검증)가 끝나고,
    // 실제 교체는 사용자의 재시작을 기다린다.
    if (this.deps.sessionsBusy()) {
      this.pending = { url: asset.url, sha256: asset.sha256, version: feed.version };
      return { deferred: true, version: feed.version };
    }
    // 이 요청이 직접 준비까지 간다 — 남아 있는 연기분은 지워 두 번 준비하지 않는다.
    this.pending = null;
    return await this.prepare({ url: asset.url, sha256: asset.sha256, version: feed.version });
  }

  /** 세션 상태가 움직일 때마다: 연기된 설치가 있고 모두 내려앉았으면 지금 준비한다. */
  async maybeRunDeferred(): Promise<void> {
    if (this.deps.sessionsBusy()) return;
    // 사용자가 이미 재시작을 골랐다 — 준비가 끝난 설치를 지금 실행한다.
    if (this.installOnIdle && this.prepared) {
      this.installOnIdle = false;
      await this.installPrepared();
      return;
    }
    if (!this.pending) return;
    const feed = this.pending;
    this.pending = null;
    const result = await this.prepare(feed);
    if ("error" in result) {
      void this.deps.notify(
        "업데이트를 준비하지 못했습니다",
        `${result.error} — 설정 → 문제 해결에서 다시 시도할 수 있습니다.`,
        this.deps.focusMain,
      );
    }
  }

  /**
   * 준비된 설치를 알린다 — 클릭이 곧 재시작 동의다. 알림이 OS 에서 거절돼도
   * 설정의 설치 버튼이 같은 자리(prepared)로 이어 준다.
   */
  private announcePrepared(version: string): void {
    void this.deps.notify(
      "새 버전이 준비됐습니다",
      `Colo Design ${version} — 재시작하면 설치됩니다. 클릭하면 지금 재시작합니다.`,
      () => {
        void this.installPrepared();
      },
    );
  }

  /**
   * 내려받기·검증까지 — 교체 스크립트는 아직 띄우지 않는다. 끝나면 알림으로
   * 재시작을 묻고, 실제 교체는 installPrepared 가 사용자의 동의 뒤에 한다.
   */
  private async prepare(feed: {
    url: string;
    sha256: string;
    version: string;
  }): Promise<{ prepared: true; version: string } | { error: string }> {
    // 연기된 설치의 준비와 직접 요청의 준비가 겹치면 같은 downloadPath 로
    // pipeline 이 둘씩 달린다 — 두 번째는 진행 중인 준비에 합류한다.
    this.prepareFlight ??= this.runPrepare(feed).finally(() => {
      this.prepareFlight = null;
    });
    return await this.prepareFlight;
  }

  private async runPrepare(feed: {
    url: string;
    sha256: string;
    version: string;
  }): Promise<{ prepared: true; version: string } | { error: string }> {
    const downloadsDir = app.getPath("downloads");
    const windows = process.platform === "win32";
    try {
      // 교체 대상: Windows 는 지금 도는 exe 그대로(설치 프로그램이 그 자리를
      // 덮어쓴다), mac 은 그 exe 가 사는 앱 번들 — /Applications 고정이 아니라
      // 어디에서 실행했든 그 자리를 바꾼다.
      const bundle = dirname(dirname(dirname(process.execPath)));
      const macTarget = basename(bundle).endsWith(".app") ? bundle : undefined;
      const plan = planSelfUpdate({
        url: feed.url,
        sha256: feed.sha256,
        downloadsDir,
        // 계획은 내려받을 대상 버전의 이름을 짓는다 — 실행 중 버전이 아니라.
        version: feed.version,
        platform: process.platform,
        target: windows ? process.execPath : macTarget,
      });
      // 만석은 sha256 이 잡지 못한다 — 내려받기 전에 두 볼륨(내려받기·교체
      // 대상)의 여유를 먼저 본다.
      await requireDiskSpace({
        path: downloadsDir,
        minBytes: UPDATE_MIN_FREE_BYTES,
        statfs: (target) => statfs(target),
      });
      await requireDiskSpace({
        path: dirname(plan.target),
        minBytes: UPDATE_MIN_FREE_BYTES,
        statfs: (target) => statfs(target),
      });
      await downloadFile(feed.url, plan.downloadPath);
      await verifyDownload(plan.downloadPath, plan.expectedSha256);
      this.prepared = { plan, version: feed.version };
      this.announcePrepared(feed.version);
      return { prepared: true, version: feed.version };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 사용자가 고른 재시작: 준비된 설치의 교체 스크립트를 띄우고 종료한다.
   * 세션이 돌고 있으면 종료를 강행하지 않는다 — 동의를 installOnIdle 에
   * 새겨 두고 모두 내려앉는 순간으로 미룬다(P0#6).
   */
  private async installPrepared(): Promise<Record<string, unknown>> {
    // 알림 클릭과 설정 버튼이 겹쳐도 교체 스크립트는 한 번만 뜬다 — 두 번째
    // 호출은 진행 중인 교체에 합류한다.
    swapFlight ??= this.runInstallPrepared().finally(() => {
      swapFlight = null;
    });
    return await swapFlight;
  }

  private async runInstallPrepared(): Promise<Record<string, unknown>> {
    const prepared = this.prepared;
    if (!prepared) return { error: "준비된 업데이트가 없습니다 — 업데이트 확인을 눌러 주세요." };
    if (this.deps.sessionsBusy()) {
      this.installOnIdle = true;
      this.deps.focusMain();
      return { deferred: true, version: prepared.version };
    }
    // 스크립트가 결과 파일에 찍는 version 은 갈아입은 대상이다 — 다음 실행이
    // 자기 버전과 겨루므로(reportSwapResult) 실행 중 버전을 찍으면 완료 보고가
    // 영원히 닿지 않는다.
    const version = prepared.version;
    const windows = process.platform === "win32";
    try {
      const logPath = join(app.getPath("temp"), "colo-design-update.log");
      const script = {
        plan: prepared.plan,
        pid: process.pid,
        logPath,
        resultPath: updateResultPath(),
        version,
      };
      if (windows) {
        const scriptPath = join(app.getPath("temp"), `colo-design-update-${version}.ps1`);
        // BOM 을 붙여 쓴다: Windows PowerShell 5.1 은 BOM 없는 UTF-8 .ps1 을
        // 현재 코드페이지(ANSI)로 읽어 스크립트 안의 한국어를 깨뜨린다 — 깨진
        // 실패 이유는 그대로 사용자 알림에 실린다.
        await writeFile(scriptPath, `\uFEFF${buildWinSwapScript(script)}`);

        spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
          detached: true,
          stdio: "ignore",
        }).unref();
      } else {
        const scriptPath = join(app.getPath("temp"), `colo-design-update-${version}.sh`);
        await writeFile(scriptPath, buildMacSwapScript(script), { mode: 0o755 });
        // 응답이 렌더러에 닿은 뒤에 종료한다 — 화면이 "곧 닫힙니다"를 볼 시간.
        spawn("/bin/bash", [scriptPath], {
          detached: true,
          stdio: "ignore",
        }).unref();
      }
      // 이 종료는 사용자가 확인한 설치의 마지막 걸음이다 — 가드가 다시 묻지
      // 않는다. Windows 에서는 이 한 줄이 교체의 성립 조건이다: 세션이 돌고
      // 있으면 guardStopUnderTurn 의 `세션 실행 중` 확인 창이 quit 을 막아
      // 앱이 살아 있고, 잠긴 exe 앞에서 스크립트는 30초를 기다리다 실패로 끝난다.
      this.prepared = null;
      this.deps.allowQuit();
      setTimeout(() => app.quit(), 500);
      return {
        started: true,
        downloadPath: prepared.plan.downloadPath,
        steps: prepared.plan.steps,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
