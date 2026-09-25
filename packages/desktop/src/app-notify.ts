// OS notifications and the dock badge: the daemon's DaemonNotice becomes a
// banner, the unread count rides the dock, and the renderer's prefs decide
// when a notice may interrupt. One object owns the counters so every
// caller — notice hook, update alerts, the test button — shares the policy.
import type { DaemonNotice } from "@colo-design/daemon/server";
import { app, Notification } from "electron";
import { noticeCopy } from "./notices.js";
import { DEFAULT_NOTIFICATION_PREFS, shouldNotify } from "./notify-policy.js";
import type { MainWindowHost } from "./windows.js";

/** OS 가 show·failed 중 어느 것도 말하지 않을 때 시험 버튼이 기다리는 한계. */
const NOTIFICATION_VERDICT_MS = 3_000;

export class PlannerNotices {
  /**
   * 창이 뒤에 있는 동안 도착한 사용자의 순간 수 — dock 배지로 세운다. mac 의
   * 개념이므로 다른 플랫폼은 paint 가 조용히 건너뛴다.
   */
  unread = 0;
  /** 알림 설정(시점·소리) — 부팅 때 디스크에서 읽고, 설정 다리가 고친다. */
  prefs = DEFAULT_NOTIFICATION_PREFS;

  constructor(private readonly host: MainWindowHost) {}

  /**
   * 데몬이 건넨 사용자의 순간을 OS 알림으로 그린다. 창이 앞에 있으면 사용자가
   * 이미 보고 있는 것이므로 조용히 한다. 클릭은 창을 앞으로, 그리고 그 대화로 —
   * 세션 아이디를 렌더러에 건네 열려는 대화를 알린다(리뷰 B7).
   */
  notifyPlanner(notice: DaemonNotice): void {
    if (this.host.window?.isFocused()) return;
    // 완료 알림만 시점 정책을 탄다 — 확인 요청·중단·게이트 실패·개발자 쪽
    // 사건(커미티 B1)은 언제나 즉시.
    if (!shouldNotify(notice, this.prefs)) return;
    this.unread += 1;
    this.paintBadge();
    const { title, body } = noticeCopy(notice);
    void this.show(
      title,
      body,
      // 커미티 B1: 넘김 사건의 행선은 프로젝트다 — 대화가 아니라 slug 로 간다.
      notice.kind === "handoff" || notice.kind === "ready" || notice.kind === "submit-blocked"
        ? () => this.host.focusProject(notice.slug)
        : notice.kind === "update-done"
          ? () => this.host.focusMain()
          : () => this.host.focusMain(notice.sessionId),
      {
        silent: !this.prefs.sound,
      },
    );
  }

  /** 창이 포커스를 얻었다 — 쌓인 순간은 읽은 셈. */
  markRead(): void {
    this.unread = 0;
    this.paintBadge();
  }

  /** 배지는 읽지 않은 순간의 수. 알림 클릭이 창을 앞으로 하면 focus 이벤트가 지운다. */
  paintBadge(): void {
    app.dock?.setBadge(this.unread > 0 ? String(this.unread) : "");
  }

  /**
   * OS 알림 — 클릭 행동을 골라 단다(사용자 순간과 업데이트 알림이 함께 쓴다).
   * 소리는 설정이 정하고 그 결정은 여기 한 곳에만 있다: 부르는 자리가 각자
   * 계산하면 한 자리가 빠지고(업데이트 알림이 그랬다) 설정을 껐는데 우는 알림이
   * 남는다. `options.silent` 는 그 기본을 덮는다.
   *
   * 돌려주는 값은 **OS 가 이 알림을 받아 그렸는가**다. Electron 44 의 mac 알림은
   * UNNotification 위에 있고, 그 API 는 제대로 서명되지 않은 앱 — 개발 실행이
   * 띄우는 linker-signed `Electron.app` 이 그렇다 — 의 알림을 `failed` 로
   * 거절한다. 리스너가 없으면 그 거절은 아무 데도 남지 않는다: 시험 알림이 이
   * 답을 그대로 사용자에게 보여 준다.
   *
   * 한 가지는 여기서 알 수 없다 — 사용자가 OS 에서 이 앱의 알림을 꺼 둔 경우.
   * 그때의 `show()` 는 성공하고 배너만 오지 않는다(usernoted 가 `as none` 으로
   * 기록한다). 설정 화면의 `시스템 알림 설정 열기` 가 그 경우의 유일한 길이다.
   */
  show(
    title: string,
    body: string,
    onClick: () => void,
    options?: { silent?: boolean },
  ): Promise<{ shown: boolean; error?: string }> {
    const notification = new Notification({
      title,
      body,
      silent: options?.silent ?? !this.prefs.sound,
    });
    notification.on("click", onClick);
    const { promise, resolve } = Promise.withResolvers<{
      shown: boolean;
      error?: string;
    }>();
    // 두 사건 중 먼저 오는 것이 답이다. 어느 쪽도 오지 않는 플랫폼에서는 침묵을
    // 성공으로 읽는다 — 시험 버튼이 영원히 도는 것보다 낫다.
    let settled = false;
    const settle = (result: { shown: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => settle({ shown: true }), NOTIFICATION_VERDICT_MS);
    notification.once("show", () => settle({ shown: true }));
    notification.once("failed", (_event, error) => settle({ shown: false, error: String(error) }));
    notification.show();
    return promise;
  }
}
