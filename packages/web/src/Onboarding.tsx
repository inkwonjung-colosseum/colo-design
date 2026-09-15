import type { OnboardingStep, OnboardingStepId, PermissionMode } from "@colo-design/protocol";
import { type CSSProperties, type ReactElement, useState } from "react";
import type { Daemon } from "./daemon-client";
import { GitHubTokenForm } from "./GitHubTokenForm";
import {
  BrainIcon,
  BranchIcon,
  CheckIcon,
  CloseIcon,
  KeyIcon,
  PlugIcon,
  ShieldIcon,
  WarnIcon,
} from "./icons";

/**
 * The first-run wizard (DESIGN §8): machine gates answered once — Claude
 * Code, git, Node·pnpm, the GitHub token — and then it is done. Which repo a
 * planner works on is NOT here (PLAN D4/D25): a project is added from the
 * workspace itself, where the clone's own progress is already on screen.
 *
 * One card is open at a time: the first step that is not a pass is the thing
 * a planner can act on right now, and everything before it collapses to a
 * single line. A `warn` (GitHub without a token) does not block: 시작하기
 * stays reachable.
 */
const STEP_ORDER: OnboardingStepId[] = ["claude", "git", "runtime", "github"];

const STEP_TITLE: Record<OnboardingStepId, string> = {
  // 커미티 A-4 (2026-09-15): 제목은 쓸모가 먼저다 — 도구 이름은 조용한 부제로
  // 내려간다(claude 행이 이미 사람 말 설명을 가진 것의 확장). 기획자가 평생
  // 생각할 일 없는 런타임(Node · pnpm)은 "앱에 포함"이 본체다.
  claude: "화면을 만드는 Claude",
  git: "작업을 보관할 준비",
  runtime: "앱 실행 준비",
  github: "개발자에게 넘길 준비",
};

/** The tool behind each gate — the stephead's quiet subtitle. */
const STEP_TOOL: Record<OnboardingStepId, string> = {
  claude: "Claude Code",
  git: "git",
  runtime: "앱에 포함",
  github: "GitHub",
};

/** 커미티 A-4: claude 행의 설명 한 줄 패턴(:203-209)을 나머지 셋에도. */
const STEP_HINT: Record<OnboardingStepId, string> = {
  claude: "",
  git: "화면 작업을 저장하고 개발자에게 넘기는 데 쓰는 도구입니다 — 이 앱이 대신 다룹니다.",
  runtime: "앱 안에 들어 있습니다 — 없다고 나오면 앱 설치가 깨진 것입니다.",
  github:
    "작업을 개발자에게 넘기는 길입니다. 없어도 시작할 수 있습니다 — 공개 저장소로 작업합니다.",
};

/** Each gate status's glyph — the seat already carries its tone colour. */
const STATUS_ICON: Record<OnboardingStep["status"], ReactElement> = {
  pass: <CheckIcon />,
  warn: <WarnIcon />,
  fail: <CloseIcon />,
};

/** 한 번 확인 방식을 고른 표식 — 다음 마법사부터는 저장된 값을 띄운다. */
const PERMISSION_CHOSEN_KEY = "colo-design.permission-chosen";
const STATUS_LABEL: Record<OnboardingStep["status"], string> = {
  pass: "통과",
  warn: "주의",
  fail: "실패",
};

/** Each gate row's subject — the quiet tile that names what the row is about. */
const STEP_ICON: Record<OnboardingStepId, ReactElement> = {
  claude: <BrainIcon />,
  git: <BranchIcon />,
  runtime: <PlugIcon />,
  github: <KeyIcon />,
};

