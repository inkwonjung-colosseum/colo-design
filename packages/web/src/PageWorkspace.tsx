import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ConfluenceReview,
  DocSummary,
  DrafthouseScreen,
  HandoffStatus,
  SessionSummary,
  Workspace,
} from "@drafthouse/protocol";
import { markTurn } from "@drafthouse/protocol";
import type { Daemon } from "./daemon-client";
import { useSessions, type Sessions } from "./useSessions";
import { ChatColumn } from "./ChatColumn";
import { SessionTabs } from "./SessionTabs";
import { PageTree } from "./PageTree";
import { ScreenPanel } from "./ScreenPanel";
import { DocEditor, type DocQuote } from "./DocEditor";
import { PublishDialog } from "./PublishDialog";
import { StageBar, type StageMenuItem } from "./StageBar";
import { deriveStage, type StageAction } from "./stage";
import type { Attachment } from "./Composer";
import type { ChatSettings, Settings } from "./settings";

/**
 * The whole workspace, on the page axis (PLAN D1).
 *
 * There used to be a 기획 tab and a 디자인 tab, and the split was really the
 * daemon's two cwds leaking into the UI. What a planner actually works on is
 * one 기획서 at a time: write it, build the screen it specifies, look at the
 * screen, go around again. So the tree picks a page, and everything else —
 * which threads exist, which document is open, which screen is framed — is
 * that page's.
 *
 * The two halves survive underneath, because they must: 기획 writes the
 * mirror, 화면 writes the repo clone, and the daemon stores their transcripts
 * separately. Two `Sessions` objects live side by side here and the tab strip
 * shows their union; picking a tab is what decides which one the chat column
 * is currently rendering.
 */
