import type { CSSProperties, ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import type { Daemon } from "../../lib/daemon-client";
import { CheckIcon, CloseIcon, FolderIcon, KeyIcon, SparkIcon, WarnIcon } from "../icons";
import { GitHubTokenForm } from "./GitHubTokenForm";
import { RepoPicker } from "./RepoPicker";

type GateStatus = "pass" | "warn" | "fail" | "todo";

/** 초대 파일(`*.colo-invite`) 한 장의 내용 — 비밀(token)은 화면에 다시 그리지
 *  않는다. readme 는 개발자가 파일에 적어 둔 말로, 가져오기 확인 카드에 그대로
 *  보인다(전달 경로·삭제 안내가 본체다). */
interface InviteFile {
  fileName: string;
  v: number;
  name: string;
  repoUrl: string;
  baseBranch?: string;
  token: string;
  approveCommands: boolean;
  /** E4(초대 v2): 이 작업에 적을 이름 — 넘긴 요청의 `> 작성:` 줄이 쓴다. */
  authorName?: string;
  /** E4(초대 v2): 넘긴 요청의 리뷰를 부탁할 개발자들(GitHub 로그인). */
  reviewers?: string[];
  readme?: string;
}

/** 파일 내용 → 초대장, 또는 사람이 읽는 오류 한 줄. v 는 1·2 를 안다 — 2 는
 * 이름(authorName)과 리뷰어(reviewers)를 더 실은 판이다. 그보다 높으면 이
 * 앱이 모르는 미래 포맷이므로 거절이 정직한 답이다. */
function parseInvite(fileName: string, raw: string): InviteFile | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "초대 파일을 읽지 못했습니다 — 개발자에게 파일을 다시 보내달라고 요청하세요.";
  }
  const file = parsed as Partial<InviteFile> & { v?: unknown };
  if (file.v !== 1 && file.v !== 2) {
    return "지원하지 않는 초대 파일입니다 — 앱을 최신 버전으로 업데이트했는지 확인해 주세요.";
  }
  if (typeof file.repoUrl !== "string" || !file.repoUrl.trim()) {
    return "초대 파일에 레포 주소가 없습니다 — 개발자에게 다시 만들어 달라고 요청하세요.";
  }
  if (typeof file.token !== "string" || !file.token.trim()) {
    return "초대 파일에 연결 코드가 없습니다 — 개발자에게 다시 만들어 달라고 요청하세요.";
  }
  const reviewers =
    Array.isArray(file.reviewers) && file.v === 2
      ? file.reviewers.filter(
          (login): login is string => typeof login === "string" && login.trim() !== "",
        )
      : undefined;
  return {
    fileName,
    v: file.v,
    name: typeof file.name === "string" && file.name.trim() ? file.name.trim() : file.repoUrl,
    repoUrl: file.repoUrl.trim(),
    ...(typeof file.baseBranch === "string" && file.baseBranch.trim()
      ? { baseBranch: file.baseBranch.trim() }
      : {}),
    token: file.token.trim(),
    approveCommands: file.approveCommands !== false,
    ...(file.v === 2 && typeof file.authorName === "string" && file.authorName.trim()
      ? { authorName: file.authorName.trim() }
      : {}),
    ...(reviewers && reviewers.length > 0 ? { reviewers } : {}),
    ...(typeof file.readme === "string" && file.readme.trim() ? { readme: file.readme } : {}),
  };
}

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
export function StartFlow({ daemon }: { daemon: Daemon }) {
  const githubStep = daemon.onboarding?.find((step) => step.id === "github");
  const hasToken = githubStep?.status === "pass";
  /** 통과한 토큰을 다시 여는 길 — 만료가 이유다(Onboarding 의 editingToken). */
  const [editingToken, setEditingToken] = useState(false);
  /** 선택한 레포의 검사 답 — 레포 단계의 주의 배지와 테두리의 근거. */
  const [repoNotice, setRepoNotice] = useState<{
    hasDevScript: boolean;
    canPush: boolean;
  } | null>(null);
  /**
   * 초대 파일 가져오기 (P1-5 단계 A): 파일 → 확인 카드 → (코드 저장 + 프로젝트
   * 만들기). 레포 피커는 예비 경로로 남는다 — 초대장 없이 시작하는 사람의 길.
   */
  const [invite, setInvite] = useState<
    | { phase: "confirm"; file: InviteFile }
    | { phase: "applying"; file: InviteFile }
    | { phase: "error"; file: InviteFile | null; error: string }
    | null
  >(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const readInviteFile = async (file: File) => {
    if (!file.name.endsWith(".colo-invite")) {
      setInvite({
        phase: "error",
        file: null,
        error: "초대 파일(.colo-invite)이 아닙니다 — 개발자가 보낸 파일을 선택해 주세요.",
      });
      return;
    }
    const parsed = parseInvite(file.name, await file.text());
    if (typeof parsed === "string") setInvite({ phase: "error", file: null, error: parsed });
    else setInvite({ phase: "confirm", file: parsed });
  };

  // 확인 카드의 연결: 코드를 먼저 저장해 게이트가 통과해야 프로젝트가 만들어진다.
  // 실패는 이 카드 안에서 말한다 — 화면이 작업대로 바뀌는 것은 성공의 표식뿐이다.
  const applyInvite = async (file: InviteFile) => {
    setInvite({ phase: "applying", file });
    try {
      const step = await daemon.api.githubTokenSet(file.token);
      if (step.status !== "pass") {
        setInvite({ phase: "error", file, error: step.detail });
        return;
      }
      await daemon.api.projectCreate({
        name: file.name,
        repoUrl: file.repoUrl,
        ...(file.baseBranch ? { baseBranch: file.baseBranch } : {}),
        // 초대장의 실행 허용은 개발자의 서명이다 — 피커의 체크칸을 대신한다.
        ...(file.approveCommands ? { approveCommands: true } : {}),
        ...(file.reviewers ? { reviewers: file.reviewers } : {}),
      });
      // E4(초대 v2): 초대장이 이름을 실어 왔으면 그것으로 적는다 — 마법사의
      // 이름 칸을 대신한다(비어 있으면 칸이 그 자리를 지킨다).
      if (file.authorName) await daemon.api.machineAuthorSet(file.authorName);
      // 성공하면 Shell 이 작업대로 바꿔 낀다 — 이 카드는 다시 그려질 일이 없다.
    } catch (e) {
      setInvite({
        phase: "error",
        file,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };
  /**
   * 이 작업에 적을 이름(P1-3) — 넘긴 요청의 `> 작성:` 줄과 커밋 이름이 된다.
   * 마법사의 마지막 줄: 게이트가 아니다(안 적어도 갈 수 있다).
   */
  const savedAuthor = daemon.status?.authorName ?? null;
  const [authorDraft, setAuthorDraft] = useState(savedAuthor ?? "");
  const [authorBusy, setAuthorBusy] = useState(false);
  // 데몬이 알려온 이름이 바뀌면 초안도 따른다 — 저장 성공의 반영이 이 길로 온다.
  useEffect(() => setAuthorDraft(savedAuthor ?? ""), [savedAuthor]);
  const authorDirty = authorDraft.trim() !== (savedAuthor ?? "");
  const saveAuthor = async () => {
    setAuthorBusy(true);
    try {
      await daemon.api.machineAuthorSet(authorDraft.trim() === "" ? null : authorDraft.trim());
      await daemon.api.refreshStatus();
    } catch {
      // 실패해도 초안은 살아 있다(dirty 그대로) — 다시 누를 수 있다.
    } finally {
      setAuthorBusy(false);
    }
  };

  const tokenStatus: Exclude<GateStatus, "todo"> =
    githubStep?.status === "pass" ? "pass" : githubStep?.status === "fail" ? "fail" : "warn";
  const tokenOpen = tokenStatus !== "pass" || editingToken;
  const repoWarn = repoNotice !== null && (!repoNotice.hasDevScript || !repoNotice.canPush);

  return (
    <div
      className={`onboarding onboarding--start${dragOver ? " onboarding--drop" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) void readInviteFile(file);
      }}
    >
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

      {/* 초대 파일 가져오기(P1-5) — 확인 카드가 살아 있는 동안 이것이 곧 화면이다.
          연결 코드와 레포 선택을 한 장이 대신한다. */}
      {invite && (
        <div className="onboarding__invite" data-testid="invite-card">
          {invite.phase === "error" ? (
            <>
              <div className="notice notice--error">
                <span className="notice__text">{invite.error}</span>
              </div>
              <div className="onboarding__fixrow">
                <button type="button" className="ghost" onClick={() => setInvite(null)}>
                  닫기
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => fileInputRef.current?.click()}
                >
                  다른 파일 열기
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="onboarding__detail">
                초대 파일을 읽었습니다 — <strong>{invite.file.name}</strong> ({invite.file.repoUrl})
                프로젝트를 만들고 연결 코드를 저장합니다.
              </p>
              {invite.file.readme && <p className="hint">{invite.file.readme}</p>}
              {invite.file.approveCommands && (
                <p className="hint">
                  이 레포의 설치 · 미리보기 명령 실행을 개발자가 미리 허용했습니다.
                </p>
              )}
              <div className="onboarding__fixrow">
                <button
                  type="button"
                  className="primary"
                  disabled={invite.phase === "applying"}
                  onClick={() => void applyInvite(invite.file)}
                >
                  {invite.phase === "applying" ? "연결하는 중…" : "초대 받기"}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={invite.phase === "applying"}
                  onClick={() => setInvite(null)}
                >
                  취소
                </button>
              </div>
              <p className="hint">
                연결이 끝나면 받은 파일을 지워 주세요 — 파일 안에는 당신의 연결 코드가 들어
                있습니다.
              </p>
            </>
          )}
        </div>
      )}
      {dragOver && (
        <div className="onboarding__dropveil" aria-hidden="true">
          초대 파일을 여기에 놓으세요
        </div>
      )}

      <div className="onboarding__meter" aria-hidden="true">
        {/* 통과한 준비의 실측 — ①코드 ②레포 검사. 만들기가 답하는 순간은
            화면이 작업대로 바뀌는 찰라라 3/3 을 이 미터가 그릴 일은 없다. */}
        <span
          className="onboarding__meterfill"
          style={{
            width: `${((tokenStatus === "pass" ? 1 : 0) + (repoNotice !== null ? 1 : 0)) * (100 / 3)}%`,
          }}
        />
      </div>

      <ol className="onboarding__steps">
        {/* ① 연결 코드 — github 게이트가 상태다. 게이트가 아직 답하기 전에는
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
            <h2>연결 코드</h2>
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
                  : "개발자에게 받은 연결 코드를 붙여넣으면, 그 코드로 쓸 수 있는 레포 목록이 열려요. 코드가 없으면 개발자에게 “콜로 연결 코드 하나 만들어줘”라고 부탁하면 됩니다."}
              </p>
              {/* 초대 파일(P1-5): 개발자가 파일을 줬다면 이것이 첫 길이다 —
                  코드와 레포를 한 장이 대신한다. 붙여넣기는 예비 길로 남는다. */}
              <div className="onboarding__fixrow">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => fileInputRef.current?.click()}
                >
                  개발자가 준 초대 파일 열기
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".colo-invite,application/json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void readInviteFile(file);
                  }}
                />
              </div>
              <GitHubTokenForm daemon={daemon} onDone={() => setEditingToken(false)} />
              <p className="hint">
                코드는 이 컴퓨터의 자격 증명 저장소에만 저장돼요 — 앱 화면을 여는 다른
                연결값(페어링)과는 별개예요.
              </p>
            </>
          ) : (
            <>
              <p className="onboarding__detail">
                {githubStep?.detail ?? "연결 코드가 이 컴퓨터의 자격 증명 저장소에 저장돼 있어요"}
              </p>
              <div className="onboarding__fixrow">
                <button type="button" className="ghost" onClick={() => setEditingToken(true)}>
                  코드 바꾸기
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
                코드로 쓸 수 있는 레포를 찾았어요. 어느 레포인지 모르겠으면 개발자에게 레포 이름을
                물어보세요.
              </p>
              <RepoPicker daemon={daemon} onInspection={setRepoNotice} />
            </>
          ) : (
            <p className="onboarding__detail">코드를 연결하면 목록이 열려요.</p>
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

      {/* 이 작업에 적을 이름(P1-3) — 마법사의 마지막 줄. 게이트가 아니라
          선택: 요청이 봇 계정으로 열리므로 개발자는 이 이름으로 누구 작업인지
          읽는다. 안 적으면 도구 이름(Colo Design)으로 넘어간다. */}
      <div className="onboarding__author">
        <label className="onboarding__authorlabel" htmlFor="author-name">
          이 작업에 적을 이름
        </label>
        <input
          id="author-name"
          value={authorDraft}
          placeholder="예: 김기획"
          maxLength={80}
          disabled={authorBusy}
          onChange={(e) => setAuthorDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && authorDirty && !authorBusy) void saveAuthor();
          }}
        />
        <button
          type="button"
          className="ghost"
          disabled={!authorDirty || authorBusy}
          onClick={() => void saveAuthor()}
        >
          {authorBusy ? "저장하는 중…" : "이름 저장"}
        </button>
      </div>
      <p className="hint onboarding__authorhint">
        개발자에게 넘기는 요청에 함께 적히는 이름입니다 — 다른 사람들과 작업을 구분하는 데 쓰여요.
        적지 않아도 시작할 수 있습니다.
      </p>
    </div>
  );
}
