import type { CSSProperties, ReactElement } from "react";
import { useState } from "react";
import type { Daemon } from "../../lib/daemon-client";
import type { SettingsCategory } from "../dialogs/SettingsDialog";
import { CheckIcon, CloseIcon, FolderIcon, KeyIcon, SparkIcon, WarnIcon } from "../icons";
import { GitHubTokenForm } from "./GitHubTokenForm";
import { RepoPicker } from "./RepoPicker";

type GateStatus = "pass" | "warn" | "fail" | "todo";

/** Each status's glyph — the seat already carries its tone colour. */
const STATUS_GLYPH: Partial<Record<GateStatus, ReactElement>> = {
  pass: <CheckIcon />,
  warn: <WarnIcon />,
  fail: <CloseIcon />,
};

/**
 * 프로젝트가 없을 때의 화면 전부 — 창을 통째로 쓰는 시작 마법사
 * (mockups/onboarding/02-wizard.html). 기계 게이트 마법사(Onboarding)와 같은
 * 인터랙션 모델이다: 통과한 단계는 한 줄로 접히고, 지금 단계 하나만
 * 펼쳐지며, 다가올 단계는 조용한 한 줄로 읽힌다. 세 단계 — ①토큰 연결
 * ②레포 선택 ③준비.
 *
 * CTA는 하나다: 레포 단계의 프로젝트 만들기. 만들기가 답하는 순간
 * 레지스트리에 프로젝트가 들어오고 Shell 이 작업대로 바꿔 끼므로 푸터의
 * 시작하기는 존재할 자리가 없다(자동 진행). ③준비의 진행 카드도 같은
 * 이유로 여기 그리지 않는다 — 작업대의 미리보기 열이 그 몫이다.
 */
