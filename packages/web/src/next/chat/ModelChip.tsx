import { useRef, useState } from "react";
import type { Sessions } from "../../hooks/useSessions";
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
 * 입력창의 설정 칩 `Claude · 보통 ▾` 과 그 팝오버(목업 `modelPop`) —
 * 프로바이더(쓸 수 있는 것이 둘 이상일 때만) · 모델 · 생각 시간 · 사용량. 부르는
 * 길은 옛 입력창과 같다: `sessions.pickProvider` · `setModel` · `setEffort`.
 * 한도가 가까우면(P6, 70% 넘음) 칩 옆에 사용량 한 단어가 선다.
 */
export function ModelChip({
  daemon,
  sessions,
  disabledProviders = [],
}: {
  daemon: Daemon;
  sessions: Sessions;
  disabledProviders?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    setModelQuery("");
  };
  const { selector } = sessions;
  const providers = (daemon.status?.providers ?? []).filter(
    (p) => !disabledProviders.includes(p.id),
  );
  const usable = providers.filter((p) => p.available && p.loggedIn !== false);
  const provider = selector.provider ?? sessions.chatProvider;
  const providerLabel = providers.find((p) => p.id === provider)?.label ?? L.model.ai;
  const modelRow = modelRowOf(selector.models, selector.model);
  const models = modelOptions(selector.models, modelRow);
  const needle = modelQuery.trim().toLowerCase();
  const visibleModels =
    needle === ""
      ? models
      : models.filter((row) => `${row.label} ${row.hint ?? ""}`.toLowerCase().includes(needle));
  const levels = modelRow?.supportedEffortLevels ?? null;
  const efforts = (Object.keys(EFFORT_OF) as EffortWord[]).filter(
    (word) => levels === null || levels.includes(EFFORT_OF[word]),
  );
  const showEffort = modelRow?.supportsEffort !== false && efforts.length > 0;
  const think = effortWord(selector.effort);
  const label = chipLabel(providerLabel, showEffort ? EFFORT_WORDS[think] : null);
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
        <Popover anchor={anchor} onClose={close} align="end" up className="nx-model-pop">
          {usable.length >= 2 && (
            <>
              <div className="nx-mh">{L.model.ai}</div>
              {usable.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="nx-mi"
                  onClick={() => {
                    sessions.pickProvider(p.id);
                    if (sessions.activeId === null) close();
                  }}
                >
                  <span className="nx-mt">
                    <b>{p.label}</b>
                    <small>{L.model.loggedIn}</small>
                  </span>
                  {sessions.chatProvider === p.id && (
                    <span className="nx-ck nx-r">
                      <CheckIcon />
                    </span>
                  )}
                </button>
              ))}
              {sessions.activeId !== null && <div className="nx-mnote">{L.model.openConvNote}</div>}
              <div className="nx-msep" />
            </>
          )}
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
              {visibleModels.map((row) => (
                <button
                  key={row.value ?? row.label}
                  type="button"
                  className="nx-mi"
                  onClick={() => {
                    void sessions.setModel(row.value);
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
                    onClick={() => void sessions.setEffort(EFFORT_OF[word])}
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
