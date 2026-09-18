# colo-design 전수 코드 감사 — 감사 결과

## 2026-09-18 — Full Audit (New Findings)

- 범위: 저장소 전체 (packages/daemon, packages/desktop, packages/web, packages/protocol, scripts, 테스트, 루트 설정). EXCLUDES: node_modules, dist, build, web-dist, release, .dev-userData*, .test-logs, pnpm-lock.yaml, *.tsbuildinfo, 벤더/생성 산출물.
- 방법: 조사 서브에이전트 28개(모듈 × 관점 분할, 세션 모델 상속) → 후보 252건 → 반증 서브에이전트 26개(조사자와 다른 에이전트)가 전건 검증 → 오케스트레이터가 Critical/High 전수 spot-check.
- 기존 findings 없음 (최초 감사) — 기존 중복 폐기 0건.

### 1. 결함 목록 (심각도 내림차순, 승인 202건)

### [Critical] Repo-shipped settings quarantine misses other widening keys (statusLine/apiKeyHelper/awsAuthRefresh/awsCredentialExport/enableAllProjectMcpServers/enabledPlugins/additionalDirectories)
- 위치: packages/daemon/src/claude-trust.ts:53-85
- 분류: security
- 시나리오: Malicious repo commits .claude/settings.json with statusLine command / apiKeyHelper / enableAllProjectMcpServers (+ committed .mcp.json servers) / enabledPlugins / permissions.additionalDirectories. stripWideningSettings removes only hooks, env, permissions.allow; rest survives. trustWorkspace auto-accepts workspace trust; sessions load settingSources [user,project,local] → surviving keys take effect at session start — repo-controlled shell commands / auto-approved repo-shipped MCP servers — exactly what quarantine prevents. permissions.defaultMode pinned by managedSettings in claude driver but nothing pins the rest.
- 근거:
```
for (const [key, value] of Object.entries(parsed)) { if (key === "hooks" || key === "env") { removed.push(key); continue; } if (key === "permissions" && ...) { for (const [rule, rules] of Object.entries(value)) { if (rule === "allow") { removed.push("permissions.allow"); continue; } rest[rule] = rules; }
```
- 수정 제안: Extend strip list: statusLine, apiKeyHelper, awsAuthRefresh, awsCredentialExport, enableAllProjectMcpServers, enabled/disabledMcpjsonServers, enabledPlugins, permissions.additionalDirectories/defaultMode.
- 검증: Surviving keys include enableAllProjectMcpServers+committed .mcp.json (never sanitized): repo-controlled stdio MCP command auto-spawns at session start; managedSettings pins only defaultMode, canUseTool gates calls not server spawn — RCE, not just widening. PATH: repo ships .claude/settings.json{enableAllProjectMcpServers:true}+.mcp.json → claude-trust.ts:53-85 keeps keys → session.ts:144 sanitize… ‖ 중복 병합: DaemonPublish #7과 동일 결함 병합 — defaultMode 항은 managedSettings 클램프로 무효, 나머지 채택

### [High] claude driver store.has returns true for every id (getSessionInfo returns undefined not null)
- 위치: packages/daemon/src/agent/drivers/claude/driver.ts:116-119
- 분류: correctness
- 시나리오: SDK getSessionInfo returns Promise<SDKSessionInfo | undefined> (sdk.d.ts:767) → for any id with no transcript awaited value is undefined → info !== null is true → has returns true for every id incl. garbage. SessionManager.findStoredProvider (session-manager.ts:110-115) uses has as targeted resume router, caches wrong provider in storedProvider: resume of deleted/nonexistent/unknown id routed to first registered driver, create launches bogus resume; correct lookups shadowed when claude driver registered first.
- 근거:
```
has: async (id, cwd) => { const info = await getSessionInfo(id, { dir: cwd }).catch(() => null); return info !== null; }
```
- 수정 제안: Test info != null (covers undefined).
- 검증: getSessionInfo resolves undefined for missing ids (K3 returns undefined, never throws); info!==null true for every id; findStoredProvider caches claude for any unknown resume, defeating foreign-id guard dispatch.ts:192-197. PATH: resume unknown/codex id pre-scan → driver.ts:117-118 → session-manager.ts:110-115 → dispatch.ts:198 → claude launches bogus resume of foreign/garbage id.

### [High] Non-atomic close→create resurrect can delete a newer session sharing the id (leaked CLI process + ghost events)
- 위치: packages/daemon/src/session-manager.ts:207-213; dispatch.ts:219-222,847-875
- 분류: concurrency
- 시나리오: Session X dead. Two session.send for X arrive near-simultaneously. Dispatch A: resurrectSession → manager.close(X) → await session.close() (awaits agent.close()) → live.delete(X) → manager.create({resume:X}) creates S1. Session.close() sets closed=true synchronously → B's concurrent close() returns immediately (session.ts:1383-1384); B's manager.close(X) started before S1 existed resumes after S1's live.set and executes unconditional this.live.delete(sessionId) — deleting S1 while B creates S2 from same transcript. S1's CLI process + driver hooks orphaned (keep broadcasting for id X); S2 diverges from S1; one user message lost to '닫힌 대화입니다'. Same unconditional live.delete after await in remove (539-541) and rewind fork path (651-653).
- 근거:
```
async close(sessionId, reason = "user") { const session = this.live.get(sessionId); if (!session) return; await session.close(reason); this.live.delete(sessionId); this.settledTurns.delete(sessionId); }
```
- 수정 제안: Capture object before await; delete only if still mapped; serialize resurrect per session id (in-flight Map like checkpointSeeding).
- 검증: manager.close check-then-act: live.get→await close→unconditional live.delete; two concurrent session.send on dead X both resurrect, first close's delete lands after other's live.set(X,S1) — S1 evicted, CLI leaked, ghost events. PATH: two session.send on dead X → session-manager.ts:208-211 + dispatch.ts:847-875 → S1 deleted while its CLI lives.

### [High] Gate briefs and refresh success records deliver into another project's live session
- 위치: packages/daemon/src/dispatch.ts:894-922 (briefTo), 587-608 (repo.refresh record)
- 분류: correctness
- 시나리오: Project A active; stale tab holds live session id of project B (the stale-tab case session.send fences at dispatch.ts:257-264). Failing gate on A's repo.save — or A's 최신화 — calls briefTo(message.sessionId) or success record: manager.get(sessionId), finds alive, sends A's conflict/merge brief into B's session. B's agent, working in B's clone, receives merge-conflict/merge-done brief about a repo it's not in, may start editing/committing in B's worktree. No target.cwd !== workspaceCwd() check on this path unlike session.send/rewind/queue.
- 근거:
```
onSessionTurn: (brief) => { const named = sessionId ? this.deps.manager.get(sessionId) : undefined; const session = named && named.state !== "error" && named.state !== "closed" ? named : this.gateThreadFor(stage);
```
- 수정 제안: Resolve session and refuse when named.cwd !== workspaceCwd(); fall through to gateThreadFor.
- 검증: briefTo named-session path (dispatch.ts:901-905) and refresh record (595) use manager.get with no cwd check — unlike session.send (262) and gateThreadFor (935); stale tab's foreign sessionId receives this project's conflict/merge briefs. PATH: repo.save/refresh with stale sessionId → 901-905/595 → foreign session.send(brief).

