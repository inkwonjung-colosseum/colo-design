import type { DaemonStatus, EffortLevel, PermissionMode } from "@colo-design/protocol";
import { RELEASES_REPO, type UpdateCheckResult } from "@colo-design/protocol";
import { useEffect, useRef, useState } from "react";
import { useModalEscape, useModalFocus } from "../../hooks/use-modal-focus";
import {
  EFFORT_LABEL,
  MODE_LABEL,
  modelOptions,
  modelRowOf,
  SETTINGS_MODES,
} from "../../lib/chat-options";
import type { Daemon } from "../../lib/daemon-client";
import {
  type ChatSettings,
  clampSizePx,
  loadModelCatalog,
  type NoticeTiming,
  type SendKey,
  type Settings,
  SIZE_PX,
  switchProviderPatch,
  THEMES,
  type ThemeChoice,
} from "../../lib/settings";
import {
  BellIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CommandIcon,
  LinkIcon,
  NewChatIcon,
  ProviderIcon,
  RefreshIcon,
  ThemeIcon,
} from "../icons";
import { EscalationForm } from "../onboarding/EscalationForm";
import { GitHubTokenForm } from "../onboarding/GitHubTokenForm";
import { ConfirmDialog } from "./ConfirmDialog";

/** Slowest last, so the picker reads as a dial rather than a set. */
const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

const THEME_LABEL: Record<ThemeChoice, string> = {
  /* "설정을 따름" is the picker's one sentence above the grid, so the tile
     can wear the short word — 9글자 라벨은 ✓ 와 함께 타일을 넘어갔다. */
  system: "시스템",
  dark: "어둡게",
  light: "밝게",
  contrast: "고대비",
  dracula: "드라큘라",
  solarized: "솔라라이즈드",
  catppuccin: "캣푸친",
  nord: "노르드",
  gruvbox: "그럽박스",
  tokyonight: "도쿄나이트",
  rosepine: "로즈파인",
  everforest: "에버포레스트",
  onedark: "원다크",
  github: "깃허브",
  monokai: "모노카이",
  latte: "캣푸친 라떼",
  claude: "클로드",
  codex: "코덱스",
  cursor: "커서",
  vscode: "VS 코드",
  linear: "리니어",
  jetbrains: "젯브레인",
  slack: "슬랙",
};

/** What "follow the OS" actually tracks, in one sentence at the picker. */
const SYSTEM_HINT = "OS 밝기를 따르고, 고대비를 요청하면 고대비 팔레트를 씁니다.";

const SEND_LABEL: Record<SendKey, string> = {
  enter: "Enter로 보내기, Shift+Enter는 줄바꿈",
  modEnter: "⌘/Ctrl+Enter로 보내기, Enter는 줄바꿈",
};

/** 세그먼트 조각이 입는 짧은 이름 — 온전한 문장은 고른 조각 아래 설명으로
    내려앉는다(Choice의 activeHint). 20자 문장은 조각에 안 들어간다. */
const SEND_SHORT: Record<SendKey, string> = {
  enter: "Enter",
  modEnter: "⌘/Ctrl+Enter",
};

/** 완료 알림의 세 상태 — 고르는 행과 접힌 방의 요약이 같은 말을 한다. */
const NOTICE_DONE_LABEL: Record<NoticeTiming, string> = {
  off: "끔",
  long: "오래 걸린 턴만",
  all: "모든 턴",
};

/** A 크기 knob in px: −/+ steppers around a field that also takes a typed
    number. Typing stays a draft until blur or Enter — committing on every
    keystroke would clamp "1" to the floor before "14" is finished. */
function PxSize({
  label,
  hint,
  axis,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  axis: keyof typeof SIZE_PX;
  value: number;
  onChange: (px: number) => void;
}) {
  const spec = SIZE_PX[axis];
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    setDraft(null);
    const px = Number.parseFloat(raw);
    if (Number.isFinite(px)) onChange(clampSizePx(axis, px));
  };
  const step = (dir: 1 | -1) => onChange(clampSizePx(axis, value + dir * 0.5));
  return (
    <Row label={label} {...(hint ? { hint } : {})}>
      <span className="pxsize">
        <button
          type="button"
          aria-label={`${label} 줄이기`}
          disabled={value <= spec.min}
          onClick={() => step(-1)}
        >
          −
        </button>
        <input
          type="number"
          aria-label={label}
          min={spec.min}
          max={spec.max}
          step={0.5}
          value={draft ?? value}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
          }}
        />
        <span className="pxsize__unit">px</span>
        <button
          type="button"
          aria-label={`${label} 키우기`}
          disabled={value >= spec.max}
          onClick={() => step(1)}
        >
          +
        </button>
      </span>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Categories — one column of rooms: a folded row carries its current values,
// the open row carries the room. 검색이 방을 좁힌다.
// ---------------------------------------------------------------------------

/** The rooms of 설정. 프로바이더 carries the provider and its own defaults;
    연결 carries two groups (GitHub 계정, 레포); the rest are one group each —
    the row is the index and the room at once. 팔레트의 `설정 ·` 행도
    같은 배열을 읽는다 — 두 벌이 어긋날 길이 없다. */
