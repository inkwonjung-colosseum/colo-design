/**
 * Planning-tab editor e2e — the real TipTap contenteditable against the real
 * daemon over the wire, with the daemon's Confluence client on recorded
 * fixtures (fixtures/confluence/editor/). No Claude session, no network.
 *
 * Covers: open → type → debounced autosave lands the daemon-normalized file
 * on the mirror (and a second save is a no-op — idempotent normalization);
 * the 원문 toggle edits through the same save path; selection → 인용 lands a
 * quote chip in the composer; 보내기 stays disabled while unsaved editor work
 * exists; doc.lock over a second socket flips the editor read-only with the
 * Korean banner; a fixture-driven conflict opens the three-way chooser and
 * 내 것으로 덮기 + 게시-like push uploads version+1 of our content.
 *
 * Prerequisites: `pnpm build`
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import ws from "../../daemon/node_modules/ws/index.js";
const { WebSocket } = ws;
import { createFixtureRepo, freePort, writeStubClaude } from "../../daemon/test/fixture-repo.mjs";
import { markdownToStorage, parseFrontmatter, storageToMarkdown } from "../../daemon/dist/sync/storage-markdown.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const daemonEntry = join(repoRoot, "packages", "daemon", "dist", "index.js");
const webDist = join(repoRoot, "packages", "web", "dist");
const DIR = join(tmpdir(), "drafthouse-editor-e2e");
const MIRROR = join(DIR, "mirror");
const FIXTURES = join(repoRoot, "packages", "daemon", "test", "fixtures", "confluence", "editor");
const PORT = 5399;

process.env.DRAFTHOUSE_CONFLUENCE_DIR = MIRROR;
process.env.DRAFTHOUSE_CONFLUENCE_SETTINGS = join(DIR, "settings.json");
process.env.DRAFTHOUSE_PROJECTS_SETTINGS = join(DIR, "projects.json");
process.env.DRAFTHOUSE_PROJECTS_DIR = join(DIR, "projects");
process.env.DRAFTHOUSE_CONFLUENCE_FIXTURE = FIXTURES;

const results = [];
function check(name, passed, detail = "") {
  if (typeof passed !== "boolean") {
    throw new Error(`check("${name}") was called without a verdict`);
  }
  results.push({ name, passed });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serveDist() {
  const server = createServer((req, res) => {
    const requested = (req.url ?? "/").split("?")[0];
    let file = join(webDist, requested === "/" ? "index.html" : requested);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDist, "index.html");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(PORT, "127.0.0.1", () => ok(server)));
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  if (!existsSync(webDist)) throw new Error("web dist missing. Run: pnpm --filter @drafthouse/web build");
  if (!existsSync(daemonEntry)) throw new Error("daemon dist missing. Run: pnpm --filter @drafthouse/daemon build");

  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, "claude-config"), { recursive: true });
  const fixture = await createFixtureRepo({ dir: join(DIR, "fixture"), port: await freePort() });

  const env = {
    ...process.env,
    DRAFTHOUSE_PORT: String(await freePort()),
    DRAFTHOUSE_CONFLUENCE_DIR: MIRROR,
    DRAFTHOUSE_CONFLUENCE_SETTINGS: join(DIR, "settings.json"),
    // Same isolation as every other suite: the registry belongs to this run.
    DRAFTHOUSE_PROJECTS_SETTINGS: join(DIR, "projects.json"),
    DRAFTHOUSE_PROJECTS_DIR: join(DIR, "projects"),
    DRAFTHOUSE_CONFLUENCE_FIXTURE: FIXTURES,
    CLAUDE_CONFIG_DIR: join(DIR, "claude-config"),
    // A stubbed CLI keeps the onboarding gate green without touching the
    // real Claude login (this suite runs no model turns).
    DRAFTHOUSE_CLAUDE_BIN: writeStubClaude(join(DIR, "bin")),
    DRAFTHOUSE_CREDENTIAL_STORE: "memory",
    // Onboarding-gate seeds: a reachable (never cloned) repo url keeps the
    // repo step at a non-blocking warn; Confluence is configured up front so
    // its step passes before the browser connects.
    DRAFTHOUSE_REPO_URL: fixture.remote,
    DRAFTHOUSE_CONFLUENCE_SITE: "https://example.atlassian.net",
    DRAFTHOUSE_CONFLUENCE_EMAIL: "dev@example.com",
    DRAFTHOUSE_CONFLUENCE_TOKEN: "editor-e2e-token",
  };
  delete env.ANTHROPIC_API_KEY;
  const daemon = spawn(process.execPath, [daemonEntry], { env, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  process.on("exit", () => daemon.kill("SIGKILL"));
  const daemonUrl = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("daemon never printed a url")), 20000);
    let buffered = "";
    daemon.stdout.on("data", (chunk) => {
      buffered += String(chunk);
      const match = buffered.match(/client url: (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        ok(match[1]);
      }
    });
  });

  // A second socket the test uses to drive doc.lock exactly like an external
  // holder would.
  const control = new WebSocket(daemonUrl);
  const controlInbox = [];
  control.on("message", (raw) => controlInbox.push(JSON.parse(String(raw))));
  await new Promise((resolve) => control.once("open", resolve));
  const controlCall = (message) => {
    control.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${message.type}`)), 15000);
      const tick = () => {
        const reply = controlInbox.find((m) => m.id === message.id);
        if (reply) {
          clearTimeout(timer);
          resolve(reply);
        } else setTimeout(tick, 50);
      };
      tick();
    });
  };

  await controlCall({ id: "c0a", type: "confluence.update", siteUrl: "https://example.atlassian.net", email: "dev@example.com", apiToken: "editor-e2e-token" });

  const server = await serveDist();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1720, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByPlaceholder("ws://127.0.0.1:7823?token=…").fill(daemonUrl);
    await page.getByRole("button", { name: "연결" }).click();
    await page.waitForSelector(".planner__body", { timeout: 60000 });
    check(
      "the shell opens on one workspace, not a pair of tabs",
      (await page.locator(".planner__body").count()) === 1 &&
        (await page.getByRole("tab", { name: "기획", exact: true }).count()) === 0,
    );

    // Configure + clone the fixture space over the control socket.
    await controlCall({ id: "c1", type: "confluence.update", siteUrl: "https://example.atlassian.net", email: "dev@example.com", apiToken: "editor-e2e-token" });
    const cloned = await controlCall({ id: "c2", type: "confluence.sync", space: "ENG" });
    check("the fixture space clones", cloned.data.phase === "idle" && cloned.data.pages === 2, cloned.data.detail ?? "");

    // --- the tree and the editor ------------------------------------------
    await page.locator(".pagetree__title", { hasText: "주문 정책" }).waitFor({ timeout: 10000 });
    check("the page tree lists cloned pages", (await page.locator(".pagetree__title").count()) === 2);
    await page.locator(".pagetree__title", { hasText: "주문 정책" }).click();
    await page.locator(".doc-editor__content .tiptap").waitFor({ timeout: 10000 });
    const headingText = await page.locator(".tiptap h2").innerText();
    check("the WYSIWYG editor renders the markdown body", headingText === "주문 정책", headingText);
    check("frontmatter is hidden behind the title field", (await page.getByLabel("문서 제목").inputValue()) === "주문 정책");

    const preserved = await page.locator(".doc-atom").count();
    check("no preserved blocks in this simple page", preserved === 0);

    // --- a thread belongs to its 기획서, not to the workspace ---------------
    // The whole point of the page axis: opening another page must not show
    // the first one's conversations. Persistence across a page switch needs a
    // real transcript, which needs a real model turn — projects-e2e proves
    // that half over the socket instead.
    await page.getByRole("button", { name: "+ 새 기획" }).click();
    await page.locator(".sessiontab").first().waitFor({ timeout: 20000 });
    check("a thread started on this page shows in its strip", (await page.locator(".sessiontab").count()) === 1);

    await page.locator(".pagetree__title", { hasText: "회원 관리 기획서" }).click();
    await page
      .waitForFunction(() => document.querySelectorAll(".sessiontab").length === 0, undefined, {
        timeout: 10000,
      })
      .catch(() => undefined);
    check(
      "another page does not show it",
      (await page.locator(".sessiontab").count()) === 0,
      `${await page.locator(".sessiontab").count()} tabs`,
    );
    // Switching pages remounts the editor; typing before it has loaded the
    // document back would race the load and lose the keystrokes.
    await page.locator(".pagetree__title", { hasText: "주문 정책" }).click();
    await page
      .locator('.doc-editor__bar input[aria-label="문서 제목"][value="주문 정책"]')
      .waitFor({ timeout: 10000 })
      .catch(() => undefined);
    await page.waitForFunction(
      () => document.querySelector(".tiptap h2")?.textContent === "주문 정책",
      undefined,
      { timeout: 10000 },
    );

    const file = join(MIRROR, "ENG", "주문 정책.md");
    const original = readFileSync(file, "utf8");
    const meta = parseFrontmatter(original).meta;

    // --- type in the real contenteditable → debounced autosave -----------
    // Anchored by its own text, not by position: `.tiptap p` also matches the
    // list items below, and a click that lands on one of those appends the
    // sentence in the wrong place — which reads as a normalizer bug.
    const paragraph = page.locator(".tiptap p", { hasText: "주문은" }).first();
    await paragraph.waitFor({ timeout: 10000 });
    await paragraph.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" 에디터에서 추가한 문장입니다.");
    const sendButton = page.getByRole("button", { name: "보내기" });
    try {
      check(
        "보내기 is disabled while unsaved editor work exists",
        (await sendButton.isDisabled()) === true,
      );
    } catch (error) {
      await page.screenshot({ path: join(here, "ui-editor-debug.png"), fullPage: true });
      console.error("DIAG body html len:", (await page.locator(".planner").innerHTML()).length);
      console.error("DIAG planner classes:", await page.locator(".planner").getAttribute("class"));
      console.error("DIAG errors:", errors.slice(0, 6));
      throw error;
    }
    await waitFor(() => readFileSync(file, "utf8").includes("에디터에서 추가한 문장입니다"), 10_000, "the autosave to reach the mirror");
    check("autosave settles within the debounce window", true);

    const disk = readFileSync(file, "utf8");
    const expected = canonicalize(
      original.replace("주문은 *당일* 승인된다.", "주문은 *당일* 승인된다. 에디터에서 추가한 문장입니다."),
      meta,
    );
    check(
      "the saved file is the daemon-normalized markdown",
      disk === expected && disk.includes("에디터에서 추가한 문장입니다"),
      firstDifference(disk, expected),
    );

    // --- normalization is idempotent --------------------------------------
    const reply = await controlCall({ id: "c3", type: "doc.save", path: "ENG/주문 정책.md", markdown: disk });
    check("saving the normalized file again changes nothing", reply.data.markdown === disk);
    check("the tree marks the edited page 수정됨", (await page.locator(".pagetree__flag", { hasText: "수정됨" }).count()) >= 1);

    // --- the 원문 toggle edits through the same save path -----------------
    await page.getByRole("button", { name: "원문" }).click();
    const raw = page.locator(".doc-editor__raw");
    await raw.click();
    await page.keyboard.press("Meta+ArrowUp");
    await page.keyboard.press("End");
    await page.keyboard.type("\n원문에서 추가한 문장입니다.");
    await waitFor(() => readFileSync(file, "utf8").includes("원문에서 추가한 문장입니다"), 10_000, "the 원문 autosave to reach the mirror");
    check(
      "the 원문 toggle saves through the same normalizer",
      canonicalize(readFileSync(file, "utf8"), meta) === readFileSync(file, "utf8"),
      "the raw edit is already in its normalized form",
    );
    await page.getByRole("button", { name: "원문" }).click();

    // --- selection → 인용 → composer chip ---------------------------------
    await page.locator(".tiptap p").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.locator(".doc-editor__quotefloat button", { hasText: "인용" }).waitFor({ timeout: 5000 });
    await page.locator(".doc-editor__quotefloat button", { hasText: "인용" }).click();
    await page.locator('[data-testid="quote-chip"]').waitFor({ timeout: 5000 });
    const chip = await page.locator('[data-testid="quote-chip"]').innerText();
    // The chip names the page and heading; the selected text itself rides
    // into the message on send, not into the chip.
    check(
      "a selection lands in the composer as a quote chip naming page and heading",
      chip.includes("주문 정책"),
      chip.replace(/\n/g, " "),
    );
    await page.locator('[data-testid="quote-chip"] .chip__dismiss').click();
    check("the quote chip can be dismissed", (await page.locator('[data-testid="quote-chip"]').count()) === 0);

    // --- the lock: read-only with the Korean banner -----------------------
    await controlCall({ id: "c4", type: "doc.lock", locked: true, reason: "테스트 잠금" });
    await page.locator(".doc-editor__lock").waitFor({ timeout: 5000 });
    check(
      "doc.lock makes the editor read-only with a banner",
      (await page.locator(".doc-editor__lock .notice__text").innerText()) === "테스트 잠금" &&
        (await page.locator(".tiptap").getAttribute("contenteditable")) === "false",
    );
    await controlCall({ id: "c5", type: "doc.lock", locked: false });
    await page.waitForFunction(() => document.querySelector(".tiptap")?.getAttribute("contenteditable") === "true", undefined, { timeout: 5000 });
    check("releasing the lock restores editing", true);

    // --- the conflict chooser ----------------------------------------------
    // Restore the page so the push story below only touches 101.
    writeFileSync(file, original);
    const target = join(MIRROR, "ENG", "회원 관리 기획서.md");
    writeFileSync(target, `${readFileSync(target, "utf8").trimEnd()}\n\n로컬에서 고친 문단입니다.\n`);

    const pulled = await controlCall({ id: "c6", type: "confluence.pull", space: "ENG" });
    check("the pull reports the conflict", pulled.data.conflicts?.length === 1, pulled.data.detail ?? "");

    await page.locator(".pagetree__title", { hasText: "회원 관리 기획서" }).click();
    await page.locator('[role="dialog"][aria-label="충돌 해결"]').waitFor({ timeout: 10000 });
    const banner = await page.locator('[role="dialog"][aria-label="충돌 해결"] .hint').innerText();
    check(
      "the chooser names both versions",
      /내 버전 v3/.test(banner) && /원격 v5/.test(banner),
      banner.replace(/\n/g, " "),
    );

    await page.getByRole("button", { name: "직접 보기" }).click();
    await page.locator(".conflict__side").first().waitFor({ timeout: 5000 });
    const sides = await page.locator(".conflict__side pre").allInnerTexts();
    check(
      "직접 보기 shows mine and theirs side by side",
      sides[0]?.includes("로컬에서 고친 문단입니다") && sides[1]?.includes("원격 충돌 분기 문단입니다"),
      `${sides[0]?.length ?? 0}B vs ${sides[1]?.length ?? 0}B`,
    );

    await page.getByRole("button", { name: "내 것으로 덮기" }).click();
    await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-label="충돌 해결"]') === null, undefined, { timeout: 10000 });
    const after = readFileSync(target, "utf8");
    check(
      "resolving mine keeps our content at the remote version",
      after.includes("로컬에서 고친 문단입니다") && parseFrontmatter(after).meta.version === 5,
      `v${parseFrontmatter(after).meta.version}`,
    );

    // --- 기획서 게시: now the stepper's own primary (PLAN D8) ---------------
    // The page is edited but unpublished, so that is exactly the step the rail
    // should be on, and 기획서 게시 is the one button it offers.
    const primary = page.locator(".stagebar__primary");
    await primary.waitFor({ timeout: 10000 });
    check(
      "the stepper stands on 게시 and offers only that",
      (await primary.innerText()).trim() === "기획서 게시" &&
        (await page.locator(".stagerail__step--on .stagerail__label").innerText()).trim() === "게시",
      `${await primary.innerText()} / ${await page.locator(".stagerail__step--on .stagerail__label").innerText()}`,
    );

    // The count of what would be sent moved to 더 보기, which carries every
    // action whatever the step: the resolved page is still "modified" (its
    // hash was cleared so the next push overwrites the remote), so it is one.
    await page.getByRole("button", { name: "더 보기" }).click();
    const publishItem = page.getByRole("menuitem", { name: /^기획서 게시/ });
    check(
      "기획서 게시 counts the pages waiting to go up",
      /게시 \(1\)/.test(await publishItem.innerText()),
      await publishItem.innerText(),
    );
    await page.keyboard.press("Escape");

    await primary.click();
    // 게시 now asks first: the dialog lists what would go up — the resolved
    // page, its version bump — and only its own 게시 button writes.
    const review = page.locator('[role="dialog"][aria-label="기획서 게시 확인"]');
    await review.waitFor({ timeout: 10000 });
    const reviewRow = review.locator(".publish__page").first();
    await reviewRow.waitFor({ timeout: 10000 });
    check(
      "the review names the page and its version bump",
      /기획서/.test(await reviewRow.innerText()) && /v\d+ → v\d+/.test(await reviewRow.innerText()),
      (await reviewRow.innerText()).replace(/\s+/g, " ").slice(0, 80),
    );
    await review.getByRole("button", { name: /^게시 \(\d+\)$/ }).click();
    await page.locator(".planner__doc .notice--info").waitFor({ timeout: 20000 });
    const pushNotice = await page.locator(".planner__doc .notice--info .notice__text").innerText();
    check(
      "게시 uploads our content at version+1 (fixture-asserted)",
      /페이지 1개 반영/.test(pushNotice),
      pushNotice,
    );

    // --- 이 문서로 화면 만들기: the next step, so the next primary ----------
    await page
      .locator(".stagebar__primary", { hasText: "이 문서로 화면 만들기" })
      .waitFor({ timeout: 15000 });
    check(
      "publishing moves the rail on to 화면 만들기",
      (await page.locator(".stagerail__step--on .stagerail__label").innerText()).trim() === "화면 만들기",
      await page.locator(".stagerail__step--on .stagerail__label").innerText(),
    );
    await page.locator(".stagebar__primary").click();
    await page.locator('.sessiontab--on:has-text("화면")').waitFor({ timeout: 15000 });
    check(
      "the handoff opens a 화면 thread on the same page and shows the screen",
      (await page.getByRole("tab", { name: "화면", exact: false }).count()) > 0 &&
        (await page.locator('.segment .segment__on').innerText()) === "화면",
    );
    // The first turn of a handoff is a sentence this app wrote, so letting it
    // name the thread would put a mirror path in the strip the planner
    // navigates by reading.
    const tabText = await page.locator(".sessiontab--on").innerText();
    check(
      "the handoff tab is named after its 기획서, not the path in the brief",
      tabText.includes("회원 관리 기획서") && !tabText.includes("@confluence/"),
      tabText,
    );
    const composer = page.locator(".composer textarea");
    await composer.waitFor({ timeout: 5000 });
    const drafted = await composer.inputValue();
    // PLAN D9: the 기획서 is a chip, and the box holds a sentence the planner
    // can edit. The mirror path is Claude's business and appears nowhere they
    // could accidentally delete half of it.
    const briefChip = page.locator('[data-testid="brief-chip"]');
    await briefChip.waitFor({ timeout: 5000 });
    check(
      "the 기획서 rides as a chip, named by its title",
      (await briefChip.innerText()).includes("회원 관리 기획서"),
      await briefChip.innerText(),
    );
    check(
      "the brief is prefilled as plain words, with no path in the box",
      drafted.includes("이 기획서로 화면을 만들어 주세요") &&
        !drafted.includes("@confluence/") &&
        !drafted.includes(".md"),
      drafted,
    );
    check("nothing was sent on the planner's behalf", (await page.locator(".bubble--user").count()) === 0);

    // Sending is what turns the chip back into the reference Claude reads.
    await page.locator(".composer__send").click();
    let briefEcho = null;
    await waitFor(
      () => {
        briefEcho = controlInbox.find(
          (m) =>
            m.type === "session.event" &&
            m.event?.kind === "user.echo" &&
            typeof m.event.text === "string" &&
            m.event.text.includes("이 기획서로 화면을 만들어 주세요"),
        );
        return Boolean(briefEcho);
      },
      20000,
      "the brief turn on the socket",
    ).catch(() => {
      briefEcho = null;
    });
    const briefText = briefEcho?.event?.text ?? "";
    check(
      "the sent turn still carries the @confluence reference",
      briefText.includes("@confluence/ENG/회원 관리 기획서.md"),
      briefText.slice(0, 120),
    );
    const briefCard = page.locator(".machine--brief");
    await briefCard.waitFor({ timeout: 15000 }).catch(() => undefined);
    check(
      "and it is rendered as a card, not as the path",
      (await briefCard.count()) === 1 &&
        (await briefCard.innerText()).includes("회원 관리 기획서") &&
        !(await briefCard.innerText()).includes("@confluence/"),
      (await briefCard.count()) === 1 ? await briefCard.innerText() : "no card",
    );

    // --- the three columns hold at a laptop width (PLAN M7 acceptance) -----
    // 나란히 needs 1440; below that the two panes are each too narrow to read,
    // so the option is withdrawn rather than offered and disappointing.
    check(
      "나란히 is offered at 1720",
      (await page.getByRole("tab", { name: "나란히" }).count()) === 1,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(200);
    check(
      "and withdrawn at 1280, where it would not fit",
      (await page.getByRole("tab", { name: "나란히" }).count()) === 0,
    );

    const columns = await Promise.all(
      [".planner__sessions", ".planner__chatcol", ".planner__doc"].map((selector) =>
        page.locator(selector).boundingBox(),
      ),
    );
    const laidOut =
      columns.every((box) => box !== null && box.width > 120) &&
      columns[0].x + columns[0].width <= columns[1].x + 1 &&
      columns[1].x + columns[1].width <= columns[2].x + 1 &&
      columns[2].x + columns[2].width <= 1281;
    check(
      "the three columns still sit side by side at 1280, none overlapping",
      laidOut,
      columns.map((box) => (box ? `${Math.round(box.x)}+${Math.round(box.width)}` : "none")).join(" "),
    );
    await page.screenshot({ path: join(here, "ui-editor-1280.png") });
    await page.setViewportSize({ width: 1720, height: 1000 });
    await page.waitForTimeout(200);

    check("no uncaught console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.screenshot({ path: join(here, "ui-editor-e2e.png"), fullPage: true });
  } finally {
    await browser.close();
    server.close();
    control.close();
    daemon.kill("SIGTERM");
    rmSync(DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

/** The single save path, as the daemon applies it (used as the oracle here). */
function canonicalize(markdown, meta) {
  const storage = markdownToStorage(markdown, "attachments/102").storage;
  return storageToMarkdown(storage, {
    pageId: meta.pageId,
    version: meta.version,
    space: meta.space,
    title: meta.title,
    parentPageId: meta.parentPageId ?? null,
  }, "attachments/102");
}

function firstDifference(actual, expected) {
  if (actual === expected) return "";
  for (let i = 0; i < Math.min(actual.length, expected.length); i += 1) {
    if (actual[i] !== expected[i]) {
      return `at ${i}: …${JSON.stringify(actual.slice(Math.max(0, i - 30), i + 30))} vs …${JSON.stringify(expected.slice(Math.max(0, i - 30), i + 30))}`;
    }
  }
  return `length ${actual.length} vs ${expected.length}`;
}

main().catch((error) => {
  console.error(`\nEDITOR E2E ERROR: ${error.message}`);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(2);
});
