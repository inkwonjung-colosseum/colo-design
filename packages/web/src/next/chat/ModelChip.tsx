import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ChipTarget, Sessions } from "../../hooks/useSessions";
import { modelName, modelOptions, modelRowOf } from "../../lib/chat-options";
import type { Daemon } from "../../lib/daemon-client";
import { L } from "../labels";
import { chipLabel, EFFORT_OF, type EffortWord, effortWord } from "../lib/thread";
import {
  refillWhen,
  USAGE_HOT_MIN,
  USAGE_WORD_MIN,
  usageHeat,
  usageReading,
  usageRowName,
  usageRows,
} from "../lib/usage";
import { Popover } from "../ui/Popover";
import { CheckIcon, ChevIcon, LockIcon, ProviderMark } from "./icons";

/** 이 개수부터는 모델 줄을 눈으로 걷지 않고 거르는 편이 빠르다. */
const MODEL_FILTER_MIN = 8;

/** AI 고르는 줄의 화살표 키 — 한 칸씩 가는 방향. Home · End 는 양 끝으로 간다. */
const AI_KEY_STEP: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * 입력창의 설정 칩 `Opus 5.5 · 보통 ▾` 과 그 팝오버(목업 `modelPop`) —
 * 칩은 모델과 생각 시간을 말한다(모델 목록이 오지 않았을 때만 프로바이더가 앞말).
 * 팝오버는 AI · 모델 · 생각 시간 · 사용량. 읽고 쓰는 주인은 `target` 이
 * 정한다(PLAN-MODEL-CHIP D1·D2): `next` 는 AI 고르는 줄이 서고(팝은 닫지 않고
 * 모델 목록이 바뀌는 것을 보여 준다), `session` 은 누르지 않는 AI 한 줄만 선다.
 * 부르는 길은 `target.pickProvider` · `setModel` · `setEffort`.
 * 한도가 가까우면(P6, 70% 넘음) 칩 옆에 사용량 한 단어가 선다 — 가장 찬 창의
 * 것. 팝의 사용량 칸은 창을 모두 한 줄씩 세운다(5시간 · 이번 주 · 모델별 창).
 */
