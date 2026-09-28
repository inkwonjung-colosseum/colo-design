/**
 * 재생 벤치(PLAN-HARNESS §3.A)의 순수 함수 — 시나리오 읽기 · 핀 턴 만들기 ·
 * 통계 행 모으기 · 끝 판정 · 판정 · 요약 · 비교. 네트워크와 git 은 bench.mjs 가
 * 갖고, 이 파일은 검증하기 쉽도록 부작용을 파일 읽기(loadScenarios ·
 * collectRows) 정도로만 둔다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { markTurn } from "../../packages/protocol/dist/index.js";

const TURN_STATS_PREFIX = "turn-stats-";

// ---------------------------------------------------------------------------
// 시나리오 — JSON 파일 하나가 시나리오의 배열이다.
//
//   { "id": "search", "kind": "user", "text": "…",
//     "expect": { "files": ["server.js"], "contains": ["…"] } }
//   { "id": "pin-title", "kind": "pin", "note": "제목을 더 크게 해 줘",
//     "pins": [{ "screen": "list", "text": "회원 목록" }],
//     "expect": { "files": ["server.js"] } }
//
// `expect.files` 의 각 항목은 바뀐 파일 경로의 부분 문자열, `expect.contains` 의
// 각 항목은 바뀐 파일 어느 하나의 지금 내용에 들어 있어야 하는 문자열이다.
// ---------------------------------------------------------------------------

/** 시나리오 하나를 검사한다 — 문제가 있으면 Error, 없으면 조용히 돌아온다. */
function validateScenario(item, index) {
  const where = `시나리오 ${index + 1}번`;
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`${where} — 시나리오는 객체여야 합니다.`);
  }
  const id = item.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(`${where} — id 가 비어 있습니다.`);
  }
  const at = `${where}(${id})`;
  if (item.kind === "user") {
    if (typeof item.text !== "string" || item.text.trim() === "") {
      throw new Error(`${at} — user 시나리오에 text 가 없습니다.`);
    }
  } else if (item.kind === "pin") {
    if (typeof item.note !== "string" || item.note.trim() === "") {
      throw new Error(`${at} — pin 시나리오에 note(메모)가 없습니다.`);
    }
    if (!Array.isArray(item.pins) || item.pins.length === 0) {
      throw new Error(`${at} — pin 시나리오에 pins 목록이 없습니다.`);
    }
    for (const [i, pin] of item.pins.entries()) {
      if (typeof pin?.screen !== "string" || pin.screen.trim() === "") {
        throw new Error(`${at} — pins[${i}] 의 screen 이 없습니다.`);
      }
      if (typeof pin?.text !== "string" || pin.text.trim() === "") {
        throw new Error(`${at} — pins[${i}] 의 text 가 없습니다 — 벤치의 핀은 글자 핀입니다.`);
      }
    }
  } else {
    throw new Error(
      `${at} — kind 는 "user" 또는 "pin" 이어야 합니다(${JSON.stringify(item.kind)}).`,
    );
  }
  const expect = item.expect;
  if (expect === null || typeof expect !== "object" || Array.isArray(expect)) {
    throw new Error(`${at} — expect 가 없습니다.`);
  }
  if (
    !Array.isArray(expect.files) ||
    expect.files.length === 0 ||
    expect.files.some((f) => typeof f !== "string" || f === "")
  ) {
    throw new Error(`${at} — expect.files 는 비어 있지 않은 경로 조각 목록이어야 합니다.`);
  }
  if (
    expect.contains !== undefined &&
    (!Array.isArray(expect.contains) || expect.contains.some((s) => typeof s !== "string"))
  ) {
    throw new Error(`${at} — expect.contains 는 문자열 목록이어야 합니다.`);
  }
}

/** 시나리오 배열을 검사한다 — id 중복과 각 항목의 모양. */
export function validateScenarios(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("시나리오 파일은 비어 있지 않은 배열이어야 합니다.");
  }
  const seen = new Set();
  for (const [i, item] of list.entries()) {
    validateScenario(item, i);
    if (seen.has(item.id)) {
      throw new Error(`시나리오 id "${item.id}" 가 겹칩니다.`);
    }
    seen.add(item.id);
  }
  return list;
}