export const CATEGORIES = [
  { id: "screen", label: "화면", icon: ThemeIcon },
  { id: "providers", label: "프로바이더", icon: BrainIcon },
  { id: "chat", label: "대화", icon: NewChatIcon },
  { id: "behavior", label: "동작", icon: CommandIcon },
  { id: "notice", label: "알림", icon: BellIcon },
  { id: "connection", label: "연결", icon: LinkIcon },
  { id: "troubleshoot", label: "문제 해결", icon: RefreshIcon },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

/** 검색의 사전 — 방 이름만으로는 못 찾는 말을 방에 얹는다. 행의 JSX 를
    다시 읽지 않고도 "엔터"로 동작 칸에 닿게 하는 최소한의 층이다. */
const CATEGORY_KEYWORDS: Record<CategoryId, string> = {
  screen: "테마 배율 글자 크기 화면 크기 다크모드 다크 모드 밝기 ui scale font",
  providers: "프로바이더 에이전트 모델 생각 시간 노력 effort provider claude codex 기본",
  chat: "대화 생각 과정 작업 과정 보기 도구 컴포저 임시 저장 초안 턴 도중 보내기 대기 줄 바로 실어 steer",
  behavior: "동작 보내기 키 Enter 링크 열기",
  notice: "알림 소리 배지 완료 확인 요청 데스크톱 notification",
  connection: "연결 깃허브 github 토큰 레포 주소 저장 위치 계정 token repo url",
  troubleshoot: "문제 해결 재시작 로그 업데이트 업그레이드 초기화 복구 다시",
};

/** 설정을 여는 손이 고를 수 있는 칸 — `설정 열기`가 맥락의 칸으로 바로 선다. */
export type SettingsCategory = CategoryId;
/** 이 세션에서 마지막으로 본 설정의 방 — 다이얼로그를 다시 열 때 그 방부터. */
let lastCategory: CategoryId | null = null;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  /** Put the control on its own line, for anything wider than a picker. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={wide ? "setting setting--wide" : "setting"}>
      <span className="setting__text">
        <span className="setting__label">{label}</span>
        {hint && <span className="setting__hint">{hint}</span>}
      </span>
      <span className="setting__control">{children}</span>
    </label>
  );
}

/** A row that is not a <label> — segmented rows must not turn a click on the
    row text into a click on the first option (label activates its control),
    so segments live in a plain div and carry their names in aria instead. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting">
      <span className="setting__text">
        <span className="setting__label">{label}</span>
        {hint && <span className="setting__hint">{hint}</span>}
      </span>
      <span className="setting__control">{children}</span>
    </div>
  );
}

function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: Array<{ value: T; label: string; hint?: string; disabled?: boolean }>;
  onChange: (value: T) => void;
}) {
  /** The menu carries the choice's name; the description reads below the
      row, where a full sentence fits and nothing truncates mid-thought. */
  const activeHint = options.find((option) => option.value === value)?.hint ?? hint;
  /** 두세 태는 세그먼트로 — 한 번의 클릭이 곧 고르기다. 하나뿐인 임시 행과
      네 태 이상(생각 시간·모델)은 여전히 메뉴가 낫다. 키보드는 themegrid·
      탭 목록과 한 규칙: 화살표가 옮기고, 옮기는 것이 곧 고르는 것(APG radio). */
  const group = useRef<HTMLSpanElement>(null);
  if (options.length >= 2 && options.length <= 3) {
    const enabled = options.filter((option) => !option.disabled);
    const stopValue = options.some((option) => option.value === value) ? value : enabled[0]?.value;
    const step = (from: number, dir: 1 | -1) => {
      let to = from;
      for (let hops = 0; hops < options.length; hops += 1) {
        to = (to + dir + options.length) % options.length;
        if (!options[to]?.disabled) break;
      }
      const option = options[to];
      if (!option || option.disabled) return;
      onChange(option.value);
      group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[to]?.focus();
    };
    return (
      <Row label={label} {...(activeHint ? { hint: activeHint } : {})}>
        <span className="segcontrol" role="radiogroup" aria-label={label} ref={group}>
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={option.value === value}
              disabled={option.disabled}
              tabIndex={option.value === stopValue ? 0 : -1}
              className="segcontrol__opt"
              data-testid={`choice-${label}-${option.value}`}
              onKeyDown={(event) => {
                const dir =
                  event.key === "ArrowRight" || event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowLeft" || event.key === "ArrowUp"
                      ? -1
                      : 0;
                if (dir === 0) return;
                event.preventDefault();
                step(index, dir);
              }}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </span>
      </Row>
    );
  }
  return (
    <Field label={label} {...(activeHint ? { hint: activeHint } : {})}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** 저장 메모 담당 — 빈 메모의 커밋 문장과 넘기기 초안을 쓰는 에이전트.
    대화의 프로바이더(새 대화 프로바이더 행)와 무관한 기계의 잔일이라
    설정도 데몬에 산다(machine.json · machine.set). 후보는 oneShot 계약을
    구현한 드라이버뿐이고, 지금 담당은 상태의 machineProviderActive 가
    말한다 — 고른 값이 못 쓰이면 그 사실까지 한 줄로. */
function MachineProviderField({ daemon, disabled }: { daemon: Daemon; disabled: boolean }) {
  const status = daemon.status;
  const candidates = (status?.providers ?? []).filter((p) => p.oneShot);
  const configured = status?.machineProvider ?? null;
  const active = status?.machineProviderActive ?? null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (raw: string) => {
    if (disabled || pending || raw === (configured ?? "auto")) return;
    setPending(true);
    setError(null);
    daemon.api
      .machineSet(raw === "auto" ? null : raw)
      .then(() => daemon.api.refreshStatus())
      .catch((e: Error) => setError(e.message))
      .finally(() => setPending(false));
  };

  const labelOf = (id: string | null) =>
    id === null ? null : ((status?.providers ?? []).find((p) => p.id === id)?.label ?? id);

  // 지금 담당의 한 줄 — 설정과 자동을 구분해 말하고, 고른 값이 못 쓰이는
  // 동안엔 대체 중임까지 말한다. 상태가 유일한 진실이라 낙관치는 없다.
  const activeLine =
    active === null
      ? "지금: 쓸 수 있는 에이전트가 없어 메모를 건너뜁니다"
      : `지금: ${labelOf(active.id)} (${active.origin === "setting" ? "내 설정" : "자동"})${
          configured !== null && active.id !== configured
            ? " — 고른 에이전트를 지금 쓸 수 없어 자동으로 대체 중"
            : ""
        }`;

  return (
    <Field
      wide
      label="저장 메모 담당"
      hint="빈 메모의 저장과 넘기기 초안을 어느 에이전트가 쓰지 정합니다. 자동이면 설치된 것 중 첫 번째를 씁니다 — 대화의 프로바이더와는 무관합니다."
    >
      <span className="settings__stack">
        <select
          aria-label="저장 메모 담당"
          value={configured ?? "auto"}
          disabled={disabled || pending}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="auto">자동 (권장)</option>
          {candidates.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.available}>
              {p.label}
              {p.available ? "" : ` — ${p.reason ?? "설치 필요"}`}
            </option>
          ))}
        </select>
        {pending && (
          <span className="hint" role="status">
            바꾸는 중…
          </span>
        )}
        {error !== null ? (
          <span className="hint" role="alert">
            {error}
          </span>
        ) : (
          <span className="hint">{activeLine}</span>
        )}
      </span>
    </Field>
  );
}