export function PageWorkspace({
  daemon,
  settings,
  onChatChange,
  onOpenSettings,
  onOpenOnboarding,
}: {
  daemon: Daemon;
  settings: Settings;
  /** 설정 owns how Claude answers; both halves start their threads on it. */
  onChatChange: (patch: Partial<ChatSettings>) => void;
  onOpenSettings: () => void;
  /** Opens the first-run wizard — the only place a project gets created. */
  onOpenOnboarding: () => void;
}) {
  const { api } = daemon;
  const mirrored = daemon.confluenceStatuses.length > 0;

  const [docPath, setDocPath] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [docDirty, setDocDirty] = useState(false);
  const [quote, setQuote] = useState<DocQuote | null>(null);
  const [treeKey, setTreeKey] = useState(0);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [pushing, setPushing] = useState(false);
  const [notice, setNotice] = useState<{ level: "info" | "error"; text: string } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [review, setReview] = useState<ConfluenceReview | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  /** Which side of the page the planner is looking at: the 기획서 or the screen. */
  const [segment, setSegment] = useState<"doc" | "screen" | "both">("doc");
  /**
   * What the connected repo declared it can render (PLAN D7). It arrives from
   * the preview app itself, so it is empty until the 화면 segment has been
   * mounted once — the tree's stage marks say 기획 중 until then rather than
   * guessing.
   */
  const [screens, setScreens] = useState<DrafthouseScreen[]>([]);
  const [active, setActive] = useState<{ workspace: Workspace; sessionId: string } | null>(null);
  /** The two dialogs of the cycle. The stepper opens them; ScreenPanel draws them. */
  const [saveOpen, setSaveOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  /**
   * The handed-off state as last read on demand. Nothing polls it — a timer
   * would ask GitHub every minute about something that only moves when a
   * developer acts — so pressing 상태 다시 확인 is the planner's refresh.
   */
  const [readHandoff, setReadHandoff] = useState<HandoffStatus | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  /**
   * Whether there is room to put the 기획서 and its screen side by side. Below
   * this the two columns are each too narrow to read, so the option is not
   * offered rather than offered and disappointing.
   */
  const [wideEnough, setWideEnough] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 1440,
  );
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1440px)");
    const onChange = () => setWideEnough(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  // A window that narrows while 나란히 is open falls back to the document,
  // rather than leaving a segment selected that no longer has a button.
  useEffect(() => {
    if (!wideEnough) setSegment((current) => (current === "both" ? "doc" : current));
  }, [wideEnough]);

  const planning = useSessions(daemon, "planning", {
    ready: mirrored,
    confirmBeforeDelete: settings.confirmBeforeDelete,
    pageId,
    chat: settings.chat,
    onChatChange,
  });
  const design = useSessions(daemon, "design", {
    ready: daemon.repo?.phase === "ready",
    confirmBeforeDelete: settings.confirmBeforeDelete,
    pageId,
    chat: settings.chat,
    onChatChange,
  });

  // A finished pull rewrites files without a doc.changed for each one, so the
  // tree also refreshes whenever a space leaves its working phase.
  const syncPhases = daemon.confluenceStatuses.map((s) => `${s.space}:${s.phase}`).join(",");
  useEffect(() => {
    setTreeKey((key) => key + 1);
  }, [daemon.docChanged, syncPhases, quote === null]);

  const spaces = useMemo(
    () => daemon.confluenceStatuses.map((status) => status.space),
    [daemon.confluenceStatuses],
  );

  /**
   * Which space 게시 would push: the open page's own, or the only mirrored one
   * when there is no ambiguity. With several spaces and nothing open, the
   * planner has to say which by opening a page.
   */
  const space = useMemo(() => {
    const fromDoc = docPath?.split("/")[0];
    if (fromDoc && spaces.includes(fromDoc)) return fromDoc;
    return spaces.length === 1 ? (spaces[0] ?? null) : null;
  }, [docPath, spaces]);

  // What 게시 would actually send: locally edited pages plus 기획서 that have
  // never existed in Confluence.
  useEffect(() => {
    if (!space) {
      setDocs([]);
      return;
    }
    let cancelled = false;
    void api
      .docList(space)
      .then((pages) => !cancelled && setDocs(pages))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, space, treeKey]);

  const pendingPages = docs.filter((page) => page.modified || page.isNew);

  /**
   * The tree hands back a path; the threads are keyed by the page's own id,
   * which survives a rename. A page the daemon has not listed yet leaves the
   * id null — its threads simply are not known yet, and the next listing
   * settles it.
   */
  useEffect(() => {
    setActive(null);
    setPageId(docPath ? (docs.find((page) => page.path === docPath)?.pageId ?? null) : null);
  }, [docPath, docs]);

  // A brief names one 기획서, so it cannot outlive the page it was made on.
  // Keyed on the path alone: `docs` re-lists on every tree refresh and would
  // otherwise throw the chip away while the planner was still typing under it.
  useEffect(() => {
    setBrief(null);
  }, [docPath]);

  /**
   * 게시 opens the review dialog first: a push writes to Confluence, so the
   * planner sees WHAT would go up before consenting. The dialog itself never
   * pushes — `push()` stays the one writer, with its conflict handling.
   */
  const openReview = async () => {
    if (!space) return;
    setReviewError(null);
    setReview(null);
    setReviewOpen(true);
    try {
      setReview(await api.confluenceReview(space));
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : String(e));
    }
  };

  const push = async () => {
    if (!space) return;
    setPushing(true);
    setNotice(null);
    try {
      const status = await api.confluencePush(space);
      if (status.conflicts.length > 0) {
        const [first] = status.conflicts;
        // The editor owns conflict resolution (DESIGN §4.2), so 게시 opens the
        // conflicting page and lets its own 충돌 chooser settle it.
        const conflicted = first ? docs.find((page) => page.pageId === first.pageId) : undefined;
        if (conflicted) {
          setDocPath(conflicted.path);
          setSegment("doc");
        }
        setNotice({
          level: "error",
          text:
            status.detail ??
            `충돌 ${status.conflicts.length}건 — 문서를 열어 어느 쪽을 남길지 골라 주세요.`,
        });
      } else {
        setNotice({ level: "info", text: status.detail ?? "Confluence에 반영했습니다." });
      }
    } catch (e) {
      setNotice({ level: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setPushing(false);
      setReviewOpen(false);
      setTreeKey((key) => key + 1);
    }
  };

  const sessionsOf = (workspace: Workspace): Sessions =>
    workspace === "planning" ? planning : design;
  const activeSessions = active ? sessionsOf(active.workspace) : null;

  const openTab = (workspace: Workspace, session: SessionSummary) => {
    setActive({ workspace, sessionId: session.sessionId });
    // 화면 threads are about what renders; showing the preview beside them is
    // what makes the tab worth picking.
    setSegment(workspace === "design" ? "screen" : "doc");
    void sessionsOf(workspace).open(session);
  };

  /**
   * Starting a thread on this page. `create()` attaches it to `pageId`, so it
   * lands in this page's strip and nobody else's.
   *
   * Selecting it here is not cosmetic: the composer, its placeholder and the
   * handoff draft all follow the ACTIVE tab, so a 화면 thread created while
   * 기획 stayed selected would put a screen brief into the conversation that
   * writes the mirror. The hook's own `activeId` cannot be read back the
   * instant after the await, which is why `create()` hands the id over.
   */
  const createTab = async (workspace: Workspace, title?: string) => {
    const sessionId = await sessionsOf(workspace).create(title);
    if (sessionId) setActive({ workspace, sessionId });
    setSegment(workspace === "design" ? "screen" : "doc");
  };

  // The hook owns which thread is open in its half; the strip's highlight
  // follows it so a thread the hook created, resumed or discarded is the one
  // shown as selected.
  useEffect(() => {
    if (!active) return;
    const current = active.workspace === "planning" ? planning.activeId : design.activeId;
    if (current && current !== active.sessionId) {
      setActive({ workspace: active.workspace, sessionId: current });
    }
  }, [active, planning.activeId, design.activeId]);

  useEffect(() => {
    if (active) return;
    if (planning.activeId) setActive({ workspace: "planning", sessionId: planning.activeId });
    else if (design.activeId) setActive({ workspace: "design", sessionId: design.activeId });
  }, [active, planning.activeId, design.activeId]);

  /**
   * The planning composer waits on the autosave: a turn sent while the editor
   * still holds unsaved text would have Claude read the older file.
   */
  const submit = async (text: string, attachments: Attachment[]) => {
    if (!activeSessions) return;
    if (active?.workspace === "planning" && docDirty) {
      planning.setError("문서에 저장되지 않은 변경이 있습니다 — 잠시 기다려 주세요.");
      return;
    }
    const quoted = quote
      ? [
          `> 인용: ${quote.title}${quote.heading ? ` · ${quote.heading}` : ""}`,
          ...quote.text.split("\n").map((line) => `> ${line}`),
          "",
          text,
        ].join("\n")
      : text;
    /**
     * The 기획서 a handoff opened on rides as a chip, not as text in the box
     * (PLAN D9): the mirror path is how Claude finds the file and is not a
     * thing a planner should have to read, let alone edit around. It is
     * attached here, at the one place that already composes the wire text.
     */
    const composed = brief
      ? markTurn({ kind: "brief", title: brief.title }, `@confluence/${brief.path} ${quoted}`)
      : quoted;
    setBrief(null);
    await activeSessions.submit(composed, attachments);
  };

  /**
   * 이 문서로 화면 만들기: the page becomes the brief of a NEW 화면 thread on
   * the same page, and the right column flips to the screen. Nothing is sent —
   * the planner reads the brief and presses send themselves.
   *
   * What they read is a sentence and a chip naming the 기획서; `submit` turns
   * that back into the `@confluence/…` reference Claude needs.
   */
  const [draft, setDraft] = useState<{ text: string; nonce: number } | null>(null);
  const [brief, setBrief] = useState<{ title: string; path: string } | null>(null);
  const handoffToScreen = () => {
    if (!docPath) return;
    const title = docs.find((page) => page.path === docPath)?.title ?? docPath;
    setBrief({ title, path: docPath });
    setDraft({ text: "이 기획서로 화면을 만들어 주세요.", nonce: Date.now() });
    // The brief is this app's sentence, not the planner's, so the thread is
    // named here. Letting the first turn name it puts a mirror path in the
    // tab strip - the one place the planner navigates by reading.
    void createTab("design", title);
  };

  /**
   * Comment pins from the preview land in this page's 화면 thread, started on
   * the spot if the page has none: a planner marking up a screen should not
   * have to open a conversation first.
   */
  const forwardComments = useCallback(
    async (turn: string) => {
      // A thread the tool opens is named by the tool (the M5 lesson): the first
      // turn here is a bundle of pins this app composed, and letting it name
      // the tab writes machine text into the strip the planner navigates by.
      if (!design.activeId) {
        await design.create(docs.find((page) => page.path === docPath)?.title);
      }
      await design.sendTurn(turn);
    },
    [design, docs, docPath],
  );

  /**
   * Which 기획서 a screen was built from, resolved against this project's own
   * page list. The repo names a mirror-relative path and never a Confluence
   * id — see `DrafthouseScreen.spec` — so the lookup lives here, where the
   * pages are.
   */
  const pageIdOf = useCallback(
    (specPath: string) => docs.find((page) => page.path === specPath)?.pageId ?? null,
    [docs],
  );

  /**
   * 넘기기 전 점검: the one judgement the tool refuses to make itself.
   *
   * Whether a screen covers what its 기획서 asked for means reading the
   * 기획서, and how a 기획서 is written is the connected repo's decision, not
   * ours (`drafthouse.json#planning.rules`). So this asks the 화면 thread,
   * naming the screens the repo declared and the states they implement, and
   * leaves the verdict in the chat where the planner can argue with it.
   */
  const precheck = useCallback(() => {
    if (!docPath) return;
    const mine = screens.filter((screen) => screen.spec === docPath);
    const listed = mine
      .map((screen) => `- ${screen.title} (${screen.route}) — 상태: ${screen.states.join(", ")}`)
      .join("\n");
    const title = docs.find((page) => page.path === docPath)?.title ?? docPath;
    void forwardComments(
      markTurn(
        { kind: "precheck", title, screens: mine.map((screen) => screen.title) },
        [
          `@confluence/${docPath} 기획서와 아래 화면을 비교해 주세요.`,
          "",
          listed || "- (이 기획서로 만든 화면이 아직 없습니다)",
          "",
          "기획서의 '화면 목록'과 '상태'에 적힌 것 중 화면에 빠진 것이 있으면 항목으로 적어 주세요.",
          "빠진 것이 없으면 없다고만 답해 주세요. 지금은 고치지 말고 확인만 해 주세요.",
        ].join("\n"),
      ),
    );
  }, [docPath, docs, screens, forwardComments]);

  // A `repo.status` broadcast is newer than anything read by hand, so it drops
  // the hand-read copy on its way in — otherwise a stale 넘김 would outlive the
  // 반영됨 the daemon just reported.
  useEffect(() => {
    setReadHandoff(null);
  }, [daemon.repo?.handoff]);

  const handoff = readHandoff ?? daemon.repo?.handoff ?? null;

  /**
   * Where this 기획서 is, and therefore the one button (PLAN D8). Everything it
   * reads is already on screen somewhere — the tree's marks, the preview's
   * screens, the developer's pull request — so the stepper is a reading of the
   * page rather than a state of its own.
   */
  const openPage = docPath ? (docs.find((page) => page.path === docPath) ?? null) : null;
  const stage = deriveStage({
    page: openPage,
    screens,
    pendingChanges: daemon.repo?.pendingChanges ?? 0,
    branch: daemon.repo?.branch ?? null,
    handoff,
  });

  /**
   * The clone is checked out and installed, whatever the dev server is doing.
   * 저장 and 넘기기 act on the worktree and the remote, so gating them on a
   * preview that cannot bind a port would strand work that is already done.
   */
  const repoPhase = daemon.repo?.phase ?? null;
  const workable = repoPhase === "ready" || repoPhase === "error";

  const refreshHandoff = () => {
    setHandoffBusy(true);
    void api
      .handoffStatus()
      .then(setReadHandoff)
      .catch((e: Error) => setNotice({ level: "error", text: e.message }))
      .finally(() => setHandoffBusy(false));
  };

  const act = (action: StageAction | "precheck" | "openInConfluence") => {
    switch (action) {
      case "publishDoc":
        void openReview();
        return;
      case "buildScreen":
        handoffToScreen();
        return;
      case "viewScreen":
        setSegment("screen");
        return;
      case "save":
        setSegment("screen");
        setSaveOpen(true);
        return;
      case "handoff":
        setSegment("screen");
        setHandoffOpen(true);
        return;
      case "refreshHandoff":
        refreshHandoff();
        return;
      case "precheck":
        precheck();
        return;
      case "openInConfluence": {
        const site = daemon.confluenceSettings?.siteUrl;
        if (site && openPage && !openPage.isNew) {
          window.open(`${site}/wiki/spaces/${openPage.path.split("/")[0]}/pages/${openPage.pageId}`, "_blank");
        }
        return;
      }
      case null:
        return;
    }
  };

  /**
   * Everything a cycle can do, always. The rail says what is usual; a planner
   * who wants to publish a document while the stepper is asking them to save a
   * screen should not have to satisfy the stepper first.
   */
  const menu: StageMenuItem[] = [
    {
      label: pendingPages.length > 0 ? `기획서 게시 (${pendingPages.length})` : "기획서 게시",
      action: "publishDoc",
      disabled: !mirrored || !space || pendingPages.length === 0 || pushing,
      title: space ? "무엇이 올라갈지 확인하고 게시합니다" : "게시할 스페이스를 문서에서 선택해 주세요",
    },
    { label: "이 문서로 화면 만들기", action: "buildScreen", disabled: !docPath || docDirty },
    { label: "저장", action: "save", disabled: !workable },
    {
      label: "개발자에게 넘기기",
      action: "handoff",
      disabled: !workable || !daemon.repo?.branch,
      title: daemon.repo?.branch ? undefined : "아직 저장한 변경이 없습니다. 먼저 저장해 주세요",
    },
    { label: "넘긴 뒤 상태 다시 확인", action: "refreshHandoff", disabled: !handoff },
    {
      label: "Confluence에서 보기",
      action: "openInConfluence",
      disabled: !openPage || openPage.isNew || !daemon.confluenceSettings?.siteUrl,
    },
  ];

  /**
   * A project whose 기획서 subtree is empty (PLAN D14).
   *
   * Every column had its own empty sentence, and none of them was a way
   * forward: the tab strip said to pick a 기획서, the tree said there were
   * none, and + 새 기획 was disabled until one was picked. A planner on their
   * first day met three statements of the same dead end. One button instead.
   */
  const emptyProject = mirrored && docs.length === 0 && !docPath;

  const startFirstDoc = () => {
    setSegment("doc");
    setDraft({
      text: "새 기획서를 하나 만들어 주세요. 어떤 화면을 만들지 함께 정리하고 싶습니다.",
      nonce: Date.now(),
    });
    void createTab("planning");
  };

  return (
    <>
      <aside className="planner__sessions">
        <div className="sidebar__heading">
          <span className="sidebar__heading-label">기획 문서</span>
        </div>
        <PageTree
          daemon={daemon}
          selected={docPath}
          onSelect={(path) => setDocPath(path)}
          refreshKey={treeKey}
          onConnect={onOpenOnboarding}
          screens={screens}
        />
      </aside>

      <div className="planner__chatcol">
        <SessionTabs
          planning={planning}
          design={design}
          active={active}
          onSelect={openTab}
          onCreate={(workspace) => void createTab(workspace)}
          onClose={(workspace, session) => void sessionsOf(workspace).remove(session)}
          disabled={!docPath && !emptyProject}
        />
        <ChatColumn
          daemon={daemon}
          sessions={activeSessions ? { ...activeSessions, submit } : planning}
          sendKey={settings.sendKey}
          workspace={active?.workspace ?? "planning"}
          placeholder={
            active?.workspace === "design"
              ? "만들고 싶은 화면을 말해 주세요"
              : "기획서를 새로 쓰거나 고칠 내용을 말해 주세요"
          }
          disabled={(!docPath && !emptyProject) || (active?.workspace === "planning" && docDirty)}
          quote={quote}
          onDismissQuote={() => setQuote(null)}
          brief={brief}
          onDismissBrief={() => setBrief(null)}
          draft={draft}
          onDraftConsumed={() => setDraft(null)}
          emptyHint={
            docPath || emptyProject
              ? undefined
              : "왼쪽에서 기획서를 고르면 그 문서의 대화가 여기에 열립니다."
          }
        />
      </div>

      <section className="planner__doc">
        <StageBar
          stage={stage}
          busy={pushing || handoffBusy}
          menu={menu}
          onAct={act}
          {...(stage.id === "revise" || stage.id === "save" ? { onPrecheck: precheck } : {})}
        />

        <div className="segment" role="tablist" aria-label="문서·화면 전환">
          <button
            type="button"
            role="tab"
            aria-selected={segment === "doc"}
            className={segment === "doc" ? "segment__on" : ""}
            onClick={() => setSegment("doc")}
          >
            문서
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={segment === "screen"}
            className={segment === "screen" ? "segment__on" : ""}
            onClick={() => setSegment("screen")}
          >
            화면
          </button>
          {/* Reviewing means reading the 기획서 and the screen against each
              other; at narrower widths there is not room for both, and a
              button that produces two unreadable columns is worse than no
              button (PLAN D13). */}
          {wideEnough && (
            <button
              type="button"
              role="tab"
              aria-selected={segment === "both"}
              className={segment === "both" ? "segment__on" : ""}
              onClick={() => setSegment("both")}
            >
              나란히
            </button>
          )}
        </div>

        {notice && (
          <div className={notice.level === "error" ? "notice notice--error" : "notice notice--info"}>
            <span className="notice__text">{notice.text}</span>
            <button
              type="button"
              className="notice__close"
              aria-label="게시 알림 닫기"
              onClick={() => setNotice(null)}
            >
              ×
            </button>
          </div>
        )}

        {reviewOpen && (
          <PublishDialog
            review={review}
            spaceTitle={daemon.confluenceStatuses.find((status) => status.space === space)?.spaceTitle ?? null}
            error={reviewError}
            pushing={pushing}
            onConfirm={() => void push()}
            onClose={() => setReviewOpen(false)}
          />
        )}

        {/* Both halves stay mounted. The editor holds unsaved text and the
            preview holds a running app; unmounting either on a segment flip
            would throw away work the planner cannot see they are losing. */}
        <div className={segment === "both" ? "planner__split" : "planner__panes"}>
        <div className="planner__segment" hidden={segment === "screen"}>
          {emptyProject ? (
            <div className="firstdoc">
              <h2>첫 기획서를 만들어 볼까요?</h2>
              <p>
                기획 대화에 무엇을 만들고 싶은지 말하면 기획서를 함께 씁니다. 다 쓰면 게시해서
                Confluence에 올리고, 그 기획서로 화면을 만듭니다.
              </p>
              <button type="button" className="primary" onClick={startFirstDoc}>
                첫 기획서 만들기
              </button>
            </div>
          ) : (
            <DocEditor
              daemon={daemon}
              path={docPath}
              onDirty={setDocDirty}
              onQuote={setQuote}
            />
          )}
        </div>
        <div className="planner__segment" hidden={segment === "doc"}>
          <ScreenPanel
            daemon={daemon}
            onOpenSettings={onOpenSettings}
            onComments={forwardComments}
            turnState={design.active?.state ?? "idle"}
            publishSessionId={design.activeId}
            specPath={docPath}
            onScreens={setScreens}
            pageIdOf={pageIdOf}
            onPrecheck={precheck}
            saveOpen={saveOpen}
            handoffOpen={handoffOpen}
            onCloseSave={() => setSaveOpen(false)}
            onCloseHandoff={() => setHandoffOpen(false)}
          />
        </div>
        </div>
      </section>
    </>
  );
}