/** 시나리오 파일을 읽고 검사한다. */
export function loadScenarios(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`시나리오 파일을 읽지 못했습니다 — ${file}: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`시나리오 파일이 JSON 이 아닙니다 — ${file}: ${error.message}`);
  }
  return validateScenarios(data);
}

// ---------------------------------------------------------------------------
// 핀 턴 — packages/web/src/lib/preview-turns.ts 의 pinsToTurn 을 따르되,
// 벤치가 아는 줄만 싣는다(문장 · 안내 한 줄 · `1. <글자> — "<글자>"` · 메모 한
// 줄). 마커의 items[].id 는 session.send 의 pinHints[].id 와 같은 값이다.
// ---------------------------------------------------------------------------

/** 마커의 items 와 pinHints 가 함께 쓰는 핀 id — 시나리오 id + 순번. */
export function pinIds(scenario) {
  return (scenario.pins ?? []).map((_, i) => `${scenario.id}-${i + 1}`);
}

/** session.send 의 pinHints — id 가 턴 마커의 items[].id 에 닿아야 한다. */
export function pinHints(scenario) {
  return (scenario.pins ?? []).map((pin, i) => ({
    id: pinIds(scenario)[i],
    text: pin.text,
    screen: pin.screen,
  }));
}

/** session.send 의 pins — 이 턴이 가리킨 화면(게이트가 다시 열 대상). */
export function pinsOf(scenario) {
  return (scenario.pins ?? []).map((pin) => ({ screen: pin.screen }));
}

/**
 * 핀 시나리오가 에이전트에게 실어 보낼 턴 본문(마커 포함 한 줄 머리).
 * 문장과 메모는 같은 말이다 — 실제 입력창에서 담기(↵)가 메모를 문장 칸에
 * 옮기는 흐름이 그대로이기 때문이다.
 */
export function pinTurnText(scenario) {
  const sentence = scenario.note.trim();
  const pins = scenario.pins;
  const spread = new Set(pins.map((pin) => pin.screen)).size > 1;
  const ids = pinIds(scenario);
  const marker = {
    kind: "comments",
    screen: spread ? `화면 ${new Set(pins.map((pin) => pin.screen)).size}곳` : pins[0].screen,
    ...(sentence ? { note: sentence } : {}),
    items: pins.map((pin, i) => ({
      id: ids[i],
      label: pin.text,
      comment: sentence,
      ...(spread ? { screen: pin.screen } : {}),
    })),
  };
  const blocks = pins
    .map((pin, i) => {
      const rows = [`${i + 1}. ${pin.text} — "${pin.text}"${spread ? ` · ${pin.screen}` : ""}`];
      if (sentence) rows.push(`   ${sentence}`);
      return rows.join("\n");
    })
    .join("\n\n");
  const lines = [
    ...(sentence ? [sentence, ""] : []),
    "아래는 사용자가 가리킨 자리입니다 — 사용자의 말대로 해 주세요.",
    "",
    blocks,
  ];
  return markTurn(marker, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// 통계 행 모으기 — turn-stats-<UTC 날짜>.jsonl 의 한 줄이 한 행이다.
// ---------------------------------------------------------------------------

/** 오늘과 어제(UTC)의 turn-stats 파일 경로 — 자정 무렵 걸린 턴을 덮는다. */
export function statsFiles(logDir, now = new Date()) {
  const day = (d) => `${TURN_STATS_PREFIX}${d.toISOString().slice(0, 10)}.jsonl`;
  return [join(logDir, day(now)), join(logDir, day(new Date(now.getTime() - 86_400_000)))];
}

/** 주어진 파일들에서 이 세션의 행만 — 깨진 줄과 다른 세션은 무시한다. */
export function collectRows(files, sessionId) {
  const rows = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // 그 날의 파일이 아직 없을 수 있다.
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue; // 쓰다 만 줄이나 깨진 줄은 행이 아니다.
      }
      if (row === null || typeof row !== "object" || row.sessionId !== sessionId) continue;
      rows.push(row);
    }
  }
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return rows;
}

// ---------------------------------------------------------------------------
// 끝 판정 — 시나리오가 한 턴의 자식이다. 턴 행 하나 이상이 있고 그 뒤에
// gateset 행이 있으면 끝난 것이다. gateset 이 reopened: true 면 게이트의 고침
// 턴이 하나 더 도니 턴 행 하나를 더 기다린다(게이트는 두 번 서지 않는다).
// ---------------------------------------------------------------------------

/**
 * rows 는 이 세션의 행(at 순). { done, waiting } — waiting 은 지금 기다리는
 * 것의 이름("turn" | "gateset" | "reopen-turn")이다.
 */
export function turnProgress(rows) {
  const turns = rows.filter((row) => row.kind !== "gateset");
  if (turns.length === 0) return { done: false, waiting: "turn" };
  const gates = rows.filter((row) => row.kind === "gateset");
  const lastTurn = turns[turns.length - 1];
  // 오류 · 중지로 끝난 턴은 자동 보관이 서지 않으므로 gateset 행도 오지 않는다
  // (server.ts 의 autoSaveDue 조건) — 그 턴으로 끝난 것이다. 판정은 judge 가
  // 마지막 턴의 isError 로 실패시킨다.
  if (
    (lastTurn.isError === true || lastTurn.subtype === "interrupted") &&
    !gates.some((row) => row.at > lastTurn.at)
  ) {
    return { done: true };
  }
  if (gates.length === 0) return { done: false, waiting: "gateset" };
  const lastGate = gates[gates.length - 1];
  if (lastGate.reopened === true) {
    const reopened = turns.filter((row) => row.at > lastGate.at).length;
    return reopened >= 1 ? { done: true } : { done: false, waiting: "reopen-turn" };
  }
  return { done: true };
}

// ---------------------------------------------------------------------------
// 판정 — 시나리오의 expect 와 실제로 바뀐 것을 대조한다.
// ---------------------------------------------------------------------------

/**
 * contents 는 바뀐 파일 경로 → 지금 내용의 Map(읽지 못한 파일은 빼둔다).
 * lastTurn 은 마지막 턴 행(없을 수 있다). 참이 되어야 할 세 가지:
 *   expect.files 의 각 조각이 바뀐 파일 중 하나의 경로에 들어 있다
 *   expect.contains 의 각 문자열이 바뀐 파일 중 하나의 내용에 있다
 *   마지막 턴 행의 isError 가 false
 */
export function judge(scenario, changed, contents, lastTurn) {
  const reasons = [];
  const expect = scenario.expect ?? {};
  const changedList = changed ?? [];
  for (const file of expect.files ?? []) {
    if (!changedList.some((path) => path.includes(file))) {
      reasons.push(`바뀐 파일에 ${file} 이 없습니다`);
    }
  }
  for (const needle of expect.contains ?? []) {
    const hit = changedList.some((path) => (contents.get(path) ?? "").includes(needle));
    if (!hit) reasons.push(`바뀐 파일 어디에도 "${needle}" 문장이 없습니다`);
  }
  if (!lastTurn) {
    reasons.push("끝난 턴이 없습니다");
  } else if (lastTurn.isError) {
    reasons.push(`마지막 턴이 오류로 끝났습니다(${lastTurn.failure ?? "other"})`);
  }
  return { pass: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// 요약과 비교 — 표의 한 줄 / 두 결과 파일의 같은 id 끼리.
// ---------------------------------------------------------------------------

/** 결과 파일의 시나리오 항목 하나 → 표 한 줄의 칸. */
export function summaryOf(entry) {
  const turns = entry.turns ?? [];
  const sum = (key) => turns.reduce((acc, turn) => acc + (turn.tools?.[key] ?? 0), 0);
  const browserMs = turns.every((turn) => turn.browserMs === null || turn.browserMs === undefined)
    ? null
    : turns.reduce((acc, turn) => acc + (turn.browserMs ?? 0), 0);
  return {
    id: entry.id,
    pass: entry.pass === true,
    ms: turns.reduce((acc, turn) => acc + (turn.durationMs ?? 0), 0),
    firstEditMs: turns[0]?.firstEditMs ?? null,
    contextTokens: turns.every(
      (turn) => turn.contextTokens === null || turn.contextTokens === undefined,
    )
      ? null
      : Math.max(...turns.map((turn) => turn.contextTokens ?? 0)),
    browser: sum("browser"),
    browserMs,
    exec: sum("exec"),
    reopened: entry.gate?.reopened === true,
  };
}

/** 중앙값 — 짝수면 가운데 둘의 평균. 빈 목록은 null. */
export function median(values) {
  const nums = values
    .filter((v) => typeof v === "number" && !Number.isNaN(v))
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * 두 결과 파일(a = 기준, b = 비교)의 같은 id 끼리 칸을 맞춘다 — `--repeat` 으로
 * 같은 id 가 여러 행 있을 수 있으니 각 쪽의 중앙값으로 접는다. 한쪽에만 있는
 * id 도 행으로 남기고, 비는 칸은 null 로 둔다.
 */
export function compareResults(a, b) {
  const ids = new Set([...(a.scenarios ?? []), ...(b.scenarios ?? [])].map((s) => s.id));
  const rows = [];
  for (const id of ids) {
    const left = (a.scenarios ?? []).filter((s) => s.id === id).map(summaryOf);
    const right = (b.scenarios ?? []).filter((s) => s.id === id).map(summaryOf);
    const metric = (key) => ({
      a: left.length === 0 ? null : median(left.map((r) => r[key])),
      b: right.length === 0 ? null : median(right.map((r) => r[key])),
    });
    const ms = metric("ms");
    rows.push({
      id,
      passA: left.filter((r) => r.pass).length,
      passB: right.filter((r) => r.pass).length,
      countA: left.length,
      countB: right.length,
      ms,
      firstEditMs: metric("firstEditMs"),
      contextTokens: metric("contextTokens"),
      browser: metric("browser"),
      browserMs: metric("browserMs"),
      exec: metric("exec"),
      // 변화율 — a 가 0 이거나 어느 쪽이 비면 null.
      msChange: ms.a === null || ms.b === null || ms.a === 0 ? null : (ms.b - ms.a) / ms.a,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 표 — 고정 폭 텍스트. 열의 값은 ms 를 초로 환산하고, 없으면 "-".
// ---------------------------------------------------------------------------

const padEnd = (text, width) => String(text).padEnd(width);
const padStart = (text, width) => String(text).padStart(width);
const seconds = (ms) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : "-");
const num = (value) => (value === null || value === undefined ? "-" : String(value));
const percent = (ratio) =>
  ratio === null ? "-" : `${ratio > 0 ? "+" : ""}${(ratio * 100).toFixed(0)}%`;

/** run 결과 표 — 시나리오 한 줄. */
export function renderSummaryTable(entries) {
  const rows = entries.map(summaryOf);
  const head = [
    padEnd("시나리오", 16),
    padStart("통과", 5),
    padStart("총 시간", 9),
    padStart("첫 편집", 9),
    padStart("컨텍스트", 10),
    padStart("browser", 8),
    padStart("browserMs", 10),
    padStart("exec", 6),
    padStart("게이트 재개", 11),
  ].join(" ");
  const line = (row) =>
    [
      padEnd(row.id.slice(0, 16), 16),
      padStart(row.pass ? "통과" : "실패", 5),
      padStart(seconds(row.ms), 9),
      padStart(seconds(row.firstEditMs), 9),
      padStart(num(row.contextTokens), 10),
      padStart(String(row.browser), 8),
      padStart(seconds(row.browserMs), 10),
      padStart(String(row.exec), 6),
      padStart(row.reopened ? "있음" : "-", 11),
    ].join(" ");
  return [head, head.replace(/[^ ]/g, "-"), ...rows.map(line)].join("\n");
}

/** compare 결과 표 — 같은 id 끼리 중앙값과 총 시간 변화율. */
export function renderCompareTable(rows, nameA = "a", nameB = "b") {
  const pair = (m) => `${seconds(m.a)} → ${seconds(m.b)}`;
  const head = [
    padEnd("시나리오", 16),
    padStart(`통과 ${nameA}→${nameB}`, 12),
    padStart("총 시간", 20),
    padStart("Δ", 7),
    padStart("첫 편집", 20),
    padStart("컨텍스트", 16),
    padStart("exec", 12),
  ].join(" ");
  const line = (row) =>
    [
      padEnd(row.id.slice(0, 16), 16),
      padStart(`${row.passA}/${row.countA} → ${row.passB}/${row.countB}`, 12),
      padStart(pair(row.ms), 20),
      padStart(percent(row.msChange), 7),
      padStart(pair(row.firstEditMs), 20),
      padStart(`${num(row.contextTokens.a)} → ${num(row.contextTokens.b)}`, 16),
      padStart(`${num(row.exec.a)} → ${num(row.exec.b)}`, 12),
    ].join(" ");
  return [head, head.replace(/[^ ]/g, "-"), ...rows.map(line)].join("\n");
}
