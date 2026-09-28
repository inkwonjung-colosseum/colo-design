import { useRef, useState } from "react";
import type { ChipTarget, Sessions } from "../../hooks/useSessions";
import { modelOptions, modelRowOf } from "../../lib/chat-options";
import type { Daemon } from "../../lib/daemon-client";
import { L } from "../labels";
import {
  chipLabel,
  EFFORT_OF,
  type EffortWord,
  effortWord,
  USAGE_WORD_MIN,
  type UsageReading,
  usageReading,
} from "../lib/thread";
import { Popover } from "../ui/Popover";
import { CheckIcon, ChevIcon } from "./icons";

const EFFORT_WORDS: Record<EffortWord, string> = {
  short: L.model.thinkShort,
  normal: L.model.thinkNormal,
  long: L.model.thinkLong,
  longer: L.model.thinkLonger,
  max: L.model.thinkMax,
};

/** 이 개수부터는 모델 줄을 눈으로 걷지 않고 거르는 편이 빠르다. */
const MODEL_FILTER_MIN = 8;

function windowName(reading: UsageReading): string {
  if (reading.window.kind === "fiveHour") return L.chat.usageFiveHour;
  if (reading.window.kind === "sevenDay") return L.chat.usageWeek;
  return reading.window.label;
}

function clock(at: string): string {
  return new Date(at).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * 입력창의 설정 칩 `Opus 5.5 · 보통 ▾` 과 그 팝오버(목업 `modelPop`) —
 * 칩은 모델과 생각 시간을 말한다(모델 목록이 오지 않았을 때만 프로바이더가 앞말).
 * 팝오버는 AI · 모델 · 생각 시간 · 사용량. 읽고 쓰는 주인은 `target` 이
 * 정한다(PLAN-MODEL-CHIP D1·D2): `next` 는 AI 고르는 줄이 서고(팝은 닫지 않고
 * 모델 목록이 바뀌는 것을 보여 준다), `session` 은 누르지 않는 AI 한 줄만 선다.
 * 부르는 길은 `target.pickProvider` · `setModel` · `setEffort`.
 * 한도가 가까우면(P6, 70% 넘음) 칩 옆에 사용량 한 단어가 선다.
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
  const anchor = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setModelQuery("");
  };
  const providers = (daemon.status?.providers ?? []).filter(
    (p) => !disabledProviders.includes(p.id),
  );
  const usable = providers.filter((p) => p.available && p.loggedIn !== false);
  const provider = target.provider;
  const providerLabel = providers.find((p) => p.id === provider)?.label ?? L.model.ai;
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
    modelRow?.displayName ?? providerLabel,
    showEffort ? EFFORT_WORDS[think] : null,
  );
  const reading = usageReading(daemon.status?.planUsageByProvider?.[provider]);

  return (
    <div className="nx-anchor nx-model">
      {reading && reading.pct >= USAGE_WORD_MIN && (
        <span className={`nx-usage-word${reading.pct >= 90 ? " nx-usage-word--hot" : ""}`}>
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
        <span className="nx-model-label">{label}</span>
        <ChevIcon />
      </button>
      {open && (
        <Popover anchor={anchor} onClose={close} align="end" up={up} className="nx-model-pop">
          {usable.length >= 2 &&
            (target.pickProvider ? (
              <>
                <div className="nx-mh">{L.model.ai}</div>
                {usable.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="nx-mi"
                    onClick={() => {
                      // 팝은 닫지 않는다 — 거르는 칸만 비우고 바로 아래 모델 칸이
                      // 새 AI 의 목록으로 바뀌는 것을 보인 채 이어서 고르게 한다.
                      // 「AI 를 바꿨는데 모델이 안 바뀐다」가 이 결함의 증상이었다.
                      target.pickProvider?.(p.id);
                      setModelQuery("");
                    }}
                  >
                    <span className="nx-mt">
                      <b>{p.label}</b>
                      <small>{L.model.loggedIn}</small>
                    </span>
                    {provider === p.id && (
                      <span className="nx-ck nx-r">
                        <CheckIcon />
                      </span>
                    )}
                  </button>
                ))}
                <div className="nx-mnote">{L.model.aiNext}</div>
                <div className="nx-msep" />
              </>
            ) : (
              <>
                <div className="nx-mh">{L.model.ai}</div>
                {/* 열린 대화의 AI 는 태어날 때 정해진다 — 고르는 줄이 아니라
                    이름과 안내만 한 줄 선다(D1). */}
                <div className="nx-mi nx-mi--static">
                  <span className="nx-mt">
                    <b>{providerLabel}</b>
                    <small>{L.model.aiFixed}</small>
                  </span>
                </div>
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
              <div className="nx-mlist">
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
              <div className="nx-mseg" role="group" aria-label={L.model.think}>
                {efforts.map((word) => (
                  <button
                    key={word}
                    type="button"
                    aria-pressed={think === word}
                    className={think === word ? "nx-on" : ""}
                    onClick={() => void target.setEffort(EFFORT_OF[word])}
                  >
                    {EFFORT_WORDS[word]}
                  </button>
                ))}
              </div>
            </>
          )}
          {reading && (
            <>
              <div className="nx-msep" />
              <div className="nx-usage">
                <div className="nx-mh">{L.model.usage}</div>
                <div className="nx-bar">
                  <i style={{ width: `${reading.pct}%` }} />
                </div>
                <div>
                  {L.chat.usageLine(windowName(reading), reading.pct)}
                  {reading.resetsAt && ` · ${L.chat.usageRefill(clock(reading.resetsAt))}`}
                </div>
              </div>
            </>
          )}
        </Popover>
      )}
    </div>
  );
}