### [High] Windows killTree SIGTERM branch leaks the whole dev-server tree, then aims taskkill at a dead pid
- 위치: packages/daemon/src/preview-claim.ts:11-26
- 분류: leak
- 시나리오: Windows preview stop (repo-bringup.ts:382-383, handoff-preview.ts:477-478, repo-core.ts:1186-1188): SIGTERM first. On Windows child.kill('SIGTERM') is TerminateProcess on cmd.exe shell only (file's own comment). 3s later killTree(child, 'SIGKILL') runs taskkill /pid <pid> /T /F; /T walks children of given pid but pid already dead → taskkill fails → entire dev-server tree survives holding port → next startPreview/handoff hits EADDRINUSE or adopts ghost. POSIX: non-detached callers (repo-core capture, detached:false repo-core.ts:1107) process.kill(-child.pid) fails ESRCH, fallback child.kill leaves grandchildren.
- 근거:
```
if (currentPlatform() !== "win32" && child.pid) process.kill(-child.pid, signal); else if (signal === "SIGKILL" && child.pid) { const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], ...
```
- 수정 제안: Run taskkill /T /F for SIGTERM too on Windows; verify group contains child before -pid signalling on POSIX.
- 검증: Mechanism corrected: Windows child.kill(SIGTERM)=TerminateProcess kills cmd shell instantly; exit fires and clears the 3s timer, so the taskkill /T cleanup never runs at all. Tree survives holding port; next start fails. PATH: Windows stop (repo-bringup.ts:381-385, handoff-preview.ts:476-480, repo-core.ts:1185-1188) → killTree SIGTERM → shell killed, exit clears SIGKILL/taskkill → node tree orphan…

### [High] capture() watchdog never arms for silent commands — install/preview/git can hang the phase forever
- 위치: packages/daemon/src/repo-core.ts:1100-1225 (capture, rearm 1143-1155)
- 분류: error-handling
- 시나리오: rearm() only invoked from absorb()/absorbStdout() (on output). Command producing NO output and never exiting (hung npm socket before first byte, preinstall waiting on stdin) never triggers rearm → watchdog undefined → promise never settles → bootstrap stuck 'installing' with no stall error despite advertised 5-min stall deadline. Every core.git() passes stallMs=undefined → wedged-network git fetch/push hang forever; publishing/refreshing locks held; all saves/pulls queue behind corpse.
- 근거:
```
const rearm = () => { if (stallMs === undefined || stalled) return; clearTimeout(watchdog); watchdog = setTimeout(() => { ... killTree(child, "SIGTERM"); ... }, stallMs); watchdog.unref?.(); }; const absorb = (chunk) => { ...; rearm(); ... }; // rearm called ONLY from absorb/absorbStdout — never at spawn time
```
- 수정 제안: Arm watchdog immediately after spawn (rearm() once before wiring listeners).
- 검증: rearm only from data handlers (repo-core.ts:1198,1213); git() passes stallMs undefined — silent hangs never settle. PATH: zero-output hang (npm socket, blackholed git fetch/push) → watchdog never armed → capture never settles → phase stuck, core.publishing held.

### [High] checkpoint restore deletes untracked files that ARE in the snapshot when their names are non-ASCII (ls-tree quotepath mismatch)
- 위치: packages/daemon/src/repo-checkpoints.ts:141-153 (via repo.ts:575-591)
- 분류: correctness
- 시나리오: Turn creates untracked 화면.txt; checkpoint snapshots it; 되돌리기 rebuilds inSnapshot from ls-tree WITHOUT -c core.quotepath=false (C-quoted "\355\231\224\353\251\264.txt") while bornAfter's ls-files uses quotepath=false (raw 화면.txt) → mismatch puts file in bornAfter → rmSync deletes a file the snapshot contains. Verified git quoting behavior empirically.
- 근거:
```
const inSnapshot = new Set((await this.core.git(["ls-tree","-r","--name-only",tree]))...); const bornAfter = (await this.core.git(["-c","core.quotepath=false","ls-files","--others","--exclude-standard"])).filter(p => !inSnapshot.has(p) && safeRepoPath(p) !== null);
```
- 수정 제안: Add -c core.quotepath=false to checkpointRestore ls-tree (clearUnsavedWork's already has it).
- 검증: ls-tree lacks quotepath=false while ls-files has it; non-ASCII untracked file mismatches inSnapshot → rmSync deletes a snapshotted file. PATH: untracked 화면.txt snapshotted → repo-checkpoints.ts:141 C-quoted vs :147 raw → !inSnapshot.has → :160 rmSync deletes it ‖ 중복 병합: DaemonPublish #1과 동일 결함 병합

### [High] Unborn HEAD (empty repo) breaks bootstrap and save with raw git errors; save review sticks at computing
- 위치: packages/daemon/src/repo-core.ts:605-607 (also 921-933, 980-991; surfaces repo-publish.ts:123-124)
- 분류: error-handling
- 시나리오: Empty remote: clone succeeds so isCloned() true; refreshFromRemote → aheadBehindBase rev-list HEAD...origin/main exits 128 (verified) → bootstrap error; project never ready. git diff HEAD exits 128 (verified) → runSave throws AFTER setDiff(computing) — diffStage stuck computing forever; stash push and ls-tree HEAD fail similarly.
- 근거:
```
const tracked = parseUnifiedDiff(await this.git(["-c","core.quotepath=false","diff","HEAD","--no-color"])); // runSave: this.core.setDiff({stage:"computing"}); const files = await this.core.diff();
```
- 수정 제안: Detect unborn HEAD; treat diff as all-untracked / aheadBehind [0,0]; wrap early runSave steps to emit setDiff(failed) instead of throwing past computing.
- 검증: Unborn HEAD: fetch/rev-list exit 128 → bootstrap error; diff HEAD exits 128 → runSave throws after setDiff(computing), stage stuck forever. PATH: empty-repo clone → repo-core.ts:797/983 fail → bringup error; save → :606 diff HEAD 128 → throw past repo-publish.ts:123 → computing stuck

### [High] startServer permanently excludes scanned ports after one failed probe, so slow-to-answer dev servers always time out
- 위치: packages/daemon/src/handoff-preview.ts:343,368-374
- 분류: correctness
- 시나리오: Dev server binds LISTEN before HTTP answers (Next dev cold compile / 5xx warmup; probePreviewUrl null for >=500 and its own 2s timeout). Port probed once, added to `scanned`, never re-probed. Loop spins to READY_TIMEOUT_MS 120s, ready:false, finally kills healthy server. Sibling repo-bringup.ts:333-337 retries after SCAN_RETRY_MS=2s and documents the exact pitfall.
- 근거:
```
const scanned = new Set<number>(); for (const port of await pidListeningPorts(pids)) { if (scanned.has(port)) continue; scanned.add(port); const url = await servingUrl(port); if (url !== null) { live.port = port; live.url = url; return null; } }
```
- 수정 제안: Map<number,number> of last-probe timestamps; re-probe after ~2s.
- 검증: scanned Set permanently excludes a port after one null probe; repo-bringup.ts:333-337 retries at 2s and documents this exact pitfall. Once the hint port appears LISTENing it enters scanned, killing even the hint re-probe. PATH: dev server binds LISTEN before HTTP answers (cold compile / 5xx warmup; probePreviewUrl null on >=500 or 2s timeout) → iteration 1 servingUrl(port)=null, scanned.add(port)…

### [High] Upgraded WebSocket sockets have no 'error' listener — socket errors become uncaught exceptions
- 위치: packages/daemon/src/server.ts:812-819
- 분류: error-handling
- 시나리오: WS client passes token/origin handshake, then connection resets (sleep/resume, reload mid-frame, hostile local process with token sending malformed frame). ws library emits 'error' on per-connection WebSocket; attach() registers only close+message → EventEmitter throws → uncaughtException. CLI entry only logs (index.ts:134-137), socket dies mid-op; desktop host (main.ts embeds DaemonServer, no uncaughtException/unhandledRejection handler — grep-verified) surfaces main-process error dialog/abort of whole app while turn running.
- 근거:
```
private attach(ws: WebSocket): void { this.clients.add(ws); this.logger.info("클라이언트 연결", ...); ws.on("close", () => { this.clients.delete(ws); ... }); ws.on("message", (raw) => void this.onMessage(ws, String(raw)));
```
- 수정 제안: Add ws.on('error', ...) in attach() logging+terminate; consider 'error' handler on noServer WebSocketServer.
- 검증: attach() registers only close+message; ws 'error' on reset/malformed frame → EventEmitter throw → uncaughtException; desktop main has no handler → app crash. PATH: WS client passes token/origin → attach (server.ts:812-819, no error listener) → socket error post-upgrade → uncaughtException → desktop main aborts mid-turn.

### [High] Crash recovery wipes the lost room — resurrectSession/manager.close runs close('user') which disk.clear()s the queue file including lost items
- 위치: packages/daemon/src/session.ts:1382-1395 (with dispatch.ts:847-848, queue-store.ts:201-203)
- 분류: correctness
- 시나리오: Turn running + queued sends → CLI crashes → settleTransport()→dropHeld() moves held sends to lost room, emits queue.lost (recovery panel data) → planner re-sends → dispatch sees !sendable → resurrectSession → manager.close(dead.id) → session.close('user') → this.disk?.clear() → rmSync(queue-<id>.json) deletes BOTH held and lost arrays → recovery panel advertises already-unrestorable items (takeLost returns null); window reload → panel empty; user-composed messages silently destroyed. Same wipe on manager.reopen (session-manager.ts:221). Lost room only survives full daemon restart, never the crash-recovery path it exists for.
- 근거:
```
async close(reason = "user") { if (this.closed) return; this.closed = true; ... if (reason === "user") { this.held.length = 0; this.disk?.clear(); } }
```
- 수정 제안: disk.clear() only removes held side, or resurrect/reopen closes with a reason preserving lost; or QueueStore.clear keeps lost array.
- 검증: Crash→dropHeld→moveToLost persists lost room; next send→resurrectSession→manager.close→close('user')→disk.clear() rmSyncs the whole queue file, destroying advertised lost items. PATH: CLI crash with held sends → session.ts:714-723, dispatch.ts:275,847-848, session.ts:1389-1391, queue-store.ts:201-203 → lost room wiped, takeLost null.

### [High] list() never rescans — resolved scan promise stays in `scanning` forever, making invalidateThreads dead code
- 위치: packages/daemon/src/session-manager.ts:373-398 (mutation points: 325-334, 487-489)
- 분류: correctness
- 시나리오: First list(cwd) stores {epoch, scan} in this.scanning, never removed (only scanning.delete is removeWhere :334). After scan resolves, session event → invalidateThreads → diskStale.add → next list enters stale branch, finds entry with matching epoch, await entry.scan returns ALREADY-RESOLVED promise — .then writing this.disk and clearing diskStale never re-runs. Disk half of session list frozen at first scan for daemon lifetime: closed thread vanishes from sidebar (removed from live, never re-added from disk); deleted thread keeps showing; external transcripts never appear. Documented 'failed scan keeps previous answer' (365-369) unreachable — failing scan writes [] permanently.
- 근거:
```
let entry = this.scanning.get(cwd); const epoch = this.scanEpoch.get(cwd) ?? 0; if (!entry || entry.epoch !== epoch) { const scan = Promise.all(...).then((groups) => { ... this.disk.set(cwd, rows); this.diskStale.delete(cwd); ... }); scan.catch(() => undefined); entry = { epoch: scanEpoch, scan }; this.scanning.set(cwd, entry); } const scanned = await entry.scan;
```
- 수정 제안: Delete scanning entry when scan settles (.finally with identity check) or check diskStale before joining existing entry.
- 검증: scanning entries are never deleted after resolution (only removeWhere :334); stale list() re-awaits the resolved promise, diskStale is never cleared, disk freezes at first scan for daemon lifetime. PATH: session event → invalidateThreads(:487-489) → list(:373-393) finds entry.epoch===current → awaits already-resolved scan → disk.set(:384) never re-runs → new/closed threads vanish or go stale in si…

### [High] Escape key is permanently swallowed from the previewed page
- 위치: packages/desktop/src/preview-view.ts:1179-1200 (with web NativeHost.tsx:201-202)
- 분류: correctness
- 시나리오: Repo app closes modals/menus/drawers with Escape. Pane holds focus → Escape → before-input-event matches forward list → event.preventDefault() stops key from reaching previewed page's DOM; forwarded colo-preview:key discarded by web (NativeHost :202 if payload.key === 'Escape' return) → Escape dead key inside pane. Un-freeze Escape needs nothing here — when frozen view is hidden (cover → setVisible(false)), focus already in main window, its document listener receives real keydown.
- 근거:
```
contents.on("before-input-event", (event, input) => { if (input.type !== "keyDown") return; const mod = ...; const forward = input.key === "Escape" || (mod && (...)); if (!forward) return; event.preventDefault();
```
- 수정 제안: Stop preventDefault-ing bare Escape (forward nothing) or replay forwarded Escape into page-facing key path.
- 검증: Escape matched at :1183 → preventDefault :1193 blocks page DOM; NativeHost.tsx:202 discards forwarded key — dead for previewed app and web. PATH: pane focused+Escape → :1183/:1193/:1194 → NativeHost:202 drop → no keydown anywhere.

### [High] Dropping an image onto the composer attaches it twice (footer onDrop bubbles into ChatColumn's onDrop, both invoke readAttachments)
- 위치: packages/web/src/components/chat/ChatColumn.tsx:403-409 + packages/web/src/components/chat/Composer.tsx:1119-1125
- 분류: correctness
- 시나리오: User drags an image file and drops it on the composer. React synthetic drop events bubble: composer <footer> onDrop runs readAttachments(files) first, then the same event bubbles to ChatColumn's <main> onDrop which calls attachFiles.current — the same readAttachments registered via registerAttach (Composer.tsx:699-707). Neither handler stops propagation; both async calls append, so each dropped image lands twice (doubled base64 to daemon, duplicate chips). Path-dependent: drop on chat column outside footer attaches once.
- 근거:
```
// Composer.tsx
onDrop={(e) => { e.preventDefault(); void readAttachments(e.dataTransfer.files); }}
// ChatColumn.tsx
onDrop={(event) => { event.preventDefault(); setDragDepth(0); if (event.dataTransfer.files.length > 0) { attachFiles.current?.(event.dataTransfer.files); } }}
```
- 수정 제안: stopPropagation in composer footer onDrop, or drop the footer handler and rely on the registered attach callback.
- 검증: Footer onDrop lacks stopPropagation; event bubbles to main onDrop calling the same readAttachments via registerAttach; both setEditor appends apply. PATH: drop image on composer footer → Composer.tsx:1115-1118 readAttachments + bubble to ChatColumn.tsx:403-408 attachFiles (registered Composer.tsx:693-706) → attachments duplicated.

### [High] hydrate() wholesale-replaces blocks, dropping live events that raced the history round-trip
- 위치: packages/web/src/lib/daemon-client.ts:1781-1803 (with packages/web/src/hooks/useSessions.ts:278-292)
- 분류: concurrency
- 시나리오: Open/reload into a mid-turn session: loadHistory awaits api.history — daemon snapshots replay at request time; while reply in flight, live socket broadcasts text.delta/tool.start/tool.end/user.echo folded into view.blocks; hydrate then wholesale-replaces blocks with older replay (blocks: events.reduce(foldEvent, [])). tool.start+tool.end pair in window → tool call permanently missing; orphaned tool.start → row stuck running; lost thinking deltas → truncated thinking (no final-replace healing unlike text.done). Persists until next full reload.
- 근거:
```
const view = prev[sessionId] ?? EMPTY_SESSION; ... return { ...prev, [sessionId]: { ...view, blocks: events.reduce<Block[]>(foldEvent, []) ...
```
- 수정 제안: Merge instead of replace — fold history into existing view's prefix or skip replacement when session went live between fetch and hydrate; keep authoritative queue/dropped tail.
- 검증: hydrate wholesale-replaces blocks; live events folded during the history round-trip are discarded — tool pairs lost, orphaned starts stuck running, thinking truncated. PATH: open/reload mid-turn → loadHistory useSessions.ts:282-283 → snapshot session-manager.ts:498 → live folds via daemon-client.ts:1201 → hydrate :1797 replaces → rows lost until reload.

### [High] usePreviewCover MutationObserver misses attribute changes — HistoryDrawer's data-cover-stage toggle is invisible
- 위치: packages/web/src/hooks/use-preview-cover.ts:32-33; HistoryDrawer.tsx:113-118; ScreenPanel.tsx:292-299
- 분류: correctness
- 시나리오: Drawer open docked; window resize crosses 700px → historyCover flips → React adds/removes data-cover-stage on already-mounted <aside>; observer only {childList,subtree} → reconciler.sync() never fires → narrowing: native preview keeps painting over drawer (unreadable — the narrow-window fallback it exists for); widening: stage stays frozen/covered until unrelated DOM mutation resyncs.
- 근거:
```
const observer = new MutationObserver(() => reconciler.sync()); observer.observe(document.body, { childList: true, subtree: true });
```
- 수정 제안: Add attributes:true, attributeFilter:["class","data-cover-stage"].
- 검증: Observer lacks attributes:true; data-cover-stage toggles in place on mounted aside at 700px breakpoint, so reconciler.sync never fires and cover state goes stale. PATH: drawer open + resize across 700px → ScreenPanel.tsx:292-299 flips historyCover → HistoryDrawer.tsx:118 attribute-only change → use-preview-cover.ts:33 observer {childList,subtree} misses it → native view paints over drawer / stage…

### [High] Stale cycleRequest replays 상태 확인 (and ChatColumn's 저장/넘기기) on every ScreenPanel/ChatColumn remount — per-mount nonce ref loses the guard
- 위치: packages/web/src/components/panels/ScreenPanel.tsx:541-547 (with shell/PageWorkspace.tsx:184-191,663-755)
- 분류: correctness
- 시나리오: 상태 확인 pressed → askCycle('check') sets cycleRequest={kind:'check',nonce:N}, setView('thread') → ScreenPanel handles it; cycleRequest never cleared. Planner clicks 홈/여정 → view!=='thread' unmounts planner__body (ChatColumn+ScreenPanel). Clicking a thread or ⌘T remounts ScreenPanel — checkNonce useRef(-1) resets while cycleRequest still nonce N → effect replays readHandoffState(false): surprise GitHub re-read; unhandled comments → 개발자 코멘트 modal opens itself. ChatColumn.tsx:228-235 identical per-mount cycleNonce guard → same remount replays runSave() (a REAL save) or re-opens handoff card — unintended save on view switch. Korean comment at ScreenPanel.tsx:538-540 states this exact replay was the bug being fixed; ref doesn't survive the remount it names.
- 근거:
```
const checkNonce = useRef(-1); useEffect(() => { if (cycleRequest?.kind !== "check" || cycleRequest.nonce === checkNonce.current) return; checkNonce.current = cycleRequest.nonce; readHandoffState(false); }, [cycleRequest]);
```
- 수정 제안: Clear request after consumed (setCycleRequest(null)) or lift last-seen nonce into PageWorkspace state/ref surviving remounts.
- 검증: cycleRequest never cleared; remount resets nonce refs so check replays modal, save re-commits, handoff card re-opens on every thread re-entry. PATH: 상태 확인/⌘S click → askCycle sets cycleRequest (PageWorkspace.tsx:188-191), never cleared → 홈/여정 unmounts planner__body (663-676) → thread re-entry remounts ScreenPanel/ChatColumn → checkNonce/cycleNonce useRef(-1) (ScreenPanel:541, ChatColumn:225) → eff…

### [Medium] All SDK control calls await unbounded — wedged CLI hangs session.models/setMode forever
- 위치: packages/daemon/src/agent/drivers/claude/session.ts:366-432
- 분류: error-handling
- 시나리오: setModel/setEffort/setMode/setFastMode/stopTask/backgroundTask (+ post-catch models/commands/contextUsage) await SDK control requests with no timeout. INTERRUPT_GRACE_MS/PROBE_GRACE_MS exist for interrupt; every other chip/RPC path unbounded: CLI hanging after system/init makes session.models/setMode hang forever; await this.consumer at close adds second hang holding session open.
- 근거:
```
async setModel(model) { await this.run.setModel(model ?? undefined); } async stopTask(taskId) { await this.run.stopTask(taskId); }
```
- 수정 제안: Bound each control call with Promise.race grace timer (settleInterrupt pattern).
- 검증: setModel/setEffort/setMode/setFastMode/stopTask/backgroundTask/models/commands/contextUsage await SDK control responses unbounded; wedged-but-alive CLI hangs them forever; INTERRUPT_GRACE_MS shows wedged case acknowledged but uninsured elsewhere.

### [Medium] Transport settles on 'exit' not 'close' — buffered final response dropped, false transport-closed crash
- 위치: packages/daemon/src/agent/jsonrpc.ts:58-57 (exit wiring)
- 분류: concurrency
- 시나리오: Node emits 'exit' when child dies potentially BEFORE parent drained stdout the child flushed just before exiting (pipes drained asynchronously; 'close' fires after stdio ends). One-shot agent answering session/prompt and exiting: response line sits in pipe buffer, 'exit' fires first, end() rejects pending waiter 'JSON-RPC transport closed', arrived answer dropped — false crash on clean exit.
- 근거:
```
this.proc.on("exit", (code) => end(code)); this.proc.on("error", () => end(null)); ... waiter.reject(new Error("JSON-RPC transport closed"));
```
- 수정 제안: Settle on stdout/stderr 'close' (or proc 'close') instead of 'exit'.
- 검증: Node 'exit' fires before stdio drains; end() rejects pending waiters and buffered final response lines dropped → false 'transport closed' crash on clean-exit agents.

### [Medium] Daemon start-up probe treats any HTTP 200 on the stored port as a live colo daemon
- 위치: packages/daemon/src/index.ts:93-102, 122-131
- 분류: error-handling
- 시나리오: daemon.json holds old default port 7823; another program answering 200 on /health binds it. Launch desktop app: daemonHealthy gets response.ok true from foreign service → main() prints 'daemon 이 이미 … 돌고 있습니다' and exit(0) — real daemon never starts, UI cannot connect, log points at nonexistent daemon. Endpoint returns {ok:true, protocolVersion} (server.ts:652-654) but probe never reads body/version.
- 근거:
```
const response = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1_500) }); return response.ok;
```
- 수정 제안: Parse JSON body; require colo-design marker (protocolVersion match).
- 검증: daemonHealthy returns response.ok only (index.ts:93-102); any foreign HTTP 200 on stored port → main exits 0 at 122-131, daemon never starts, UI cannot connect.

### [Medium] Codex interrupt() timeout leaves wedged transport + running child (core assumes driver aborted)
- 위치: packages/daemon/src/agent/drivers/codex/session.ts:423-431
- 분류: error-handling
- 시나리오: 
- 근거:
```
const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000));
try {
  return await Promise.race([settled, timeout]);
} finally {
  this.turnSettlers.delete(settle);
}
```
- 수정 제안: 
- 검증: Timeout path returns without transport.close() (unlike ACP:332-334); core session.ts:1238 sets aborted assuming driver killed query, but wedged app-server child keeps running/streaming until resurrect. PATH: stalled turn → interrupt → turn/interrupt answered but no turn/completed → 10s settle timeout (423) → 'timeout' → core aborted; child lives, late events stream post-stop.

### [Medium] ACP interrupt() during slow boot returns answered while queued send still launches the turn
- 위치: packages/daemon/src/agent/drivers/acp/session.ts:320-325
- 분류: concurrency
- 시나리오: 
- 근거:
```
if (!this.vendorSessionId) {
  await Promise.race([this.ready, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]).catch(() => undefined);
  if (!this.alive) return "dead";
}
const sessionId = this.vendorSessionId;
if (!sessionId) return "answered";
```
- 수정 제안: 
- 검증: Boot-window: vendorSessionId null after 5s grace → returns 'answered' (321) without cancel; queued doSend still awaits ready then runs session/prompt — stopped turn launches anyway. PATH: send during slow session/new → stop → interrupt races ready 5s (313-316) → sessionId null → 'answered' → boot completes → doSend:250 fires prompt.

### [Medium] Executable negative-caching makes 'install then re-check' permanently fail for codex/opencode/omp
- 위치: packages/daemon/src/agent/drivers/codex/driver.ts:73-76; acp/driver.ts:83-86
- 분류: correctness
- 시나리오: 
- 근거:
```
private exe(): string | null {
  if (this.executable === undefined) this.executable = resolveCodexExecutable();
  return this.executable;
}
```
- 수정 제안: 
- 검증: exe() caches resolveExecutable() result including null (codex/driver.ts:105-108, acp/driver.ts:86-89); drivers are registry singletons so isAvailable re-check and createSession keep failing after install until daemon restart.

### [Medium] isInjectedText drops genuine user prompts starting with '<' or '# AGENTS.md'
- 위치: packages/daemon/src/agent/drivers/codex/store.ts:152-154
- 분류: correctness
- 시나리오: 
- 근거:
```
function isInjectedText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<") || trimmed.startsWith("# AGENTS.md");
}
```
- 수정 제안: 
- 검증: isInjectedText (152-155) drops any user block starting with '<' or '# AGENTS.md'; userMessageText filter removes genuine prompts from replay user.echo, titles, collectPrompts/promptCount — user's words silently vanish from transcript.

### [Medium] lsof port scan breaks on common dev ports — service-name resolution (missing -P/-n)
- 위치: packages/daemon/src/preview-claim.ts:58-88
- 분류: correctness
- 시나리오: POSIX dev server on port in /etc/services (3000→hbci on macOS, 8000, 8080, 5000, 8888). lsof invoked without -P → resolves port to service name (verified on this host: listener on 3000 prints nlocalhost:hbci). Parser takes text after last colon → Number('hbci') NaN → port dropped, pidListeningPorts [] → socket-scan fallback (repo-bringup.ts:331-364 / handoff-preview.ts:364-377) finds nothing → healthy server declared PreviewPortUndetected (or handoff not ready) purely because of port number.
- 근거:
```
? ["-a", "-n", "-o"] : ["-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-Fn"]; ... if (!line.startsWith("n")) continue; const port = Number(line.slice(1).split(":").pop()?.replace(/]$/, ""));
```
- 수정 제안: Add -P (and -n) to lsof argv, or dns.lookupService non-numeric names.
- 검증: Re-verified on host: production argv without -P prints nlocalhost:hbci for port 3000 (3000->hbci in /etc/services); parser Number('hbci')=NaN drops port → scan [] → PreviewPortUndetected for servers that print no URL. PATH: dev server on /etc/services port, no printed URL → preview-claim.ts:58-64 lsof, :83-88 parser → [] → bring-up undetected.

### [Medium] one dead pid in the scan list discards the entire lsof output
- 위치: packages/daemon/src/preview-claim.ts:65-73
- 분류: error-handling
- 시나리오: Bring-up pid list [child.pid, ...descendantPids] includes exited pid (wrapper shell hands off and exits). Verified on this host: lsof -a -p <live>,<dead> exits rc=1 while still printing live listener line. execFile rejects on non-zero exit → .catch(() => "") throws stdout away → returns [] → every remaining READY-loop scan stays empty; running server never found. Same wipe on Windows when one netstat fails.
- 근거:
```
(error, out) => (error ? reject(error) : resolve(String(out))), ).catch(() => ""); const ports = new Set<number>();
```
- 수정 제안: Treat non-zero exit as partial data: resolve with captured stdout on error too, or scan per-pid.
- 검증: Re-verified: lsof -p live,dead exits rc=1 while printing live listener lines; callback rejects on error discarding stdout, .catch(()=>"") wipes it → all remaining scans empty.

### [Medium] descendantPids is always empty on Windows — PowerShell pipeline parsed by cmd.exe due to shell:true
- 위치: packages/daemon/src/preview-claim.ts:93-101
- 분류: correctness
- 시나리오: [INFERENCE on exact cmd.exe parsing] Windows execFile('powershell', args, {shell:true}) runs via cmd /c → cmd interprets | in 'Get-CimInstance Win32_Process | Select-Object …' → pipes into nonexistent program 'Select-Object' → command fails → descendantPids [] → pidListeningPorts only sees top shell pid → pick-your-own-port handoff detection can't find dev server port on Windows → not-ready failure path.
- 근거:
```
execFile(windows ? "powershell" : "ps", windows ? ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId"] ...
```
- 수정 제안: Escape/quote for cmd, use -EncodedCommand, or shell:false with full powershell path.
- 검증: Node DEP0190 confirms args concatenated unescaped; probe showed inner pipe executes in outer shell. cmd splits bare pipe → Select-Object not executable → reject → [] → port detection sees only top shell pid on Windows. [INFERENCE] holds.

### [Medium] runGate has no timeout around the gate driver — a hung open() silently swallows the completion notice and leaks the isolated window
- 위치: packages/daemon/src/preview-drivers.ts:143-155
- 분류: error-handling
- 시나리오: server.ts:456 fires void this.drivers.runGate(...). inspectScreens awaits driver.open per screen; desktop implementation's window.webContents.loadURL has no timeout (desktop/src/preview-driver.ts:335) — server accepts but never answers leaves it pending minutes. runGate never reaches done(): finished turn's deferred completion notice never sent, UI turn clock keeps running, isolated BrowserWindow (debugger attached) leaks until hang resolves. Up to MAX_GATE_SCREENS=6 screens repeat the delay.
- 근거:
```
const driver = factory.forIsolated(status.previewUrl); let troubles: ScreenTrouble[] = []; let broken = false; try { troubles = await inspectScreens(driver, kept); } catch {
```
- 수정 제안: Whole-gate timeout resolving to broken=true so runGate always terminates and emits done().
- 검증: loadURL (desktop preview-driver.ts:335) has no deadline and only rejects on did-fail-load; hung server leaves open pending forever → done() never runs (deferred idle notice swallowed, server.ts:455-456 void), finally destroy unreached → isolated window+debugger leak.

### [Medium] Quoted git paths with ' -> ' defeat changedPaths rename split — discard/shelve silently leaves files behind
- 위치: packages/daemon/src/repo-core.ts:698-712
- 분류: correctness
- 시나리오: File literally named `a -> b` (verified quoted even with quotepath=false): rename regex on QUOTED body yields `"a` and `b""`; unquoteGitPath unchanged; git rm fails (swallowed), rmSync ENOENT suppressed → real file survives discard and shelve cleanup; after shelve desk stays dirty → unshelve refuses (SHELF_DIRTY) forever; shelf pop conflicts with surviving copy — data unreachable through both doors. DUP-ish of DaemonRepoCore #6 (broader consequences).
- 근거:
```
const body = line.slice(3); const rename = body.match(/^(.*) -> (.*)$/); if (rename) paths.push(unquoteGitPath((rename[1]??"").trim()), unquoteGitPath((rename[2]??"").trim())); else paths.push(unquoteGitPath(body.trim()));
```
- 수정 제안: Unquote body first then split; or use status --porcelain -z.
- 검증: greedy rename regex mis-splits 'a -> b' names; discard/shelve leave survivor; unshelve SHELF_DIRTY (repo-shelf.ts:120-122); finder's quoted-name aside wrong but mechanism holds unquoted. [DUP-family DaemonRepoCore #6] ‖ 중복 병합: DaemonRepoCore #6(porcelain '->')와 동일 결함 병합 — 보관함(shelf) 파급 포함

### [Medium] attachShots commits whatever is staged, not just shot files — unreviewed work rides into the PR
- 위치: packages/daemon/src/repo-publish.ts:425-472 (commit 465-470) and commitApproved 785-788
- 분류: correctness
- 시나리오: checkpointRestore leaves checkout files staged; unshelve leaves applied patch staged (--3way --index); interrupted save leaves partial stages. 넘기기 → attachShots sees non-empty diff --cached, commits message 'Colo Design 화면 미리보기 캡처', pushes — bypasses 'commit exactly approved paths' contract; unreviewed work in PR under misleading message.
- 근거:
```
if ((await this.core.git(["diff", "--cached", "--name-only"])).trim() !== "") { await this.core.git([...(await this.core.identityArgs()), "commit", "-m", SHOTS_COMMIT_MESSAGE]); await this.core.git(["push", "origin", branch]); }
```
- 수정 제안: Stage only shots; commit with explicit pathspec or reset index first; never commit pre-existing dirty index.
- 검증: attachShots commits whole index when any diff --cached non-empty (repo-publish.ts:465-470); checkpointRestore/apply --index leave staged residue riding into shots commit+push.

### [Medium] Windows: git() falls back to shell:true with attacker-controlled path arguments — command injection via filenames
- 위치: packages/daemon/src/repo-core.ts:1098-1130 (git) and 1170-1176 (capture spawn)
- 분류: security
- 시나리오: Windows, resolveGitExecutable() null → shell:true → Node runs whole argv through cmd.exe /c. Filenames with cmd metacharacters (legal NTFS) e.g. x"&calc&".txt reach git add -- <paths> in commitApproved/clearUnsavedWork/checkout → shell splits and executes injected command with daemon privileges (PAT-holding env). DUP of DaemonRepoCore #5 (extends: injection not just metachar interference).
- 근거:
```
shell: windows && git === "git", detached: false, ... const result = await this.capture(git, { cwd, shell: windows && git === "git", ... }, args, undefined, binary);
```
- 수정 제안: Never shell for argument-bearing invocations; fail with GIT_MISSING_DETAIL instead, or dedicated argv0 invocation.
- 검증: shell:true fallback (repo-core.ts:1103) passes changedPaths filenames through cmd.exe; resolver-null (environment.ts:117-159) + crafted filename → injection; DUP DaemonRepoCore #5. ‖ 중복 병합: DaemonRepoCore #5(Windows shell:true)와 동일 결함 병합 — 주입 프레임 채택

### [Medium] landCycle/save race: save can commit and push onto the base branch mid-landing
- 위치: packages/daemon/src/repo-publish.ts:613-655 (landCycle) vs 180-198 (runSave commit)
- 분류: concurrency
- 시나리오: Interleave: runSave passes guards → landCycle dirty check reads clean → runSave ensureCycleBranch switches to cycle branch → landCycle checkout baseBranch + reset --hard fires → commitApproved commits approved work ON BASE BRANCH → push --set-upstream origin cycleBranch pushes OLD cycle head; new commit stranded on base; next pull ff/merge silently discards. 'Published' work gone from PR.
- 근거:
```
const dirty = (await this.core.git(["status", "--porcelain"])).trim().length > 0; await this.core.git(["checkout", this.core.baseBranch]); if (!dirty) await this.core.git(["reset", "--hard", `origin/${this.core.baseBranch}`]); // runSave meanwhile: branch = await this.ensureCycleBranch(); await this.commitApproved(memo, approved);
```
- 수정 제안: Fence landCycle with publishing flag or re-verify HEAD === cycle branch immediately before/after commit.
- 검증: refreshHandoff unfenced vs publishing (repo.ts:413); dispatch fence gap before diffStage computing; landHandoffIfDue re-activation path — commit lands on base, push sends old head; reset --hard detail skipped when dirty.

### [Medium] restore/discard/checkpointRestore take no worktree lock — concurrent pull/shelve interleaves with half-restored trees
- 위치: packages/daemon/src/repo.ts:456-470, 520-532, 571-587
- 분류: concurrency
- 시나리오: They only AWAIT existing locks, never set refreshing/shelving/publishing. Session-start pull (dispatch.ts:243 fire-and-forget) mid-restore passes guards → stashUnsavedWork parks half-restored tree → merge → pop → review shows mix of two moments; subsequent save commits it. Shelve during checkpointRestore snapshots half-restored tree then clearUnsavedWork wipes — undo path corrupted. update()'s rmSync(root) after settle() can delete live clone mid-restore.
- 근거:
```
async checkpointRestore(id) { if (!this.core.isCloned()) return { restored: [] }; while (this.core.publishing) await this.core.publishing.catch(...); await this.core.refreshing?.catch(...); await this.core.shelving?.catch(...); // ← no lock TAKEN
```
- 수정 제안: Shared worktree mutex (dedicated core.restoring promise all fences await); include in settle().
- 검증: restore/discard/checkpointRestore only await fences, never set (repo.ts:470-472,553-555,589-591); dispatch.ts:244 fire-and-forget pull interleaves; settle() blind to restores before rmSync(root).

### [Medium] checkpoint() fire-and-forget snapshots mid-mutation worktrees — rewind restores a state that never existed
- 위치: packages/daemon/src/server.ts:397-402 (caller) + repo-checkpoints.ts:31-63
- 분류: concurrency
- 시나리오: checkpoint() awaits nothing (no fences) and void-called. Fired during pull's stash window → snapshots EMPTY parked desk; during unshelve/restore → half-applied tree. session.rewind 'restores' bogus moment: files user had on screen at turn start deleted as bornAfter (stashed, not born) — rewind destroys the work it promises to bring back.
- 근거:
```
if (event.kind !== "user.echo") return; const turn = this.checkpointTurns.get(sessionId); ... void this.workspaceOfSession(sessionId)?.repo.checkpoint(sessionId, turn + 1).catch(() => undefined); // repo-checkpoints.ts: no isCloned/lock guard before git add -A
```
- 수정 제안: checkpoint awaits worktree fences inside store before add -A.
- 검증: void checkpoint (server.ts:401-403) snapshots mid-mutation worktree (repo-checkpoints.ts:31-56 no fences); rewind to bogus moment deletes real work as bornAfter.

### [Medium] bootstrap's refreshFromRemote bypasses the refreshing lock — saves/pulls/shelves run inside its stash-merge window
- 위치: packages/daemon/src/repo-bringup.ts:71-77 (bootstrap else-branch) vs repo-core.ts:756-834
- 분류: concurrency
- 시나리오: Only pull() facade sets core.refreshing; bootstrap calls refreshFromRemote() directly. During stash→fetch→merge→pop window, runSave passes await core.refreshing (null) → computes diff against PARKED clean desk → approves zero files → reports 'nothing to save' with real work stashed, or commits mid-merge tree if conflicts. Same exposure repo.diff(), shelve() (wrong-moment snapshot + wipe), server.ts:614 void active.repo.sync() re-entry.
- 근거:
```
} else { this.core.setPhase("pulling", null); await this.core.scrubOriginCredential(); await this.core.refreshFromRemote(); sanitizeRepoAgentSettings(this.core.root); }
```
- 수정 제안: Core-owned refresh job wrapper setting/clearing core.refreshing; bootstrap uses it.
- 검증: bootstrap calls refreshFromRemote directly (repo-bringup.ts:71-77) without core.refreshing; runSave/diff/shelve enter stash window; server.ts:614 double-entry.

### [Medium] recoverParkedWork retry loop: non-conflict stash pop failure rethrows but the parked entry stays — every bootstrap fails forever
- 위치: packages/daemon/src/repo-core.ts:958-981 (recoverParkedWork) + 939-956 (popStash)
- 분류: error-handling
- 시나리오: popStash treats only conflicted-files outcomes as recoverable; other failure ('untracked working tree file would be overwritten' — git keeps stash entry) rethrows. recoverParkedWork propagates → bootstrap error with bringUpErrorKind 'conflict' only if message contains '충돌한 파일' (it doesn't) → card mislabels. Every sync() re-runs → same failing pop: workspace bricked until human inspects git stash; no UI path names the stash.
- 근거:
```
const conflicted = await this.popStash(ref); if (!conflicted) return "restored"; ... this.setPhase("error", RECOVER_CONFLICT_DETAIL, "conflict"); throw new Error(RECOVER_CONFLICT_DETAIL); // popStash catch: if (conflicted.length === 0) throw error; ...
```
- 수정 제안: Detect would-overwrite case and route into conflict brief naming stash ref.
- 검증: popStash rethrows non-conflict (repo-core.ts:946-949), stash entry persists, kind falls to install (repo-bringup.ts:436); untracked-overwrite pop reproduces every sync.

### [Medium] clearUnsavedWork rmSync can delete the wrong path when git quotes the filename (newline/arrow names)
- 위치: packages/daemon/src/repo-core.ts:668-696 (loop 686-692)
- 분류: correctness
- 시나리오: Quoted outputs (' -> ' or newline names — verified quoted even with quotepath=false): mis-split/mis-decoded path reaches rmSync(join(root, path), {recursive:true, force:true}). force suppresses ENOENT → real file NOT deleted (discard lies: reports removed), or decoded backslash form coincides with another real path → THAT path deleted recursively. Porcelain afterwards lists survivor; refreshPendingChanges heals count while desk shows work user asked to destroy. DUP-family with #2/#3.
- 근거:
```
for (const path of allowed) { if (inHead.has(path)) continue; await this.git(["rm", "--force", "--cached", "--", path]).catch(() => undefined); rmSync(join(this.core.root, path), { recursive: true, force: true }); }
```
- 수정 제안: porcelain -z for changedPaths; drop force's silent ENOENT (existence check); skip control-char paths with report.
- 검증: safeRepoPath normalization (repo-core.ts:675-677) feeds rmSync — backslash name becomes a/b.txt: wrong-path recursive deletion or suppressed-ENOENT survivor while discard reports removed.

### [Medium] dependencyHash ignores bun lockfiles and workspace/package.json-only dependency moves — stale installs serve old deps
- 위치: packages/daemon/src/repo-bringup.ts:505-516 + repo-config.ts:31-40 (LOCKFILES)
- 분류: correctness
- 시나리오: Repo using bun (bun.lock/bun.lockb) or pnpm/yarn/npm workspace where dependency change lands only in packages/sub/package.json: hash identical → dependenciesMoved false → install skipped → preview serves node_modules missing new dependency (module-not-found or old version silently running). LOCKFILES maps bun lockfiles to nothing → lockedManager null → install never declared.
- 근거:
```
function dependencyHash(root) { const hash = createHash("sha256"); for (const file of ["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) { hash.update(existsSync(path) ? readFileSync(path) : Buffer.alloc(0)); } return hash.digest("hex").slice(0, 16); }
```
- 수정 제안: Hash bun lockfiles; include pnpm-workspace.yaml + member manifests (or install on any workspace manifest change).
- 검증: dependencyHash omits bun lockfiles + member manifests (repo-bringup.ts:505-516) — real; but LOCKFILES claim false: repo-config.ts:31-36 maps bun.lockb/bun.lock to bun install.

### [Medium] Raw paths passed as git pathspecs — glob metacharacters over-match, git rm/add touch unapproved files
- 위치: packages/daemon/src/repo-publish.ts:785-787 (also repo.ts:517, repo-core.ts:684)
- 분류: correctness
- 시나리오: Verified git 2.53: git add -- 'app/[slug]/page.tsx' also staged unrelated app/s/page.tsx; after commit, git rm --force -- same spec deleted both from worktree+index. Save commits unreviewed content; 되돌리기's bornAfter rm permanently deletes sibling files matching the class.
- 근거:
```
await this.core.git(["add","--",...paths]); // repo.ts: if (bornAfter.length>0) await this.core.git(["rm","--force","--",...bornAfter]);
```
- 수정 제안: Prefix each path with :(literal) or --pathspec-from-file with --pathspec-file-nul in commitApproved, restore's rm, clearUnsavedWork's checkout/rm.
- 검증: Raw paths passed as pathspecs to git add (repo-publish.ts:786) and git rm (repo.ts:517); glob chars like [slug] over-match siblings → unreviewed commits / extra deletions.

### [Medium] 1MB stdout cap in capture() silently truncates the save-review diff — leading files vanish from review and commit
- 위치: packages/daemon/src/repo-core.ts:1209-1218
- 분류: correctness
- 시나리오: git diff HEAD output >1MB (big lockfile + screens): stdout=slice(-1_000_000) drops leading 'diff --git' headers; parseUnifiedDiff misses those files; they never reach review or approved; save reports published while omitting them.
- 근거:
```
const absorbStdout = (chunk) => { ... stdout = (stdout + String(chunk)).slice(-1_000_000); absorb(chunk); };
```
- 수정 제안: Cap per-file or fail loudly when cap truncates mid-stream.
- 검증: stdout.slice(-1_000_000) at repo-core.ts:1216 drops leading diff --git headers → parseUnifiedDiff misses files → silently absent from review and commit. ‖ 중복 병합: DaemonPublish #23(1MB truncate)과 동일 결함 병합

### [Medium] handoff-preview servingUrl probes only http, so HTTPS-only preview servers never become ready
- 위치: packages/daemon/src/handoff-preview.ts:460-466
- 분류: correctness
- 시나리오: Preview command serves HTTPS only → servingUrl builds only http:// URLs → GET against TLS listener errors → null every iteration → failure after 120s. Main preview path probes http+https (repo-bringup.ts:338-341); comment claims parity but scheme dropped.
- 근거:
```
async function servingUrl(port) { for (const host of ["127.0.0.1", "[::1]"]) { const url = `http://${host}:${port}/`; if ((await probePreviewUrl(url)) !== null) return url; } return null; }
```
- 수정 제안: Probe both schemes per host with rejectUnauthorized:false.
- 검증: servingUrl probes only http:// though probePreviewUrl supports https and repo-bringup.ts:338-341 probes both schemes; parity comment false. HTTPS-only preview → all probes error → 120s failure.

### [Medium] repo-summary git calls omit -c core.quotepath=false, so handoff preview diverges from shipped PR body for non-ASCII paths
- 위치: packages/daemon/src/repo-summary.ts:101 (also :68)
- 분류: correctness
- 시나리오: Korean filename → git C-quotes path in numstat/name-status; repo-publish.ts:318-324 passes -c core.quotepath=false for real PR body but preview omits it → preview shows octal escapes (contradicts comment at 95-97); line 68 feeds quoted garbage paths to model draft.
- 근거:
```
filesSection = buildFilesSection(await this.core.git(["diff", "--numstat", options.range]), HANDOFF_FILE_LIMIT);
```
- 수정 제안: Add -c core.quotepath=false to both git calls.
- 검증: numstat/name-status omit -c core.quotepath=false while repo-publish.ts:319-323 (real PR body) passes it; empirically Korean paths render as octal escapes without the flag → preview diverges from shipped body and handoffPrompt gets garbage paths.

### [Medium] parseUnifiedDiff breaks on git's mandatory C-quoted paths, misattributing hunks to the previous file
- 위치: packages/daemon/src/repo-diff.ts:18-31,45-47
- 분류: correctness
- 시나리오: File named `say "hi".ts` → git C-quotes unconditionally (quotepath=false doesn't help) → DIFF_HEADER ^diff --git a/(.*) b/(.*)$ doesn't match → no DiffFile opened → hunks pushed onto PREVIOUS file; rename to quoted string stores quoted path. unquoteGitPath exists but unused on diff output.
- 근거:
```
const header = DIFF_HEADER.exec(line); if (header) { current = { path: header[2]!, status: "modified", hunks: [] }; ... } else if (line.startsWith("rename to ")) current.path = line.slice("rename to ".length);
```
- 수정 제안: Allow optional C-quoting; route captures through unquoteGitPath.
- 검증: Empirically confirmed: quoted header (diff --git "a/say \"hi\".ts" ...) fails DIFF_HEADER even with quotepath=false; hunks append to previous file, rename-to stores quoted path; unquoteGitPath unused in parser.

### [Medium] KeychainCredentialStore.save spawns `security` with no child 'error' handler — spawn failure crashes the daemon
- 위치: packages/daemon/src/credentials.ts:77-93
- 분류: error-handling
- 시나리오: security cannot spawn (ENOENT on non-macOS with CREDENTIAL_STORE=keychain, EMFILE/EACCES, sandbox) → spawn emits 'error' on ChildProcess; only child.stdin has handler → uncaught exception takes daemon down; enclosing Promise never settles.
- 근거:
```
const child = spawn(this.security, ["add-generic-password", ...], { stdio: ["pipe", "ignore", "pipe"] }); ... child.stdin.on("error", () => undefined); child.on("close", (code) => {
```
- 수정 제안: child.once('error', reject); guard close against double-settle.
- 검증: spawn has no child 'error' handler (only stdin); ENOENT/EMFILE emits 'error' → uncaught exception crashes daemon and the promise never settles (credentials.ts:77-93)

### [Medium] GitHubBridge.setToken arms the new PAT before persisting and before re-arming workspaces — a save failure leaves split-brain token state
- 위치: packages/daemon/src/github-bridge.ts:106-121
- 분류: error-handling
- 시나리오: github.token.set with throwing store: this.pat = token first, credentials.save throws → rejects before repoListCache cleared, noteAuth(false), deps.onToken → REST calls and listRepos use NEW token while live workspaces push/clone with OLD token (or none); token lost on restart; client sees error but daemon half-switched. Concurrent listRepos can populate repoListCache under new-token key with old-token fetch.
- 근거:
```
async setToken(token) { this.pat = token; if (this.pat) await this.deps.credentials.save(REPO_PAT_ITEM, this.pat); else await this.deps.credentials.delete(REPO_PAT_ITEM).catch(() => undefined); this.repoListCache = null; this.noteAuth(false); this.deps.onToken(this.pat);
```
- 수정 제안: Persist first, then assign pat + cache-clear/onToken (or roll back in catch).
- 검증: setToken assigns this.pat before credentials.save; a save throw exits before cache clear/noteAuth/onToken → daemon REST uses new token, workspaces keep old, token lost on restart (github-bridge.ts:106-121)

### [Medium] CLI probes (security, claude auth status, git --version, node --version, which) run with no timeout — a wedged binary stalls startup/status/onboarding
- 위치: packages/daemon/src/credentials.ts:100-109; environment.ts:96-103,362-397; onboarding.ts:128-140
- 분류: error-handling
- 시나리오: No timeout on execFile/spawn probes: security find-generic-password blocks on keychain-unlock prompt (stalls loadRepoPat inside server.start()); claude auth status/--version hang on wedged binary (stalls every buildStatus broadcast + onboarding gate); git/node/which unbounded. probeCdsRegistry sets timeout 20s — the only one; pattern intended but not applied.
- 근거:
```
async load(item) { try { const { stdout } = await run(this.security, ["find-generic-password", "-s", this.service, "-a", item, "-w"]);
```
- 수정 제안: Bounded timeout (10-30s) on every probe; expiry = negative answer.
- 검증: execFile/spawn probes (security find-generic-password, claude auth status/--version, git/node --version, which) run with no timeout — only probeCdsRegistry sets 20s; wedged binary stalls start/status/onboarding indefinitely

### [Medium] Interaction ops return the off-repo page's accessibility tree without the permission card
- 위치: packages/daemon/src/server.ts:1029-1051 (with callBrowserOp 161-181)
- 분류: security
- 시나리오: Gate design promises off-repo screen content readable only past permission card; result stripped only for navigate/back/forward. click/press/type/select/drag return post-action AX snapshot (BrowserDriver.click(): Promise<PreviewAxNode[]>; desktop impl: await clickRect then axTree). Starting on repo surface, click a link navigating off-repo (isRepoSurface true at op start → no card) returns external page AX tree to MCP child as ok:true — consent gate bypassed for most common navigation path.
- 근거:
```
const result = await callBrowserOp(driver, op, params); if (repoSurface && !driver.isRepoSurface() && (op === "navigate" || op === "back" || op === "forward")) {
```
- 수정 제안: After callBrowserOp, re-check isRepoSurface() for every op whose result carries page content; replace result with external note or demand card.
- 검증: click/type/press/select/drag return post-action axTree (preview-driver.ts:1112+); strip covers only navigate/back/forward (server.ts:1034-1038) → off-repo link click leaks external AX tree past consent card. PATH: browser_click on repo-surface link → isRepoSurface true (1012) → no card → navigation → axTree of foreign page returned ok:true.

### [Medium] serveWeb reads files without try/catch — a racing file swap throws inside the HTTP handler
- 위치: packages/daemon/src/web-static.ts:37-58
- 분류: error-handling
- 시나리오: statSync succeeds then file deleted/replaced before readFileSync (desktop self-update / dev rebuild rewrite web-dist while serving) → readFileSync throws synchronously inside createServer listener → uncaughtException: desktop host no handler → main-process dialog/abort; CLI daemon logs only, requesting browser never gets response — page load hangs until timeout.
- 근거:
```
if (!stat || stat.isDirectory()) { const index = join(root, "index.html"); ... res.end(readFileSync(index)); return; } ... res.writeHead(200, { "content-type": type }); res.end(readFileSync(file));
```
- 수정 제안: Wrap both readFileSync in try/catch; 404 or SPA-fallback on failure.
- 검증: statSync guarded but readFileSync (web-static.ts:53,58) unguarded; file swap between stat and read throws synchronously inside createServer listener (server.ts:664) → uncaughtException; desktop has no handler.

### [Medium] handleTransportEnd treats mid-turn CLI death as quiet close when state is waiting_permission/waiting_question — and treats a deliberate forced stop as a crash
- 위치: packages/daemon/src/session.ts:580-603
- 분류: error-handling
- 시나리오: (a) CLI dies while permission/question card open → state waiting_permission not running → else-branch → setState('closed'), crashed never set, no error notice — contradicting docstring ('A query that ends while a turn is in flight is a crash wearing exit code 0'); turnStartedAt is the real in-flight marker, ignored; crash card races abort-signal settle order. (b) interrupt() timeout path sets aborted=true, driver aborts query; if stream then ends CLEANLY → state still running → crash branch → crashed=true + '예상 밖으로 멈췄습니다' card + state error — planner's own 중지 reported as crash, opposite of interrupt() comment intent.
- 근거:
```
private handleTransportEnd(shutdownReason) { if (this.state === "running") { this.crashed = true; ... this.setState("error", ...); } else { this.setState("closed"); } this.settleTransport(); }
```
- 수정 제안: Gate crash branch on turnStartedAt !== null (or pending.size>0); exempt aborted/interrupting.
- 검증: waiting_permission/question death takes else-branch→quiet closed (no crashed, no notice) though turnStartedAt non-null; forced-stop clean stream end hits running-branch→false crash card. PATH: CLI dies mid-card → session.ts:583-603 → silent close; interrupt timeout→abort→clean end → :584-599 → deliberate stop misreported as crash.

### [Medium] settle() unconditionally sets state running when last pending request resolves — sessions stuck showing a running turn that does not exist
- 위치: packages/daemon/src/session.ts:883-898 (one-off patch 856-861)
- 분류: correctness
- 시나리오: Turn ends while card still open (endTurn keeps waiting_* because pending.size>0) → user presses 중지 → interrupt() sets turnStartedAt=null, state idle → user answers stale card → settle sees pending.size===0, state not closed/error → setState('running') → running lamp forever: no turn in flight (turnStartedAt null), no turn.end will arrive, next send() queued into held until something else ends phantom turn. decideBrowserOp carries one-off correction (if turnStartedAt===null && state==='running') setState('idle') proving defect real but patched only for browser ops.
- 근거:
```
const settle = (outcome) => { if (!this.pending.has(requestId)) return; this.pending.delete(requestId); ... if (this.pending.size === 0 && this.state !== "closed" && this.state !== "error") { this.setState("running"); } resolve(outcome); };
```
- 수정 제안: Restore running only when turnStartedAt !== null; else idle; then delete decideBrowserOp workaround.
- 검증: settle() sets running whenever last pending resolves and state not closed/error; turn.end with open card keeps waiting_*, answer then yields phantom running with turnStartedAt null (only decideBrowserOp patched). PATH: turn.end while card open → user answers → session.ts:888-890 → stuck running lamp, project shows working forever.

### [Medium] interrupt() applies its outcome to whatever turn exists when the await resolves — late dead/timeout closes the session and strands a turn the queue just started
- 위치: packages/daemon/src/session.ts:1198-1236 (sendHeldNow 770-783)
- 분류: concurrency
- 시나리오: sendHeldNow(item) or stop click → interrupt() awaits agent.interrupt() → during await running turn ends naturally, release() starts NEXT turn on same live query → in-flight interrupt resolves: (a) dead → aborted=true, dropHeld() (loses rest of queue), setState('closed') — healthy session closed mid-turn; (b) timeout → aborted=true, driver aborts query under new turn → crash card; (c) answered → CLI-side interrupt lands on NEW turn whose interrupting flag deliver already cleared → its abort surfaces as '예상 밖으로 멈췄습니다' instead of 멈춤. Double-click guard :774 only covers same item; second sendHeldNow on different item during grace slices first item's just-started turn.
- 근거:
```
async interrupt() { this.interrupting = true; const outcome = (await this.agent?.interrupt()) ?? "dead"; if (outcome === "dead") { this.aborted = true; if (!this.closed) { ... this.setState("closed");
```
- 수정 제안: Re-check after await that interrupted turn is still the one running at entry (capture turnStartedAt/generation; bail or re-scope).
- 검증: interrupt() applies dead/timeout/answered outcome to whatever turn exists when await resolves; natural turn end→release starts next turn, late outcome closes healthy session or cuts the new turn. PATH: sendHeldNow→await agent.interrupt→turn ends→release→new turn → session.ts:1202-1242 → outcome lands on new turn.

### [Medium] interrupting flag only cleared on error turn.end — successful turn after pressed stop leaves flag set; later transport error misreported as planner's stop
- 위치: packages/daemon/src/session.ts:546-571
- 분류: correctness
- 시나리오: 중지 pressed → interrupting=true → CLI ignores interrupt, turn completes SUCCESSFULLY → turn.end non-error path emits event, calls endTurn() but never clears interrupting (only isError paths clear, :553/:566) → later transport throws for unrelated reason → handleTransportError sees interrupting && !closed → emits phantom turn.end subtype:'interrupted' (for turn that already ended) and sets idle — real crash masked: no error notice, crashed never set, session idle-but-dead.
- 근거:
```
if (event.isError && this.interrupting) { this.interrupting = false; ... this.endTurn(); return; } if (event.isError) this.interrupting = false; this.events.onEvent(this.id, event); this.endTurn(); return;
```
- 수정 제안: Clear interrupting on every turn.end.
- 검증: interrupting cleared only on isError turn.end (:552,:566) despite comment '어떤 턴 끝이든 소비'; successful turn leaves flag → later transport error emits phantom interrupted + idle, masking real crash. PATH: stop→turn succeeds→unrelated transport error → :611-625 → no error notice, crashed never set.

### [Medium] writesGitHistory verb allowlist is bypassable and incomplete — git -c alias, tag/branch flag-dodging, unlisted write verbs all pass
- 위치: packages/daemon/src/session.ts:296-358
- 분류: security
- 시나리오: Gate's purpose: no session puts unreviewed history on handoff branch. (a) git -c alias.ci=commit ci -m x — -c/value skipped as pair, ci not in GIT_WRITE_VERBS → allowed, alias executes commit; (b) git tag -l -d v1 / git branch -a -d feature — only tokens[j+1] inspected → read flag first lets later -d/-f delete refs; (c) mutating verbs absent: symbolic-ref (moves HEAD), filter-branch, reflog expire, update-index, bisect (checks out), worktree add/remove, notes, replace, gc/prune — all allowed despite comment claiming worktree/index/reference mutators blocked.
- 근거:
```
if (tok === "-C" || tok === "-c" || tok === "--git-dir" || ...) { j += 2; } else if (tok.startsWith("-")) { j += 1; } else { break; }
```
- 수정 제안: Refuse/resolve alias.* in -c; scan ALL tokens after tag/branch for write flags; extend verb list or invert to read-only allowlist.
- 검증: Verb allowlist incomplete vs its own comment (claims worktree/index/ref mutators blocked): git -c alias.ci=commit ci bypasses, tag -l -d / branch -a -d flag-dodge, symbolic-ref/update-index/worktree/filter-branch unlisted. PATH: `git -c alias.ci=commit ci` or `git worktree add` → session.ts:296-358 → allowed.

### [Medium] remove() swallows store-delete failure for live sessions — 'deleted' transcript survives and resurrects
- 위치: packages/daemon/src/session-manager.ts:235-247
- 분류: error-handling
- 시나리오: Delete live thread WITH messages; driver.store.delete throws (locked file, permission, corruption); catch returns early whenever live truthy — comment justifies only no-transcript case but code never verifies transcript absent (unlike non-live path checking stored.some) → {ok:true} reported, transcript stays, thread reappears after rescan/restart.
- 근거:
```
try { await driver.store?.delete?.(sessionId, cwd); } catch (error) { if (live) return; const stored = await driver.store?.list(cwd, 200).catch(() => []); if (!stored?.some((s) => s.id === sessionId)) return; throw error; }
```
- 수정 제안: Run stored.some check before swallowing on live path too.
- 검증: live path returns {ok:true} unconditionally on store.delete failure (:240); unlike the non-live path it never checks the transcript is absent — delete failure leaves an undead stored thread that resurrects on rescan/restart.

### [Medium] create() can return a session that is mid-close — caller gets a dead session, send throws
- 위치: packages/daemon/src/session-manager.ts:121-128, 207-213
- 분류: concurrency
- 시나리오: close() awaits session.close BEFORE live.delete. During await (slow agent teardown), create() for same id (resume from second window, rapid close→reopen) finds closing session and returns it; Session.send throws '닫힌 대화입니다' (closed set at top of session.close) — message lost, thread cannot reopen until close finishes. If session.close throws, session stays in live with closed=true forever; every future create returns dead object.
- 근거:
```
const existing = wantedId === undefined ? undefined : this.live.get(wantedId); if (existing) return existing; ... async close(sessionId, reason = "user") { const session = this.live.get(sessionId); if (!session) return; await session.close(reason); this.live.delete(sessionId);
```
- 수정 제안: Delete from live before awaiting close (or mark closing and skip/replace in create); on close() throw still remove entry.
- 검증: Session.close sets closed=true (:1397) before awaiting agent.close (:1406); create() in that window returns the dying session and send throws (session.ts:1106); if disk.clear() throws in close, live.delete is skipped leaving a permanently dead object in live.

### [Medium] findStoredProvider trusts stale cache — comment claims re-verification that never happens
- 위치: packages/daemon/src/session-manager.ts:104-119 (comment at 311-313)
- 분류: correctness
- 시나리오: removeWhere deleteAll path cannot enumerate ids → storedProvider entries survive (comment says harmless because 'findStoredProvider re-verifies with has'). It does not — returns this.storedProvider.get(sessionId) immediately. After project delete/re-add, externally deleted transcript, or deleteAll sweep, session.create with resume gets stale provider, skips 'agent not found' guard (dispatch.ts:192-197), launches wrong driver against nonexistent transcript.
- 근거:
```
async findStoredProvider(sessionId, cwd) { const known = this.storedProvider.get(sessionId); if (known) return known; for (const driver of this.drivers.all()) { const found = driver.store?.has ? await driver.store.has(sessionId, cwd).catch(() => false) : ...
```
- 수정 제안: Verify cached provider with store.has before returning, or purge storedProvider in deleteAll branch.
- 검증: findStoredProvider returns the cached entry immediately (:105-106); the :311-313 comment claims has() re-verification that does not exist; deleteAll path never clears entries, so a stale resume skips the dispatch.ts:192-197 guard and launches the wrong/nonexistent transcript.

### [Medium] promptCount() propagates store-read errors — documented 'failure → 0' fallback missing, send fails
- 위치: packages/daemon/src/session-manager.ts:505-510 (caller dispatch.ts:292-304)
- 분류: error-handling
- 시나리오: Docstring says '읽기가 실패하면 0(빈 대화)' but no .catch — promptCount rejecting (corrupt rollout, CLI error in opencode exportSession) propagates; dispatch caller awaits seeding with no catch → user's first send after daemon restart rejects, message not delivered, for telemetry-adjacent read. Other caller project-fleet.ts:200 does .catch(() => 0) confirming intended contract.
- 근거:
```
async promptCount(sessionId, dir) { const provider = this.live.get(sessionId)?.provider ?? (await this.findStoredProvider(sessionId, dir)); const driver = this.driverFor(provider); return (await driver.store?.promptCount?.(sessionId, dir)) ?? 0; }
```
- 수정 제안: .catch(() => 0) on store read (or in dispatch seeding).
- 검증: docstring (:503) promises 0 on read failure but promptCount has no catch and driver.store.promptCount can reject; dispatch.ts:290-304 awaits seeding uncaught → first send after restart rejects; project-fleet.ts:200 confirms the intended .catch(()=>0) contract.

### [Medium] permissionLog() sync throw hangs the turn — telemetry write on permission critical path
- 위치: packages/daemon/src/permission-log.ts:86-91 (callers session.ts:876, session.ts:1056-1060)
- 분류: error-handling
- 시나리오: write() uses mkdirSync/appendFileSync letting errors propagate. Unwritable config dir/disk full: (a) ask() throws inside handlePermission before request promise created → tool call gets exception, no card; (b) alwaysAllowedAnswer() throws inside respondPermission AFTER alwaysAllowed.record but BEFORE request.resolve → pending permission never settled, turn hangs forever, '항상 허용' click appears dead.
- 근거:
```
private write(event) { mkdirSync(dirname(this.file), { recursive: true }); appendFileSync(this.file, `${JSON.stringify(event)}\n`); this.lines.push(event); if (this.lines.length > MAX_LINES) this.trim(); }
```
- 수정 제안: try/catch around fs writes (measurement must not break measured path) or tolerant callers.
- 검증: write() uses mkdirSync/appendFileSync unguarded (:86-91); ask() throws before the request promise exists (session.ts:881) and alwaysAllowedAnswer throws after record but before request.resolve (session.ts:1061-1070) → pending card never settles, '항상 허용' click hangs the turn.

### [Medium] undoLog().record() throws after the undo already succeeded — client sees failure for a completed restore
- 위치: packages/daemon/src/undo-log.ts:62-68 (callers dispatch.ts:759-764, 794, 818-823)
- 분류: error-handling
- 시나리오: session.rewind, repo.restore, repo.checkpoint.restore call undoLog().record AFTER operation succeeded; record does mkdirSync+appendFileSync synchronously; fs error propagates out of dispatch handler → client receives error for undo that happened; retry double-restores (rewind forks again, checkpoint restore rewrites worktree again).
- 근거:
```
record(event) { const line = { ts: Date.now(), ...event }; mkdirSync(dirname(this.file), { recursive: true }); appendFileSync(this.file, `${JSON.stringify(line)}\n`); ... }
```
- 수정 제안: Catch fs errors inside record/trim.
- 검증: record() does sync mkdirSync/appendFileSync (:62-68) after the undo succeeded at dispatch.ts:759/794/818; fs error rejects the handler → client sees failure for a completed restore; retry double-restores (rewind forks again).

### [Medium] rewind() deletes the original transcript when the fork's first event is any non-'Resume rejected' failure
- 위치: packages/daemon/src/session-manager.ts:567-585, 636-661
- 분류: correctness
- 시나리오: Wait loop breaks on forkAnswered — set by ANY event incl. notice/turn.end error subtype. rejected only true for type==='error' state or turn.end with resultText exactly starting 'Resume rejected'. Fork emitting turn.end subtype 'error'/'interrupted' with different text (crash, init failure), or any non-outcome event first then fork dies → outcome null/non-rejected → proceeds to fork.send + await this.remove(input.sessionId, input.cwd) — permanently deletes original transcript while replacement fork broken. fork.send only throws for closed/aborted/crashed flags; dead agent without flags accepts send silently.
- 근거:
```
onEvent: (id, event) => { forkAnswered = true; if (event.kind === "turn.end" && outcomeBox.value === null) { outcomeBox.value = { type: "end", subtype: event.subtype, resultText: event.resultText }; } ... const rejected = outcome !== null && (outcome.type === "error" || (outcome.type === "end" && outcome.subtype !== "success" && (outcome.resultText ?? "").startsWith("Resume rejected"))); ... fork.send(input.text, input.images); await this.remove(input.sessionId, input.cwd).catch(() => undefined);
```
- 수정 제안: Treat any non-success first outcome as refusal; verify fork sendable/alive before deleting original transcript.
- 검증: claimed paths mostly defended: dying forks set crashed/closed so fork.send throws before remove (:658) — but the 5s wait (:636-640) treats a still-validating fork as healthy; a later deterministic refusal cannot undo remove(:661), losing the original transcript. Edge-case race, not the blanket any-failure claim → Medium.

### [Medium] Daemon fails to boot permanently on a shape-broken queue file — quarantine only covers JSON syntax, not structure
- 위치: packages/daemon/src/queue-store.ts:104-112,161,210-226
- 분류: error-handling
- 시나리오: queue-<id>.json valid JSON but structurally wrong ({"held":"x"}, item missing images) passes load()'s JSON.parse, survives as parsed.held ?? []. At boot server.ts:550 calls sweepOrphans() unguarded; moveHeldToLost → held.map(budget) → item.images.reduce throws TypeError → start() rejects → daemon permanently fails to boot until file manually deleted — exact failure the .corrupt quarantine exists to prevent. Same shape crashes lostItems() (send.images.length).
- 근거:
```
return { held: parsed.held ?? [], lost: kept }; // budget: item.images.reduce(...); sweepOrphans per-file loop no try/catch
```
- 수정 제안: Validate shapes at load (Array.isArray); quarantine violations like parse-error path; try/catch per-file sweep.
- 검증: load() quarantines JSON syntax but shape damage escapes: migrate keeps non-array attachments (:114-124); budget's item.attachments.reduce / part.data.length (:74) and summarize's .filter (:66) throw OUTSIDE the try; sweepOrphans at server.ts:550 is unguarded in start() → permanent boot failure. Candidate's {"held":"x"} example is actually quarantined; attachments:[{}]/attachments:"x" reconstructio…

### [Medium] parseProject accepts any slug string; project.remove rmSync(join(projectsRoot, slug)) can delete outside the projects root
- 위치: packages/daemon/src/projects.ts:173-177,409-410 (rmSync at dispatch.ts:555)
- 분류: security
- 시나리오: projects.json (designed to tolerate hand edits) is the only slug source; parseProject accepts any non-empty string. Slug '..', '.', '../../..' in registry → project.remove computes paths.root = join(projectsRoot, slug) outside root → dispatch.ts:555 rmSync(paths.root, {recursive:true, force:true}) — recursive deletion of ~/.colo-design/projects, ~/.colo-design, or /, destroying all clones and registry. slugify's own comment (113-117) documents the dot-slug join hazard; nothing enforces alphabet on load.
- 근거:
```
projects.ts:173-177 parseProject accepts any non-empty slug; paths():410 const root = join(projectsRoot(this.env), slug); dispatch.ts:555 rmSync(paths.root, { recursive: true, force: true })
```
- 수정 제안: Validate slug in parseProject against slugify's alphabet, or containment check vs projectsRoot in paths().
- 검증: parseProject accepts any non-empty slug (:173-174); slugify's dot-guard (:114-118) applies only at creation, never at load. PATH: projects.json slug ".." → parseProject accepts → dispatch project.remove with deleteFiles → rmSync(join(projectsRoot,"..")) (projects.ts:410, dispatch.ts:555) → ~/.colo-design recursively deleted, destroying registry and every clone. ‖ 중복 병합: DaemonDispatch #6과 동일 결함 병합 (B-2)

### [Medium] Legacy repo.json url is never consumed, so an empty registry resurrects the removed default project on next boot
- 위치: packages/daemon/src/projects.ts:276-284,489-534
- 분류: correctness
- 시나리오: config/repo.json survives migration (credentials.ts:267-268 deletes only pat key). After planner removes last project, projects.json legitimately empty; next boot load sees zero projects → migrateLegacyLayout finds repoUrl !== null → recreates '내 프로젝트' default at stale legacy url; activation re-clones; removed project resurrects in sidebar — every boot, since repo.json never consumed.
- 근거:
```
if (loaded.projects.length > 0) return ...; const migrated = migrateLegacyLayout(env); ... hasRepo = ... || repoUrl !== null
```
- 수정 제안: One-shot migration: skip migrateLegacyLayout whenever projects.json exists (even zero projects), or delete repo.json after migration.
- 검증: migrateLegacyLayout re-runs whenever projects.json is empty (:278-284); repo.json survives with url intact (credentials.ts:267 deletes only pat) so legacyRepoUrl stays non-null (:493-496) → removed-last project resurrects as '내 프로젝트' on every boot.

### [Medium] activateProjectInner deactivates the outgoing repo before the switch can fail, permanently stranding it inactive
- 위치: packages/daemon/src/project-fleet.ts:497-514
- 분류: concurrency
- 시나리오: current?.repo.setActive(false) runs before registry.setActive(slug), which throws for unknown slug (stale client row) or when workspacesFor→ensureDirs throws (unwritable disk) after registry flip. Throw aborts switch with registry still naming old project active but current.repo.active false forever: repo-bringup.ts:231 (if (!this.core.active) return) makes install/preview permanently refuse for on-screen project until another successful switch re-arms it.
- 근거:
```
current?.repo.setActive(false); this.deps.registry.setActive(slug); ... const next = this.workspacesFor(slug); ... next.repo.setActive(true);
```
- 수정 제안: Resolve/validate incoming slug before touching current.repo.active, or re-arm setActive(true) when switch aborts.
- 검증: current.repo.setActive(false) (:509) precedes registry.setActive (:513), which throws for unknown slug (:305) or workspacesFor (resolvedRepo/ensureDirs) throws after the flip → on-screen project left inactive; repo-bringup.ts:96,231 then silently refuse install/preview until a re-switch.

### [Medium] crypto.randomUUID() throws on insecure http:// origins — Alt+click/region pin silently dies after swallowing the click
- 위치: packages/desktop/src/preview-preload.ts:584-596 (also 691-696)
- 분류: correctness
- 시나리오: Pane roams to insecure origin (http://192.168.x.x:3000 — allowed by openTab for any http(s)). Alt+click: handler preventDefault+stopPropagation then crypto.randomUUID() — [SecureContext]-only, undefined on non-localhost http → TypeError; page's click eaten, no pin posted, uncaught exception in preload listener. Same for region drags (:692).
- 근거:
```
event.preventDefault(); event.stopPropagation(); const pin = { id: crypto.randomUUID(), ...screenContext(element), element: target }; ...
```
- 수정 제안: Generate id without secure-context API or gate path on typeof crypto.randomUUID === 'function'.
- 검증: crypto.randomUUID is SecureContext-gated; preload runs on roamed insecure http origins (openTab allows any http(s)); click already preventDefault'd at :578 before TypeError at :584 — pin silently dies.

### [Medium] registerDesktopBridge runs after loadURL resolves — renderer's boot-time getNotificationPrefs races handler registration and can permanently lock the prefs gate
- 위치: packages/desktop/src/main.ts:269,283-290 (with web/src/App.tsx:117-143)
- 분류: correctness
- 시나리오: loadURL resolves at did-finish-load; registerDesktopBridge (registers desktop:notify-prefs:get) called only after. Renderer mount effect calls bridge.getNotificationPrefs() during initial render (typically before did-finish-load) → invoke rejects 'No handler registered'; web catch swallows WITHOUT setting notifyPrefsReady → write-back effect locked whole session: notification pref changes never reach main/disk.
- 근거:
```
await window.loadURL(url); ... registerDesktopBridge({...}); // web: bridge.getNotificationPrefs().then((prefs) => { ... setNotifyPrefsReady(true); }).catch(() => { /* 문은 잠긴 채로 둔다 */ });
```
- 수정 제안: Register bridge before loadURL, or renderer retry on failure.
- 검증: registerDesktopBridge at main.ts:283 runs after await loadURL (:269); renderer boot effect (App.tsx:117-139) invokes desktop:notify-prefs:get during load → 'No handler registered' → catch never sets notifyPrefsReady → write-back gate locked all session.

### [Medium] guardNavigations' will-navigate misses redirects and subframes — external origin can load inside the privileged tool window
- 위치: packages/desktop/src/windows.ts:39-54
- 분류: security
- 시나리오: will-navigate not emitted for server-side redirects (will-redirect) nor subframes. Same-origin URL 302→external (open-redirect endpoint, OAuth bounce, compromised local server on stored port) lands external page inside main window carrying full coloDesignDesktop bridge (self-update install, preview snapshot, folder open). External iframes load unblocked inheriting preload bridge.
- 근거:
```
window.webContents.on("will-navigate", (event, target) => { try { if (new URL(target).origin === toolOrigin) return; } catch {} event.preventDefault();
```
- 수정 제안: Add will-redirect handler with same origin check; decide subframe guarding.
- 검증: will-navigate (windows.ts:39) not emitted for redirects (will-redirect unhandled) or subframes; same-origin 302→external loads inside privileged tool window carrying coloDesignDesktop bridge.

### [Medium] preview:snapshot captures external (roamed) pages — contradicts the stated 'never snapshot a foreign origin' invariant
- 위치: packages/desktop/src/preview-view.ts:859-876 (handler at 1366); intent at 137-141
- 분류: security
- 시나리오: loopbackHttp comment: compromised renderer must not aim overlay at file:// or foreign origin and snapshot. Agent driver has isRepoSurface gate. Renderer IPC path has none: preview:open/open-external navigate pane to any https origin (persist:preview partition keeps user logins); preview:snapshot capturePage()s whatever is on screen — e.g. logged-in external site — returning JPEG+console to renderer, forwarded into an AI turn.
- 근거:
```
async snapshot() { ... const contents = this.webContents(); ... await this.withOverlayHidden(async () => { const image = await contents.capturePage(); ...
```
- 수정 제안: Gate snapshot (and pin path) on activePage.kind === 'preview' or isRepoSurface().
- 검증: snapshot() (preview-view.ts:859-876) lacks the kind==='preview' gate siblings have (:720,731,737); openTab roams pane to any https; persist:preview keeps logins; capturePage returns external site JPEG+console to renderer.

### [Medium] Isolated gate window has no JS-dialog handling — native dialog blocks gate/capture until op timeout
- 위치: packages/desktop/src/preview-driver.ts:252-255 (contrast 641-643, 695-707)
- 분류: error-handling
- 시나리오: Gate verification (factory.forIsolated) opens declared screen calling confirm()/alert() (unsaved-changes guard). Pane driver auto-answers via Page.enable + Page.javascriptDialogOpening ('아무도 대답하지 않으면 페이지가 영원히 멈춘다' :692-694); bootWindow enables only Runtime+Network → dialog in hidden offscreen window answered by nobody: native modal pops onto user's screen, renderer blocks, settle() polls fail, screenshot stalls, gate run degrades to 90s BROWSER_OP_TIMEOUT/'broken'.
- 근거:
```
// bootWindow: for (const domain of ["Runtime.enable", "Network.enable"]) { await contents.debugger.sendCommand(domain, {}).catch(() => undefined); } // pane attach(): for (const domain of ["Runtime.enable", "DOM.enable", "Network.enable", "Page.enable"])
```
- 수정 제안: Enable Page domain in bootWindow + register same Page.javascriptDialogOpening handler.
- 검증: Isolated window lacks Page.enable + dialog handler; JS dialog hangs open()/runGate indefinitely (no 90s timeout exists — hang worse than claimed, defect real).

### [Medium] DOM.resolveNode remote objects are never released — renderer memory leak pinned per browser op
- 위치: packages/desktop/src/preview-driver.ts:1410-1423 (callers 1214, 1361)
- 분류: leak
- 시나리오: Long SPA session: every ref op → rectOfRef→resolveNode→DOM.resolveNode materializes CDP RemoteObject; objectId used for one Runtime.callFunctionOn then dropped; Runtime.releaseObject/releaseObjectGroup never called (grep-verified) → renderer remote object group accumulates one pinned RemoteObject per op for context lifetime; memory growth + DOM nodes pinned from GC.
- 근거:
```
private async resolveNode(contents, ref, backendNodeId) { const resolved = (await contents.debugger.sendCommand("DOM.resolveNode", { backendNodeId })) as { object?: { objectId?: string } }; ... } // no Runtime.releaseObject anywhere
```
- 수정 제안: Runtime.releaseObject({objectId}) in finally after each callFunctionOn, or explicit objectGroup + releaseObjectGroup.
- 검증: DOM.resolveNode RemoteObjects never released; one pinned object per ref op accumulates for attach-session lifetime; no releaseObject anywhere.

### [Medium] navigate() to the currently loaded URL always stalls the full 3s settleAfterNav timeout, then settles twice
- 위치: packages/desktop/src/preview-driver.ts:830-835 (with preview-view.ts:394-397, 648-652)
- 분류: performance
- 시나리오: Navigate to already-loaded URL: settleAfterNav armed BEFORE openTab; openTab→load() no-ops when page.mountedUrl === url → no did-navigate event → settleAfterNav burns full 3s timer resolving false. dest.contents === before → settled twice (up to ~9s). Every same-URL navigate pays fixed multi-second stall.
- 근거:
```
const before = pane.webContents(); const moved = before ? this.settleAfterNav(before) : null; pane.openTab(url); const dest = await this.target(); if (dest.contents === before) await moved; const settled = await this.settleOn(dest.contents, null);
```
- 수정 제안: Detect no-op case before arming; treat timeout as already-settled; skip second settleOn.
- 검증: Same-URL navigate: load() no-ops, armed settleAfterNav burns full 3s; "~9s twice" exaggerated (second settle instant) but fixed stall real.

### [Medium] Pane mobile emulation never applies the phone UA — agent window and pane diverge
- 위치: packages/desktop/src/preview-view.ts:886-895; emulation.ts:11-15; preview-driver.ts:294-298
- 분류: contract
- 시나리오: 모바일 pressed. Electron contents.enableDeviceEmulation(parameters) accepts only screenPosition/screenSize/viewPosition/deviceScaleFactor/viewSize — no userAgent field → spread ...(preset.userAgent ? {userAgent} : {}) silently dropped → iPhone UA never applies (touch likewise). Agent's hidden window applies via CDP Emulation.setUserAgentOverride. UA-branching sites serve different content to agent's 'mobile' window vs user's pane — breaks emulation.ts header contract ('a screen the agent called mobile must be the width the user sees when they press 모바일').
- 근거:
```
const preset = VIEWPORT_METRICS[width]; contents.enableDeviceEmulation({ screenPosition: ..., screenSize: {...}, ...(preset.userAgent ? { userAgent: preset.userAgent } : {}) });
```
- 수정 제안: contents.setUserAgent(preset.userAgent) (clear on emulate(null)) or route pane through same CDP path as driver.
- 검증: Electron Parameters (d.ts:23179) lacks userAgent — :894 spread silently dropped; driver applies via CDP :294-298, pane/agent mobile diverge on UA-branching sites.

### [Medium] Device-emulation state is not replayed when a different page is shown
- 위치: packages/desktop/src/preview-view.ts:879-896 vs 988-1009
- 분류: correctness
- 시나리오: 모바일 on (emulate applied to page A's webContents only). Clicking project B's card shows page B — show() replays mode, pins, location, loading, zoom but never re-applies device emulation → B renders full desktop width while web UI's width toggle still reads mobile on. Desktop-layout page under active 모바일 toggle until toggled off/on. Zoom shows intended pattern (per-page zoomFactor replayed at show); emulation omitted.
- 근거:
```
contents.send("colo-overlay:mode", ...); contents.send("colo-overlay:pins", ...); this.sendLocation(page); this.send("colo-preview:loading", ...); this.send("colo-preview:zoom", { factor: page.zoomFactor }); // emulation is NOT replayed
```
- 수정 제안: Track desired emulation width on view; re-apply/clear enableDeviceEmulation in show() like zoomFactor.
- 검증: emulate() keeps no state; show() :988-1010 replays mode/pins/location/loading/zoom but never enableDeviceEmulation — switched page renders desktop under active mobile toggle.

### [Medium] Concurrent relayPin/snapshot share one captureAck slot — cross-resolved acks photobomb captures
- 위치: packages/desktop/src/preview-view.ts:746-768
- 분류: concurrency
- 시나리오: Pin relay (relayPin) and agent snapshot (snapshot) overlap on same page — user ⌥+clicks pin while 화면 보여 주기 turn runs. relayPin arms captureAck=ackA; snapshot overwrites with ackB. relayPin's hide-ack resolves SNAPSHOT's wait early; snapshot's capturePage starts. relayPin's finally sends {on:false} → overlay (badges/bubbles) re-shown while snapshot's capturePage in flight → agent's frame contains overlay it was contractually hidden for ('the pins and bubbles must not ride the crop'). Preload acks hide and show identically (both send colo-overlay:capture-done) → any cross-order pairing possible.
- 근거:
```
contents.send("colo-overlay:capture", { on: true }); await new Promise<void>((ok) => { const timer = setTimeout(ok, CAPTURE_ACK_MS); this.captureAck = () => { clearTimeout(timer); this.captureAck = null; ok(); }; }); try { await work(); } finally { contents.send("colo-overlay:capture", { on: false }); }
```
- 수정 제안: Queue acks (FIFO array) or serialize withOverlayHidden behind mutex.
- 검증: One captureAck slot :267 overwritten at :752; preload acks hide and show identically (:951) — concurrent relayPin/snapshot cross-resolve, {on:false} lands mid-capture, overlay photobombs.

### [Medium] did-navigate arms the repo overlay with the connected project's pins over a different registered origin's app
- 위치: packages/desktop/src/preview-view.ts:1092-1120 (mounts never deleted: only set at 288)
- 분류: correctness
- 시나리오: Project A mounted once (mounts keeps origin A forever — nothing deletes). Later B connected; link in B's app (dev proxy, docs link to localhost:A) roams B's page to origin A. did-navigate recomputes kind=preview because mounts.has(A) → arms overlay with lastPins — B's pin list — over A's app: B's badges on A's UI; ⌥+clicking A's elements attaches pins (with A's screenshots) into B's pin list going to agent as repo context. isRepoSurface() (:486-489) correctly answers false for this page → sensitive-op gate and overlay arm disagree on same surface.
- 근거:
```
const origin = safeOrigin(url); if (origin !== "") { page.origin = origin; page.kind = this.mounts.has(origin) ? "preview" : "web"; } ... if (page.kind === "preview") { contents.send("colo-overlay:pins", this.lastPins ?? { pins: [] });
```
- 수정 제안: Arm overlay only when page.origin equals connected repo's origin (compare against current mount, not mere registration), or key lastPins by origin.
- 검증: mounts never cleared (only :288); roaming B's page to A's origin → did-navigate :1100 kind=preview → :1109 arms B's lastPins over A's app; isRepoSurface :488 disagrees.

### [Medium] Pin crop rect passed to capturePage in CSS pixels while clamping assumes zoom-divided DIP bounds
- 위치: packages/desktop/src/preview-view.ts:777-785, 833, 837 (cropRect 113-126)
- 분류: correctness
- 시나리오: Pane zoomed 2× (D85 ⓔ). Element at right edge measures rect.x≈700 CSS px (viewportCss ≈ 800/2=400 wide, correctly used for clamping); cropRect output — still CSS px — passed verbatim to contents.capturePage(crop) whose rect is in view DIPs: at zoomFactor 2 same region lives at 1400 DIP. Captured thumbnail from wrong place (offset/half-size) or clamped/empty at frame edge — the 'half-blank image' failure cropRect's comment says it prevents. Zoom 1 unaffected; defect only for zoomed users.
- 근거:
```
const width = bounds.width / factor; // CSS px for clamping ... const crop = cropRect(rect, this.viewportCss()); // rect is CSS px; const image = await contents.capturePage(crop); // rect consumed as view DIPs
```
- 수정 제안: Multiply clamped CSS rect by page.zoomFactor before capturePage (or clamp in DIP space).
- 검증: capturePage rect is DIP; cropRect emits CSS px (viewportCss :782 divides zoom for clamping) passed unscaled at :837 — wrong/empty crop when zoomFactor≠1.

### [Medium] Unreadable credentials.json treated as empty wipes all stored secrets on save/delete
- 위치: packages/desktop/src/safe-storage-store.ts:51-63
- 분류: error-handling
- 시나리오: credentials.json exists but read fails (AV/backup lock EBUSY/EPERM, transient EACCES) → read()'s blanket catch returns {} → save() writes only new item, delete() writes {} → all other stored secrets (machine-wide GitHub PAT, per-project PATs) silently destroyed; daemon migrateProjectPats legacy delete() reaches this in normal flows.
- 근거:
```
async save(item, secret) { const entries = this.read(); entries[item] = encrypt(secret); this.write(entries); } ... private read() { try { ... } catch { return {}; } }
```
- 수정 제안: Distinguish ENOENT from other errors; abort save/delete when existing file unreadable instead of overwriting from empty.
- 검증: read() blanket-catch returns {} on any read failure (safe-storage-store.ts:58-60); save() :23-25 and delete() :40-42 write only that map, wiping all other secrets; migrateProjectPats delete() at credentials.ts:205 reaches it in normal flows.

### [Medium] compareSemver truncates prerelease/garbage versions — prerelease installs never see the final release, corrupt feed silently disables updates
- 위치: packages/protocol/src/update.ts:64-79 (fetchLatest:101-103)
- 분류: correctness
- 시나리오: parseInt('3-beta',10)=3 → compareSemver('1.2.3-beta','1.2.3') returns 0 → updateAvailable:false; feed version 'garbage'/'' passes typeof string check, parses [0,0,0] → bogus or silent no-update instead of 형식이 올바르지 않습니다 error.
- 근거:
```
const parse = (version) => { const [major = 0, minor = 0, patch = 0] = version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0); return [major, minor, patch]; };
```
- 수정 제안: Reject non-numeric segments / prerelease < release; fetchLatest rejects empty/non-semver.
- 검증: parseInt truncation verified update.ts:64-67; malformed feed version passes typeof check (91) → [0,0,0] → silent no-update instead of 형식 오류.

### [Medium] dev:desktop kills the vite server that dev.mjs is explicitly designed to reuse
- 위치: package.json:15 (with packages/desktop/scripts/dev.mjs:138-157)
- 분류: correctness
- 시나리오: dev:web in terminal 1 (vite 29173) → pnpm dev:desktop in terminal 2 → free-port SIGTERMs live vite before dev.mjs starts → reuse path unreachable via documented entry; foreign-server safety bypassed — different project's server on 29173 killed silently instead of dev.mjs's refusal error.
- 근거:
```
"dev:desktop": "node scripts/free-port.mjs 29173 && pnpm --filter @colo-design/desktop dev:hmr" / dev.mjs: if (await webDevServerRunning(DEV_SERVER)) { console.log(`[dev] 이미 도는 개발 서버를 쓴다…`) }
```
- 수정 제안: Drop free-port from dev:desktop or skip listener answering as this repo's vite.
- 검증: dev:desktop free-port kills the dev:web vite dev.mjs is designed to reuse; foreign servers killed not refused

### [Medium] test-parallel interrupt path leaks suite groups that ignore SIGTERM
- 위치: scripts/test-parallel.mjs:303-308
- 분류: concurrency
- 시나리오: Wedged suite → Ctrl-C → SIGTERM to each group then immediate process.exit(130) → suite ignoring SIGTERM (exact case killSuiteGroupHard exists for) survives as orphaned detached group holding ports → next run meets leaked listeners as strangers.
- 근거:
```
for (const signal of ["SIGINT", "SIGTERM"]) { process.on(signal, () => { for (const child of running) killSuiteGroup(child); process.exit(130); }); }
```
- 수정 제안: Reuse SIGTERM→SIGKILL escalation on interrupt.
- 검증: interrupt path SIGTERMs then exits; SIGTERM-ignoring suites leak as detached groups holding ports

### [Medium] theme-contrast-gate passes vacuously when the CSS stops matching its regexes
- 위치: scripts/theme-contrast-gate.mjs:38-66
- 분류: test
- 시나리오: styles.css refactor changes theme selector shape or token format (rgb()/oklch()/3-digit hex) → matchAll finds nothing or tokens silently skipped → '0 pairs checked, 0 failures' exit 0 → WCAG gate green checking nothing; no minimum-pairs assertion.
- 근거:
```
for (const { 1: theme, 2: body } of css.matchAll(/\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) { ... if (!tokens[fg] || !tokens[surface]) continue; } ... if (failures.length) { ... process.exit(1); }
```
- 수정 제안: Assert pairs floor; fail when a theme block yields zero recognized tokens.
- 검증: no minimum-pairs assertion; regex drift yields 0 pairs checked, exit 0

### [Medium] pr_watch reads comment_ids/review dedup state it never writes — stale feedback re-notified on every fingerprint change
- 위치: scripts/pr_watch.py:186-192,217,226
- 분류: correctness
- 시나리오: new_known persists only {fp, failed, stale_reported} → old_ids always empty (fresh = all comments), prev.get('review') always None → any fingerprint change re-fires feedback notifications for already-reported feedback; comment notes missing persistence.
- 근거:
```
new_known[str(n)] = {"fp": fp, "failed": failed, "stale_reported": prev.get("stale_reported", False)} # no comment_ids, no review / old_ids = set(prev.get("comment_ids") or [])
```
- 수정 제안: Persist comment_ids and review into new_known each tick.
- 검증: new_known never persists comment_ids/review; stale feedback re-notified on every fingerprint change

### [Medium] pr_watch DIRTY/BLOCKED notifications fire on every fingerprint change, not on transition
- 위치: scripts/pr_watch.py:238-245
- 분류: correctness
- 시나리오: PR sits DIRTY (or passed+BLOCKED) → any later fingerprint change re-appends '자동 반영이 안 돼요' — no prev.get('ms') comparison or reported flag → same condition once per session start while dirty, violating 'silence is the default'.
- 근거:
```
ms = pr.get("mergeStateStatus"); if ms == "DIRTY": messages.append(...)
```
- 수정 제안: Store last notified mergeStateStatus / ms_reported flag; message only on transition.
- 검증: DIRTY/BLOCKED fire on every fp change, no transition check; violates silence-default contract

### [Medium] lefthook pre-push runs `pnpm knip` without the dist build knip requires
- 위치: lefthook.yml:12-18
- 분류: config
- 시나리오: Fresh clone/worktree → pnpm install (no build) → push → knip: daemon/desktop tests import ../dist/*.js per ci.yml comment → entry points unresolvable → phantom dead exports → knip exits non-zero → push blocked. CI builds before knip for exactly this; local gate doesn't.
- 근거:
```
pre-push: commands: typecheck: run: pnpm -r typecheck; knip: run: pnpm knip
```
- 수정 제안: pnpm build before pnpm knip in hook, matching CI ordering.
- 검증: lefthook pre-push knip without dist build; fresh clone push blocked by phantom dead exports

### [Medium] PAT-leak guard passes on multi-line leaks and on any git error
- 위치: packages/daemon/test/repo-security.test.mjs:163-170
- 분류: test
- 시나리오: PAT committed twice in one file (count 2-9/20-29) or path/count without digit '1' → !String(pushedPat).includes('1') passes while token is in pushed tree; .catch(() => '') maps ANY git failure (corrupt remote, bad ref) to pass — broken verification indistinguishable from clean tree.
- 근거:
```
const pushedPat = await promisifiedRun("git", ["-C", fixture.remote, "grep", "-c", "ghp_npmrc_leak_probe", "HEAD"]).catch(() => ""); assert.ok(!String(pushedPat).includes("1"), "the pushed tree has no PAT");
```
- 수정 제안: assert.equal(pushedPat, "") catching only exit-1 no-match (check error.code === 1, rethrow others), or git grep -l/--quiet with empty-output assert.
- 검증: git grep -c prints path:count; count>=2 or any git error (catch->"") passes while PAT sits in pushed tree — broken verification indistinguishable from clean.

### [Medium] rewind-e2e asserts memoryKept is a boolean, not the honest false the stub's no-fork path must return
- 위치: packages/daemon/test/rewind-e2e.mjs:226-230
- 분류: test
- 시나리오: Stub CLI cannot fork → rewind takes fallback branch and must return memoryKept:false (session-manager.ts:516-518,544,555,655) so UI says 'AI 의 기억은 그대로입니다' honestly. Regression returning true on fallback passes because only typeof asserted.
- 근거:
```
check("memoryKept names the fallback honestly when the stub cannot fork", typeof rewound.memoryKept === "boolean", String(rewound.memoryKept));
```
- 수정 제안: Assert rewound.memoryKept === false.
- 검증: Stub cannot fork (exits 150ms post-answer) so fallback path with memoryKept:false is mandatory; check asserts only typeof boolean — regression returning true passes while check name claims honesty verified.

### [Medium] midturn-queue 'follows at the next turn's end' check only orders the two sends — a mid-turn delivery still passes
- 위치: packages/daemon/test/midturn-queue-e2e.mjs:354-359
- 분류: test
- 시나리오: Contract (header 5-11): queued send must not reach CLI until running turn ends. Regression pushing FIRST mid-turn → followed.at >= hurried.at still holds, secondEnd is truthy waitFor return (&& true) → check passes while the guarded bug is live.
- 근거:
```
const followed = await waitFor(() => arrivals(FIRST)[0], 20_000, "the remaining send"); check("the other send follows at the next turn's end", followed.at >= hurried.at && secondEnd, ...)
```
- 수정 제안: Compare FIRST's stdin-log timestamp against hurried turn's actual end; drop dead && secondEnd.
- 검증: secondEnd is waitFor's boolean true, so check reduces to followed.at >= hurried.at; FIRST delivered mid-hurried-turn passes; no other assertion pins FIRST's CLI arrival to after the turn end.

### [Medium] desktop-smoke 'no console errors' check attaches listeners after the app has fully loaded — startup renderer errors are never observed
- 위치: packages/desktop/test/desktop-smoke.mjs:168-177
- 분류: test
- 시나리오: Renderer pageerror/console.error during startup (missing preload, bad token URL, daemon race) never observed: listeners attached only after firstWindow/URL//health/.planner/onboarding WS/bridge checks, observing only final 1.5s idle window → PASS while renderer erred at boot.
- 근거:
```
const errors = []; window.on("pageerror", (error) => errors.push(error.message)); window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); }); await window.waitForTimeout(1500); ... check("no console errors", meaningful.length === 0, ...)
```
- 수정 제안: Attach listeners immediately after app.firstWindow() (as desktop-switch.mjs:114-116, desktop-comments.mjs:314-315 already do).
- 검증: Listeners attach at :169 after full boot; startup pageerror/console.error never observed — only final 1.5s idle window checked.

### [Medium] desktop-comments prompt log is a hardcoded global path shared by concurrent runs — receipt counts can be satisfied by another run's lines
- 위치: packages/desktop/test/desktop-comments.mjs:279,306,679-708
- 분류: test
- 시나리오: Two concurrent runs share /tmp/colo-prompts.log → B's pin-turn line satisfies A's turnCountBefore+1 receipt even if A's send lost (false pass); extra foreign lines make +2 (false fail); file never truncated, grows unbounded.
- 근거:
```
const promptLog = "/tmp/colo-prompts.log"; ... COLO_PROMPT_LOG: promptLog; ... const logBefore = readFileSync(promptLog, "utf8").split("\n"); ... turnCountAfter = lines.filter(turnLine).length; if (turnCountAfter >= turnCountBefore + 1) break;
```
- 수정 제안: Log inside per-run temp dir like sibling COLO_REFUSE_MODE_FLAG.
- 검증: Hardcoded /tmp/colo-prompts.log appended, never truncated; concurrent run's lines satisfy +1 receipt (false pass) or force +2 (false fail).

### [Medium] desktop-comments: refused-send preservation contract (acceptance criterion 2) has zero coverage — suite reports all-pass with the seat deliberately empty
- 위치: packages/desktop/test/desktop-comments.mjs:646-659
- 분류: test
- 시나리오: e2e for 'refused send keeps words/pins/badges + one warning band' removed with plan-first chip; header still lists criterion; stub carries dead COLO_REFUSE_MODE_FLAG machinery (set at :301 but nothing creates flag file) → refused-send preservation regression ships green.
- 근거:
```
// --- 거부된 전송의 e2e 자리는 계획 먼저와 함께 비었다 ---------------- ...
```
- 수정 제안: Add deterministic refusal door (stub rejects user turn, or daemon test hook) and restore check; until then log explicit SKIP.
- 검증: Seat :646-659 empty; COLO_REFUSE_MODE_FLAG machinery dead (nothing creates flag) — criterion 2 uncovered, suite green.

### [Medium] Conditional check silently skipped when .progress__head is absent — bootstrap reporting can regress to nothing and the suite stays green
- 위치: packages/web/test/ui-planner-e2e.mjs:168-171
- 분류: test
- 시나리오: Progress UI regresses → count() 0 → if body never runs → no check recorded → suite all-pass while 'bootstrap reports what it is doing' never exercised; verdict is tautology true even when present.
- 근거:
```
const progress = page.locator(".progress__head h2"); if (await progress.count()) { check("bootstrap reports what it is doing", true, await progress.first().innerText()); }
```
- 수정 제안: Assert existence in the check or drop it.
- 검증: No guard for .progress__head: absent → check silently skipped (suite green); present → check(true) can never fail. RepoProgress.tsx:149-151 renders it, so the skip path is real.

### [Medium] Swallowed waitForFunction lets 'picking a repo judges it before any clone' pass while the judgment UI is broken
- 위치: packages/web/test/ui-onboarding-e2e.mjs:222-236
- 분류: test
- 시나리오: .repopicker__confirm judgment text regresses → waitForFunction times out → .catch(() => undefined) swallows → check verdict only asserts inputValue → PASS although named contract never observed.
- 근거:
```
await page.waitForFunction(() => document.querySelector(".repopicker__confirm")?.textContent?.includes("화면 제작 준비가 된 레포"), undefined, { timeout: 15000 }).catch(() => undefined); check("picking a repo judges it before any clone, and pre-fills the name", (await page.getByLabel("프로젝트 이름").inputValue()) === "payments-web", ...)
```
- 수정 제안: Fold confirm-text into verdict or let the wait throw.
- 검증: Confirmed and worse: "화면 제작 준비가 된 레포" appears nowhere in web src — wait always times out, catch swallows, check asserts only prefill (setName in pick, independent of inspection). Judgment half never verified yet reported PASS.

### [Medium] readAttachments: one unreadable file rejects Promise.all, losing the whole batch and throwing an unhandled rejection with no user feedback
- 위치: packages/web/src/components/chat/Composer.tsx:677-695 (Promise.all at :692); void'd call sites :700, :1123, :1477, :1526
- 분류: error-handling
- 시나리오: One File unreadable (revoked clipboard temp, locked file) → toAttachment's FileReader rejects → Promise.all rejects before setEditor → even readable files never attach; all call sites are void'd so rejection unhandled, no notice shown; paste silently does nothing.
- 근거:
```
const read = await Promise.all(accepted.map((file) => toAttachment(file)));
setEditor((prev) => ({ text: prev.text, attachments: [...prev.attachments, ...read] }));
```
- 수정 제안: Promise.allSettled + surface failures via rejected notice, or .catch reporting via rejected.show().
- 검증: Promise.all (Composer.tsx:684) over FileReader rejects (:109) drops whole batch; all 4 call sites void'd (:694/:1117/:1471/:1520) → silent loss + unhandled rejection.

### [Medium] onFixReview marks reviews handled before the turn is accepted and voids the submit rejection — failed fix-send is silent and unretryable (plus double-click double-send)
- 위치: packages/web/src/components/chat/ChatColumn.tsx:616-620 (vs guarded retry at :126-134); button in packages/web/src/components/transcript/HumanMessage.tsx:79-82
- 분류: error-handling
- 시나리오: saveHandledReview() runs immediately (badge decrements, recorded handled) before sessions.submit accepted; submit rethrows on failure (hooks/useSessions.ts:778-784) but call is void'd — unhandled rejection, no error surface; comment permanently marked handled though never sent. HumanMessage button no disabled state, no retrying guard → double click submits twice.
- 근거:
```
onFixReview={(reviews) => { for (const review of reviews) saveHandledReview(review.pr, review.id); onReviewsHandled(); void sessions.submit(reviewToTurn(reviews), []); }}
```
- 수정 제안: Guard ref around submit, await before saveHandledReview/onReviewsHandled, route rejection to showError.
- 검증: saveHandledReview+badge fire before void'd sessions.submit that rethrows (useSessions.ts:777-778); handled reviews filtered from badge/panel; ScreenPanel.tsx:761-769 is the repo's own await-then-mark precedent; unguarded buttons double-send.

### [Medium] watched pointer never re-pointed when opening a non-live thread or clearing the composer, suppressing background-thread notifications
- 위치: packages/web/src/lib/daemon-client.ts:1749-1762 (write sites 1432, 1804-1810; caller useSessions.ts:550-556, 611-620)
- 분류: correctness
- 시나리오: Background thread A running; open stored (non-live) thread B — open() calls markLive only if summary.live, fresh() never touches ref → watched.current still A. A finishes: effect sees sessionId !== watched.current → skips notifyBackgroundThread → completion/waiting notification suppressed; same after 새 대화 setActiveId(null).
- 근거:
```
if (prevStates.current[sessionId] === "running" && view.state !== "running") { ... if (sessionId !== watched.current && blockingAsk(view.state, sessionId, pending)) { void notifyBackgroundThread(...
```
- 수정 제안: Re-point watched whenever viewed thread changes regardless of liveness; or clear in fresh() and always set in open().
- 검증: watched re-pointed only by send (:1432) and markLive (:1805); open() skips markLive for non-live summaries (useSessions.ts:554) and fresh() never clears → background thread's finish fails the :1752 check, suppressing its completion notification.

### [Medium] Settings-push effect records `pushed` before its guard, silently dropping edits made while the selector probe is in flight
- 위치: packages/web/src/hooks/useSessions.ts:907-926
- 분류: concurrency
- 시나리오: Thread opened, api.selectors() probe in flight → selector null; planner edits model/effort/permissionMode in 설정; effect writes pushed.current = chat (:910) then hits if (!activeId || !last || !selector) return (:914) pushing nothing; selector lands → effect re-runs but last equals edited chat → all diffs false → edit never sent to live thread; dialog says changed but conversation keeps old model/mode until next session. Same swallow when edit lands before activeId set.
- 근거:
```
const pushed = useRef<ChatSettings | null>(null); useEffect(() => { const last = pushed.current; pushed.current = chat; if (!activeId || !last || !selector) return; ... if (same && last.model !== chat.model) void api.setModel(activeId, chat.model).catch(fail);
```
- 수정 제안: Advance pushed.current only after guards pass (or per-session last-pushed snapshot).
- 검증: pushed.current=chat written before the !selector guard: dialog edit during probe flight is recorded-as-pushed, never sent; when selector lands last===chat so no diff — live thread keeps old model/mode.

### [Medium] Project switch clears list/activeId but leaves the previous project's selector and usage chips
- 위치: packages/web/src/hooks/useSessions.ts:405-421
- 분류: correctness
- 시나리오: Project A thread X open (selector=X's model/mode, usage=X's context) → switch to project B; slug effect clears list/activeId/historyFailed but never selector/usage/selectorFor.current; activeId null → no effect re-fetches → composer chips/usage popover show A's X values as B's next-session pick; wrong-provider pick can seed B's first session via startRef. fresh() (611-620) does these resets; slug path omits.
- 근거:
```
listedSlug.current = activeSlug; setList([]); setActiveId(null); setHistoryFailed(false); if (connection === "open") void refresh(); // fresh(): setSelector(null); setUsage(null);
```
- 수정 제안: Also clear selector/usage/selectorFor.current/commands in slug-change effect.
- 검증: Slug effect clears list/activeId/historyFailed but not selector/usage/selectorFor (fresh() resets all three); stale chips/usage show after switch→open until probe resolves; seed effect can write A-provider pin in window.

### [Medium] loadHistory races: a slow empty/error answer for a previous thread paints historyFailed or an error onto the newly opened thread
- 위치: packages/web/src/hooks/useSessions.ts:278-292
- 분류: concurrency
- 시나리오: Click A then quickly B; both loadHistory run; open(B) sets historyFailed=false, hydrates B; A's late api.history(A) resolves empty → guard checks only that A is listed (not active) → setHistoryFailed(true) fires while B displayed → B shows '대화 기록을 읽지 못했습니다'. Late rejection for A → setError banner over B. Other async writes stamped (selectorFor/usageFor); this one not.
- 근거:
```
const events = await api.history(sessionId); hydrate(sessionId, events); if (events.length === 0 && listRef.current.some((row) => row.sessionId === sessionId)) { setHistoryFailed(true); } } catch (e) { setError(...); }
```
- 수정 제안: Stamp each load (historyFor.current) and drop late writes for non-active session.
- 검증: loadHistory lacks the activeId stamp used for selectorFor/usageFor; late empty answer for A sets historyFailed over B (banner renders without activeId guard, ChatColumn:586); late rejection sets error over B.

### [Medium] startSession post-await writes clobber newer state: stale selectorFor stamp, wiped pendingMode, stolen focus
- 위치: packages/web/src/hooks/useSessions.ts:332-381
- 분류: concurrency
- 시나리오: startSession awaits api.createSession; during await planner clicks thread B (setActiveId(B), B's settle effect sets selectorFor.current=B). Create resolves → continuation unconditionally setActiveId(sessionId) (steals focus back), selectorFor.current = sessionId (:373, re-stamps guard so B's in-flight selector answer discarded, new invisible thread's answer paints later), setPendingMode(null) (:367, erases mode pick planner pressed for next session).
- 근거:
```
const { sessionId } = await api.createSession({...}); ensureSession(sessionId); markLive(sessionId); setActiveId(sessionId); ... setPendingMode(null); ... selectorFor.current = sessionId;
```
- 수정 제안: Capture intent before await, re-check after; only clear pendingMode if this start consumed it.
- 검증: Post-await continuation unconditionally setActiveId(sessionId) steals focus from a thread opened mid-await; setPendingMode(null)+startRef wipe drops a mode picked during the create await — never applied.

### [Medium] Legacy composer pins resurrect after the planner clears them, and can cross providers
- 위치: packages/web/src/lib/settings.ts:410-422,484-501
- 분류: correctness
- 시나리오: legacyComposerDefaults() re-reads old per-workspace keys on EVERY loadChat, never cleared after migration; loadChat treats explicit null same as absent (stored.model ? stored.model : (legacy.model ?? null)) → cleared pin returns next reload. Catalog guard only drops storedModel when knownModels.length > 0; provider switched to one with no cached catalog → switchProviderPatch stores model:null → reload resurrects legacy Claude alias as new provider's pin → startSession (useSessions.ts:347) creates next session with foreign model id.
- 근거:
```
const storedModel = typeof stored.model === "string" && stored.model ? stored.model : (legacy.model ?? null); const knownModels = loadModelCatalog(provider); const model = storedModel && knownModels.length > 0 && !knownModels.some((m) => m.value === storedModel) ? null : storedModel;
```
- 수정 제안: Apply legacy fallback once (delete keys after migration); never let legacy model bypass provider-vocabulary check.
- 검증: legacyComposerDefaults re-reads never-cleared keys every loadChat; stored.model null (provider switch to unpinned provider) → legacy Claude alias resurrects as that provider's pin when catalog uncached → foreign model id sent at create.

### [Medium] tool.progress never clears `retry` — stale '연결이 끊겨 다시 시도합니다' persists after retry succeeds
- 위치: packages/web/src/lib/progress.ts:99-107; blocks.tsx:37,117-123
- 분류: correctness
- 시나리오: tool.progress with retry:{attempt:2,maxRetries:3} stored; retry succeeds → later events carry no retry → {...before, ...(event.retry ? {retry} : {})} keeps old retry via ...before → row shows retry status for rest of run and even after tool.end done.
- 근거:
```
case "tool.progress": progress = { ...before, elapsedSeconds: event.elapsedSeconds, ...(event.retry ? { retry: event.retry } : {}) }; break;
```
- 수정 제안: retry: event.retry ?? null or delete key; or clear in tool.end fold.
- 검증: tool.progress spreads ...before and only writes retry when present (progress.ts:100-107); tool.end never clears progress, so stale '연결이 끊겨 다시 시도합니다' row renders on the finished tool block (blocks.tsx:117-123).

### [Medium] delivery.ts 'closed' row hides unsaved work despite claiming to mirror 'merged'
- 위치: packages/web/src/lib/delivery.ts:231-256 vs 191-223
- 분류: correctness
- 시나리오: PR closed while pendingChanges > 0 → closed row chip unconditionally '개발자가 반려함', docLabel same — pending unsaved work disappears from chip/doc; primary stays 'check' though save enabled; merged row handles unsaved explicitly (chip '저장 안 함', '바꿈 N · 저장 안 됨', primary 'save').
- 근거:
```
if (handoff?.state === "closed") { return { state: "closed", chip: { label: "개발자가 반려함", tone: "changes", ... }, ... primary: "check",
```
- 수정 제안: Mirror merged row's unsaved handling.
- 검증: closed row (delivery.ts:231-256) claims to mirror merged but drops unsaved handling: chip/docLabel fixed, primary 'check' not 'save' — violates the file's own 'unsaved 가 PR 상태보다 앞선다' rule; unsaved work invisible.

### [Low] blockId seq only advances once — consecutive id-less assistant messages collide, second text.done overwrites first
- 위치: packages/daemon/src/agent/drivers/claude/event-mapper.ts:50-54,358
- 분류: correctness
- 시나리오: blockId falls back to m${currentSeq} when message carries no id; nextSeq only advanced when currentSeq === 0 (streamEvent:313, assistant:358) → second consecutive id-less assistant message reuses same seq → identical blockIds (main:m1:b0). Web foldEvent keys blocks by id (daemon-client.ts:177,197) → second message's text.done overwrites/mis-settles first — duplicated/swallowed blocks for subagent messages lacking message.id (older CLIs).
- 근거:
```
if (!messageId && this.currentSeq(agentId) === 0) this.nextSeq(agentId); ... return id ? `${scope}:${id}:b${index}` : `${scope}:m${this.currentSeq(agentId)}:b${index}`;
```
- 수정 제안: Advance per-agent seq for every id-less message or include seq at emit time.
- 검증: consecutive id-less assistant messages for same agent reuse m${seq} (seq advances only at 0 or message_start) → identical blockId → second text.done overwrites first block (daemon-client.ts:197-205).

### [Low] thinking dedup keyed on message_start's id — deltas-first streams re-emit thinking twice
- 위치: packages/daemon/src/agent/drivers/claude/session.ts:262-267
- 분류: concurrency
- 시나리오: streamedThinkingByAgent marks message id only inside thinking_delta branch, requiring messageIdByAgent set by prior message_start. For documented case ('Deltas can be the first thing we see: older CLIs and subagent streams skip message_start') mark skipped → follow-up aggregated assistant re-emits same thinking as another thinking.delta → UI shows reasoning twice (foldEvent appends, daemon-client.ts:238-259).
- 근거:
```
if (delta?.type === "thinking_delta" ...) { const streamed = this.messageIdByAgent.get(agentId); if (streamed) { ... seen.add(streamed); } return [{ kind: "thinking.delta", ... }]; }
```
- 수정 제안: Mark dedup on the delta itself regardless of message id.
- 검증: thinking dedup mark requires messageIdByAgent set by message_start; deltas-first streams (documented lines 310-312) skip mark → aggregated assistant re-emits thinking → duplicate reasoning block.

### [Low] SIGKILL follow-up timer .unref() — wedged agent survives daemon shutdown
- 위치: packages/daemon/src/agent/jsonrpc.ts:154-170
- 분류: leak
- 시나리오: close() schedules SIGKILL follow-up with .unref(). Daemon shutting down within 3s of close (normal case when last session closes) → unref'd timer never fires → wedged agent ignoring SIGTERM never killed → process outlives daemon as orphan holding MCP servers/ports. Comment says agent 'still has to die' but unref removes guarantee exactly when it matters.
- 근거:
```
setTimeout(() => { try { if (!this.ended) this.proc.kill("SIGKILL"); } catch {} }, 3000).unref();
```
- 수정 제안: Drop .unref() (bounded 3s cost) or escalate synchronously on shutdown.
- 검증: SIGKILL follow-up timer unref'd; daemon exiting within 3s of close() leaves SIGTERM-ignoring agent orphaned holding MCP servers/ports.

### [Low] write() silently no-ops when stdin not writable — requests queue into pending forever, no timeout, no end
- 위치: packages/daemon/src/agent/jsonrpc.ts:109-112,120-142
- 분류: concurrency
- 시나리오: request() pends waiter then write(); write silently returns when !this.proc.stdin?.writable while ended still false. Agent closed stdin read end but keeps running → writable false indefinitely → every subsequent request (permission prompts, session/cancel, status polls) queued into pending, never answered nor rejected → UI wedges with no timeout and no end event.
- 근거:
```
private write(message) { if (this.ended || !this.proc.stdin?.writable) return; this.proc.stdin.write(`${JSON.stringify(message)}\n`); }
```
- 수정 제안: write returns boolean; request() rejects immediately when frame could not be queued.
- 검증: write() silently returns when stdin not writable while ended=false; requests pend forever with no timeout and no end event.

### [Low] Image-only send builds empty text block — Anthropic rejects empty text, image-only turn dies at CLI
- 위치: packages/daemon/src/agent/drivers/claude/session.ts:270-292
- 분류: boundary
- 시나리오: Send with images and empty/whitespace text (turn.text = "") builds content = [{type:text,text:""},{type:image,...}] → Anthropic Messages API rejects empty text blocks ('text fields must be non-empty') → turn dies at CLI with API error card instead of sending image — the image-only path the images plumbing exists for misbehaves on primary case.
- 근거:
```
const content = images.length > 0 ? [{ type: "text" as const, text: turn.text }, ...images.map(...)] : turn.text;
```
- 수정 제안: Include text block only when turn.text.trim() !== "".
- 검증: image-only send (turn.text='') composes {type:'text',text:''}+image blocks (composeTurnText returns raw text when sections empty); Anthropic rejects empty text blocks → turn dies at CLI.

### [Low] loadConfig trusts daemon.json's shape, so a semantically corrupt file bricks the daemon with no repair
- 위치: packages/daemon/src/index.ts:26-39
- 분류: config
- 시나리오: daemon.json valid JSON but incomplete object → catch-and-rewrite never runs → token: undefined makes Buffer.from(this.config.token) throw in WS auth handler (server.ts:701) killing every client connection; port: undefined → daemonHealthy fetch http://127.0.0.1:NaN/health always false (no exit) and server binds random port while UI dials ws://127.0.0.1:undefined. Only syntactically broken files get rewritten.
- 근거:
```
try { const stored = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StoredConfig; return override > 0 ? { ...stored, port: override } : stored; } catch { /* fall through and rewrite */ }
```
- 수정 제안: Validate fields (typeof token string, finite port, non-empty host); fall through to regenerate when missing.
- 검증: loadConfig trusts parsed shape (index.ts:26-33); token:undefined → Buffer.from throws at server.ts:701 on every WS upgrade; port:undefined → random bind while UI dials stale port. Only syntactic corruption repaired.

### [Low] realpathBestEffort ancestor walk never resolves on Windows, degrading containsPath to lexical comparison
- 위치: packages/daemon/src/paths.ts:10-29
- 분류: correctness
- 시나리오: Windows (code targets it :24): not-yet-created target C:\Users\Me\proj\newdir\file.ts splits into ["C:", ...]; prefixes \C:, \C:\Users… — first never exists → realpathSync throws every depth → returns raw lexical absolute → containsPath compares lexical candidate vs resolved root: junction/8.3-shortname root → legitimate writes refused (or outside path slips past).
- 근거:
```
const parts = absolute.split(sep).filter(Boolean); for (let depth = parts.length; depth > 0; depth -= 1) { const prefix = `${sep}${parts.slice(0, depth).join(sep)}`; try { const real = realpathSync(prefix);
```
- 수정 제안: Strip drive letter before walk (parts[0] matching /^[A-Za-z]:$/ becomes prefix root).
- 검증: Windows: prefix `${sep}${parts.join}` yields `\C:\...` which never exists → ancestor walk always throws → lexical fallback; containment degrades to prefix compare for not-yet-created targets (paths.ts:27-38).

### [Low] Codex interrupt() awaits ready unbounded — stop can hang ~45s (ACP bounds to 5s)
- 위치: packages/daemon/src/agent/drivers/codex/session.ts:390-392
- 분류: error-handling
- 시나리오: 
- 근거:
```
async interrupt(): Promise<"answered" | "timeout" | "dead"> {
  await this.ready.catch(() => undefined);
  if (!this.alive) return "dead";
```
- 수정 제안: 
- 검증: await this.ready (391) unbounded: handshake worst case ~45s (15s initialize + 30s thread/*) while core shows running (send sets turnStartedAt pre-ready), so stop hangs; ACP bounds identical wait to 5s.

### [Low] findRollout matches by path substring — can bind wrong rollout file
- 위치: packages/daemon/src/agent/drivers/codex/store.ts:121-126
- 분류: correctness
- 시나리오: 
- 근거:
```
export async function findRollout(root: string, id: string): Promise<string | null> {
  for (const path of await listRolloutFiles(root)) {
    if (path.includes(id)) return path;
  }
  return null;
}
```
- 수정 제안: 
- 검증: findRollout uses path.includes(id) (123) instead of matching filename tail; empty/short/malformed client-supplied id binds newest rollout, and delete(id,_cwd) ignores cwd → has('') true, delete('') unlinks wrong file.

### [Low] omp catalogIndex caches empty catalog forever after one failed models --json
- 위치: packages/daemon/src/agent/drivers/acp/omp.ts:74-80
- 분류: error-handling
- 시나리오: 
- 근거:
```
let catalogByValue: Promise<Record<string, SessionModelInfo>> | null = null;
function catalogIndex(): Promise<Record<string, SessionModelInfo>> {
  catalogByValue ??= catalogModels(resolveOmpExecutable() ?? "").then((rows) =>
    Object.fromEntries(rows.map((row) => [row.value, row])));
  return catalogByValue;
}
```
- 수정 제안: 
- 검증: catalogByValue ??= caches the promise permanently (74-80); one failed 'omp models --json' or missing binary (execFile('') throws → catch → []) leaves empty index forever — enrichModels never restores effort traits.

### [Low] omp listStoredSessions fully reads/parses every session file before limit slice
- 위치: packages/daemon/src/agent/drivers/omp/store.ts:192-200
- 분류: performance
- 시나리오: 
- 근거:
```
const files = await Promise.all(names.map((name) => loadFile(join(dir, name))));
...
return rows.sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
```
- 수정 제안: 
- 검증: listStoredSessions Promise.all's loadFile over every .jsonl (192) — full readFile + JSON.parse of all entries per file — before sort().slice(0,limit) (203); timestamped filenames would allow cheap pre-limit.

### [Low] opencode deleteAll fans out unbounded parallel CLI spawns
- 위치: packages/daemon/src/agent/drivers/acp/opencode.ts:124-134
- 분류: concurrency
- 시나리오: 
- 근거:
```
const stored = await listStored(executable, cwd, 200);
await Promise.all(
  stored.map((row) =>
    run(executable, ["session", "delete", row.id], { cwd, timeout: 15_000 }).catch(() => undefined)),
);
```
- 수정 제안: 
- 검증: deleteAll fans out up to 200 concurrent 'opencode session delete' execFile spawns (127-134) with failures swallowed — fd/process exhaustion (macOS ulimit 256) yields silent partial sweep.

### [Low] opencode has/promptCount answer via full transcript export
- 위치: packages/daemon/src/agent/drivers/acp/opencode.ts:113-117
- 분류: performance
- 시나리오: 
- 근거:
```
promptCount: async (id, cwd) => {
  const doc = await exportSession(executable, id, cwd);
  return doc ? exportPromptCount(doc) : 0;
},
has: async (id, cwd) => (await exportSession(executable, id, cwd)) !== null,
```
- 수정 제안: 
- 검증: has (117) and promptCount (113-116) spawn full 'opencode export <id>' (30s timeout, whole transcript serialization) to answer existence/count; has runs per findStoredProvider lookup — heavy for a boolean.

### [Low] runHandoff updates a stale merged/closed PR when openHandoff survives landing failure
- 위치: packages/daemon/src/repo-publish.ts:385-398
- 분류: correctness
- 시나리오: landCycle checkout fails (dirty refusal) → early return, cycle still set. Later runHandoff: open && open.branch === branch still matches already-merged PR → updatePullRequest retitles/rebodies MERGED PR instead of creating new one; actual new work never gets own request until stale state clears.
- 근거:
```
const open = this.core.openHandoff; const pull = open && open.branch === branch ? await client.updatePullRequest({...slug, number: open.number, title, body}) : await client.createPullRequest({...});
```
- 수정 제안: Gate update on open.state open-ish; or clear openHandoff when landCycle aborts after merge observed.
- 검증: runHandoff lacks open.state guard (repo-publish.ts:385-392); landCycle dirty-refusal keeps merged openHandoff + old branch; merged PR retitled, new work PR-less until next refreshHandoff.

### [Low] handoffShot/attachShots blob links break on '#', '?', '%' in routes
- 위치: packages/daemon/src/repo-publish.ts:461-468 (url build) and 483-497 (handoffShot match)
- 분류: correctness
- 시나리오: shotNamePart keeps '#', '?', '%' verbatim (only separators/leading dots replaced; spaces hand-%-escaped). Route /docs#faq → PR-body link fragment truncates at '#faq' → wrong path 404. '%'+non-hex → invalid URL GitHub renders broken. Stage itself works (name matches).
- 근거:
```
const url = `https://github.com/${slug.owner}/${slug.repo}/blob/${branch}/${SHOTS_DIR}/${name.replaceAll(" ", "%20")}`;
```
- 수정 제안: encodeURIComponent for the link, literal filename on disk.
- 검증: shotNamePart keeps #?%; URL escapes only spaces (repo-publish.ts:461-468) — fragment truncation/invalid encoding in PR links.

### [Low] IPv6 loopback URLs printed by the preview server are never captured — port-undetected for [::1]-only servers
- 위치: packages/daemon/src/repo-bringup.ts:445-470 (previewUrlCandidate) and 474-480 (LOOPBACK_URL_HOSTS)
- 분류: correctness
- 시나리오: Schemed regex excludes ']' → 'http://[::1]:3000/' captures 'http://[::1' → new URL throws → bare regex requires prefix boundary; line-start '[' fails the (^|\s) requirement → urlCandidates empty for [::1]-only-printing servers; detection degrades to 2s socket scan; port-undetected fires despite printed URL.
- 근거:
```
const hit = /https?:\/\/[^\s"'<>)\]]+/.exec(line); // ']' excluded → truncates [::1] ... const bare = /(?:^|\s)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5}).../.exec(line);
```
- 수정 제안: Allow ']' in schemed match or run bare-host regex first for bracketed hosts.
- 검증: ] excluded from schemed URL class → new URL throws; bare regex boundary fails mid-line → candidates empty for [::1]-only printers; degrades to socket scan.

### [Low] REGISTRY_AUTH_DETAIL hardcodes npm.pkg.github.com regardless of the repo's declared registry host
- 위치: packages/daemon/src/repo-core.ts:192-193 with repo-config.ts isPackageHost
- 분류: error-handling
- 시나리오: deriveRegistry accepts any *.pkg.github.com host; 401 against that host → REGISTRY_AUTH_DETAIL instructs pnpm config set //npm.pkg.github.com/:_authToken — wrong host line; following card verbatim doesn't fix.
- 근거:
```
export const REGISTRY_AUTH_DETAIL = "GitHub 패키지 인증이 필요합니다 — pnpm config set //npm.pkg.github.com/:_authToken <read:packages 권한 PAT>";
```
- 수정 제안: Template failing registry host through the error.
- 검증: isPackageHost accepts *.pkg.github.com (repo-config.ts:70-72) but REGISTRY_AUTH_DETAIL hardcodes npm.pkg.github.com (repo-core.ts:192-193).

### [Low] Registry-persisted repo.branch skips isSafeRefname and flows verbatim into git checkout/push argv
- 위치: packages/daemon/src/projects.ts:188 (consumed repo-publish.ts:233-236, repo-core.ts:799-804/987/1045)
- 분류: contract
- 시나리오: baseBranch validated with isSafeRefname but persisted cycle branch only cleanString: corrupted projects.json with branch '--force' → ensureCycleBranch runs `git checkout --force` (resets worktree, discarding unsaved work) and builds ref ranges from the value.
- 근거:
```
repo: { url: cleanString(repo.url), baseBranch: cleanString(repo.baseBranch) ?? DEFAULT_BASE_BRANCH, branch: cleanString(repo.branch) } // ensureCycleBranch: await this.core.git(["checkout", this.core.branch]);
```
- 수정 제안: Apply isSafeRefname to repo.branch and handoff.branch in parseProject/parseHandoff; fall back to null.
- 검증: projects.ts:188 persists repo.branch via cleanString only; ensureCycleBranch runs `git checkout <branch>` verbatim (repo-publish.ts:235) → corrupted value like `-- .` discards worktree.

### [Low] restorePlan splits name-status on the first tab — quoted filenames containing tabs yield garbage paths and a failed restore
- 위치: packages/daemon/src/repo-paths.ts:39-50 (called from repo-checkpoints.ts:120-158)
- 분류: correctness
- 시나리오: Path containing a tab: name-status emits A\t"a\tb" (C-quoted); indexOf('\t') finds tab inside quote → status '"A', path 'a\tb"'; safeRepoPath passes garbage; git checkout tree -- <garbage> matches nothing → whole checkpointRestore throws.
- 근거:
```
const tab = trimmed.indexOf("\t"); if (trimmed === "" || tab < 0) continue; const status = trimmed.slice(0, tab).trim(); const path = trimmed.slice(tab + 1).trim();
```
- 수정 제안: Split status at first tab; run remainder through unquoteGitPath (or split quoted values at last tab).
- 검증: restorePlan never unquotes C-quoted tab paths (repo-paths.ts:41-44) → garbage pathspec → git checkout fails → whole checkpointRestore throws; indexOf detail wrong, defect real.

### [Low] runOpen early-return guards skip the previous project's teardown, leaving a stale build holding the port
- 위치: packages/daemon/src/handoff-preview.ts:157-161,165-171,174-176
- 분류: leak
- 시나리오: Live build for A; switch to B whose previewCommand resolves null (or tip unresolvable) → runOpen returns at :158/:166 BEFORE slug/branch mismatch check at :174 → A's server keeps port + worktree until 15-min TTL or next successful open.
- 근거:
```
if (!previewCommand) { return notReady(null, ...); } const commit = await tipOf(repoRoot, branch); ... if (this.live && (this.live.slug !== slug || this.live.branch !== branch)) { await this.teardown("넘김이 바뀌었습니다"); }
```
- 수정 제안: Hoist mismatch teardown above the guards.
- 검증: !previewCommand and tipOf-null guards return before the slug/branch mismatch teardown, so the previous project's build holds port+worktree; bounded by 15-min idle TTL or next passing open — Low leak as claimed.

### [Low] open(null) (sessionId omitted on the wire) makes the handoff build unreapable and steals opener ownership
- 위치: packages/daemon/src/handoff-preview.ts:96,100 (wire: packages/protocol/src/messages.ts:433; handler: packages/daemon/src/dispatch.ts:703)
- 분류: correctness
- 시나리오: repo.handoffPreview sessionId optional → open(null) stamps lastOpener/live.opener=null → closeSession(realId) never matches (opener !== sessionId) → worktree+port survive to TTL (lifetime rule 1 void); also steals ownership from previous opener.
- 근거:
```
open(sessionId) { this.lastOpener = sessionId; this.opening ??= this.runOpen().finally(() => { this.opening = null; }); if (this.live) this.live.opener = sessionId; return this.opening; }
```
- 수정 제안: Keep existing opener on null; or make sessionId required.
- 검증: sessionId optional on wire, client omits when falsy, ScreenPanel defaults null without an active session; open(null) stamps live.opener=null so closeSession never matches — TTL-only reap plus ownership theft.

### [Low] claudeHandoffDraft strips the 내용:/body: label only at string start, so a blank line after the title leaks the label into the PR body
- 위치: packages/daemon/src/repo-summary.ts:145-150
- 분류: correctness
- 시나리오: Model answers `제목: X\n\n내용: Y` → body string starts with "\n" → ^(내용|body) anchor fails (no m flag, no \s*) → literal "내용: " ships in PR body draft.
- 근거:
```
const body = lines.slice(first + 1).join("\n").replace(/^(내용|body)\s*[:：]\s*/i, "").trim().slice(0, HANDOFF_BODY_MAX_CHARS);
```
- 수정 제안: Trim before stripping or anchor ^\s*.
- 검증: Blank line after title makes the body string start with \n; anchored ^(내용|body) replace fails (no m flag), .trim() keeps the label — '내용: ' leaks into the PR body draft.

### [Low] Stale 401 from an old-token in-flight request flips authState to expired after a valid token is set
- 위치: packages/daemon/src/github-bridge.ts:57-63,106-121
- 분류: concurrency
- 시나리오: listRepos under old token in flight during setToken(newToken); setToken calls noteAuth(false); old request resolves 401 → wrapper noteAuth(true) → authState 'expired' broadcast though armed token valid. If whoAmI then fails non-401 (offline), nothing resets — false expiry until next successful GitHub read.
- 근거:
```
this.transport = { request: async (input) => { const response = await inner.request(input); this.noteAuth(response.status === 401); return response; } };
```
- 수정 제안: Tag requests with token generation; ignore 401s from superseded generations; or re-verify whoAmI before broadcasting.
- 검증: In-flight old-token request resolving 401 after setToken's noteAuth(false) flips authState to expired despite valid token; only a later non-401 read clears it (github-bridge.ts:57-63,106-121)

### [Low] parseRepoSlug strips .git before trailing slashes — …/repo.git/ parses as repo repo.git
- 위치: packages/daemon/src/github.ts:566-574
- 분류: correctness
- 시나리오: User pastes https://github.com/org/repo.git/ → .git$ doesn't match (ends /) → trailing-slash strip yields org/repo.git → passes charset check → slug {owner:org, repo:repo.git} → every API call 404s; clone/handoff target nonexistent repo.
- 근거:
```
const segments = match[2]!.replace(/\.git$/i, "").replace(/\/+$/, "").split("/");
```
- 수정 제안: Strip trailing slashes before .git suffix.
- 검증: .git suffix stripped before trailing slashes; 'repo.git/' yields repo='repo.git' passing charset check → every API call 404s (github.ts:566-574)

### [Low] github.repo.inspect interpolates unvalidated owner/repo into the API path — '..' segments reach other endpoints
- 위치: packages/daemon/src/github.ts:140-146; dispatch.ts:639-640
- 분류: security
- 시나리오: message.owner/repo straight into /repos/${owner}/${repo} with no charset validation (parseRepoSlug gate only for remote urls). owner='a/b/..' repo='..' → /repos/a/b/../../.. → undici normalizes to other api.github.com path → caller drives authenticated GETs to arbitrary GitHub API endpoints under user's token (GETs, filtered fields).
- 근거:
```
const data = await this.getJson(`/repos/${input.owner}/${input.repo}`, "레포 확인");
```
- 수정 제안: Validate owner/repo ^[\w.-]+$ (reject ./..) in inspectRepo or dispatch boundary.
- 검증: owner/repo interpolated unvalidated into /repos/ path; '..' segments normalize to arbitrary api.github.com GET endpoints under the user's token (github.ts:141,179; dispatch.ts:639-640)

### [Low] migratePlaintextSecrets crashes daemon startup when the settings file parses to null
- 위치: packages/daemon/src/credentials.ts:256-263
- 분류: error-handling
- 시나리오: repo.json contains exactly null → JSON.parse succeeds → parsed = null → parsed[target.secretKey] throws TypeError outside try/catch → migratePlaintextSecrets rejects → server.start() dies before serving.
- 근거:
```
try { parsed = JSON.parse(readFileSync(target.file, "utf8")); } catch { continue; } const secret = parsed[target.secretKey];
```
- 수정 제안: After parse: if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue.
- 검증: repo.json containing literal null parses fine, then parsed['pat'] throws TypeError outside try → migratePlaintextSecrets rejects → server.start dies (credentials.ts:256-263; server.ts:555)

### [Low] mergeNpmrc dedup misses whitespace-padded existing keys — duplicate registry/_authToken lines accumulate
- 위치: packages/daemon/src/credentials.ts:309-316
- 분류: correctness
- 시나리오: ~/.npmrc contains '  //npm.pkg.github.com/:_authToken=old' (leading spaces) → startsWith(key=) fails → old kept AND new appended; npm reads top-down so appended wins, but stale PAT remains forever (secret-hygiene leak after rotation).
- 근거:
```
const kept = existing.split("\n").filter((line) => line.trim() !== "" && !lines.some((entry) => line.startsWith(`${entry.key}=`)));
```
- 수정 제안: Match on line.trimStart().startsWith(key=) or compare trimmed key.
- 검증: Dedup tests line.startsWith(key=); whitespace-padded existing key survives and stale _authToken line persists beside the new one after rotation (credentials.ts:309-316)

### [Low] resolvePnpmExecutable/resolveClaudeExecutable return on existsSync without probing — a broken binary reports 'ready'/'login required'
- 위치: packages/daemon/src/environment.ts:195-213,322-347
- 분류: correctness
- 시나리오: First existsSync-true candidate wins — stale ~/.local/bin/pnpm shim with uninstalled target, or directory named pnpm, beats working pnpm later/on PATH → checkRuntime reports 'pnpm 준비됨' (version probe failure swallowed) while installs fail. Same for claude: non-executable ~/.local/bin/claude shadows Homebrew → 'login required' instead of 'not found'. Git probes --version (gitWorks); pnpm/claude don't.
- 근거:
```
export async function resolvePnpmExecutable() { const platform = currentPlatform(); for (const candidate of pnpmCandidates(platform, homedir())) { if (existsSync(candidate)) return candidate; }
```
- 수정 제안: Probe candidates like gitWorks (--version) or verify file+executable.
- 검증: resolvePnpm/Claude return first existsSync hit with no version probe (unlike gitWorks); broken shim reports 'pnpm 준비됨'/'login required' while real binary is shadowed (environment.ts:195-213,322-347)

### [Low] GitHubFetchTransport.fetch has no timeout — a hung connection stalls onboarding/status for minutes
- 위치: packages/daemon/src/github.ts:662-678
- 분류: error-handling
- 시나리오: fetch with no AbortSignal; black-holed connection (VPN drop, accepting proxy) → undici long default timeouts (~5 min) → whoAmI in github.token.set/checkGitHub and listRepos hang far beyond UI patience instead of failing fast into existing unreachable branch.
- 근거:
```
const response = await fetch(`${this.apiUrl}${input.url}`, { method: input.method, headers: input.headers, body: ... });
```
- 수정 제안: signal: AbortSignal.timeout(15-30s).
- 검증: GitHubFetchTransport.fetch has no AbortSignal; black-holed connection stalls whoAmI/listRepos for undici's ~5min defaults instead of failing into the unreachable branch (github.ts:662-678)

### [Low] fileCache and registryAuthCache are unbounded Maps that never evict
- 위치: packages/daemon/src/environment.ts:266-296,501-566
- 분류: leak
- 시나리오: set(cwd, …) one entry per distinct cwd, only overwrite; TTL gates reads not removal → long-lived daemon touching many roots grows both maps unbounded; fileCache entries hold up to 20k strings each.
- 근거:
```
const fileCache = new Map<string, { files: string[]; readAt: number }>(); const FILE_CACHE_TTL_MS = 15_000; const WALK_FILE_LIMIT = 20_000;
```
- 수정 제안: Evict on access when expired or cap with LRU.
- 검증: fileCache and registryAuthCache are unbounded Maps keyed by cwd; TTL gates reads only, entries never evicted → unbounded growth, up to 20k strings per fileCache entry (environment.ts:266-296,501-566)

### [Low] repoSettingsWarning/sanitizeRepoAgentSettings crash on a corrupt quarantine record's entry shape
- 위치: packages/daemon/src/claude-trust.ts:87-99,165-172
- 분류: error-handling
- 시나리오: readQuarantine validates only record.files is array; entry null or missing removed/originalRaw → entry.removed.join / hash.update(entry.originalRaw) throw → repoSettingsWarning rejects every buildStatus; sanitizeRepoAgentSettings throws inside bring-up.
- 근거:
```
const record = parsed as QuarantineRecord; return Array.isArray(record.files) ? record : null; ... const named = record.files.map((entry) => `${entry.file}(${entry.removed.join(", ")})`).join(" · ");
```
- 수정 제안: Validate each entry's field types; drop malformed entries.
- 검증: readQuarantine validates only files-is-array; malformed entry → entry.file/entry.removed.join throws → sanitize throws at session launch, repoSettingsWarning rejects every buildStatus (claude-trust.ts:87-99,121,165-172)

### [Low] verifyPullRequestAccess maps every 403 to 'check the repo address/token' — rate-limit 403s misdiagnose
- 위치: packages/daemon/src/github.ts:410-419
- 분류: error-handling
- 시나리오: GitHub 403 also for rate limiting; rate-limited token gets '레포 주소가 맞는지, 토큰이…' detail → planner re-checks correct url/token instead of waiting; x-ratelimit-remaining/retry-after headers unread.
- 근거:
```
if (status === 403 || status === 404) { return { ok: false, detail: `...레포에 접근할 수 없습니다...` }; }
```
- 수정 제안: For 403 check rate-limit headers/body; return wait-and-retry detail.
- 검증: Every 403 maps to 'check repo address/token'; rate-limit 403s misdiagnose since x-ratelimit-remaining/retry-after are unread (github.ts:410-419)

### [Low] allowedUpgradeOrigin misses default-port elision — daemon on port 80/443 rejects its own UI's WebSocket
- 위치: packages/daemon/src/server.ts:749-752
- 분류: correctness
- 시나리오: Daemon on port 80: new URL('http://localhost/') elides default port → parsed.port === "" vs String(port) === "80" → strict equality fails → same-origin page daemon itself served gets 403 on WS upgrade; bundled UI can never connect; browsers always send Origin.
- 근거:
```
if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false; const port = this.address().port; const loopback = [...].includes(parsed.hostname); if (loopback && parsed.port === String(port)) return true;
```
- 수정 제안: Normalize default ports in comparison.
- 검증: URL elides default port → parsed.port="" vs String(80) fails (server.ts:749-752); daemon on port 80 403s its own UI's WS upgrade since browsers always send Origin.

### [Low] writesGitHistory false-positives block common read-only git commands
- 위치: packages/daemon/src/session.ts:333-356
- 분류: correctness
- 시나리오: git config user.name (bare key read) → readForm regex only --get*/--list/-l → treated as write → denied. git tag -n5 / -ln → /^-[ln]$/ no match → denied. git branch --merged/--sort=-committerdate/-vv → not in allowed flags → denied. Each denial = permission refusal for harmless read; trains agent that git reads are refused.
- 근거:
```
if (verb === "config") { const readForm = /^(--get(-all|-regexp|-urlmatch|-color|-colorbool)?|--list|-l)$/; if (!tokens.slice(j + 1).some((t) => readForm.test(t))) return true; }
```
- 수정 제안: Only treat value-setting/unset config forms as writes; widen tag/branch read-flag patterns.
- 검증: Read-only forms denied: `git config user.name` (bare read fails readForm regex), `git tag -n5` (fails /^-[ln]$/), `git branch --merged` (not whitelisted) all return GIT_WRITE_REFUSAL. PATH: harmless git read → session.ts:333-356 → permission refusal.

### [Low] Shell indirection bypasses writesGitHistory — bash -c 'git commit', eval, backslash-escaped g\it
- 위치: packages/daemon/src/session.ts:271-294
- 분류: security
- 시나리오: bash -c 'git commit -m x' → quoted string one token, no bare git token → allowed; same sh -c/eval/ssh host. g\it commit → tokenizer doesn't handle backslash → token g\it ≠ git → allowed while shell executes git. Gate only sees literal git tokens in verb position; any wrapper/escape defeats it.
- 근거:
```
} else if (ch === '"' || ch === "'") { quote = ch; } else if (/\s/.test(ch)) { ...
```
- 수정 제안: Detect wrapper commands (bash/sh/zsh/eval/env/ssh with command-string arg) and recurse or refuse; handle \ escapes; or document as guardrail only.
- 검증: Tokenizer only sees literal git tokens; `bash -c 'git commit'` keeps command inside one quoted token, backslash escapes unhandled — guardrail defeated by ordinary shell indirection. PATH: `bash -c 'git commit -m x'` → session.ts:271-294 → allowed, commit executes.

### [Low] interrupt() 'dead' path never resolves pending permission/question requests
- 위치: packages/daemon/src/session.ts:1203-1224
- 분류: error-handling
- 시나리오: Permission card open → 중지 → agent.interrupt() returns 'dead' → dead-path cleanup runs dropHeld() and setState('closed') but never resolves this.pending (unlike settleTransport()/close()) → driver's decidePermission promise hangs until session close; pendingReplays() keeps returning stale card to reconnecting clients in the window.
- 근거:
```
this.aborted = true; if (!this.closed) { const hadTurn = this.turnStartedAt !== null; this.interrupting = false; this.turnStartedAt = null; this.dropHeld(); ... this.setState("closed"); }
```
- 수정 제안: Resolve this.pending with deny (as settleTransport/close do) before setState('closed').
- 검증: Dead path sets aborted/dropHeld/closed but never resolves this.pending (unlike close/settleTransport); stale card replays to reconnecting clients via pendingReplays→server.ts:831. PATH: card open→stop→interrupt 'dead' → session.ts:1203-1230 → pending leaks, driver promise hangs.

### [Low] permissionSignature JSON fallback collapses all object/array values to [object Object] — different tool calls share one 항상 허용 signature
- 위치: packages/daemon/src/session.ts:101-114
- 분류: correctness
- 시나리오: Tool input with object/array params ({config:{a:1}} vs {config:{b:2}}) → signature tool:json:config=[object Object] for both → 항상 허용 on first silently auto-allows second, a different call planner never approved. Docstring promises 'this exact call never prompts again — different command or path still does' — violated for structured inputs.
- 근거:
```
const keys = Object.keys(input).sort(); return `${toolName}:json:${keys.map((key) => `${key}=${String(input[key])}`).join("|")}`;
```
- 수정 제안: Serialize nested values structurally (JSON.stringify with sorted keys).
- 검증: String({...})='[object Object]' collapses distinct structured inputs to one signature; 항상 허용 on first auto-allows a different call, violating the docstring's exact-call promise. PATH: tool input {config:{a:1}} then {config:{b:2}} → session.ts:113 → identical signature.

### [Low] A throwing event listener wedges the session in running forever — send()/deliver()/release() perform turn side-effects without isolation
- 위치: packages/daemon/src/session.ts:1101-1130, 1136-1195
- 분류: error-handling
- 시나리오: send() sets turnStartedAt, setState('running') → events.onState (or onPinned/onEvent inside deliver) throws → exception propagates out of send() before agent.send() invoked → no turn exists, no turn.end will arrive → turnStartedAt stays non-null, state running permanently; every subsequent send() queued into held, never released. Same exposure in release() (~696-708): throw between splice and deliver loses batch.
- 근거:
```
this.turnStartedAt = Date.now(); this.setState("running"); this.deliver(item); } private deliver({ text, images, pins }) { this.interrupting = false; if (pins.length > 0) this.events.onPinned?.(this.id, pins);
```
- 수정 제안: Wrap listener calls so throwing subscriber can't abort state machine; or wrap deliver in try/catch synthesizing error turn.end.
- 검증: send()/release() set turnStartedAt+running before listener calls (onPinned/onEvent) that can throw → no turn exists, no turn.end arrives → permanent running, later sends held forever; release splice loses batch. PATH: throwing onState/onPinned → session.ts:1123-1127,:699-705 → wedged session.

### [Low] trim() loses lines appended by other processes between load and rename
- 위치: packages/daemon/src/undo-log.ts:75-81 (same pattern permission-log.ts:94-104)
- 분류: concurrency
- 시나리오: lines loaded once at construction; trim() rewrites from in-memory snapshot via tmp+rename — lines appended by another process (second daemon, test sharing COLO_DESIGN_UNDO_LOG, restarted daemon) since load are silently discarded. Events lost without error.
- 근거:
```
private trim(): void { this.lines = this.lines.slice(Math.floor(MAX_LINES / 2)); const temporary = `${this.file}.colo-design-${process.pid}`; writeFileSync(temporary, ...); renameSync(temporary, this.file); }
```
- 수정 제안: Re-read and merge newer lines before rewrite, or append-only trim.
- 검증: trim() rewrites from the constructor-time snapshot (undo-log.ts:75-81); lines appended by another process sharing COLO_DESIGN_UNDO_LOG since load are silently dropped on rewrite; rare (single-process daemon, shared env var) → Low.

### [Low] list() cache ignores `limit` — a limit=1 scan poisons the shared cache for limit=50 callers
- 위치: packages/daemon/src/session-manager.ts:362-398 (caller project-fleet.ts:198)
- 분류: correctness
- 시나리오: disk/scanning keyed only by cwd; scan passes limit to each store. project-fleet.ts:198 calls list(cwd, 1) for tape anchoring; if first scan, disk permanently seeded with ≤1 row/driver; later list(cwd, 50)/refreshThreads(cwd, 50) serve 1-row cache (compounded by never-rescan defect).
- 근거:
```
const scan = Promise.all(this.drivers.all().map((driver) => driver.store?.list(cwd, limit).catch(() => []) ?? []))...
```
- 수정 제안: Scan with max limit (50) and slice per-call, or key cache by limit.
- 검증: scan is keyed by cwd only and bakes per-call limit into the shared disk cache (:380,384); project-fleet.ts:198 list(cwd,1) as first scan seeds a 1-row cache all later list(cwd,50) callers serve (compounded by A-1) → Low.

### [Low] saveProjectsFile skips the fsync its own sibling store treats as mandatory for atomic replaces
- 위치: packages/daemon/src/projects.ts:246-255
- 분류: error-handling
- 시나리오: Registry documented as 'the only thing that survives a restart' with 'a bad write must never be the last one on disk' — uses writeFileSync + renameSync without fsyncSync, the exact gap queue-store.ts:137-140 fixes with a comment about power loss leaving a name with no content. Power cut right after save → empty/unflushed projects.json → loadProjectsFile backs up junk .corrupt and starts empty (or ENOENT re-migrates) → every project row lost (handoff PR state, branch, commentsSince) though .bak copied from same unflushed lineage.
- 근거:
```
projects.ts:251-255 writeFileSync(temporary, ...); renameSync(temporary, path); (no fsync) vs queue-store.ts:139-140 writeSync(fd, ...); fsyncSync(fd);
```
- 수정 제안: fsyncSync temp file (and directory) before renameSync, matching queue-store discipline.
- 검증: saveProjectsFile (:246-255) omits fsyncSync that queue-store.ts:149-152 documents as mandatory for atomic replaces; power cut right after save can leave unflushed projects.json → registry rows lost despite .bak being copied from the same unflushed lineage.

### [Low] notification-click session/project messages can be lost or delivered stale
- 위치: packages/desktop/src/windows.ts:152-167,179-188,205-214
- 분류: correctness
- 시나리오: (a) focusMain/focusProject attach once('did-finish-load'); if load fails (did-fail-load), listener survives → NEXT successful load receives stale sessionId → wrong conversation. (b) reopen() clears pending slots then sends after fixed 1200ms; if loadURL failed or renderer listener attaches later → message gone, slot cleared.
- 근거:
```
if (window.webContents.isLoading()) { window.webContents.once("did-finish-load", () => { setTimeout(() => { if (window.isDestroyed()) return; window.webContents.send(OPEN_PROJECT_CHANNEL, slug); }, 1200); }); }
```
- 수정 제안: Remove once-listener on did-fail-load; re-queue pending message or keep until renderer ack.
- 검증: once('did-finish-load') survives did-fail-load → stale sessionId sent on next successful load; reopen clears pending slots then sends after fixed 1200ms into possibly-failed page.

### [Low] preview:bounds accepts NaN/Infinity — typeof check passes, setBounds throws or stores NaN
- 위치: packages/desktop/src/preview-view.ts:1292-1309 (setBounds 417-425)
- 분류: error-handling
- 시나리오: Structured clone preserves NaN/Infinity; typeof NaN === 'number' passes field check (epoch guard exists two handlers up). setBounds stores Math.round(NaN)=NaN into this.bounds; view.setBounds throws inside ipcMain handler → renderer invoke rejects (unhandled rejection in NativeHost fire-and-forget); openTab's bounds.width <= 0 mis-evaluates on NaN.
- 근거:
```
if (input && typeof input === "object" && ["x", "y", "width", "height"].every((key) => typeof input[key] === "number")) { const rect = input; view.setBounds(rect); }
```
- 수정 제안: Add Number.isFinite to per-field check.
- 검증: typeof NaN==='number' passes field check; setBounds stores Math.round(NaN) → hasBounds() false → openTab falls back to OS browser; sibling mount handler explicitly guards NaN (:1282).

### [Low] preview:mount returns {ok:true} when the mount was refused — renderer cannot tell the pane is empty
- 위치: packages/desktop/src/preview-view.ts:1275-1287
- 분류: contract
- 시나리오: view.mount silently returns for non-loopback-http url; handler returns {ok:true} for refusal and malformed input alike. NativeHost flow mount().then(() => open(target.path)) → open no-ops on !activePage → pane blank, no error surfaced.
- 근거:
```
ipcMain.handle("preview:mount", (_event, input) => { if (!input || typeof input !== "object" || !("url" in input) || typeof input.url !== "string") { return { ok: true }; } ... view.mount(input.url, epoch); return { ok: true }; });
```
- 수정 제안: Return refused/failed result so web can show stopped/error state.
- 검증: view.mount silently returns for non-loopback url (:284); handler returns {ok:true} for refusal and malformed input alike (:1277,1286); renderer cannot tell pane is empty.

### [Low] preload mount() accepts an `origins` arg that the IPC handler drops — dead contract parameter
- 위치: packages/desktop/src/preload.ts:47-48 (handler preview-view.ts:1285)
- 분류: contract
- 시나리오: Preload mount(url, epoch, origins?) forwards origins; handler reads only url/epoch; PlannerPreviewView.mount(url, epoch) has no third param → declared-origins allow-list silently discarded. pane-unit-entry.mjs:126 still calls view.mount(url, null, [a, b]) believing it replaces allow list.
- 근거:
```
mount: (url: string, epoch: number | null, origins?: string[]) => ipcRenderer.invoke("preview:mount", { url, epoch, origins }),
```
- 수정 제안: Wire origins into view.mount or remove parameter + stale test call.
- 검증: preload mount forwards origins (preload.ts:47-48); handler reads only url/epoch; PlannerPreviewView.mount has no third param; pane-unit-entry.mjs:126 still passes [a,b] believing it replaces allow list.

### [Low] desktop:open-home reports success even when shell.openPath fails
- 위치: packages/desktop/src/bridge.ts:33-42
- 분류: error-handling
- 시나리오: shell.openPath resolves with non-empty error string on failure (never rejects); handler ignores return, always answers {opened: path} → settings UI says folder opened when nothing happened (deleted dir, sandbox denial).
- 근거:
```
if (target === "logs") { mkdirSync(deps.logsDir, { recursive: true }); await shell.openPath(deps.logsDir); return { opened: deps.logsDir }; }
```
- 수정 제안: Check resolved string; return {error} on failure.
- 검증: shell.openPath resolves non-empty error string on failure, never rejects; bridge.ts:37-41 ignores return and always answers {opened} — false success on deleted dir/sandbox denial.

### [Low] renderOverlay sweeps the in-flight region-drag selection box
- 위치: packages/desktop/src/preview-preload.ts:761-765 (drag.box created 648-652)
- 분류: correctness
- 시나리오: During region drag, colo-overlay:pins sync (any renderOverlay) removes every root child except hover/toasts/flashRing; drag.box not in keep-list → selection square vanishes mid-gesture while drag.box points at detached node; mousemove styles orphaned node; mouseup removes node already gone.
- 근거:
```
function renderOverlay(): void { for (const child of [...root.childNodes]) { if (child === hover || child === toasts || child === flashRing) continue; child.remove(); }
```
- 수정 제안: Add child === drag?.box to keep-list or null out drag.box when removed.
- 검증: renderOverlay keep-list (:763) omits drag.box created at :648-652; pins sync mid-drag detaches selection box; mousemove styles orphaned node; mouseup remove() no-ops.

### [Low] describeHtml serializes the whole subtree before the 1500-char cap
- 위치: packages/desktop/src/preview-preload.ts:78-90
- 분류: performance
- 시나리오: Alt+click on top-level wrapper (body/html): cloneNode(true) deep-clones subtree, outerHTML serializes ALL (potentially MBs) before slicing to 1500 → allocation+serialization cost on every pick of large subtree, janks renderer.
- 근거:
```
const clone = element.cloneNode(true); ... const html = clone.outerHTML; return html === "" ? undefined : html.length > 1500 ? `${html.slice(0, 1500)}…` : html;
```
- 수정 제안: Cap by depth/child-count before serializing or serialize incrementally.
- 검증: describeHtml cloneNode(true)+outerHTML serializes whole subtree (body pick potentially MBs) before 1500-char slice — allocation/serialization jank on every large-element pick.

### [Low] cssPath interpolates raw id and data-screen values into a selector — unparseable path silently loses the badge
- 위치: packages/desktop/src/preview-preload.ts:41-59 (consumed at 856)
- 분류: correctness
- 시나리오: id with whitespace/specials (id='foo bar') → div#foo bar (matches nothing); data-screen with quote → invalid selector. Next pins sync: querySelector(pin.path) throws (caught) or matches nothing → pin badge never re-anchors, silently disappears though element exists.
- 근거:
```
const index = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ""; const id = node.id ? `#${node.id}` : ""; parts.unshift(`${tag}${id}${index}`); ... return [`div[data-screen="${root.getAttribute("data-screen")}"]`, ...parts].join(" > ");
```
- 수정 제안: Escape interpolated values (CSS.escape).
- 검증: id='foo bar' → 'div#foo bar' matches nothing; quoted data-screen → querySelector throws (caught at :857); badge silently never re-anchors though element exists.

### [Low] window.coloDesign.post exposed on every page incl. external sites — unbounded IPC payload reaches main before the kind check
- 위치: packages/desktop/src/preview-preload.ts:225-227 (drop at preview-view.ts:904-909)
- 분류: security
- 시나리오: Preload runs on every page pane visits incl. external sites; window.coloDesign.post(envelope) lets any page fire ipcRenderer.send('colo-overlay:post', ...) with unbounded payload; main drops only AFTER receipt (page?.kind !== 'preview') → malicious page can flood main with large structured clones (memory/CPU); kind check prevents pin injection but not IPC abuse.
- 근거:
```
contextBridge.exposeInMainWorld("coloDesign", { post: (envelope: unknown) => ipcRenderer.send("colo-overlay:post", envelope), });
```
- 수정 제안: Size/type-cap envelope in preload; gate on location at post time.
- 검증: contextBridge exposes coloDesign.post on every page incl. external sites; unbounded structured clone reaches main before kind check at :909 — IPC flood/memory surface, pin injection blocked but abuse not.

### [Low] colo-overlay:pins handler crashes on a null pin entry — badge sync dead until next sync
- 위치: packages/desktop/src/preview-preload.ts:819-825
- 분류: error-handling
- 시나리오: rows checked with Array.isArray but entries not: null/undefined element → pin.screen throws inside flatMap → whole listener dies with uncaught exception, badges keeps stale list → every subsequent pin projection wrong until clean sync.
- 근거:
```
const rows = Array.isArray(sync?.pins) ? sync.pins : []; badges = rows.flatMap((pin, index): Badge[] => { if (pin.screen !== here.screen || pin.state !== here.state) return [];
```
- 수정 제안: Skip non-object entries before reading fields.
- 검증: Array.isArray checks rows not entries; null pin → pin.screen throws inside flatMap (:825) → whole sync dropped, badges stay stale until next clean sync.

### [Low] PaneCaptureDriver.destroy releases the shared PaneBrowserDriver globally, killing an in-flight agent op's debugger attach despite the 'only what I attached' contract
- 위치: packages/desktop/src/preview-driver.ts:1577-1581, 776-782, 1494-1497
- 분류: concurrency
- 시나리오: preview.capture (HTTP op, not on session's serialized op queue) runs while agent op starts between capture's attachActive (attachedByMe=true) and destroy(). Agent op finds debugger attached, proceeds; capture destroy → release() detaches debugger under agent's in-flight CDP commands ('not attached' spurious failure) and sweeps agent's keepAlive intervals → long evaluate loses keeper until next armIdleDetach.
- 근거:
```
/** 캡처 뒤엔 자기가 붙인 디버거만 뗀다 */ async destroy(): Promise<void> { if (this.attachedByMe) this.browser.releasePage(); this.attachedByMe = false; } // releasePage → release(): sweeps ALL idleDetach timers, ALL keepAlive intervals, unbind→debugger.detach()
```
- 수정 제안: Scope release to the attach it created (generation counter) or only clear timers/attachment when no session op in flight.
- 검증: preview.capture skips op queue; capture-first attach then destroy→release() detaches debugger under concurrent agent op and sweeps its keepAlive. Narrow race.

### [Low] select() reports false success for value "" when no empty option exists, defeating its missing-option guard
- 위치: packages/desktop/src/preview-driver.ts:1229-1246
- 분류: correctness
- 시나리오: select({ref, value:""}) on <select> without empty-valued option: setter sets selectedIndex -1, el.value "" → guard "" !== "" passes → tool reports success ('picked: ""') though no option matched — defeats the guard built to prevent silent success.
- 근거:
```
const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; setter.call(el, value); ... if (value?.picked !== target.value) { throw new Error(`${target.ref} 에 그런 option 이 없습니다: ${target.value}`); }
```
- 수정 제안: Verify requested value exists in el.options before assigning; report not-found for empty string too.
- 검증: select("") on select without empty option: selectedIndex=-1 makes el.value ""===target "", guard passes, false success — guard's intent defeated.

### [Low] preview:bounds accepts non-finite numbers — the NaN hole the same file explicitly fixed for epoch
- 위치: packages/desktop/src/preview-view.ts:1292-1309 (contrast epoch fix 1279-1284)
- 분류: error-handling
- 시나리오: Slot-measurement bug or corrupted layout message posts preview:bounds with width: NaN (structured clone preserves NaN; typeof NaN === 'number' passes guard — exact trap author documented and fixed for epoch four handlers earlier). view.setBounds({width:NaN}) throws 'Error processing argument' inside ipcMain.handle → invoke rejects; this.bounds never updated; pane keeps stale/unsized slot while renderer believes assertion landed.
- 근거:
```
if (input && typeof input === "object" && ["x", "y", "width", "height"].every((key) => typeof input[key] === "number")) { ... view.setBounds(rect); }
```
- 수정 제안: Apply Number.isFinite test (used for epoch) to all four bound fields.
- 검증: NaN passes typeof guard :1296 → this.bounds poisoned, hasBounds() false; identical trap explicitly fixed for epoch at :1282.

### [Low] Feed-controlled version used unvalidated in filesystem paths (path traversal, write-before-verify)
- 위치: packages/desktop/src/self-update.ts:82,103; app-updates.ts:432,443; protocol/src/update.ts:91
- 분류: security
- 시나리오: latest.json version with path separators passes typeof-string check → join(downloadsDir, `colo-design-${version}.zip`) normalizes '..' outside downloads → downloadFile writes there BEFORE sha256 verification; same for 0o755 swap script path.
- 근거:
```
if (!parsed || typeof parsed.version !== "string") throw ...; const filename = `colo-design-${input.version}.zip`; downloadPath: join(input.downloadsDir, filename)
```
- 수정 제안: Validate version against semver regex in fetchLatest; reject plan paths whose dirname escapes downloadsDir/temp.
- 검증: feed version only typeof-string checked (update.ts:91); join() at self-update.ts:82/86 and app-updates.ts:432/443 normalizes .. escapes; downloadFile (:385) writes before verifyDownload (:386). Requires feed compromise — marginal gain, hence Low.

### [Low] reportSwapResult trusts user-writable update-result.json — fake completion report and openPath on arbitrary path
- 위치: packages/desktop/src/app-updates.ts:189-216
- 분류: security
- 시나리오: Local process plants ~/.colo-design/update-result.json → next launch shows update-failed notification whose click runs shell.openPath(arbitrary path); outcome=done with matching version yields fake success notification; logPath unvalidated before opening.
- 근거:
```
void this.deps.notify("업데이트하지 못했습니다", ..., () => { void shell.openPath(result.logPath); });
```
- 수정 제안: Constrain logPath to expected temp log path before openPath.
- 검증: parseSwapResult accepts any string logPath (self-update.ts:47-53); reportSwapResult passes it unvalidated to shell.openPath on notification click (app-updates.ts:209-214); planted update-result.json yields fake failure/success reports. Local-process prerequisite → Low.

### [Low] macOS swap script reports 'rolled back' even when rollback failed
- 위치: packages/desktop/src/mac-self-update.ts:87-100
- 분류: error-handling
- 시나리오: mv of new bundle fails AND restore mv of backup also fails (disk full past 1 GiB pre-check, permissions) → script unconditionally writes '이전 버전으로 되돌렸습니다' while /Applications/Colo Design.app no longer exists — false report suppresses recovery action.
- 근거:
```
if mv "$BACKUP" "$TARGET"; then echo 복원; else echo "복원 실패"; fi; write_result ...("새 앱 배치에 실패해 이전 버전으로 되돌렸습니다")
```
- 수정 제안: Track rollback success; emit two distinct failure messages.
- 검증: mac-self-update.ts:64-69: when both mv "$SRC" "$TARGET" and restore mv "$BACKUP" "$TARGET" fail, script still writes '이전 버전으로 되돌렸습니다' though $TARGET no longer exists — false report hides the stranded backup.

### [Low] session.rewind has no pins field — rewound 화면 turn loses screen-gate inputs
- 위치: packages/protocol/src/messages.ts:124-131
- 분류: contract
- 시나리오: Turn sent with pins records via onPinned as gate inputs; rewind sends text/images only → deliver runs pins:[] → onPinned never fires → gate skips verification for re-asked turn; client can't recover pins (Transcript excludes marker text from rewind seed).
- 근거:
```
type: z.literal("session.rewind"), sessionId: z.string().min(1), turn: z.number().int().positive(), text: z.string().min(1), images: z.array(...).optional()
```
- 수정 제안: Add optional pins array or derive from rewound turn's marker.
- 검증: rewind schema lacks pins; manager.rewind re-sends text/images only (session-manager.ts:543,554,658) → onPinned never fires → gate skips re-asked turn.

### [Low] session.send accepts text:"" with no attachments — empty prompt delivered to agent
- 위치: packages/protocol/src/messages.ts:51-61
- 분류: contract
- 시나리오: text ' ' with no images/pins passes validation → dispatch.ts:306 carrier.send('') → deliver starts turn → agent.send({text:'',images:[]}) → provider 400 (Anthropic empty text) or content-free turn; UI shows running turn ending in error card.
- 근거:
```
type: z.literal("session.send"), sessionId: z.string().min(1), text: z.string(), images: z.array(...).optional()
```
- 수정 제안: Require non-empty text OR non-empty images/pins; or refuse all-empty send in daemon.
- 검증: text:z.string() admits ""; dispatch.ts:306→session.ts:1159 delivers empty prompt; only web composer guards it, wire boundary does not.

### [Low] readTurn reinterprets planner-typed text as machine card
- 위치: packages/protocol/src/turn-marker.ts:166-168,240-258
- 분류: correctness
- 시나리오: User types/pastes message starting with well-formed <!-- colo-design:<kind> {json} --> → MARKER matches → transcript renders machine card swallowing sentence; session.ts:1152 treats as machine turn (no titling); no escape mechanism.
- 근거:
```
const MARKER = /^<!--\s*colo-design:([a-z]+)\s+(\{[^\n]*\})\s*-->\n?/; ... if (!match || !kind || !json || !isKind(kind)) return { marker: null, body: text };
```
- 수정 제안: Sentinel field only markTurn emits.
- 검증: MARKER matches any leading well-formed marker; user-typed marker renders as MachineTurn (Transcript.tsx:299), skips titling (session.ts:1152); no escape.

### [Low] toolLabel strips MCP prefix at LAST __ — truncates names containing __
- 위치: packages/protocol/src/tool-names.ts:36-40
- 분류: correctness
- 시나리오: mcp__server__my__tool → bare 'tool'; collision with built-in (mcp__x__do__Bash → Bash) mislabels third-party MCP tool as 명령 실행 on permission cards — misrepresents what planner approves.
- 근거:
```
const bare = name.startsWith("mcp__") ? name.slice(name.lastIndexOf("__") + 2) : name; return NAMES[bare] ?? name;
```
- 수정 제안: Split at first __ after mcp__ prefix (indexOf("__", 4)) or strip only when remainder maps to known name.
- 검증: lastIndexOf("__") truncates mcp__s__my__tool→"tool"; mcp__x__do__Bash→"Bash"→명령 실행 mislabels third-party tool on permission cards.

### [Low] github.token.set accepts whitespace-only token — stored verbatim, later 401s read as 'token expired'
- 위치: packages/protocol/src/messages.ts:513-517
- 분류: contract
- 시나리오: '   ' passes min(1); GitHubBridge.setToken persists to OS store; every GitHub call 401s → githubAuthExpired true → misleading 만료 카드 though token never valid; web form trims but schema is boundary for non-web clients.
- 근거:
```
type: z.literal("github.token.set"), token: z.string().min(1).nullable(),
```
- 수정 제안: z.string().trim().min(1).nullable().
- 검증: min(1) passes whitespace; setToken persists verbatim (github-bridge.ts:108); 401s flip authState→expired → 만료 card for never-valid token.

### [Low] takeLost drops pins on truncated path (daemon side, QueuedSendPayload contract)
- 위치: packages/daemon/src/queue-store.ts:183-189
- 분류: contract
- 시나리오: Lost send with pins + >8MB images: budget() keeps pins but sets truncated; takeLost early return {text,images:[]} omits pins while non-truncated path restores them → 되살리기 re-sends without gate inputs, screen verification silently skipped — regression QueuedSendPayload.pins exists to prevent.
- 근거:
```
if (item.truncated) return { text: item.text, images: [] }; return { text: item.text, images: item.images, ...(item.pins?.length ? { pins: item.pins } : {}) };
```
- 수정 제안: Include pins in truncated early return — pins are metadata, not byte budget.
- 검증: budget() keeps pins when truncating images (queue-store.ts:75) but takeLost:183 early return drops them while :188 restores — asymmetric gate-input loss.

### [Low] pr_watch reports a merged PR as 'closed without merge' once >10 newer merges exist
- 위치: scripts/pr_watch.py:254-266
- 분류: correctness
- 시나리오: Session starts after >10 other merges → gh pr list --state merged --limit 10 no longer contains watched PR → '반영 없이 닫혔어요 — 필요하면 다시 만들게요' for a PR that shipped → duplicate PR risk.
- 근거:
```
merged = gh_json(["pr", "list", "-R", slug, "--state", "merged", "--limit", "10", ...]); if n in merged_titles: ... else: messages.append(f"❌ …반영 없이 닫혔어요…")
```
- 수정 제안: Query specific PR per vanished known PR.
- 검증: merged --limit 10 evicts watched PR after >10 newer merges; merged PR reported closed

### [Low] pr_watch has no top-level exception guard despite its 'never block session start' contract
- 위치: scripts/pr_watch.py:138-301 (e.g. 166,173,258)
- 분류: error-handling
- 시나리오: Docstring promises quiet exit 0 on any failure but main() unguarded: p.get('author',{}).get('login') AttributeError on author:null (deleted/ghost accounts, also c.get('user',{}) 221/230); int(n_str) ValueError on corrupt state key → traceback + exit 1 from SessionStart hook.
- 근거:
```
detailed = [p for p in prs if not is_bot(p.get("author", {}).get("login"))] ... n = int(n_str)
```
- 수정 제안: try/except around main(); (p.get('author') or {}).get('login').
- 검증: main() unguarded vs quiet-exit-0 contract; author:null AttributeError, int(n_str) ValueError

### [Low] daemon package declares a `bin` that is not executable — no shebang in dist/index.js
- 위치: packages/daemon/package.json:27-29 (src/index.ts:1)
- 분류: contract
- 시나리오: bin colo-design-daemon → dist/index.js has no shebang (verified: begins with import) → invoking linked bin fails exec-format/EACCES; only node dist/index.js works.
- 근거:
```
"bin": { "colo-design-daemon": "./dist/index.js" } / // src/index.ts line 1: import { randomBytes } from "node:crypto";
```
- 수정 제안: Add #!/usr/bin/env node as first line (tsc carries it) or drop bin.
- 검증: bin points at dist/index.js with no shebang; direct exec fails

### [Low] biome `files.includes` silently excludes .github/renovate.json
- 위치: biome.json:9
- 분류: config
- 시나리오: includes [packages/**, scripts/**, *.json, *.mjs] — *.json matches only repo-root JSON → .github/renovate.json never parsed/formatted; syntax error surfaces only when renovate runs.
- 근거:
```
"files": { "includes": ["packages/**", "scripts/**", "*.json", "*.mjs"] }
```
- 수정 제안: Add .github/** to includes.
- 검증: biome includes exclude .github/renovate.json; verified Checked 0 files

### [Low] desktop build renames preload.js.map to preload.cjs.js.map — sourceMappingURL left dangling
- 위치: packages/desktop/package.json:10
- 분류: correctness
- 시나리오: tsc emits dist/preload.js with sourceMappingURL=preload.js.map; rename produces preload.cjs + preload.cjs.js.map → .cjs points at preload.js.map which no longer exists; map's file field still preload.js → preload source maps never resolve in DevTools.
- 근거:
```
"build": "tsc -p tsconfig.json && tsc -p tsconfig.preload.json && node -e \"…renameSync…\""
```
- 수정 제안: Rename js.map → .cjs.map and rewrite sourceMappingURL inside .cjs.
- 검증: preload rename leaves dangling sourceMappingURL and stale map file field

### [Low] release publish step fails outright on lightweight v* tags
- 위치: .github/workflows/desktop-release.yml:204
- 분류: error-handling
- 시나리오: Lightweight tag (git tag v0.3.11, no -a) → build jobs succeed → publish step NOTES=$(git cat-file tag …) fails (ref points at commit not tag object) under set -euo pipefail → step dies → no release for valid version tag.
- 근거:
```
set -euo pipefail; NOTES=$(git cat-file tag "$TAG" | sed '1,/^$/d')
```
- 수정 제안: Guard extraction with fallback to default notes.
- 검증: git cat-file tag exits 128 on lightweight tags; publish step dies under pipefail

### [Low] test-parallel runs a lane twice when the same lane id is passed twice
- 위치: scripts/test-parallel.mjs:124-125
- 분류: correctness
- 시나리오: node scripts/test-parallel.mjs L5 L5 → laneIds keeps both → two runLane('L5') concurrently → same fixed ports, userData dirs, same log file appended by both → interleaved logs and flaky collisions.
- 근거:
```
const laneIds = requested.length > 0 ? requested : Object.keys(LANES).filter((id) => id !== "L4");
```
- 수정 제안: Dedupe [...new Set(requested)] or reject duplicates.
- 검증: duplicate lane ids run lane twice concurrently; shared ports/userData/logs collide

### [Low] desktop `typecheck` (the pre-push gate) never checks the preload sources
- 위치: packages/desktop/package.json:11 + tsconfig.json:14
- 분류: config
- 시나리오: pnpm -r typecheck runs tsc -p tsconfig.json --noEmit which excludes src/preload.ts and src/preview-preload.ts; nothing imports them → type errors in two shipped preload files pass typecheck and pre-push, surface only at build/CI.
- 근거:
```
"typecheck": "tsc -p tsconfig.json --noEmit" / "exclude": ["src/preload.ts", "src/preview-preload.ts"]
```
- 수정 제안: Extend typecheck to also run tsc -p tsconfig.preload.json --noEmit.
- 검증: desktop typecheck excludes both preload sources; type errors pass pre-push

### [Low] runtime-gate tests leak a stub-node PATH prefix and temp dirs for the rest of the suite
- 위치: packages/daemon/test/onboarding.test.mjs:439-463, 465-488 (also 416-437 dir leak)
- 분류: test
- 시나리오: Test sets process.env.PATH=nodeBin+previousPath but finally restores only COLO_DESIGN_EXTRA_PATH; nodeBin holds working node v20.11.0 + pnpm stubs; dir never rmSync'd → later tests resolving node/pnpm via PATH silently get stubs (latent false-pass/fail, currently masked). Test at 465 also sets PATH (:480) never restores; neither removes workdir. Deviates from file's own save/restore convention (54-119, 166-195).
- 근거:
```
process.env.COLO_DESIGN_EXTRA_PATH = ""; const previousPath = process.env.PATH; process.env.PATH = `${nodeBin}:${previousPath}`; const step = await checkRuntime(() => Promise.resolve(pnpm)); ... } finally { if (previousExtra === undefined) delete process.env.COLO_DESIGN_EXTRA_PATH; else process.env.COLO_DESIGN_EXTRA_PATH = previousExtra; }
```
- 수정 제안: Capture previousPath before try, restore in finally; rmSync(dir) in finally.
- 검증: Leak real: old-node (439-463) and bundled (465-488) tests never restore PATH and no runtime-gate test rmSyncs workdir; but node --test per-file process isolation caps blast radius to onboarding.test.mjs, whose later tests are unaffected — latent hygiene, currently zero outcome change → Low.

### [Low] 'empty machine' onboarding test doesn't scrub COLO_DESIGN_EXTRA_PATH — non-hermetic false-fail
- 위치: packages/daemon/test/onboarding.test.mjs:52-121
- 분류: test
- 시나리오: Empties PATH/HOME, pins GIT_BIN, never clears EXTRA_PATH; resolveNodeVersion (environment.ts:227-240) searches EXTRA_PATH first → on host with bundled node>=22, detail differs → assert.match(/Node\.js 22 이상이 필요합니다/) false-fails despite correct code.
- 근거:
```
process.env.HOME = dir; process.env.PATH = join(dir, "empty-bin"); process.env.COLO_DESIGN_GIT_BIN = join(dir, "no-git"); delete process.env.COLO_DESIGN_CLAUDE_BIN; ... assert.match(runtime.detail, /Node\.js 22 이상이 필요합니다/);
```
- 수정 제안: Save/clear/restore COLO_DESIGN_EXTRA_PATH with the others.
- 검증: checkRuntime (onboarding.ts:170) calls resolveNodeVersion with process.env; environment.ts searches COLO_DESIGN_EXTRA_PATH first; host with bundled node>=22 gives '앱에 포함됨' detail → assert false-fails on correct code.

### [Low] logged-out CLI stub uses a fixed shared tmpdir path, never cleaned — concurrent-run flake
- 위치: packages/daemon/test/platform.test.mjs:173-189
- 분류: test
- 시나리오: Fixed stubDir name (not mkdtempSync): concurrent node --test runs interleave writeFileSync/chmodSync on same claude file → ETXTBSY/truncated stub → flaky false-fail; stale stub from older revision picked up; dir never removed.
- 근거:
```
const stubDir = join(tmpdir(), "colo-design-platform-logged-out"); mkdirSync(stubDir, { recursive: true }); const stub = join(stubDir, "claude"); writeFileSync(stub, [...].join("\n")); chmodSync(stub, 0o755);
```
- 수정 제안: mkdtempSync + rmSync in finally.
- 검증: Fixed shared tmpdir, no mkdtemp/cleanup; same-user temp shared across worktrees → concurrent runs interleave write/stub-execution → truncated script → flaky false-fail. (ETXTBSY cannot fire for #!/bin/sh scripts; truncated-read mechanism carries the finding.)

### [Low] fast-mode stub seeds dead state — 'blocked reason cleared' claim never asserted
- 위치: packages/daemon/test/fast-mode.test.mjs:15-46
- 분류: test
- 시나리오: fastSession() seeds fastMode/fastModeBlocked fields that setFastMode/readFastMode (session.ts:400-416) never read/write — real class lacks them. Test titled '막힌 사유는 그 자리에서 지워진다' asserts only seen.flags → regression in blocked-reason clearing passes silently. Same at :42.
- 근거:
```
const stub = { run: { applyFlagSettings: async (s) => { seen.flags.push(s); } }, hooks: { onFastMode: (on, blocked) => { seen.fastMode.push({ on, blocked }); } }, fastMode, fastModeBlocked }; ... await stub.setFastMode(true); assert.deepEqual(seen.flags, [{ fastMode: true }], "…");
```
- 수정 제안: Drop dead fields and retitle, or assert fastModeBlocked post-call.
- 검증: setFastMode pure forward to applyFlagSettings (driver session.ts:402-404), no fastMode/fastModeBlocked fields — stub seeds dead state; titled clearing contract exists only in src/session.ts:1304, no test exercises it (grep) — deleting it passes suite while row reports contract verified. Same at :42.

### [Low] 'unknown review id refused' passes on any error, including a non-refusal
- 위치: packages/daemon/test/publish-e2e.mjs:922-932
- 분류: test
- 시나리오: catch on ANY thrown error sets unknownRefused=true — daemon forwarding id 999 to GitHub fixture (errors), crashing, or stalling past 120s all satisfy; contract 'refuses unknown ids rather than guessing' never verified.
- 근거:
```
let unknownRefused = false; try { await request({ id: "22", type: "comments.reply", reviewId: 999, body: "없는 코멘트" }); } catch { unknownRefused = true; } check("D88 an unknown review id is refused, not guessed", unknownRefused === true);
```
- 수정 제안: Assert on error reply content (reply.type === 'error' with unknown-review refusal message).
- 검증: catch-any-error accepts timeout/crash/downstream-404 as refused; verifies an error occurred, never that daemon refused rather than guessed.

### [Low] 'PAT absent from argv and .git/config' test never inspects argv or .git/config
- 위치: packages/daemon/test/repo-security.test.mjs:48-68
- 분류: test
- 시나리오: Clone targets https://127.0.0.1:1/... fails at connect — no .git/config created, argv never inspected; only broadcast statuses scanned; near-verbatim duplicate of next test. PAT persisting into .git/config on successful clone passes silently.
- 근거:
```
const status = await workspace.sync(); assert.equal(status.phase, "error"); assert.ok(!JSON.stringify(broadcasts).includes("ghp_super_secret"), "the PAT must stay daemon-side");
```
- 수정 제안: Retitle or add coverage: successful clone with PAT then assert git config --local --list contains no token.
- 검증: Clone fails at connect so .git/config never exists and argv never inspected; name claims coverage body lacks — near-duplicate of next test.

### [Low] browser-gate repo-surface half never asserts the driver ran — a skip-everything regression passes
- 위치: packages/daemon/test/browser-gate.test.mjs:228-236
- 분류: test
- 시나리오: Repo-surface half asserts body.ok===true and gate.seen.ops empty but never driver.seen.calls (unlike non-repo half 220-224) → regression skipping gate AND driver dispatch for repo surfaces passes; 'op executes without card' half-verified.
- 근거:
```
for (const [op, params] of GATED_OPS) { ... await DaemonServer.prototype.onInternalBrowser.call(server, request, response); assert.equal(response.body.ok, true, ...); assert.deepEqual(gate.seen.ops, [], ...); }
```
- 수정 제안: Add assert.deepEqual(driver.seen.calls.map(([name]) => name), [op], ...) mirroring non-repo half.
- 검증: Repo-surface loop asserts ok:true and empty gate.seen.ops but never driver.seen.calls; regression skipping callBrowserOp for repo surfaces returns ok:true and passes, unlike non-repo half which pins dispatch.

### [Low] desktop-smoke AppUserModelId check is vacuous on every non-Windows platform
- 위치: packages/desktop/test/desktop-smoke.mjs:75-82
- 분류: test
- 시나리오: On macOS/Linux getAppUserModelId doesn't exist → null → `=== null || ...` always true → PASS line asserts nothing; broken setAppUserModelId reports PASS on mac.
- 근거:
```
const appUserModelId = await app.evaluate(({ app }) => typeof app.getAppUserModelId === "function" ? app.getAppUserModelId() : null); check("the process AppUserModelId matches the electron-builder appId", appUserModelId === null || appUserModelId === "org.colo-design.desktop", ...)
```
- 수정 제안: Explicit SKIP off-win32 (like desktop-cover.mjs:249) or platform-independent probe.
- 검증: Off-win32 getter absent → null → `=== null ||` always true; PASS asserts nothing on macOS/Linux.

### [Low] desktop-smoke 'a window opens' check is a tautology after the throwing firstWindow()
- 위치: packages/desktop/test/desktop-smoke.mjs:68-69
- 분류: test
- 시나리오: firstWindow() resolves truthy Page or throws (exit 2 before check) → Boolean(window) never false → always-true PASS inflating pass count.
- 근거:
```
const window = await app.firstWindow(); check("a window opens", Boolean(window));
```
- 수정 제안: Drop or assert something firstWindow doesn't guarantee.
- 검증: firstWindow() resolves truthy Page or throws; Boolean(window) never false — tautological PASS.

### [Low] desktop-switch records two always-true checks
- 위치: packages/desktop/test/desktop-switch.mjs:199,213
- 분류: test
- 시나리오: check(..., true) after waitFor which throws on failure → verdict literal true can never be false; N/N summary counts two no-op checks.
- 근거:
```
await waitFor(async () => (await viewUrl(app))?.startsWith(betaOrigin), 60_000, "베타 page"); ... check("the pane shows the active project's page", true, await viewUrl(app));
```
- 수정 제안: Fold real predicate into verdict or remove.
- 검증: Lines 199,213 pass literal true after throwing waitFor; verdicts can never be false.

### [Low] desktop-comments records four always-true checks
- 위치: packages/desktop/test/desktop-comments.mjs:319,337,492,838
- 분류: test
- 시나리오: Four check(..., true) after waitForSelector/waitFor that throw on failure → verdicts can never be false; N/N count overstates verification.
- 근거:
```
await page.waitForSelector(".planner__body", { timeout: 60000 }); await page.waitForSelector(".screenpanel__bar", { timeout: 60000 }); check("the planner workspace renders with the fixture project", true);
```
- 수정 제안: Remove tautologies or give real verdicts.
- 검증: Lines 319,337,492,838 all check(..., true) after throwing waits — no-op verdicts inflating count.

### [Low] browser-driver unit: consoleStillWorks passes on an empty array — a dead console bridge still satisfies the case
- 위치: packages/desktop/test/browser-driver-unit-entry.mjs:186
- 분류: test
- 시나리오: After navigate to origin B, Array.isArray(await driver.consoleLines()) true even for [] — post-roam console bridge could be dead and case still passes.
- 근거:
```
out.navigateRoams = (view.webContents()?.getURL() ?? "").startsWith(`${baseB}/two`); out.consoleStillWorks = Array.isArray(await driver.consoleLines());
```
- 수정 제안: Make destination page emit console line; assert line arrives after roam.
- 검증: consoleLines() always returns array; Array.isArray passes even with dead post-roam console bridge.

### [Low] desktop.test.mjs runDriverUnit leaks its mkdtemp dir when the unit times out or produces no answer
- 위치: packages/desktop/test/desktop.test.mjs:792-829
- 분류: test
- 시나리오: On timeout/missing COLO_DRIVER_UNIT line promise rejects at :813/:822 → rmSync at :827 skipped → temp dir with entry.mjs left on every failed run (accumulates in CI tmp).
- 근거:
```
const line = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(...)); }, 60_000); ... }); rmSync(dir, { recursive: true, force: true }); return line;
```
- 수정 제안: try/finally around the await.
- 검증: rmSync :827 skipped on timeout/no-answer rejects (:813,:822); mkdtemp dir leaks per failed run.

### [Low] restoreCheckpoint filters refetched checkpoint list with activeId captured at click time — switching threads mid-restore shows another session's checkpoints
- 위치: packages/web/src/components/chat/ChatColumn.tsx:363-376
- 분류: concurrency
- 시나리오: Restore in session A begins (slow: worktree restore + api.checkpoints round-trip); user switches to B; B's effect refetches; in-flight chain resolves and overwrites state with entries filtered by stale A id → B offers A's checkpoint rows; clicking restores A's snapshot while user believes B.
- 근거:
```
const restoreCheckpoint = (id: string) => { setRestoring(true); void api.restoreCheckpoint(id).then(() => api.checkpoints()).then((list) => { setCheckpoints(list.entries.filter((entry) => entry.sessionId === activeId)); setRestoring(false); })
```
- 수정 제안: Capture sessionId at call time; ignore late reply if it no longer matches.
- 검증: Restore chain (ChatColumn.tsx:361-374) lacks the cancelled/session guard the fetch effect has (:339-348); no per-session key (PageWorkspace.tsx:683); slow restore lands after B's fast refetch and overwrites with A-filtered rows.

### [Low] PxSize steppers ignore an uncommitted typed draft: press applies to committed value but field keeps stale draft, blur then overwrites the step
- 위치: packages/web/src/components/dialogs/SettingsDialog.tsx:119-125, 143-150
- 분류: correctness
- 시나리오: Type "9" (draft=9, value=14), click −: step() computes 14→13.5 but input renders draft??value = stale "9"; blur commit("9") clamps to 9, clobbering 13.5 — user ends at 9, + press invisible.
- 근거:
```
const commit = (raw: string) => { setDraft(null); const px = Number.parseFloat(raw); if (Number.isFinite(px)) onChange(clampSizePx(axis, px)); };
const step = (dir) => onChange(clampSizePx(axis, value + dir * 0.5));
```
- 수정 제안: step() clears draft (setDraft(null)) or commits first.
- 검증: Safari-only: buttons skip mousedown focus so no blur precedes click; step applies to committed value while input keeps stale draft; later blur commit overwrites the step; Chromium/Electron blur-first defends.

### [Low] @-file autocomplete leaves the onFindFiles promise rejection unhandled (no .catch on findFiles.current().then)
- 위치: packages/web/src/components/chat/Composer.tsx:627-640
- 분류: error-handling
- 시나리오: Type @src with degraded daemon connection → api.findFiles rejects → chain has only .then → unhandled rejection per keystroke, palette silently keeps prior state; first keystroke: empty list, no signal.
- 근거:
```
let cancelled = false; void findFiles.current(mention.query).then((entries) => { if (cancelled) return; setSuggestions(entries.slice(0, 10).map(...
```
- 수정 제안: .catch(() => setSuggestions([])) on the chain.
- 검증: .then-only chain (Composer.tsx:620-640); api calls reject on daemon error/timeout (daemon-client.ts:1151-1152, :1339-1341) even with connection open → unhandled rejection, stale palette.

### [Low] Failed interrupt leaves the stop button stuck at 정리 중… (stopping only reset when sessions.running goes false)
- 위치: packages/web/src/components/chat/ChatColumn.tsx:153-158 (reset effect :148-150); button in packages/web/src/components/chat/Composer.tsx:1498-1507
- 분류: error-handling
- 시나리오: Click 중지 → setStopping(true), button disabled 정리 중…; api.interrupt rejects (socket blip) → .catch(() => undefined) swallows; reset effect only on running→false; if daemon never got interrupt, running stays true → stop control disabled forever, no retry.
- 근거:
```
const stop = () => { if (!activeId) return; setStopping(true); void api.interrupt(activeId).catch(() => undefined); };
useEffect(() => { if (!sessions.running) setStopping(false); }, [sessions.running]);
```
- 수정 제안: Reset stopping in .finally or on rejection.
- 검증: stop() swallows interrupt rejection (ChatColumn.tsx:157); stopping resets only on running->false (:146-150); daemon never receiving interrupt keeps state running → button stuck disabled.

### [Low] permission/question card left as ghost when resolving session.state broadcast missed during disconnect — reconnect replays requests but never re-announces states
- 위치: packages/web/src/lib/daemon-client.ts:1228-1233 (clear condition), 1247-1276 (dedupe-add)
- 분류: error-handling
- 시나리오: Session S waiting_permission with card R; socket drops; R answered elsewhere; S resumes. Daemon re-announces pending requests (server.ts:831) but not states; listSessions adoption (1373-1401) updates state/live but not pending → card R stays until S's next state broadcast; respondPermission errors; if S deleted while disconnected, never clears.
- 근거:
```
if (message.state !== "waiting_permission" && message.state !== "waiting_question") { setPending((prev) => prev.filter((p) => p.sessionId !== message.sessionId)); }
```
- 수정 제안: Reconcile pending on reconnect: pendingReplays carries waiting session ids, or prune pending for sessions whose adopted state is not waiting_*.
- 검증: reconnect replays only still-pending requests (server.ts:831), never re-announces states; listSessions adoption (:1373-1401) ignores pending → card resolved or deleted during disconnect persists as ghost until next state broadcast.

### [Low] Deleting the active thread leaves the deleted session's selector, usage, and history-failed card on the empty 'new thread' state
- 위치: packages/web/src/hooks/useSessions.ts:633-655
- 분류: correctness
- 시나리오: acceptRemove on active thread: setActiveId(null), forgetLastThread but unlike fresh() no reset of selector/usage/historyFailed → composer chips keep deleted thread's provider/model/mode, usage popover keeps context reading, historyFailed card stays over empty state (restore effect requires saved pointer + non-empty list). Same in acceptClear (660-680) for active project.
- 근거:
```
if (activeId === session.sessionId) { setActiveId(null); forgetLastThread(activeSlug, session.sessionId); } ... // fresh(): selectorFor.current = null; setSelector(null); setUsage(null);
```
- 수정 제안: After nulling activeId, run fresh()'s reset block.
- 검증: acceptRemove/acceptClear set activeId null without the selector/usage/historyFailed resets fresh() performs; deleted thread's chips, usage popover, and failure card persist over the empty state.

### [Low] refresh() swallows a transient list failure into an empty list and lets concurrent refreshes land out of order
- 위치: packages/web/src/hooks/useSessions.ts:269-271
- 분류: error-handling
- 시나리오: refresh maps api.listSessions() failure to [] and setList([]) → single dropped request while daemon restarts wipes sidebar instead of keeping rows; no ordering guard → acceptRemove's trailing refresh and project.changed refresh resolve out of order → older response (with deleted row) overwrites newer, briefly resurrecting deleted row.
- 근거:
```
const refresh = useCallback(async () => { setList(await api.listSessions().catch(() => [] as SessionSummary[])); }, [api]);
```
- 수정 제안: Keep previous list on failure; monotonic request token so only newest response sets list.
- 검증: refresh maps listSessions failure to [] — sidebar empties and stays empty until next trigger (no auto-retry while connection stays open); no ordering guard lets overlapping refreshes land out of order.

### [Low] splitPath mangles paths containing a second '?' — route keeps a query fragment, later params lost
- 위치: packages/web/src/lib/preview-address.ts:24-32
- 분류: correctness
- 시나리오: URL /a?x=1?state=open (literal ? in query value legal) → planner types ?state=empty → split('?')[1] = 'x=1' → route slice keeps '?state' → parseAddress returns '/a?x=1?state?state=empty', state param dropped.
- 근거:
```
const query = path.split("?")[1] ?? ""; const route = path.slice(0, path.length - (query ? query.length + 1 : 0));
```
- 수정 제안: Split on first ? only.
- 검증: split('?')[1] truncates query at second '?'; route slice keeps '?state' fragment → parseAddress('?state=empty') yields mangled '/a?x=1?state?state=empty' with state param dropped (preview-address.ts:28-29,53-54).

### [Low] downloadTranscript revokes the object URL synchronously — download can be cancelled in Firefox
- 위치: packages/web/src/lib/transcript-export.ts:41-46
- 분류: correctness
- 시나리오: anchor.click() then URL.revokeObjectURL in same task → Firefox/WebKit can abort download (blob URL revoked before navigation fetch starts) → failed/empty download; Chrome tolerant.
- 근거:
```
const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${safe}.md`; anchor.click(); URL.revokeObjectURL(url);
```
- 수정 제안: setTimeout(() => URL.revokeObjectURL(url), 0).
- 검증: anchor.click() then URL.revokeObjectURL in same task (transcript-export.ts:41-46) — known Firefox/WebKit footgun that can abort the blob download before navigation fetch starts.

### [Low] buildHomeFeed maps unparseable updatedAt to epoch 0 — done card shows '1970. 1. 1.'
- 위치: packages/web/src/lib/home-feed.ts:190-196
- 분류: correctness
- 시나리오: Malformed/empty updatedAt → Date.parse()||0 → at:0 → timeAgo(0) = '1970. 1. 1.' nonsense date, sorts to bottom.
- 근거:
```
done.push({ sessionId: thread.id, title: thread.title, line: "답이 왔어요 — 확인해 보세요", at: Date.parse(thread.updatedAt) || 0, });
```
- 수정 제안: Number.isNaN check; skip timestamp or fall back Date.now().
- 검증: Date.parse(thread.updatedAt)||0 maps malformed timestamps to epoch 0 (home-feed.ts:191); timeAgo(0) falls through to toLocaleDateString → '1970. 1. 1.' on the done card and sorts it to bottom.

### [Low] errorKindOf's '미리보기' detail-sniff misclassifies old-daemon failures as 'preview' — losing the AI-fix action
- 위치: packages/web/src/lib/repo-guidance.ts:41-49
- 분류: correctness
- 시나리오: Older daemon fails with '미리보기 명령을 찾지 못했습니다' → includes('미리보기') → 'preview' → guidanceFor('preview') generic card with NO agent field → planner loses 'AI에게 해결 요청' path that no-preview-command/port-undetected kinds provide; wrong title.
- 근거:
```
if (detail?.includes("GitHub 패키지 인증")) return "auth"; if (detail?.includes("pnpm이 없습니다")) return "pnpm"; if (detail?.includes("미리보기")) return "preview";
```
- 수정 제안: Narrow sniff to actual preview-server-death phrasing.
- 검증: detail?.includes('미리보기') (repo-guidance.ts:45) catches old-daemon no-preview-command/port-undetected details → 'preview' kind → wrong card (preview-death slot) and wrong AI-fix brief.

### [Low] modelOptions dedup can drop the picked row — current model shows unselected
- 위치: packages/web/src/lib/chat-options.ts:137-160
- 분류: correctness
- 시나리오: Two rows identical displayName+description (alias + resolved id); modelRowOf matches picked against value OR resolvedModel → current can be SECOND duplicate; dedup keeps first → surviving row picked:false → menu shows no selection.
- 근거:
```
.filter((row, index, all) => all.findIndex((other) => other.label === row.label && other.hint === row.hint) === index);
```
- 수정 제안: Prefer picked:true row when deduplicating (or OR picked into survivor).
- 검증: Dedup keeps first identical label+hint row (chat-options.ts:156-159); modelRowOf can return the second duplicate via resolvedModel match → picked row dropped, menu shows no selection.

### [Low] usePins recordError survives a project switch — stale failure banner on another project's screen panel
- 위치: packages/web/src/hooks/usePins.ts:135-141
- 분류: correctness
- 시나리오: recordComments fails on A → recordError set → switch to B → reset block clears list/ghosts but not recordError → B's ScreenPanel shows '코멘트 기록을 저장하지 못했습니다' for A's failure.
- 근거:
```
if (loadedSlug !== slug) { setLoadedSlug(slug); setList(slug ? loadPins(slug) : []); setGhosts([]); }
```
- 수정 제안: Add setRecordError(null) to reset block.
- 검증: Slug-switch reset (usePins.ts:135-139) clears list/ghosts but not recordError → project B's ScreenPanel warning band (ScreenPanel.tsx:337-341) shows project A's recordComments failure.

### [Low] daemonLine leaves carriage returns and non-SGR ANSI sequences in the planner-facing line
- 위치: packages/web/src/lib/format.ts:61-71
- 분류: correctness
- 시나리오: Detail with \r progress output or \u001b[K/\u001b[2J → split on \n keeps \r, regex only strips SGR m-sequences → renders glued '45%\rDownloading... 90%' or raw ^[[K junk.
- 근거:
```
(detail ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((line) => line.trim())...
```
- 수정 제안: Split on /\r\n|\r|\n/; strip broader CSI set \u001b\[[0-9;?]*[a-zA-Z].
- 검증: daemonLine strips only SGR m-sequences and splits on \n (format.ts:61-71); \r progress output and non-SGR CSI (\u001b[K, \u001b[2J) survive into the planner-facing line as glued text or raw junk.

### [Low] Palette rank() subsequence match compares code points against code units — non-BMP query characters can never match
- 위치: packages/web/src/components/shell/Palette.tsx:51-63
- 분류: boundary
- 시나리오: Query with astral-plane char (emoji 😀), title contains it non-prefix → indexOf fails → subsequence branch. for (const ch of t) iterates code POINTS of text; q[i] indexes query by UTF-16 code UNIT — 😀 yields lone high surrogate (0xD83D) never equal to full code point; i === q.length never reached → matching conversations reported '와 맞는 것이 없습니다'. Same for any non-BMP query char (CJK extension ideographs).
- 근거:
```
let i = 0; for (const ch of t) { if (ch === q[i]) i += 1; if (i === q.length) return 3; } return -1;
```
- 수정 제안: Index query by code point (iterate q with pointer over text code points).
- 검증: rank() iterates text by code points but indexes query by UTF-16 code units (Palette.tsx:57-62); non-BMP query char yields lone surrogate, never matches — real boundary defect.

### [Low] Sidebar role=tree structure violates required ownership — treeitems nested under unroled divs, group headers as bare divs
- 위치: packages/web/src/components/shell/Sidebar.tsx:609-828
- 분류: a11y
- 시나리오: role='tree' requires treeitem children owned by tree (directly or via role=group). Non-rail tree renders bare <div class='gsec'> headers (no role) and <div class='leafwrap'> wrappers whose buttons carry role='treeitem'/aria-selected — treeitems not owned by tree/group; unlabelled div siblings. Keyboard walking manually implemented (onKeyDown 342-365) rather than aria-level/aria-posinset → AT users get flattened/dropped tree with no group labels.
- 근거:
```
<div className="tree" role="tree" aria-label={...} ref={listRef}> ... <div className="gsec gsec--ask">확인 대기 ...</div> ... <div class="leafwrap"><button role="treeitem" .../>
```
- 수정 제안: Wrap groups in role=group with aria-labelledby; make treeitem rows owned by group element.
- 검증: role=tree (Sidebar.tsx:611) contains bare .gsec text headers and rail-mode buttons lacking treeitem role (636-670); non-rail treeitems sit under unroled wrappers — real ARIA content-model violation.

### 2. 커버리지 표

| 모듈 | 담당 조사 에이전트 | 후보 | 승인 | 검증 폐기 |
|---|---|---|---|---|
| daemon session 코어 (session.ts, session-tape.ts) | DaemonSession | 14 | 11 | 3 |
| daemon HTTP/WS 서버 (server.ts, web-static.ts, rest-transport.ts) | DaemonServer | 4 | 4 | 0 |
| daemon repo 코어 (repo-core, repo, repo-paths, repo-config) | DaemonRepoCore | 8 | 6 (중복 병합 −2) | 0 |
| daemon dispatch/index/paths/log | DaemonDispatch | 6 | 5 (중복 병합 −1) | 0 |
| daemon publish/shelf/checkpoint/bringup | DaemonPublish | 23 | 15 (중복 병합 −3) | 5 |
| daemon agent 코어 + claude 드라이버 | DaemonClaudeDriver | 13 | 8 | 5 |
| daemon acp/codex/omp 드라이버 | DaemonOtherDrivers | 10 | 10 | 0 |
| daemon 자격증명/github/claude-trust/onboarding/environment | DaemonSecrets | 15 | 14 | 1 |
| daemon session-manager/undo/permission/projects/fleet/queue/workspaces | DaemonStores | 16 | 15 | 1 |
| daemon preview/browser/screen-gate/claim | DaemonPreviewBrowser | 7 | 5 | 2 |
| daemon repo 지원 (diff/summary/prompts/handoff/comments/notices/plan) | DaemonRepoSupport | 9 | 7 | 2 |
| desktop preview-driver | DesktopPreviewDriver | 5 | 5 | 0 |
| desktop preview-view/emulation | DesktopPreviewView | 8 | 7 | 1 |
| desktop main/preload/bridge/windows/menu/notify | DesktopIpc | 15 | 14 | 1 |
| desktop 업데이트/safe-storage/settings | DesktopUpdate | 4 | 4 | 0 |
| web daemon-client | WebClientCore | 5 | 3 | 2 |
| web useSessions/settings | WebClientState | 7 | 7 | 0 |
| web lib/* + hooks (daemon-client/settings 제외) | WebLibs | 14 | 10 | 4 |
| web shell/panels/preview/home 컴포넌트 | WebShellPanels | 6 | 3 | 3 |
| web chat/transcript/dialogs/App | WebChatTranscript | 9 | 7 | 2 |
| protocol 전체 | Protocol | 7 | 7 | 0 |
| daemon 단위 테스트 (platform/security/…/onboarding) | TestDaemonA | 4 | 4 | 0 |
| daemon repo/publish 테스트 | TestDaemonB | 4 | 3 | 1 |
| daemon 나머지 e2e 테스트 | TestDaemonC | 6 | 3 | 3 |
| web ui-* e2e 테스트 | TestWeb | 9 | 2 | 7 |
| desktop 테스트 | TestDesktop | 9 | 9 | 0 |
| scripts/CI/루트 설정 | ScriptsConfig | 15 | 14 | 1 |

모든 영역 조사 완료. 미조사 영역은 §4 참조.

### 3. 검증 후 결함 없음 목록 (다음 감사 중복 배제 재료)

**반증으로 폐기된 후보 (44건):**

- [DaemonSession] Merge-conflict recovery commit is unreachable — MERGE_HEAD check assumes .git is a directory, but sessions run in linked… — 폐기 사유: Session cwd is the clone (paths.repoRoot, git clone at repo-bringup.ts:61); .git is a real directory there so MERGE_HEAD exists mid-merge — linked-worktree premise is false (only handoff preview uses worktree add).
- [DaemonSession] dropTape races with itself — same temp filename per process, concurrent deletes can throw or clobber — 폐기 사유: dropTape is fully synchronous — same-process calls cannot interleave; different processes get different process.pid temp names. Claimed race is impossible.
- [DaemonSession] readTape accepts rows whose event lacks a kind — malformed JSONL lines splice non-events into replayed transcript — 폐기 사유: Unreachable: appendTape only writes well-formed ChatEvent rows; torn lines fail JSON.parse and are skipped — no real path produces a parseable row with a non-object event.
- [DaemonPublish] discard()/checkpointRestore() decode quoted paths into literal newline filenames — rmSync targets wrong path — 폐기 사유: unquoteGitPath restores literal name — rmSync targets correct path; backslash wrong-path deletion is safeRepoPath normalization = candidate #15.
- [DaemonPublish] First install of a private-registry repo races the npmrc token write — unawaited mergeNpmrc — 폐기 사유: mergeNpmrc idle path writes synchronously (credentials.ts:310-321); token on disk before runCommand; failures hit bootstrap catch; unhandledRejection handler exists (index.ts:135).
- [DaemonPublish] mergeRegistryNpmrc runs after install in both bring-up paths — first private install always fails — 폐기 사유: installIfNeeded merges registry+token pre-install from same resolveRepoConfig source; pat armed before sync (project-fleet.ts:524) — 401 premise fails.
- [DaemonPublish] startPreview registers no 'error' handler — spawn failure crashes the whole daemon — 폐기 사유: ERR_UNHANDLED_ERROR becomes uncaughtException caught at index.ts:134 — daemon survives; residual is delayed port-undetected card, not crash.
- [DaemonPublish] checkpointRestore leaves staged-added residue for files deleted after staging ('A' + rmSync w/o git rm) — 폐기 사유: staged-before-snapshot files are in tree → D → checkout restores index+worktree; post-snapshot AD case absent from diff (net-nil) — claimed commit-deletion effects unfounded.
- [DaemonClaudeDriver] close() aborts only on timeout, not dead — control-dead CLI wedges close() forever — 폐기 사유: dead=interrupt rejection implies dead transport/query so consumer settles; no reconstructable path where CLI stays alive ignoring EOF yet interrupt rejects; timeout case already aborts.
- [DaemonClaudeDriver] onNotify/onEnd invoked unguarded in readline handler — throw becomes uncaughtException, kills daemon — 폐기 사유: index.ts:134 installs uncaughtException handler that logs; daemon does not die; residual dropped notification is what a throwing handler does anyway.
- [DaemonClaudeDriver] cut:null collides 'keep nothing' with 'cannot determine' — rewind of turn>1 with corrupt uuid discards entire memory — 폐기 사유: SDK Kq filters entries to typeof uuid==='string' before rawMessages sees them; keptUuid null only when start===0 where cut:null is correct.
- [DaemonClaudeDriver] isPrompt counts isMeta CLI-meta lines as prompts — promptCount and rewind cutoffs wrong — 폐기 사유: SDK Gq/fHe drops isMeta entries upstream; meta lines never reach isPrompt or replayHistory.
- [DaemonClaudeDriver] deleteAll encodes realpath but CLI may key by literal path — sweep silently no-ops — 폐기 사유: SDK Ene realpaths dir identically (realpathSync+literal fallback); claimed literal-keying divergence disproven (residual: SDK truncates >200-char names with hash, driver doesn't — different defect).
- [DaemonSecrets] sanitizeRepoAgentSettings follows symlinks — a repo can make the daemon rewrite files outside the clone — 폐기 사유: renameSync(temp,file) replaces the symlink itself, not its target — user's real ~/.claude/settings.json is never written; claimed out-of-clone rewrite cannot occur (residual: target bytes only copied into clone if they contain widening keys)
- [DaemonStores] Removing the active project skips the warm-preview fence, exceeding the WARM_PREVIEWS cap — 폐기 사유: Removing a project cannot raise the inactive-warm count above the cap; skipping the fence on auto-activation is harmless — the cap counts only inactive servers, and the auto-activated survivor merely leaves the warm set (count decreases or holds).
- [DaemonPreviewBrowser] decideBrowserOp bypasses the 항상 허용 (always-allow) memory — external-surface browser ops re-prompt every call — 폐기 사유: Browser-op cards carry suggestions:[]; both card surfaces disable 항상 허용 without a suggestion (disabled label states re-asking is intended) — answering 항상 허용 is unreachable; re-prompt is announced design; residue is stale comments only.
- [DaemonPreviewBrowser] runGate — new URL and factory.forIsolated sit outside the try; a synchronous throw becomes an unhandled rejection on a v… — 폐기 사유: Both statements cannot realistically throw: previewUrl only ever set from probed well-formed URLs (repo-bringup.ts:281); forIsolated is new ElectronPreviewDriver with bare constructor (desktop preview-driver.ts:189-191); and index.ts:134-137 installs an unhand…
- [DaemonRepoSupport] parseUnifiedDiff misattributes combined-diff (diff --cc) hunks while the clone has unmerged paths — 폐기 사유: Empirically disproven: git diff HEAD with unmerged paths emits a plain unified diff (conflict markers as + lines), not diff --cc combined format, so hunks attribute correctly via repo-core.ts:606.
- [DaemonRepoSupport] memoPrompt has no file-count/total-size cap, so large diffs blow the 8s memo leash and silently lose the auto-memo — 폐기 사유: Designed graceful degradation: memo is best-effort with an 8s leash and explicit null→DEFAULT_COMMIT_MESSAGE fallback (repo-publish.ts:180-182); commit still lands with a valid message; a cap is an enhancement, not a defect.
- [DesktopPreviewView] mount(url, null) from openTab/open/driveTo clobbers the registry epoch and root url, disabling stale-epoch self-heal — 폐기 사유: Clobber real but harm unreachable: registry epoch only advances via mounts that refresh the same page, so page.epoch never lags mounts.epoch — disabled self-heal has no live firing scenario.
- [DesktopIpc] host.onClosed assigned only after loadURL resolves — window closed mid-load skips preview unmount/cover cleanup — 폐기 사유: Unreachable: during first loadURL no page can be mounted (renderer must load to invoke preview:mount), so skipped unmount()/cover(false) are no-ops; reopened windows get close guard via onCreated before load.
- [WebClientCore] synchronous ws.send throw inside the call executor leaks the pending-call entry — expiring timeout never scheduled — 폐기 사유: OPEN checked at :1323 and send runs same tick; spec throws InvalidStateError only when CONNECTING — synchronous throw unreachable, and re-rejecting a settled promise is a no-op.
- [WebClientCore] githubTokenSet forwards an empty string the protocol rejects — blank token input yields raw Zod error and can never mean… — 폐기 사유: Both forms disable submit unless draft.trim() is non-empty (GitHubTokenForm:67,73; TokenExpiryDialog:97,103) — "" unreachable; null-as-clear is a missing feature, not a defect.
- [WebLibs] deriveJourney does not apply the reset rule to 'closed' — journey shows 넘기기 warn while unsaved work piles up — 폐기 사유: Reset rule is documented as merged-specific ('merged 도착은 … 유지'); closed deliberately parks at 넘기기 warn per its own comment — design-consistency suggestion, not a reconstructable defect.
- [WebLibs] turnAnswerText leaks the previous turn's answer text into the next turn block — 폐기 사유: Unreachable: every turn.end is preceded by a user.echo (daemon session.ts:1202 emits echo for all prompts incl. machine turns), which clears parts; no code path produces a turn block after text without an intervening user block.
- [WebLibs] deriveThreadJourney marks 만들기·저장 as reached for a thread that only received a stray review event — 폐기 사유: Function implements its documented rule (human → 넘기기 warn); stray review attribution happens upstream in the daemon, and reached reflects cycle position — not a defect in this function.
- [WebLibs] modeMenuLabel renders 'undefined (undefined)' for a PermissionMode the UI predates — 폐기 사유: modeMenuLabel is only invoked over the fixed SETTINGS_MODES array (Composer.tsx:1083, SettingsDialog.tsx:1176); stored modes are validated via oneOf (settings.ts:402) — a new daemon variant never reaches it.
- [WebShellPanels] NativeHost re-rides target via mount().then(open) with no cancellation — stale open can navigate the new page to an old… — 폐기 사유: preview:mount/open IPC handlers are synchronous (preview-view.ts:1275-1320) on a FIFO channel; mount(A) resolves before mount(B), so stale open cannot land last — reordering mechanism impossible.
- [WebShellPanels] readHandoffState quiet effect re-fires on every ScreenPanel remount and every handoff.state change, polling GitHub per t… — 폐기 사유: Mount re-fire is documented intent: comment at ScreenPanel.tsx:494 explicitly describes '조용한 재사용(마운트·포커스)'; async call does not stall entry; intended freshness, not a defect.
- [WebShellPanels] FrozenStage '실제 앱 닫기' only hides the iframe — the daemon-side 시점 빌드 worktree + dev server keep running — 폐기 사유: Warm-keep is deliberate per FrozenStage.tsx:78-79 comment (instant re-show); bounded by IDLE_TTL_MS=15min (handoff-preview.ts:43); label-vs-behavior is wording, not a defect.
- [WebChatTranscript] HandoffCard hand() has no in-flight guard: repeated clicks send duplicate api.handoff calls while the first is still awa… — 폐기 사유: Daemon rejects concurrent handoff (repo.ts:396-398) while publishing is set; hand() surfaces the error; duplicate send impossible; card-open-on-error is documented intent.
- [WebChatTranscript] sendTestNotice awaits bridge.notifyTest() without try/catch — bridge rejection becomes unhandled rejection and status li… — 폐기 사유: app-notify show() resolves every outcome as a value (failed-event {shown:false,error}, timeout fallback :95-106); renderer renders error via result.shown===false; rejection needs unrealistic Notification-constructor throw.
- [TestDaemonB] D90 'no brief composed' check is a fixed-sleep negative assertion — 폐기 사유: Echo emitted synchronously inside handoff before reply frame on one FIFO socket; no async-after-reply delivery on this path — sleep redundant, not racy.
- [TestDaemonC] midturn-queue has literal check(name, true) verdicts that can never fail — 폐기 사유: Each check(true) follows a waitFor that throws on timeout, enforcing the property; rows are documented race-pattern milestone labels, cannot mask a regression — no false pass possible.
- [TestDaemonC] plan-e2e 'turn 2 end' wait can pass on turn 1's stale idle event — 폐기 사유: session.ts:924-933 emits permission.request then synchronously setState("waiting_permission"); deny's settle sets "running" before respond replies — turn 1's idle can never be events.at(-1) when the wait starts.
- [TestDaemonC] common-instructions check named 'carries the common block' never asserts the block is present — 폐기 사유: Machine turns use claudeOneShot which never passes appendSystemPrompt; only conversation sessions carry the common block, so a machine dump cannot contain COMMON_MARKER — dumpMatching can only select the session's dump.
- [TestWeb] check('two projects created over the socket, both cloning', true) verifies only one clone — plus six more tautological v… — 폐기 사유: 결제 clone IS verified later by waitReady("the 결제 clone after the switch") which throws → exit 1; the six other check(true) rows each follow hard waits that fail the suite on regression.
- [TestWeb] check('the planner connects and the workspace shows the repo preview', true) is a tautology — waitForSelector is the onl… — 폐기 사유: waitForSelector(".preview") and corridor.waitFor are unconditional — regression throws → non-zero exit. Behavior genuinely verified; check row labels a real guard.
- [TestWeb] Two tautological checks after waits in ui-planner-e2e.mjs — 폐기 사유: waitForSelector(".planner__body") and (".preview") throw on regression → exit 2. Guards real; check rows label verified behavior. Style, not defect.
- [TestWeb] check('a clean tree after 버리기 draws no strip', true) records a verdict that cannot fail — 폐기 사유: waitForFunction for .cstrip===null is unconditional; a persisting strip → timeout throw → exit 1. Claim verified by the wait.
- [TestWeb] check('a mid-turn send cut the running turn', true) is a tautology after the detached wait — 폐기 사유: stop.waitFor detached is unconditional; comment is correct that the stub never settles a marker turn, so detach proves the cut. Throws on regression.
- [TestWeb] check('the deleted thread leaves the sidebar list', true) is a tautology after the detached wait — 폐기 사유: leaf waitFor detached is unconditional → throws if the row survives deletion. Claim verified by the wait.
- [TestWeb] Activity-line regex matches zero-count text — a fold that renders '0개'/'0곳 확인' still passes — 폐기 사유: activityLine emits each counter only when count≥1 (if(file)/if(command) guards); "0개" unreachable; .activity requires a real tool run. Scenario cannot reconstruct from code.
- [ScriptsConfig] daemon `dev` script leaves tsc-only session on fresh clone — node --watch dies before dist exists — 폐기 사유: node --watch survives missing entry and restarts when file appears; verified on node 24

**조사·검증 과정에서 결함 없음이 확인된 영역/항목:**

- daemon rest-transport.ts — fixture 매칭/deepEqual/힌트 로직에 도달 가능한 오동작 없음 (DaemonServer)
- daemon web-static.ts 경로 순회 방어 — containsPath가 파일시스템 실해 기준 비교로 어휘적 ../ 무력화 확인 (DaemonServer)
- web XSS/Markdown 처리 — ReactMarkdown URL transform, mermaid securityLevel strict, OptionPreview sandbox+CSP, prefers-reduced-motion 폴드 (WebChatTranscript)
- desktop preview-driver — idle-detach/keepAttached 타이머 수명, settleAfterNav 리스너 정리, ref generation 단조성, Electron 44 콘솔 시그니처, open() origin 게이트 (DesktopPreviewDriver)
- daemon browser-mcp notifications/initialized 데드 코드(무해), captureTargets 핀 화면 정규화, probePreviewUrl <5xx 처리 (DaemonPreviewBrowser)
- daemon 테스트 repo-contract/lifecycle/refresh/changed-files/handoff/projects.test.mjs — 거짓통과 없음, 실재하는 assertion (TestDaemonB)
- daemon permission-repeat/turn-clock/preview-detect/onboarding/acp-session/fast-mode 테스트 + github fixtures — 거짓통과 없음 (TestDaemonC)
- plan-e2e turn-1 idle 대기와 crash-e2e — 세션 생성 시 idle 미브로드캐스트 확인로 실재하는 대기임 검증 (TestDaemonC)
- web transcript turnNumbers 폴백 — 도달 불가(결함 아님) 확인 (WebChatTranscript)
- session-tape dropTape 경합·비정형 row, .git/MERGE_HEAD worktree 가정 등 — 검증 단계에서 반증 (VDaemonSession #1·13·14)
- driver SDK 경계 — rewind uuid/cut, isMeta 필터, deleteAll 경로 인코딩은 SDK가 상류에서 처리 확인 (VDaemonClaudeDriver #8·9·10)
- claude-trust symlink rewrite — renameSync가 심링크 자체를 교체하므로 클론 외부 재작성 불가 (VDaemonSecrets #2)
- runGate new URL/forIsolated 예외 — 실질 던지기 불가 + unhandledRejection 로거 존재 (VDaemonPreviewBrowser #7)
- decideBrowserOp 항상 허용 우회 — 카드가 suggestions 없이 항상-허용을 비활성화해 시나리오 도달 불가 (VDaemonPreviewBrowser #5)
- 그 외 각 폐기 사유는 §3 반증 목록 참조

### 4. 미조사 영역과 이유

- `packages/web/src/styles.css` (256KB): 전수 심층 검사 미수행 — 컴포넌트 a11y/구조 감사에서 발췌 확인만 수행. 대비 게이트(scripts/theme-contrast-gate.mjs)가 존재하지만 그 게이트 자체의 공허 통과 결함은 §1 보고됨.
- `README.md`, `docs/mcp-roadmap.md`: 문서 — 코드 결함 감사 범위 외 (내용 정확성 미검증).
- `packages/desktop/release/**`, `web-dist/**`, `.dev-userData*/**`, `.test-logs/**`, `pnpm-lock.yaml`, `*.tsbuildinfo`, 테스트 PNG fixture: 빌드/런타임/생성 산출물 — EXCLUDES.
- 참고: Windows 전용 결함은 macOS 호스트에서 코드·문서 기반으로 재구성됨(실행 재현 불가) — 해당 항목 시나리오에 표시.

### 5. 통계

- 후보 총계: 252건 (조사 28 에이전트)
- 검증 통과(승인+수정): 208건
- 검증 폐기(반증): 44건
- 중복 병합으로 감소: −6건
- **최종 신규 결함: 202건** — Critical 1 / High 16 / Medium 85 / Low 100
- 기존 중복 폐기: 0건 (최초 감사)
- Critical/High 검증: 반증 패스(서브에이전트) + 오케스트레이터 spot-check 이중 확인.