export function StartFlow({
  daemon,
  onOpenSettings,
}: {
  daemon: Daemon;
  /** RepoPicker 의 토큰 없음 안내가 설정으로 건너는 다리. */
  onOpenSettings: (category?: SettingsCategory) => void;
}) {
  const githubStep = daemon.onboarding?.find((step) => step.id === "github");
  const hasToken = githubStep?.status === "pass";
  /** 통과한 토큰을 다시 여는 길 — 만료가 이유다(Onboarding 의 editingToken). */
  const [editingToken, setEditingToken] = useState(false);
  /** 선택한 레포의 검사 답 — 레포 단계의 주의 배지와 테두리의 근거. */
  const [repoNotice, setRepoNotice] = useState<{
    hasDevScript: boolean;
    canPush: boolean;
  } | null>(null);

  const tokenStatus: Exclude<GateStatus, "todo"> =
    githubStep?.status === "pass" ? "pass" : githubStep?.status === "fail" ? "fail" : "warn";
  const tokenOpen = tokenStatus !== "pass" || editingToken;
  const repoWarn = repoNotice !== null && (!repoNotice.hasDevScript || !repoNotice.canPush);

  return (
    <div className="onboarding onboarding--start">
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
        <p className="hint">첫 프로젝트를 만드는 세 단계입니다.</p>
      </header>

      <div className="onboarding__meter" aria-hidden="true">
        <span
          className="onboarding__meterfill"
          style={{ width: `${(tokenStatus === "pass" ? 1 : 0) * (100 / 3)}%` }}
        />
      </div>

      <ol className="onboarding__steps">
        {/* ① 토큰 연결 — github 게이트가 상태다. 게이트가 아직 답하기 전에는
              warn 취급으로 폼을 연다(Onboarding 의 github 행과 같다). */}
        <li
          className={`onboarding__step onboarding__step--${tokenStatus}${tokenOpen ? "" : " onboarding__step--line"}`}
          style={{ "--i": 0 } as CSSProperties}
        >
          <div className="onboarding__stephead">
            <span className="ic ic--sm ic--quiet">
              <KeyIcon />
            </span>
            <span className={`onboarding__glyph onboarding__glyph--${tokenStatus}`}>
              {STATUS_GLYPH[tokenStatus]}
            </span>
            <span className="onboarding__stepnum">1</span>
            <h2>토큰 연결</h2>
            <span className="onboarding__tool">GitHub</span>
            {!hasToken && (
              <span className={`onboarding__status onboarding__status--${tokenStatus}`}>
                {tokenStatus === "fail" ? "실패" : "주의"}
              </span>
            )}
          </div>
          {tokenOpen ? (
            <>
              <p className="onboarding__detail">
                {tokenStatus === "fail" && githubStep?.detail
                  ? githubStep.detail
                  : "개발자에게 받은 GitHub 토큰을 붙여넣으면, 그 토큰이 볼 수 있는 레포 목록이 열려요. 토큰이 없으면 개발자에게 “콜로 연결 토큰 하나 만들어줘”라고 부탁하면 됩니다."}
              </p>
              <GitHubTokenForm daemon={daemon} onDone={() => setEditingToken(false)} />
              <p className="hint">
                토큰은 이 컴퓨터의 자격 증명 저장소에만 저장돼요 — 앱 화면을 여는 연결
                토큰(페어링)과는 별개예요.
              </p>
            </>
          ) : (
            <>
              <p className="onboarding__detail">
                {githubStep?.detail ?? "토큰이 이 컴퓨터의 자격 증명 저장소에 저장돼 있어요"}
              </p>
              <div className="onboarding__fixrow">
                <button type="button" className="ghost" onClick={() => setEditingToken(true)}>
                  토큰 바꾸기
                </button>
              </div>
            </>
          )}
        </li>

        {/* ② 레포 선택 — 토큰이 통과해야 열린다. 검사가 미리보기 명령이
              없다고 답하면 주의 배지가 붙는다(02-wizard 의 국면). */}
        <li
          className={`onboarding__step${hasToken ? (repoWarn ? " onboarding__step--warn" : "") : " onboarding__step--line"}`}
          style={{ "--i": 1 } as CSSProperties}
        >
          <div className="onboarding__stephead">
            <span className="ic ic--sm ic--quiet">
              <FolderIcon />
            </span>
            <span
              className={`onboarding__glyph${hasToken && repoWarn ? " onboarding__glyph--warn" : ""}`}
            >
              {hasToken && repoWarn ? STATUS_GLYPH.warn : null}
            </span>
            <span className="onboarding__stepnum">2</span>
            <h2>레포 선택</h2>
            <span className="onboarding__tool">GitHub</span>
            {hasToken && repoWarn && (
              <span className="onboarding__status onboarding__status--warn">주의</span>
            )}
          </div>
          {hasToken ? (
            <>
              <p className="onboarding__detail">
                토큰이 볼 수 있는 레포를 찾았어요. 어느 레포인지 모르겠으면 개발자에게 레포 이름을
                물어보세요.
              </p>
              <RepoPicker
                daemon={daemon}
                onOpenSettings={onOpenSettings}
                onInspection={setRepoNotice}
              />
            </>
          ) : (
            <p className="onboarding__detail">토큰이 연결되면 목록이 열려요.</p>
          )}
        </li>

        {/* ③ 준비 — 다가올 단계는 한 줄이다. 진행 카드는 작업대의 몫: 만들기가
              답하는 순간 이 화면은 작업대로 바뀐다. */}
        <li
          className="onboarding__step onboarding__step--line"
          style={{ "--i": 2 } as CSSProperties}
        >
          <div className="onboarding__stephead">
            <span className="ic ic--sm ic--quiet">
              <SparkIcon />
            </span>
            <span className="onboarding__glyph" />
            <span className="onboarding__stepnum">3</span>
            <h2>준비</h2>
            <span className="onboarding__tool">내려받기 · 설치 · 미리보기</span>
          </div>
          <p className="onboarding__detail">
            레포를 내려받고 설치·미리보기까지 합니다 — 처음에는 몇 분 걸립니다.
          </p>
        </li>
      </ol>
    </div>
  );
}