function Switch({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="switch__track" aria-hidden="true">
          <span className="switch__knob" />
        </span>
      </span>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Theme gallery — 18 palettes chosen by their colour, not by their name.
// ---------------------------------------------------------------------------

/**
 * One tile's miniature: the app's four bones — rail, head, body, accent
 * button — drawn from the palette variables. The tile's wrapper carries
 * `data-theme`, so the same markup paints itself in whichever palette the
 * tile sells; nothing here knows a colour.
 */
function ThemeArt() {
  return (
    <span className="tg" aria-hidden="true">
      <span className="tg__rail">
        <i />
        <i />
        <i />
      </span>
      <span className="tg__main">
        <span className="tg__head" />
        <span className="tg__line" />
        <span className="tg__line tg__line--short" />
        <span className="tg__btn" />
      </span>
    </span>
  );
}

function ThemeGallery({
  value,
  onChange,
}: {
  value: ThemeChoice;
  onChange: (theme: ThemeChoice) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  /**
   * 라디오그룹의 키보드 규칙: Tab 은 그룹에 한 번만 멈추고(선택된 타일),
   * 화살표가 안에서 옮긴다 — 옮기는 것이 곧 고르는 것(APG radio).
   * 18개 타일이 전부 Tab 스톱이면 다른 설정까지 18번을 걸어야 했다.
   */
  const move = (from: number, dir: 1 | -1) => {
    const to = (from + dir + THEMES.length) % THEMES.length;
    const theme = THEMES[to];
    if (!theme) return;
    onChange(theme);
    grid.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[to]?.focus();
  };
  return (
    <div className="themegrid" role="radiogroup" aria-label="테마" ref={grid}>
      {THEMES.map((theme, index) => (
        <button
          key={theme}
          type="button"
          role="radio"
          aria-checked={theme === value}
          tabIndex={theme === value ? 0 : -1}
          className="themegrid__tile"
          data-testid={`theme-${theme}`}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(index, 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(index, -1);
            }
          }}
          onClick={() => onChange(theme)}
        >
          <span className="themegrid__art" {...(theme === "system" ? {} : { "data-theme": theme })}>
            {theme === "system" ? (
              /* system 은 두 얼굴이 한 타일: 어두운 절과 밝은 절. */
              <>
                <span className="themegrid__half" data-theme="dark">
                  <ThemeArt />
                </span>
                <span className="themegrid__half" data-theme="light">
                  <ThemeArt />
                </span>
              </>
            ) : (
              <ThemeArt />
            )}
          </span>
          <span className="themegrid__name">
            {THEME_LABEL[theme]}
            {theme === value && <CheckIcon size={11} />}
          </span>
        </button>
      ))}
    </div>
  );
}

export function SettingsDialog({
  settings,
  onChange,
  onChatChange,
  daemonUrl,
  status,
  connection,
  daemon,
  onOpenOnboarding,
  onReconnect,
  onForgetUrl,
  onClose,
  initialCategory,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** The 대화 group edits these; they reach the live thread too. */
  onChatChange: (patch: Partial<ChatSettings>) => void;
  daemonUrl: string | null;
  status: DaemonStatus | null;
  connection: string;
  /** The connected repo's url/PAT live daemon-side; the dialog only edits them. */
  daemon: Daemon;
  /** Opens the first-run wizard again. */
  onOpenOnboarding: () => void;
  onReconnect: (url: string) => void;
  onForgetUrl: () => void;
  onClose: () => void;
  /** `설정 열기`가 맥락의 칸으로 바로 서게 하는 책갈피 — 없으면 마지막 방. */
  initialCategory?: SettingsCategory;
}) {
  const [url, setUrl] = useState(daemonUrl ?? "");
  /**
   * Only a live session can be asked for the model list, so the cache is what
   * lets 설정 offer real names before a thread is open — the daemon's own copy
   * is the fallback for a browser that has never had one. Both are keyed by
   * the selected provider: a Claude alias and a Codex id are different
   * vocabularies and must never share a picker.
   */
  const models =
    loadModelCatalog(settings.chat.provider).length > 0
      ? loadModelCatalog(settings.chat.provider)
      : (status?.modelsByProvider?.[settings.chat.provider] ?? []);
  /** 누른 프로바이더 — 기본 모델·생각 시간 고르개(행 안의 펼침)가 누구의
      핀을 고치는지가 이 이름으로 판명된다. 연결 전엔 목록이 없어 id로
      불린다. */
  const pickedProvider = status?.providers?.find((p) => p.id === settings.chat.provider);
  const providerRows = status?.providers ?? [];
  /** 고를 수 있는 행 — 켜져 있고(available) 스위치가 켜진 프로바이더만
      화살표가 밟고 Tab 이 머문다. */
  const providerUsable = (id: string) =>
    Boolean(providerRows.find((q) => q.id === id)?.available) &&
    !(settings.chat.disabledProviders ?? []).includes(id);
  /** Tab 의 유일한 정거장 — 눌러 둔 프로바이더가 고를 수 있으면 그 행,
      아니면 고를 수 있는 첫 행(Choice 의 stopValue 와 한 규칙). */
  const providerStop = providerRows.some(
    (p) => p.id === settings.chat.provider && providerUsable(p.id),
  )
    ? settings.chat.provider
    : providerRows.find((p) => providerUsable(p.id))?.id;
  const providerGroup = useRef<HTMLDivElement>(null);
  /** APG radio — 화살표가 옮기고, 옮기는 것이 곧 고르는 것. */
  const stepProvider = (from: number, dir: 1 | -1) => {
    let to = from;
    for (let hops = 0; hops < providerRows.length; hops += 1) {
      to = (to + dir + providerRows.length) % providerRows.length;
      if (providerUsable(providerRows[to]?.id ?? "")) break;
    }
    const target = providerRows[to];
    if (!target || !providerUsable(target.id)) return;
    onChatChange(switchProviderPatch(settings.chat, target.id));
    providerGroup.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[to]?.focus();
  };
  // 고침 버튼(설치·로그인)의 몫 — 온보딩의 run 과 한 규칙이다. 데몬은
  // {started, guidance} 로만 답하고, mac 설치 창은 없으니 이 안내 한 줄이
  // 누름의 유일한 결과다. 행이 기억하는 건 어느 행의 말인지뿐이다.
  const [fixBusy, setFixBusy] = useState<string | null>(null);
  const [fixNotice, setFixNotice] = useState<{
    id: string;
    started: boolean;
    guidance: string;
  } | null>(null);
  /** 고침은 claude 만이 두는 길이다 — fix 종류(install-claude·login-claude)가
      그 둘뿐이고, 나머지 에이전트의 설치·로그인 안내는 드라이버의 reason 줄이
      말한다. 끝나면 다시 검사해 status 를 끌어당긴다 — 행이 스스로
      준비됨으로 바뀌어야 버튼이 성공한 걸 읽을 수 있다. */
  const runProviderFix = async (id: string, kind: "install-claude" | "login-claude") => {
    setFixBusy(id);
    setFixNotice(null);
    try {
      const reply = (await daemon.api.onboardingFix(kind)) as unknown;
      if (reply !== null && typeof reply === "object" && "guidance" in reply) {
        setFixNotice({
          id,
          started: !("started" in reply) || reply.started !== false,
          guidance: String(reply.guidance),
        });
      }
      await daemon.api.onboardingCheck(id);
    } catch (error) {
      setFixNotice({
        id,
        started: false,
        guidance: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setFixBusy(null);
    }
    await daemon.api.refreshStatus();
  };
  /** 누른 프로바이더의 기본값 고르개 두 줄 — 행 안의 펼침과 (행이 하나도
      없는 연결 전) 목록 밑의 예비 판이 같은 것을 쓴다. "기본 모델"은
      컴포저 칩의 어휘(모델·생각)를 따르고, '방식'이라는 말은 확인 방식에
      양보한다 — 같은 단어가 두 뜻으로 쓰이지 않게. */
  const defaultsEditor = (
    <>
      <Choice<string>
        label="기본 모델"
        hint={
          models.length > 0
            ? "어떤 모델이 답할지 고릅니다"
            : "대화를 한 번 시작하면 고를 수 있는 목록이 채워집니다"
        }
        value={settings.chat.model ?? ""}
        options={[
          // 카탈로그가 없는 동안의 임시 행 — 고를 수 없고, 첫 대화가
          // 목록을 채우면 사라진다. '자동' 행은 없다: 비어 있는 자리는
          // 씨앗(useSessions)이 구체적인 한 행으로 채운다.
          ...(models.length === 0
            ? [
                {
                  value: "",
                  label: "대화를 한 번 시작하면 목록이 채워집니다",
                  disabled: true,
                },
              ]
            : []),
          ...modelOptions(models, modelRowOf(models, settings.chat.model)).map((option) => ({
            value: option.value ?? "",
            label: option.label,
            ...(option.hint ? { hint: option.hint } : {}),
          })),
        ]}
        onChange={(model) => onChatChange({ model })}
      />
      <Choice<string>
        label="생각 시간"
        hint="오래 생각할수록 꼼꼼하고, 그만큼 느립니다"
        value={settings.chat.effort ?? ""}
        options={[
          // 노력은 모델이 받는 수준에서만 의미가 있다 — 아직 모르는
          // 동안의 임시 행이며, 씨앗이 채운 뒤에는 실제 수준만 남는다.
          ...(settings.chat.effort == null
            ? [
                {
                  value: "",
                  label: "첫 대화 이후 채워집니다",
                  disabled: true,
                },
              ]
            : []),
          ...EFFORT_ORDER.map((level) => ({
            value: level,
            label: EFFORT_LABEL[level],
          })),
        ]}
        onChange={(effort) => onChatChange({ effort: effort as EffortLevel })}
      />
    </>
  );
  const panel = useRef<HTMLDivElement>(null);
  useModalFocus(panel);
  /** The room the accordion holds open. 설정 opens on 화면 — the room everyone
      visits — or on the room the planner left: 닫았다 열면 그 방부터 다시
      본다. 모듈 변수면 충분하다 — 다이얼로그는 닫힐 때 내려오고, 방 위치는
      설정값이 아니라 책갈피다. 열린 방이 없는 상태(모두 접힌 목록)도 허용한다.
      */
  // `설정 열기`가 맥락을 들고 오면 그 칸이 먼저다 — 없으면 마지막으로 본 방.
  const [active, setActiveState] = useState<CategoryId | null>(
    initialCategory ?? lastCategory ?? "screen",
  );
  const setActive = (next: CategoryId) => {
    lastCategory = next;
    setActiveState(next);
  };
  /** 설정 검색 — 방 이름과 방의 어휘(CATEGORY_KEYWORDS)로 좁힌다. 검색 중에는
      걸린 방이 전부 펼쳐져 한눈에 훑고, 헤더를 누르면 그 방으로 정착한다
      (검색어가 지워지고 그 방만 열린다): 타이핑이 곧 훑기, 누름이 곧 이동이다. */
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const categoryText = (category: (typeof CATEGORIES)[number]) =>
    `${category.label} ${CATEGORY_KEYWORDS[category.id]}`.toLowerCase();
  const visibleCategories = needle
    ? CATEGORIES.filter((category) => categoryText(category).includes(needle))
    : CATEGORIES;
  const accList = useRef<HTMLDivElement>(null);
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  /** 세션이 돌고 있어 설치가 연기됐음을 알리는 한 줄. */
  const [updateDeferred, setUpdateDeferred] = useState<string | null>(null);
  /** 내려받기·검증이 끝나 종료 직전임을 알리는 안내 — 성공 경로의 한 줄. */
  const [updateStarted, setUpdateStarted] = useState<string | null>(null);
  /** 내려받기·검증이 끝나 재시작 동의만 남은 상태 — `지금 재시작` 버튼의 스위치. */
  const [updatePrepared, setUpdatePrepared] = useState(false);
  /**
   * 시험 알림의 답 한 줄. 알림이 안 온다는 신고의 절반은 OS 가 이 앱의 알림을
   * 막고 있는 경우인데, 그 사실은 어디에도 나타나지 않았다 — 시험 버튼은
   * 언제나 조용히 성공했다. 이제는 OS 가 거절하면 이유를, 받아 갔으면 "그래도
   * 배너가 없으면 OS 설정을 보라"는 다음 걸음을 말한다.
   */
  const [noticeTest, setNoticeTest] = useState<string | null>(null);

  /**
   * 업데이트 문단은 데스크톱 앱 안에서만 산다 — 브라우저엔 '이 앱의 버전'이
   * 없어 비교가 성립하지 않는다. 다리의 platform 이 설치 문단을 고른다: mac·
   * Windows 는 앱이 스스로 갈아입고, 나머지는 릴리스 페이지로 안내한다. 이
   * 플랫폼의 에셋이 피드에 있는지는 update.url·update.sha256 이 말해 준다 —
   * 메인이 이 플랫폼 몫으로 이미 골라 돌려준 한 쌍이다.
   */
  const desktop = window.coloDesignDesktop ?? null;
  const canSelfUpdate = desktop?.platform === "darwin" || desktop?.platform === "win32";

  /**
   * `폴더 열기` — the desktop bridge opens ~/.colo-design in the OS
   * file manager; the browser path has no bridge and shows the path instead.
   * The preload script is the boundary that decides the shape, so reading it
   * once through a named accessor with an `in` guard is the checked route.
   */
  const bridgeOpenHome =
    window.coloDesignDesktop && "openHome" in window.coloDesignDesktop
      ? window.coloDesignDesktop.openHome
      : undefined;
  /**
   * `시스템 알림 설정 열기` — 같은 규칙(`in` 가드로 한 번만 읽는다). 브라우저
   * 경로에는 없다: 거기서는 사이트 권한이라 주소창의 자물쇠가 그 자리다.
   */
  const bridgeOpenNotificationSettings =
    window.coloDesignDesktop && "openNotificationSettings" in window.coloDesignDesktop
      ? window.coloDesignDesktop.openNotificationSettings
      : undefined;
  /**
   * 수동 업데이트 확인: 데스크톱 다리로만 묻는다 — 확인은
   * 메인 프로세스가 피드에서 읽고, 렌더러는 결과를 보여주기만 한다.
   */
  const checkUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    setUpdateDeferred(null);
    setUpdatePrepared(false);
    try {
      const result = await desktop?.updateCheck();
      if (!result) return;
      if ("error" in result && result.error) throw new Error(String(result.error));
      setUpdate(result);
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckingUpdate(false);
    }
  };

  /**
   * 자가 교체: 새 버전이 확인되면 내려받고 sha256 검증한 뒤 앱이
   * 스스로 종료·교체·재실행한다 — mac 은 번들을 갈아 치우고, Windows 는 설치
   * 프로그램을 무인으로 돌린다. 무엇을 내려받을지는 메인이 피드에서 다시
   * 읽는다 — 렌더러는 요청만 보낸다.
   */
  const installUpdate = async () => {
    if (!update?.url || !update.sha256) return;
    setInstallingUpdate(true);
    setUpdateError(null);
    setUpdateStarted(null);
    setUpdateDeferred(null);
    setUpdatePrepared(false);
    try {
      const result = await window.coloDesignDesktop?.selfUpdate();
      if (result && typeof result === "object" && "error" in result && result.error) {
        throw new Error(String(result.error));
      }
      // 세션이 돌고 있으면 메인이 설치를 연기한다 — 이 문단이 그 약속을
      // 보여준다. 모든 대화가 내려앉는 순간 알림과 함께 설치된다.
      if (result && typeof result === "object" && "deferred" in result) {
        setUpdateDeferred(
          `작업이 끝나는 대로 ${result.version} 설치를 시작합니다 — 돌아가는 대화가 끊기지 않도록 기다리는 중입니다.`,
        );
        return;
      }
      // 내려받기·검증이 끝난 뒤 앱은 멈춰 서서 재시작 동의를 기다린다 —
      // 두 번째 selfUpdate 호출이 그 동의다(메인의 prepared 상태가 받는다).
      if (result && typeof result === "object" && "prepared" in result) {
        setUpdateStarted(
          `${result.version} 준비가 끝났습니다 — 지금 재시작을 누르면 설치하고 다시 열립니다.`,
        );
        setUpdatePrepared(true);
        return;
      }
      setUpdateStarted("재시작합니다 — 새 버전으로 다시 열립니다.");
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallingUpdate(false);
    }
  };
  /** 테스트 알림 — 데스크톱은 메인이, 브라우저는 이 자리에서 보낸다. */
  const sendTestNotice = async () => {
    setNoticeTest(null);
    const bridge = window.coloDesignDesktop;
    if (bridge?.notifyTest) {
      const result = await bridge.notifyTest();
      setNoticeTest(
        result?.shown === false
          ? `이 컴퓨터의 OS 가 알림을 거절했습니다 — ${result.error ?? "이유를 알려주지 않았습니다"}`
          : "보냈습니다. 배너가 보이지 않으면 OS 가 이 앱의 알림을 꺼 둔 것입니다 — 아래 버튼으로 켜 주세요.",
      );
      return;
    }
    if (typeof Notification === "undefined") {
      setNoticeTest("이 브라우저는 알림을 지원하지 않습니다.");
      return;
    }
    try {
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission !== "granted") {
        setNoticeTest(
          "브라우저가 이 사이트의 알림을 허용하지 않았습니다 — 주소창의 자물쇠에서 켭니다.",
        );
        return;
      }
      new Notification("알림 시험", {
        body: "실제 알림은 이렇게 도착합니다.",
        silent: !settings.notifications.sound,
      });
      setNoticeTest("보냈습니다.");
    } catch {
      // 서비스 워커 없이는 생성을 막는 브라우저가 있다 — 그 사실을 말해 준다.
      setNoticeTest("이 브라우저는 페이지에서 직접 알림을 띄우지 못합니다.");
    }
  };

  /** 접속 주소 지우기의 확인 — this app's dialog, not window.confirm. */
  const [forgetConfirm, setForgetConfirm] = useState(false);
  /** The GitHub group's 토큰 바꾸기 toggle: detail row ↔ the form. */
  const [editingToken, setEditingToken] = useState(false);
  const connected = daemon.connection === "open";

  // 확인 대화가 위에 떠 있으면 Escape 는 그 대화의 몫이다 — useModalEscape 의
  // 최상단 규칙이 부모 닫힘을 막는다(수동 forgetConfirm 가드는 그 자리로 간다).
  useModalEscape(panel, onClose);

  // Move focus into the dialog so Escape and Tab act on it rather than on the
  // page behind it.
  useEffect(() => {
    panel.current?.focus();
  }, []);

  const urlChanged = url.trim().length > 0 && url.trim() !== (daemonUrl ?? "");

  /** 접힌 방의 한 줄 요약 — 열어 보기 전에 지금 값이 읽히게 한다. 아직
      값이 정해지지 않은 방(연결 전 프로바이더)과 값 대신 절차가 있는 방
      (문제 해결)은 요약을 비워 둔다: 없는 값을 꾸미지 않는다. */
  const summaries: Record<CategoryId, string | null> = {
    screen: `${THEME_LABEL[settings.theme]} · ${settings.uiSize}px`,
    providers: (() => {
      const label = pickedProvider?.label;
      if (!label) return null;
      const model = settings.chat.model
        ? (modelRowOf(models, settings.chat.model)?.displayName ?? settings.chat.model)
        : null;
      return [label, model, settings.chat.effort ? EFFORT_LABEL[settings.chat.effort] : null]
        .filter(Boolean)
        .join(" · ");
    })(),
    chat: [
      MODE_LABEL[settings.chat.permissionMode],
      settings.chat.midturn === "steer" ? "바로 실어 보내기" : null,
    ]
      .filter(Boolean)
      .join(" · "),
    behavior: SEND_SHORT[settings.sendKey],
    notice: `${NOTICE_DONE_LABEL[settings.notifications.done]} · 소리 ${settings.notifications.sound ? "켬" : "끔"}`,
    connection: (() => {
      if (!connected) return "연결되지 않았습니다";
      const github = daemon.onboarding?.find((step) => step.id === "github");
      return github?.status === "pass" && github.detail ? github.detail : "GitHub 토큰 없음";
    })(),
    troubleshoot: null,
  };

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal__panel modal__panel--settings"
        role="dialog"
        aria-modal="true"
        aria-label="설정"
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal__head">
          <h2 className="modal__title">설정</h2>
          <button type="button" className="ghost" aria-label="설정 닫기" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <div className="settings">
          {/* 검색 — 찾는 말이 방을 좁히고, 걸린 방은 전부 펼쳐 한눈에 훑는다. */}
          <input
            className="settings__search"
            type="search"
            placeholder="설정 검색"
            aria-label="설정 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              /* 지울 검색어가 있을 때만 Escape를 이 칸에서 멈춘다 — 빈 칸의
                 Escape 는 다이얼로그 닫힘으로 흘러가야 한다(useModalEscape 가
                 document 에서 듣는다). 무조건 stopPropagation 이면 검색 칸에
                 초점이 남은 채 패널을 닫을 수 없었다. */
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          <div ref={accList} className="settings__acc">
            {visibleCategories.length === 0 && (
              <p className="settings__empty">맞는 설정이 없습니다</p>
            )}
            {visibleCategories.map((category, index) => {
              const Icon = category.icon;
              const open = needle ? true : active === category.id;
              return (
                <section key={category.id} className="acc__item">
                  <h3 className="acc__heading">
                    <button
                      type="button"
                      id={`settings-tab-${category.id}`}
                      className="acc__head"
                      aria-expanded={open}
                      aria-controls={`settings-acc-${category.id}`}
                      data-testid={`settings-nav-${category.id}`}
                      onClick={() => {
                        /* 검색 중의 누름은 정착이다 — 좁힘을 걷고 그 방만
                           열어 준다. 평소의 누름은 열고 닫고(아코디언), 다른
                           방을 누르면 그 방으로 옮겨 앉는다. */
                        if (needle) {
                          setQuery("");
                          setActive(category.id);
                        } else if (active === category.id) {
                          setActiveState(null);
                        } else {
                          setActive(category.id);
                        }
                      }}
                      onKeyDown={(event) => {
                        /* APG 아코디언: 화살표는 고개만 옮기고, Enter 가 방을
                           열고 닫는다. 두 축을 다 받는다 — 좁은 창에서도 같은
                           동작이어야 한다. */
                        const dir =
                          event.key === "ArrowDown" || event.key === "ArrowRight"
                            ? 1
                            : event.key === "ArrowUp" || event.key === "ArrowLeft"
                              ? -1
                              : 0;
                        if (dir === 0) return;
                        event.preventDefault();
                        const to =
                          (index + dir + visibleCategories.length) % visibleCategories.length;
                        accList.current
                          ?.querySelectorAll<HTMLButtonElement>(".acc__head")
                          [to]?.focus();
                      }}
                    >
                      <span className="ic ic--sm ic--quiet">
                        <Icon />
                      </span>
                      <span className="acc__name">{category.label}</span>
                      {/* 접힌 방의 한 줄 요약 — 열어 보기 전에 지금 값이 먼저 읽힌다. */}
                      <span className="acc__sum">{summaries[category.id]}</span>
                      <span className="acc__chev" aria-hidden="true">
                        <ChevronDownIcon />
                      </span>
                    </button>
                  </h3>
                  {open && (
                    <section
                      className="acc__body"
                      id={`settings-acc-${category.id}`}
                      aria-labelledby={`settings-tab-${category.id}`}
                    >
                      {category.id === "screen" && (
                        <>
                          <div className="setting setting--wide">
                            <span className="setting__text">
                              <span className="setting__label">테마</span>
                              <span className="setting__hint">{SYSTEM_HINT}</span>
                            </span>
                            <ThemeGallery
                              value={settings.theme}
                              onChange={(theme) => onChange({ theme })}
                            />
                          </div>
                          <PxSize
                            label="인터페이스 크기"
                            hint="탐색·컨트롤·레이블에 적용됩니다"
                            axis="ui"
                            value={settings.uiSize}
                            onChange={(uiSize) => onChange({ uiSize })}
                          />
                          <PxSize
                            label="콘텐츠 크기"
                            hint="채팅 본문과 렌더링된 문서에 적용됩니다"
                            axis="content"
                            value={settings.contentSize}
                            onChange={(contentSize) => onChange({ contentSize })}
                          />
                          <PxSize
                            label="코드 크기"
                            hint="명령·diff·출력 같은 기계 텍스트에 적용됩니다"
                            axis="code"
                            value={settings.codeSize}
                            onChange={(codeSize) => onChange({ codeSize })}
                          />
                        </>
                      )}

                      {/* The provider room: which provider a new conversation runs on,
                and that provider's own defaults — 기본 모델·생각 시간은
                프로바이더별 핀이라(switchProviderPatch) 한 행에 산다. 행은
                상태(준비됨·로그인 필요·설치 필요·꺼짐)가 먼저 읽히고, 막힌
                claude 행은 고치는 버튼을, 누른 행은 자기 기본값을 그 자리에서
                펼친다 — 목록과 편집 사이의 눈 왕복이 없다. */}
                      {category.id === "providers" && (
                        <>
                          {providerRows.length > 0 ? (
                            <Field
                              label="새 대화 프로바이더"
                              hint="새로 시작하는 대화가 어느 프로바이더로 돌지 고릅니다 — 열려 있는 대화는 그대로입니다. 스위치를 끄면 새 대화 목록에서 숨깁니다"
                              wide
                            >
                              <div className="providerlist__wrap">
                                <span className="providerlist__colhead">새 대화 목록</span>
                                <div
                                  className="providerlist"
                                  role="radiogroup"
                                  aria-label="새 대화 프로바이더"
                                  ref={providerGroup}
                                >
                                  {providerRows.map((p, index) => {
                                    const off = (settings.chat.disabledProviders ?? []).includes(
                                      p.id,
                                    );
                                    const on = p.available && !off;
                                    // 이 프로바이더에 저장된 기본값 — 누른 프로바이더는
                                    // 윗자리 핀을, 나머지는 byProvider 몫을 읽는다. 두 곳은
                                    // switchProviderPatch 가 맞바꾸는 한 저장소의 두 자리다.
                                    // 누른 행은 펼침이 그 핀을 곧 보여 주므로 요약 줄에서는
                                    // 빠지고, 나머지 행의 한 줄이 각자의 기본값을 말한다.
                                    const rowModels =
                                      loadModelCatalog(p.id).length > 0
                                        ? loadModelCatalog(p.id)
                                        : (status?.modelsByProvider?.[p.id] ?? []);
                                    const pin =
                                      settings.chat.provider === p.id
                                        ? {
                                            model: settings.chat.model,
                                            effort: settings.chat.effort,
                                          }
                                        : settings.chat.byProvider?.[p.id];
                                    const pinText = [
                                      pin?.model
                                        ? (modelRowOf(rowModels, pin.model)?.displayName ??
                                          pin.model)
                                        : null,
                                      pin?.effort ? EFFORT_LABEL[pin.effort] : null,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ");
                                    // 마지막 켜진 프로바이더는 끌 수 없다 — 새 대화가
                                    // 프로바이더 없이 태어난다. 스위치 자체가 잠기고 한 줄이
                                    // 이유를 말한다.
                                    const lastUsable =
                                      on &&
                                      !providerRows.some(
                                        (q) =>
                                          q.id !== p.id &&
                                          q.available &&
                                          !(settings.chat.disabledProviders ?? []).includes(q.id),
                                      );
                                    // 계정 한도 — 데몬이 claude·codex 의 플랜 읽기를
                                    // 들고 있다. 다섯 시간 창이 한도의 얼굴이고(컴포저의
                                    // UsageChip 도 그렇게 읽는다), 없으면 주간 창이 선다.
                                    const plan = status?.planUsageByProvider?.[p.id];
                                    const planWindow = plan?.fiveHour ?? plan?.sevenDay ?? null;
                                    const planText =
                                      plan && planWindow
                                        ? `${plan.fiveHour ? "5시간" : "이번 주"} ${Math.round(planWindow.utilization ?? 0)}%`
                                        : null;
                                    // 상태가 먼저 선다 — 한 단어가 행의 첫 읽기다.
                                    // 칩으로 접던 자격(버전·모델 수)은 문장이 아니라
                                    // 기본 모델 고르개의 목록이 말할 몫이라 지웠다.
                                    const statusWord = !p.available
                                      ? (p.reason ?? "설치 필요")
                                      : off
                                        ? "꺼짐"
                                        : p.loggedIn === false
                                          ? "로그인 필요"
                                          : "준비됨";
                                    const metaText = [
                                      statusWord,
                                      !p.available
                                        ? null
                                        : off
                                          ? "새 대화에 나오지 않습니다"
                                          : p.loggedIn === false
                                            ? "로그인하면 새 대화에서 쓸 수 있습니다"
                                            : settings.chat.provider === p.id
                                              ? null
                                              : pinText || null,
                                      planText,
                                      lastUsable
                                        ? "켜진 다른 프로바이더가 없어 끌 수 없습니다"
                                        : null,
                                    ]
                                      .filter((part): part is string => part !== null)
                                      .join(" · ");
                                    return (
                                      <div
                                        key={p.id}
                                        className={`providerlist__item${off || !p.available ? " providerlist__item--off" : ""}${
                                          settings.chat.provider === p.id
                                            ? " providerlist__item--picked"
                                            : ""
                                        }`}
                                        title={
                                          off
                                            ? "스위치를 켜면 새 대화의 프로바이더로 다시 고를 수 있습니다"
                                            : undefined
                                        }
                                      >
                                        <button
                                          type="button"
                                          role="radio"
                                          aria-checked={settings.chat.provider === p.id}
                                          disabled={!p.available || off}
                                          tabIndex={p.id === providerStop ? 0 : -1}
                                          className="providerlist__row"
                                          onKeyDown={(event) => {
                                            const dir =
                                              event.key === "ArrowRight" ||
                                              event.key === "ArrowDown"
                                                ? 1
                                                : event.key === "ArrowLeft" ||
                                                    event.key === "ArrowUp"
                                                  ? -1
                                                  : 0;
                                            if (dir === 0) return;
                                            event.preventDefault();
                                            stepProvider(index, dir);
                                          }}
                                          onClick={() =>
                                            onChatChange(switchProviderPatch(settings.chat, p.id))
                                          }
                                        >
                                          <span className="providerlist__mark">
                                            <ProviderIcon provider={p.id} size={15} />
                                          </span>
                                          <span className="providerlist__body">
                                            <span className="providerlist__topline">
                                              <span className="providerlist__name">{p.label}</span>
                                            </span>
                                            <span className="providerlist__meta">
                                              <span
                                                className={`providerlist__dot${on && p.loggedIn !== false ? " providerlist__dot--ok" : ""}${on && p.loggedIn === false ? " providerlist__dot--warn" : ""}`}
                                                aria-hidden="true"
                                              />
                                              {metaText}
                                            </span>
                                          </span>
                                        </button>
                                        {/* 스위치는 행 꼭대기의 오른쪽 끝 — 펼침이
                                            아래로 늘어나도 라디오와 같은 줄에 선다.
                                            flex-wrap 은 DOM 순서대로 줄을 나누므로
                                            펼침(basis 100%)보다 먼저 와야 한다. */}
                                        <span
                                          className="switch providerlist__switch"
                                          title={
                                            !p.available
                                              ? "이 기기에 없는 프로바이더입니다"
                                              : lastUsable
                                                ? "켜진 다른 프로바이더가 없어 끌 수 없습니다"
                                                : settings.chat.provider === p.id
                                                  ? "끄면 기본이 다른 켜진 프로바이더로 옮겨갑니다"
                                                  : "새 대화의 프로바이더 목록에 넣거나 뺍니다"
                                          }
                                        >
                                          <input
                                            type="checkbox"
                                            checked={on}
                                            disabled={!p.available || lastUsable}
                                            aria-label={`${p.label} 새 대화에 사용`}
                                            onChange={(event) => {
                                              if (event.target.checked) {
                                                onChatChange({
                                                  disabledProviders: (
                                                    settings.chat.disabledProviders ?? []
                                                  ).filter((id) => id !== p.id),
                                                });
                                                return;
                                              }
                                              const nextDisabled = [
                                                ...(settings.chat.disabledProviders ?? []),
                                                p.id,
                                              ];
                                              // 기본 선택이 꺼지는 것이라면 남은 켜진
                                              // 프로바이더로 옮겨 심는다 — 새 대화는 항상
                                              // 켜진 프로바이더에서 태어난다.
                                              const fallback = (status?.providers ?? []).find(
                                                (q) =>
                                                  q.id !== p.id &&
                                                  q.available &&
                                                  !nextDisabled.includes(q.id),
                                              );
                                              if (!fallback) return;
                                              const patch =
                                                settings.chat.provider === p.id
                                                  ? switchProviderPatch(settings.chat, fallback.id)
                                                  : {};
                                              onChatChange({
                                                ...patch,
                                                disabledProviders: nextDisabled,
                                              });
                                            }}
                                          />
                                          <span className="switch__track" aria-hidden="true">
                                            <span className="switch__knob" />
                                          </span>
                                        </span>
                                        {/* 막힌 claude 행의 다음 걸음 — 설치·로그인의
                                            fix 종류가 claude 의 것뿐이라 claude 만이
                                            버튼을 두고, 나머지 에이전트는 reason 줄이
                                            안내한다. 누름의 답은 행 아래의 안내 한 줄. */}
                                        {p.id === "claude" && !p.available && (
                                          <div className="providerlist__fix">
                                            <button
                                              type="button"
                                              className="primary"
                                              disabled={fixBusy === p.id}
                                              onClick={() =>
                                                void runProviderFix(p.id, "install-claude")
                                              }
                                            >
                                              {fixBusy === p.id ? "실행 중…" : "설치하기"}
                                            </button>
                                          </div>
                                        )}
                                        {p.id === "claude" &&
                                          p.available &&
                                          p.loggedIn === false && (
                                            <div className="providerlist__fix">
                                              <button
                                                type="button"
                                                className="primary"
                                                disabled={fixBusy === p.id}
                                                onClick={() =>
                                                  void runProviderFix(p.id, "login-claude")
                                                }
                                              >
                                                {fixBusy === p.id ? "실행 중…" : "로그인하기"}
                                              </button>
                                            </div>
                                          )}
                                        {fixNotice?.id === p.id && (
                                          <p
                                            className={`providerlist__fixnote${fixNotice.started ? "" : " providerlist__fixnote--warn"}`}
                                            role="status"
                                          >
                                            {fixNotice.guidance}
                                          </p>
                                        )}
                                        {/* 누른 행이 곧 기본값 판 — 라디오로 고른 것이
                                            펼침이고, 고르개 둘이 그 자리에서 이 행의
                                            핀을 고친다. 꺼졌거나 못 쓰는 행은 펼치지
                                            않는다 — 고를 수도 없는 행의 기본값이다. */}
                                        {settings.chat.provider === p.id && p.available && !off && (
                                          <div className="providerlist__detail">
                                            <span className="providerlist__detailhead">
                                              새 대화 기본값
                                              <span className="providerlist__detailnote">
                                                프로바이더마다 따로 저장됩니다
                                              </span>
                                            </span>
                                            {defaultsEditor}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </Field>
                          ) : (
                            <p className="providerlist__empty">
                              {connection === "open"
                                ? "이 기기에서 쓸 수 있는 프로바이더를 찾지 못했습니다 — Claude Code가 설치되어 있는지 확인해 주세요."
                                : "연결하면 이 기기에서 쓸 수 있는 프로바이더가 여기 표시됩니다."}
                            </p>
                          )}
                          {/* 행이 하나도 없는 연결 전 — 목록이 비어 있어도 기본값
                    핀은 첫 연결에서 데몬이 읽어 간다. 편집의 자리를 행 안
                    펼침이 대신할 수 없으니 이 예비 판이 선다. */}
                          {providerRows.length === 0 && (
                            <div className="providerlist__standalone">
                              <span className="providerlist__detailhead">
                                {pickedProvider?.label ?? settings.chat.provider} · 새 대화 기본값
                              </span>
                              {defaultsEditor}
                            </div>
                          )}
                          <MachineProviderField daemon={daemon} disabled={connection !== "open"} />
                        </>
                      )}

                      {/* Where the three composer chips went. A planner
                describing a screen should not be choosing a model to do it with;
                the choice is real, so it is kept, but it is kept here. */}
                      {category.id === "chat" && (
                        <>
                          <Choice<PermissionMode>
                            label="확인 방식"
                            hint="AI가 화면을 바꾸기 전에 물어볼지 정합니다 — 화면 파일 편집은 확인 방식과 관계없이 자동으로 적용되고, 명령 실행만 물어봅니다"
                            value={settings.chat.permissionMode}
                            options={SETTINGS_MODES.map((mode) => ({
                              value: mode,
                              label: MODE_LABEL[mode],
                            }))}
                            onChange={(permissionMode) => onChatChange({ permissionMode })}
                          />
                          {settings.chat.permissionMode === "acceptEdits" && (
                            <div className="notice notice--warn" aria-live="polite">
                              <span className="notice__text">
                                `화면 수정은 바로`는 화면 파일 편집뿐 아니라 CLI가 안전하다고 본
                                명령까지 묻지 않고 실행합니다. 편집만 조용하면 되면 `실행 전에
                                물어보기`를 고르세요.
                              </span>
                            </div>
                          )}
                          {settings.chat.permissionMode === "bypassPermissions" && (
                            <div className="notice notice--warn" aria-live="polite">
                              <span className="notice__text">
                                `바로 진행`은 확인 카드 없이 진행합니다. 자리를 비운 사이에도 화면
                                파일이 바뀔 수 있으니, 물어볼 필요가 있으면 확인 방식을 `실행 전에
                                물어보기`로 바꾸세요.
                              </span>
                            </div>
                          )}
                          {/* 턴 도중 보내기: 도는 턴에 온 말의 길. 기본은
                대기 줄 — 이 도구의 오래된 약속이다. 바로 실어 보내기는
                codex 의 turn/steer 로 도는 턴에 그대로 실리고, 와이어가 없는
                에이전트는 도는 턴을 끊고 그 말로 새 턴을 즉시 열어 같은
                '바로'를 이행하므로, 선택지는 프로바이더와 무관하게 늘 둘 다
                보인다. */}
                          <Choice<"queue" | "steer">
                            label="턴 도중 보내기"
                            value={settings.chat.midturn}
                            options={[
                              {
                                value: "queue",
                                label: "대기 줄",
                                hint: "AI가 답을 끝낸 뒤, 다음 턴으로 나갑니다",
                              },
                              {
                                value: "steer",
                                label: "바로 실어 보내기",
                                hint: "도는 턴에 바로 반영합니다 — Codex는 도는 턴에 그대로 실리고, 그 외 에이전트(Claude·OMP)는 도는 턴을 끊고 이 말로 새 턴을 즉시 시작합니다",
                              },
                            ]}
                            onChange={(midturn) => onChatChange({ midturn })}
                          />
                          {/* 대화에 남길 기록 두 스위치: "고급" 접기로 숨기지 않고
                평지에 둔다 — 접어 두면 있는 줄 모르고 지나치기 쉽다.
                기본은 여전히 꺼짐이라 평지에 있어도 어지럽히지 않고, 행의
                말과 동작은 접던 때와 같다. */}
                          {/* 작업 과정 보기: 기본은 꺼짐이다 — 생각 과정과 같은 이유다.
                사용자가 읽어야 하는 것은 답이고, 도구 호출 묶음이 답과 답
                사이마다 끼면 대화가 기계의 작업 기록처럼 읽힌다. 읽고 싶은
                사람에게는 여기서 돌려준다. 계획 카드와 캡처 카드는 이
                스위치와 무관하게 언제나 자리를 지킨다. */}
                          <Switch
                            label="작업 과정 보기"
                            hint="AI가 화면을 만들며 거친 작업 — 파일 작업과 검사 — 를 대화에 접힌 채로 남깁니다"
                            checked={settings.chat.showTools}
                            onChange={(showTools) => onChatChange({ showTools })}
                          />
                          {/* 생각 과정 보기: 기본은 꺼짐이다. 사용자가 읽어야 하는 것은
                답이고, 답을 만드는 동안의 속말이 답과 답 사이마다 끼면
                대화가 기계의 기록처럼 읽힌다. 읽고 싶은 사람에게는 여기서
                돌려준다 — 켜면 접힌 채로 다시 자리를 잡는다. */}
                          <Switch
                            label="생각 과정 보기"
                            hint="AI가 답을 만들며 한 생각을 대화에 접힌 채로 남깁니다"
                            checked={settings.chat.showThinking}
                            onChange={(showThinking) => onChatChange({ showThinking })}
                          />
                        </>
                      )}

                      {category.id === "behavior" && (
                        <>
                          <Choice<SendKey>
                            label="보내기 키"
                            value={settings.sendKey}
                            options={(["enter", "modEnter"] as SendKey[]).map((key) => ({
                              value: key,
                              label: SEND_SHORT[key],
                              hint: SEND_LABEL[key],
                            }))}
                            onChange={(sendKey) => onChange({ sendKey })}
                          />
                          {/* 데스크톱에서만 뜻이 있는 스위치 — plain 브라우저에는
                    미리보기 칸이 없으니 행 자체를 숨긴다. */}
                          {window.coloDesignDesktop?.preview?.native && (
                            <Switch
                              label="앱에서 링크 열기"
                              hint="대화·카드의 링크가 미리보기 칸에서 열립니다. 끄면 기본 브라우저가 엽니다"
                              checked={settings.openLinksInApp}
                              onChange={(openLinksInApp) => onChange({ openLinksInApp })}
                            />
                          )}
                        </>
                      )}

                      {/* 알림: 시점 3상태와 소리, 그리고 시험 한 장.
                확인 요청·중단·게이트 실패는 시점과 무관하게 언제나 온다는
                것을 힌트가 한 줄로 말한다. */}
                      {category.id === "notice" && (
                        <>
                          <Choice<NoticeTiming>
                            label="완료 알림"
                            value={settings.notifications.done}
                            options={[
                              {
                                value: "off",
                                label: NOTICE_DONE_LABEL.off,
                                hint: "완료 알림은 받지 않습니다",
                              },
                              {
                                value: "long",
                                label: NOTICE_DONE_LABEL.long,
                                hint: "1분 넘게 걸린 작업이 끝났을 때만 알립니다",
                              },
                              {
                                value: "all",
                                label: NOTICE_DONE_LABEL.all,
                                hint: "모든 작업이 끝날 때마다 알립니다",
                              },
                            ]}
                            onChange={(done) =>
                              onChange({ notifications: { ...settings.notifications, done } })
                            }
                          />
                          <Switch
                            label="알림 소리"
                            hint="알림이 도착할 때 소리를 냅니다"
                            checked={settings.notifications.sound}
                            onChange={(sound) =>
                              onChange({ notifications: { ...settings.notifications, sound } })
                            }
                          />
                          {/* 시험 결과는 정책 힌트를 덮지 않는다 — 힌트는 그 자리에
                    남기고, 결과는 버튼 아래의 한 줄이 말한다. */}
                          <Field
                            wide
                            label="테스트"
                            hint="확인 요청·중단은 이 설정과 관계없이 언제나 옵니다. 알림 허용 여부는 OS 가 앱마다 한 번만 묻습니다 — 한 번 거절된 뒤에는 OS 설정에서만 켤 수 있습니다."
                          >
                            <span className="settings__stack">
                              <span className="settings__row">
                                <button type="button" onClick={() => void sendTestNotice()}>
                                  테스트 알림 보내기
                                </button>
                                {bridgeOpenNotificationSettings && (
                                  <button
                                    type="button"
                                    onClick={() => void bridgeOpenNotificationSettings()}
                                  >
                                    시스템 알림 설정 열기
                                  </button>
                                )}
                              </span>
                              {noticeTest && (
                                <p className="settings__statusline" aria-live="polite">
                                  {noticeTest}
                                </p>
                              )}
                            </span>
                          </Field>
                          {/* 슬라이스 5: 개발자 에스컬레이션 — AI 도 고칠 수 없는
                              실패가 나면 슬랙으로. 토큰 만료 알림이 온보딩의
                              GitHub 게이트보다 먼저 도착하는 팀의 안내망이다. */}
                          <Field
                            wide
                            label="개발자 알림 (Slack)"
                            hint="토큰 만료 · 넘기기 실패처럼 AI 도 고칠 수 없는 문제가 생기면 슬랙으로 알립니다. 웹훅 주소 또는 봇 토큰+채널로 연결합니다."
                          >
                            <EscalationForm daemon={daemon} disabled={!connected} />
                          </Field>
                        </>
                      )}

                      {category.id === "connection" &&
                        (daemon.onboarding?.find((step) => step.id === "github")?.status ===
                          "pass" && !editingToken ? (
                          <Field
                            wide
                            label="GitHub 계정"
                            hint="토큰은 이 컴퓨터에만 저장되고 다시 보여지지 않습니다"
                          >
                            <span className="settings__url">
                              <span className="settings__account">
                                {daemon.onboarding?.find((step) => step.id === "github")?.detail}
                              </span>
                              <button
                                type="button"
                                className="primary"
                                disabled={!connected}
                                onClick={() => setEditingToken(true)}
                              >
                                토큰 바꾸기
                              </button>
                            </span>
                          </Field>
                        ) : (
                          <GitHubTokenForm
                            daemon={daemon}
                            onDone={() => setEditingToken(false)}
                            disabled={!connected}
                          />
                        ))}

                      {/* Everything a planner only ever needs when something is broken.
                It used to sit open under the heading 데몬, which is
                a word for the program, not for the problem. */}
                      {category.id === "troubleshoot" && (
                        <>
                          {/* 버튼 수프를 라벨 있는 행으로 — 한 flex 행에 섞여 있던
                    세 가지 일(처음 설정·저장 위치·업데이트)이 각자 자기
                    이름 아래에 선다. */}
                          <Row
                            label="처음 설정"
                            hint="연결·설치 검사를 처음 화면부터 다시 돌립니다"
                          >
                            <button type="button" onClick={onOpenOnboarding}>
                              처음 설정 다시 보기
                            </button>
                          </Row>
                          <Row
                            label="저장 위치"
                            hint={
                              bridgeOpenHome
                                ? "클론과 설정이 있는 곳입니다. 여기 파일을 직접 고치지 마세요 — 화면은 대화로, 저장은 버튼으로."
                                : "~/.colo-design — 클론과 설정이 있는 곳입니다. 여기 파일을 직접 고치지 마세요."
                            }
                          >
                            {typeof bridgeOpenHome === "function" && (
                              <>
                                <button type="button" onClick={() => void bridgeOpenHome()}>
                                  폴더 열기
                                </button>
                                <button type="button" onClick={() => void bridgeOpenHome("logs")}>
                                  로그 폴더 열기
                                </button>
                              </>
                            )}
                          </Row>
                          {desktop && (
                            <Row label="업데이트" hint="앱의 새 버전이 나왔는지 확인합니다">
                              <button
                                type="button"
                                disabled={checkingUpdate}
                                onClick={() => void checkUpdate()}
                              >
                                {checkingUpdate ? "확인 중…" : "업데이트 확인"}
                              </button>
                              {update?.updateAvailable &&
                                update.url &&
                                update.sha256 &&
                                (canSelfUpdate ? (
                                  <button
                                    type="button"
                                    disabled={installingUpdate}
                                    onClick={() => void installUpdate()}
                                  >
                                    {installingUpdate
                                      ? "준비 중…"
                                      : updatePrepared
                                        ? "지금 재시작"
                                        : "업데이트 설치"}
                                  </button>
                                ) : (
                                  <a
                                    className="setting__hint"
                                    href={`https://github.com/${RELEASES_REPO}/releases/latest`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    릴리스 페이지에서 설치 파일 내려받기
                                  </a>
                                ))}
                            </Row>
                          )}
                          {(update || updateStarted || updateDeferred || updateError) && (
                            <p className="settings__statusline" aria-live="polite">
                              {updateError ??
                                updateDeferred ??
                                updateStarted ??
                                (update &&
                                  (update.updateAvailable
                                    ? `새 버전 ${update.version}${update.notes ? ` — ${update.notes}` : ""}`
                                    : `최신 버전입니다 (${update.version})`))}
                            </p>
                          )}

                          <details className="settings__fold">
                            <summary>고급 · 연결 정보</summary>
                            <Field
                              wide
                              label="접속 주소"
                              hint={`연결 상태: ${connection}. 앱을 다시 열면 이 주소가 채워집니다.`}
                            >
                              <span className="settings__url">
                                <input
                                  value={url}
                                  spellCheck={false}
                                  placeholder="ws://127.0.0.1:7823?token=…"
                                  aria-label="접속 주소"
                                  onChange={(e) => setUrl(e.target.value)}
                                  onKeyDown={(e) =>
                                    e.key === "Enter" && urlChanged && onReconnect(url.trim())
                                  }
                                />
                                <button
                                  type="button"
                                  className="primary"
                                  disabled={!urlChanged}
                                  onClick={() => onReconnect(url.trim())}
                                >
                                  다시 연결
                                </button>
                              </span>
                            </Field>

                            {status && (
                              <dl className="settings__facts">
                                <div>
                                  <dt>운영체제</dt>
                                  <dd>{status.platform}</dd>
                                </div>
                                <div>
                                  <dt>Claude Code</dt>
                                  <dd>{status.claudeVersion ?? "찾지 못함"}</dd>
                                </div>
                                <div>
                                  <dt>로그인</dt>
                                  <dd>
                                    {status.loggedIn
                                      ? [status.email, status.subscriptionType ?? status.authMethod]
                                          .filter(Boolean)
                                          .join(" · ") || "로그인됨"
                                      : "로그인 안 됨"}
                                  </dd>
                                </div>
                                <div>
                                  <dt>pnpm</dt>
                                  <dd>{status.pnpmAvailable ? "사용 가능" : "없음"}</dd>
                                </div>
                                <div>
                                  <dt>실행 중인 기획</dt>
                                  <dd>{status.liveSessions}</dd>
                                </div>
                                <div>
                                  <dt>프로토콜</dt>
                                  <dd>v{status.protocolVersion}</dd>
                                </div>
                              </dl>
                            )}

                            <div className="settings__row">
                              <button
                                type="button"
                                className="danger"
                                onClick={() => setForgetConfirm(true)}
                              >
                                접속 주소 지우기
                              </button>
                              <span className="setting__hint">
                                연결 화면으로 돌아갑니다. 기획은 삭제되지 않습니다.
                              </span>
                            </div>
                          </details>
                        </>
                      )}
                    </section>
                  )}
                </section>
              );
            })}
          </div>
          {/* 저장 위치의 한 줄 — 눈이 머무는 바닥에서 값이 가는 곳을 말한다. */}
          <p className="settings__foot">바꾼 값은 이 기기에 저장됩니다.</p>
        </div>
      </div>
      {forgetConfirm && (
        <ConfirmDialog
          title="접속 주소 지우기"
          body={<>저장된 접속 주소를 지울까요?</>}
          hint="이 컴퓨터의 기획은 그대로 남지만, 앱이 만든 접속 주소를 다시 붙여 넣어야 합니다."
          confirmLabel="지우기"
          onConfirm={() => {
            setForgetConfirm(false);
            onForgetUrl();
          }}
          onClose={() => setForgetConfirm(false)}
        />
      )}
    </div>
  );
}