export function Onboarding({
  daemon,
  permissionMode,
  onChoosePermission,
  onDone,
}: {
  daemon: Daemon;
  /** 지금 저장된 확인 방식 — 이미 고른 적이 있으면 카드가 그 값을 띄운다. */
  permissionMode: PermissionMode;
  /** 카드의 선택이 설정에 반영되는 길(P0#4). */
  onChoosePermission: (mode: PermissionMode) => void;
  /** Called when every blocking step passed (the workspace may open). */
  onDone: () => void;
}) {
  const steps = daemon.onboarding ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The fix's own words. The daemon answers every fix with `{started, guidance}` —
      on macOS the installer opens no window and drops its stdio, so this sentence
      is the ONLY feedback a press produces. Dropping it made the button look dead. */
  const [notice, setNotice] = useState<{ started: boolean; guidance: string } | null>(null);
  /** Re-opens the token form on a github line that already passed. */
  const [editingToken, setEditingToken] = useState(false);
  /**
   * 확인 방식 카드의 선택(P0#4). 선택은 필수다 — 아무도 보지 못한 기본값으로
   * 시작하는 대신, 첫 대화 전에 한 번 스스로 고른다. 한 번 고른 사용자는
   * 마법사를 다시 열 때 저장된 값이 카드에 떠 있다.
   */
  const [picked, setPicked] = useState<PermissionMode | null>(() =>
    localStorage.getItem(PERMISSION_CHOSEN_KEY) === "1" ? permissionMode : null,
  );

  const choosePermission = (mode: PermissionMode) => {
    setPicked(mode);
    try {
      localStorage.setItem(PERMISSION_CHOSEN_KEY, "1");
    } catch {
      // 저장이 막히면 다음 마법사에서 다시 묻는다 — 값 자체는 설정에 산다.
    }
    onChoosePermission(mode);
  };

  const byId = new Map(steps.map((step) => [step.id, step]));
  const blocked = steps.some((step) => step.status === "fail");
  const busyKind = busy ?? null;

  // The check is NOT run here. `Shell` runs it on connect and this wizard is
  // its child, so a second effect meant every gate ran twice per open.

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const reply = (await action()) as unknown;
      if (
        reply !== null &&
        typeof reply === "object" &&
        typeof (reply as { guidance?: unknown }).guidance === "string"
      ) {
        setNotice({
          started: (reply as { started?: unknown }).started !== false,
          guidance: (reply as { guidance: string }).guidance,
        });
      }
      await daemon.api.onboardingCheck();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** The one step a planner can act on right now — everything else is a line. */
  const firstOpen =
    steps.find((step) => step.status === "fail")?.id ??
    steps.find((step) => step.status === "warn")?.id ??
    null;
  const isOpen = (id: OnboardingStepId) => id === firstOpen || (id === "github" && editingToken);

  return (
    <div className="onboarding">
      <header className="onboarding__head">
        <div className="onboarding__brand" aria-hidden="true">
          <img
            className="onboarding__mark"
            src="/colonova-icon.svg"
            alt=""
            width={36}
            height={36}
          />
        </div>
        <h1>Colo Design 시작하기</h1>
        <p className="hint">이 컴퓨터에서 한 번만 확인하는 네 단계입니다.</p>
      </header>

      {/* The gates answered so far, as one quiet fill — motion makes the
          machine's progress legible without a word. */}
      {steps.length > 0 && (
        <div className="onboarding__meter" aria-hidden="true">
          <span
            className="onboarding__meterfill"
            style={{
              width: `${(steps.filter((step) => step.status === "pass").length / steps.length) * 100}%`,
            }}
          />
        </div>
      )}

      {steps.length === 0 && !error && <p className="hint">단계를 확인하는 중…</p>}
      {error && (
        <div className="notice notice--error">
          <span className="notice__text">{error}</span>
        </div>
      )}

      <ol className="onboarding__steps">
        {STEP_ORDER.map((id) => {
          const step = byId.get(id);
          if (!step) return null;
          const open = isOpen(id);
          return (
            <li
              key={id}
              className={`onboarding__step onboarding__step--${step.status}${open ? "" : " onboarding__step--line"}`}
              style={{ "--i": STEP_ORDER.indexOf(id) } as CSSProperties}
            >
              <div className="onboarding__stephead">
                <span className="ic ic--sm ic--quiet">{STEP_ICON[id]}</span>
                <span className={`onboarding__glyph onboarding__glyph--${step.status}`}>
                  {STATUS_ICON[step.status]}
                </span>
                <span className="onboarding__stepnum">{STEP_ORDER.indexOf(id) + 1}</span>
                <h2>{STEP_TITLE[id]}</h2>
                {/* 도구 이름은 부제다 — 알아야 하는 것은 무엇에 쓰는지다. */}
                <span className="onboarding__tool">{STEP_TOOL[id]}</span>
                <span className={`onboarding__status onboarding__status--${step.status}`}>
                  {STATUS_LABEL[step.status]}
                </span>
              </div>
              <p className="onboarding__detail">{step.detail}</p>
              {open && step.status !== "pass" && STEP_HINT[id] !== "" && (
                <p className="hint">{STEP_HINT[id]}</p>
              )}

              {/* What this step is, before any button (실사 이후): the first
                  gate asks a non-developer for a CLI they have never heard of,
                  on an account somebody pays for, and opens a Terminal they
                  did not expect. */}
              {id === "claude" && open && step.status !== "pass" && (
                <p className="hint">
                  화면을 만드는 Claude의 도구입니다 — 설치와 로그인에는 본인의 Claude 계정(유료
                  구독)이 필요합니다. 로그인하면 터미널 창이 열립니다. macOS가 'Terminal이 이 앱을
                  제어하려고 합니다'라고 물으면 허용해 주세요.
                </p>
              )}

              {/* A passed token is still replaceable — expiry is the reason,
                  and it is the one thing this line can offer. */}
              {id === "github" && step.status === "pass" && !editingToken && (
                <div className="onboarding__fixrow">
                  <button type="button" className="ghost" onClick={() => setEditingToken(true)}>
                    토큰 바꾸기
                  </button>
                </div>
              )}

              {id === "github" && (open || editingToken) && (
                <GitHubTokenForm daemon={daemon} onDone={() => setEditingToken(false)} />
              )}

              {/* `href` fixes are links, not commands (install-node): the
                  tool installs nothing on somebody's machine by itself. */}
              {step.fix && step.status !== "pass" && (
                <div className="onboarding__fixrow">
                  {step.fix.href ? (
                    <a
                      className="primary ghlink"
                      href={step.fix.href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {step.fix.label}
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      disabled={busyKind !== null}
                      onClick={() =>
                        void run(step.fix!.kind, () => daemon.api.onboardingFix(step.fix!.kind))
                      }
                    >
                      {busyKind === step.fix.kind ? "실행 중…" : step.fix.label}
                    </button>
                  )}
                  {/* Anything the planner does outside the app — an installer,
                      a login — ends with the same question: 다시 확인. */}
                  <button
                    type="button"
                    className="ghost"
                    disabled={busyKind !== null}
                    onClick={() => void run("recheck", () => daemon.api.onboardingCheck())}
                  >
                    다시 확인
                  </button>
                </div>
              )}
              {step.fix && step.status !== "pass" && notice && (
                <div
                  className={`notice ${notice.started ? "notice--info" : "notice--error"}`}
                  role="status"
                >
                  <span className="notice__text">{notice.guidance}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {!blocked && steps.length > 0 && (
        <div className="onboarding__confirm">
          <h2 className="onboarding__confirmTitle">
            <span className="ic ic--sm ic--quiet">
              <ShieldIcon />
            </span>
            Claude가 일을 실행하기 전에 물어볼까요?
          </h2>
          <div className="onboarding__cards">
            {/* 안전한 쪽이 먼저 읽힌다 (감사 위원회): 확인 없이 진행하는 카드가
                첫 자리면 "권장"처럼 읽힌다 — 선택은 어차피 강제이니 순서만
                바꿔도 기본값은 건드리지 않는다. */}
            <button
              type="button"
              className={`onboarding__card${picked === "default" ? " onboarding__card--on" : ""}`}
              onClick={() => choosePermission("default")}
            >
              <span className="onboarding__cardTitle">
                물어보고 실행 <span className="onboarding__cardcli">Default</span>
              </span>
              <span className="onboarding__cardBody">
                명령을 실행하기 전에 확인 카드로 물어봅니다. 확인은 알림으로도 오므로 자리를 비워도
                놓치지 않습니다.
              </span>
            </button>
            <button
              type="button"
              className={`onboarding__card${picked === "bypassPermissions" ? " onboarding__card--on" : ""}`}
              onClick={() => choosePermission("bypassPermissions")}
            >
              <span className="onboarding__cardTitle">
                바로 실행 <span className="onboarding__cardcli">Bypass</span>
              </span>
              <span className="onboarding__cardBody">
                확인 없이 진행합니다. 화면 파일은 어차피 자동으로 바뀌고, 자리를 비운 사이에도
                멈추지 않습니다.
              </span>
            </button>
          </div>
          <p className="hint">나중에 설정 → 대화의 확인 방식에서 바꿀 수 있습니다.</p>
          <div className="onboarding__done">
            <button
              type="button"
              className="primary onboarding__cta"
              disabled={picked === null}
              onClick={onDone}
            >
              시작하기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