export function ModelChip({
  daemon,
  sessions,
  target,
  disabledProviders = [],
  up = true,
}: {
  daemon: Daemon;
  /** 사용량 다시 읽기(`refreshUsage`)만 쓴다 — 칩의 값은 target 이 쥔다. */
  sessions: Pick<Sessions, "refreshUsage">;
  target: ChipTarget;
  disabledProviders?: string[];
  /**
   * 여는 방향 — 입력창이 화면 바닥에 붙는 대화 칸은 위로, 홈처럼 화면 가운데
   * 있는 입력창은 아래로. 위로만 열면 홈에서 팝의 머리가 창 밖으로 나간다.
   */
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  // AI 를 바꿀 때마다 오르는 셈 — 모델 목록의 열쇠라, 목록이 새로 서며 내려앉는다.
  // 팝을 열 때는 0 이라 처음 여는 목록은 움직이지 않는다.
  const [aiSwap, setAiSwap] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null);
  const aiRadios = useRef<Array<HTMLButtonElement | null>>([]);
  const close = () => {
    setOpen(false);
    setModelQuery("");
    setAiSwap(0);
  };
  const providers = (daemon.status?.providers ?? []).filter(
    (p) => !disabledProviders.includes(p.id),
  );
  const usable = providers.filter((p) => p.available && p.loggedIn !== false);
  const provider = target.provider;
  const providerLabel = providers.find((p) => p.id === provider)?.label ?? L.model.ai;
  // 고르는 AI 줄에서 알약이 앉을 칸 — 고른 AI 가 목록에 없으면 -1(알약이 없다).
  const pickedAt = usable.findIndex((p) => p.id === provider);
  const chooseProvider = (id: string) => {
    // 팝은 닫지 않는다 — 거르는 칸만 비우고 바로 아래 모델 칸이
    // 새 AI 의 목록으로 바뀌는 것을 보인 채 이어서 고르게 한다.
    // 「AI 를 바꿨는데 모델이 안 바뀐다」가 이 결함의 증상이었다.
    if (id !== provider) setAiSwap((n) => n + 1);
    target.pickProvider?.(id);
    setModelQuery("");
  };
  // 라디오 묶음의 화살표 — 고른 자리가 곧 초점이다(초점은 고른 칸에만 서는 로빙 탭 순서).
  const stepProvider = (from: number, event: KeyboardEvent<HTMLButtonElement>) => {
    const size = usable.length;
    const step = AI_KEY_STEP[event.key];
    const to =
      step !== undefined
        ? (from + step + size) % size
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? size - 1
            : -1;
    const next = usable[to];
    if (!next) return;
    event.preventDefault();
    chooseProvider(next.id);
    aiRadios.current[to]?.focus();
    // 모델이 많은 AI 로 돌아오면 거르는 칸이 새로 서며 autoFocus 로 초점을 가져간다 —
    // 화살표로 훑는 손이 끊기지 않게 그린 뒤 고른 칸으로 되돌려 놓는다.
    requestAnimationFrame(() => aiRadios.current[to]?.focus());
  };
  const modelRow = modelRowOf(target.models, target.model);
  const models = modelOptions(target.models, modelRow);
  const needle = modelQuery.trim().toLowerCase();
  const visibleModels =
    needle === ""
      ? models
      : models.filter((row) => `${row.label} ${row.hint ?? ""}`.toLowerCase().includes(needle));
  // 다섯 칸을 모두 내놓는다. CLI 가 알려 준 지원 목록(supportedEffortLevels)으로
  // 거르면 낡거나 좁은 목록이 실제 단계(xhigh · max)를 가려 두세 개만 남는 수가
  // 있다 — 생각 시간 자체가 없는 모델(supportsEffort === false)만 칸을 통째로 숨긴다.
  const efforts = Object.keys(EFFORT_OF) as EffortWord[];
  const showEffort = modelRow?.supportsEffort !== false;
  const think = effortWord(target.effort);
  const label = chipLabel(
    modelName(target.models, target.model) ?? providerLabel,
    showEffort ? EFFORT_OF[think] : null,
  );
  const plan = daemon.status?.planUsageByProvider?.[provider];
  const reading = usageReading(plan);
  const usage = usageRows(plan);
  // 팝이 열려 있는 동안 그 AI 계정의 한도를 한 번 다시 읽는다 — 팝 안에서 AI 를
  // 바꾸면 바뀐 계정을. 한도는 대화가 아니라 계정의 것이라, 다른 곳(터미널 ·
  // 웹)에서 쓴 만큼도 여기서 따라온다. 답은 status 방송으로 돌아온다.
  const { api } = daemon;
  useEffect(() => {
    if (open) void api.planRefresh(provider).catch(() => undefined);
  }, [open, provider, api]);
  const now = new Date();

  return (
    <div className="nx-anchor nx-model">
      {reading && reading.pct >= USAGE_WORD_MIN && (
        <span
          className={`nx-usage-word${reading.pct >= USAGE_HOT_MIN ? " nx-usage-word--hot" : ""}`}
        >
          {L.chat.usageWord(reading.pct)}
        </span>
      )}
      <button
        ref={anchor}
        type="button"
        className="nx-tbtn nx-tbtn--model"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) close();
          else setOpen(true);
          if (!open) sessions.refreshUsage();
        }}
      >
        <ProviderMark provider={provider} />
        <span className="nx-model-label">{label}</span>
        <ChevIcon />
      </button>
      {open && (
        <Popover anchor={anchor} onClose={close} align="end" up={up} className="nx-model-pop">
          {usable.length >= 2 &&
            (target.pickProvider ? (
              <>
                <div className="nx-mh">{L.model.ai}</div>
                {/* 생각 시간 칸과 같은 말(틀 위에 올라앉은 알약) — 고른 AI 로 알약이
                    옮겨 앉고 그 AI 의 표식만 제 색을 입는다. 화살표 키는 고른 자리가
                    곧 초점이라 라디오 묶음의 로빙 탭 순서를 따른다. */}
                <div
                  className="nx-aipick"
                  role="radiogroup"
                  aria-label={L.model.ai}
                  data-none={pickedAt < 0 ? "" : undefined}
                  style={{ "--n": usable.length, "--i": Math.max(0, pickedAt) } as CSSProperties}
                >
                  {usable.map((p, index) => {
                    const on = provider === p.id;
                    return (
                      // biome-ignore lint/a11y/useSemanticElements: 알약 전체가 누르는 과녁이다 — 동그라미 입력칸 없이 radio 로 읽힌다(radiogroup 안).
                      <button
                        key={p.id}
                        ref={(el) => {
                          aiRadios.current[index] = el;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        tabIndex={on || (pickedAt < 0 && index === 0) ? 0 : -1}
                        className={`nx-aiopt${on ? " nx-aiopt--on" : ""}`}
                        onClick={() => chooseProvider(p.id)}
                        onKeyDown={(event) => stepProvider(index, event)}
                      >
                        <ProviderMark provider={p.id} />
                        <span className="nx-ainame">{p.label}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="nx-mnote">{L.model.aiNext}</div>
                <div className="nx-msep" />
              </>
            ) : (
              <>
                <div className="nx-mh">{L.model.ai}</div>
                {/* 열린 대화의 AI 는 태어날 때 정해진다 — 고르는 줄이 아니라 같은 틀에
                    이름 하나와 자물쇠만 서고, 안내가 그 밑에서 말한다(D1). */}
                <div className="nx-aipick nx-aipick--fixed">
                  <span className="nx-aiopt nx-aiopt--on">
                    <ProviderMark provider={provider} />
                    <span className="nx-ainame">{providerLabel}</span>
                    <LockIcon />
                  </span>
                </div>
                <div className="nx-mnote">{L.model.aiFixed}</div>
                <div className="nx-msep" />
              </>
            ))}
          {models.length > 0 && (
            <>
              <div className="nx-mh">{L.model.model}</div>
              {models.length > MODEL_FILTER_MIN && (
                <input
                  className="nx-mfilter"
                  type="text"
                  value={modelQuery}
                  // biome-ignore lint/a11y/noAutofocus: 팝이 열리면 거르는 칸부터 — 많은 모델을 걷지 않으려는 길이다.
                  autoFocus
                  placeholder={L.model.filterPlaceholder}
                  aria-label={L.model.filter}
                  onChange={(event) => setModelQuery(event.target.value)}
                />
              )}
              {/* AI 를 바꾸면 목록이 새로 서며 내려앉는다 — 어디가 바뀌었는지 눈이 따라간다. */}
              <div key={aiSwap} className={aiSwap > 0 ? "nx-mlist nx-mlist--swap" : "nx-mlist"}>
                {visibleModels.map((row) => (
                  <button
                    key={row.value ?? row.label}
                    type="button"
                    className="nx-mi"
                    onClick={() => {
                      void target.setModel(row.value);
                      close();
                    }}
                  >
                    <span className="nx-mt">
                      <b>{row.label}</b>
                      {row.hint && <small>{row.hint}</small>}
                    </span>
                    {row.picked && (
                      <span className="nx-ck nx-r">
                        <CheckIcon />
                      </span>
                    )}
                  </button>
                ))}
                {visibleModels.length === 0 && <div className="nx-mempty">{L.model.noMatch}</div>}
              </div>
              {modelRow?.supportsFastMode === false && (
                // 번개 칩이 없는 이유를 팝이 대신 대답한다 — 모델이 조용히
                // 가려진 것을 빠르게의 부재로 오해하는 일이 없게.
                <div className="nx-mnote">{L.model.fastMissing}</div>
              )}
            </>
          )}
          {showEffort && (
            <>
              {models.length > 0 && <div className="nx-msep" />}
              <div className="nx-mh">{L.model.think}</div>
              {/* biome-ignore lint/a11y/useSemanticElements: 세 단추의 한 줄(세그먼트) — fieldset 의 테두리 · legend 틀이 필요 없는 자리라 group 으로 읽힌다. */}
              <div
                className="nx-mseg"
                role="group"
                aria-label={L.model.think}
                style={{ "--n": efforts.length, "--i": efforts.indexOf(think) } as CSSProperties}
              >
                {efforts.map((word) => (
                  <button
                    key={word}
                    type="button"
                    aria-pressed={think === word}
                    className={think === word ? "nx-on" : ""}
                    onClick={() => void target.setEffort(EFFORT_OF[word])}
                  >
                    {EFFORT_OF[word]}
                  </button>
                ))}
              </div>
            </>
          )}
          {usage.length > 0 && (
            <>
              <div className="nx-msep" />
              <div className="nx-mh">{L.model.usage}</div>
              <div className="nx-usage">
                {usage.map((row) => {
                  const name = usageRowName(row, L);
                  const heat = usageHeat(row.pct);
                  const when = row.resetsAt ? refillWhen(row.resetsAt, now, L) : null;
                  return (
                    <div key={name} className={`nx-usage-row nx-usage-row--${heat}`}>
                      <div className="nx-usage-row-head">
                        <span className="nx-usage-row-name">{name}</span>
                        <span className="nx-usage-row-pct">{L.chat.usageUsed(row.pct)}</span>
                      </div>
                      {/* 쓴 비율은 위의 글이 말한다 — 막대는 눈으로 가늠하는 자리다. */}
                      <div className="nx-meter" aria-hidden="true">
                        <i style={{ width: `${row.pct}%` }} />
                      </div>
                      {when && <div className="nx-usage-row-when">{L.chat.usageRefill(when)}</div>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Popover>
      )}
    </div>
  );
}
