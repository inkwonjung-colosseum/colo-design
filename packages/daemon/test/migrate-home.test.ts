// 0.4.0 저장 위치 이주의 시험 (RENAME-NOVA-PLAN §3.3 · §8.1 "데이터 폴더 이주").
// 임시 홈을 파고 실제 파일들로 돈다 — rename · 경로 다시 쓰기 · Claude munged
// rename · Codex cwd 재작성 · 멱등성(두 번 돌리면 변화 없음).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeProjectDirName,
  migrateLegacyDataHome,
  ompSessionDirName,
  warnLegacyEnv,
} from "../dist/migrate-home.js";

// read-legacy — 치환 스크립트가 시험의 기대값까지 바꾸지 않게 조각으로 잇는다.
const LEGACY = ["co", "lo"].join("");

function makeLegacyHome(): string {
  const home = mkdtempSync(join(tmpdir(), "nova-migrate-"));
  const old = join(home, `.${LEGACY}-design`);
  const repo = join(old, "projects", "jul5", "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(old, "config"), { recursive: true });
  writeFileSync(
    join(old, "config", "projects.json"),
    `${JSON.stringify(
      {
        active: "jul5",
        projects: [
          {
            slug: "jul5",
            name: "결제",
            root: repo,
            repo: { url: null, baseBranch: "main", branch: null, handoff: null },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(join(repo, ".."), "cycle.json"),
    `${JSON.stringify({ path: repo, branches: [] }, null, 2)}\n`,
  );
  writeFileSync(
    join(repo, ".git", "config"),
    `[core]\n\thooksPath = ${join(old, "tools", "git-guard", "hooks")}\n[remote "origin"]\n\turl = https://example.com/x.git\n`,
  );
  // 세 공급자의 대화 저장소 — 모두 클론의 경로로 지난 대화를 찾는다.
  mkdirSync(join(home, ".claude", "projects", claudeProjectDirName(repo)), { recursive: true });
  const ompName = ompSessionDirName(repo, home);
  assert.ok(ompName);
  mkdirSync(join(home, ".omp", "agent", "sessions", ompName), { recursive: true });
  const rolloutDir = join(home, ".codex", "sessions", "2026", "09", "29");
  mkdirSync(rolloutDir, { recursive: true });
  const meta = {
    timestamp: "2026-09-29T00:00:00Z",
    type: "session_meta",
    payload: { id: "s1", cwd: repo },
  };
  const second = { type: "event_msg", payload: { type: "user_message", message: "안녕" } };
  writeFileSync(
    join(rolloutDir, "rollout-2026-09-29T00-00-00-s1.jsonl"),
    `${JSON.stringify(meta)}\n${JSON.stringify(second)}\n`,
  );
  return home;
}

test("데이터 폴더 이주 — 폴더 rename · 경로 다시 쓰기 · 세 저장소가 함께 간다", () => {
  const home = makeLegacyHome();
  try {
    const report = migrateLegacyDataHome({ home });
    const fresh = join(home, ".nova-design");
    assert.equal(report.renamedDataDir, true);
    assert.ok(existsSync(fresh));
    assert.ok(!existsSync(join(home, `.${LEGACY}-design`)));

    // projects.json · cycle.json · .git/config 의 절대 경로 접두.
    const projects = JSON.parse(readFileSync(join(fresh, "config", "projects.json"), "utf8"));
    assert.ok(projects.projects[0].root.startsWith(fresh));
    const cycle = JSON.parse(readFileSync(join(fresh, "projects", "jul5", "cycle.json"), "utf8"));
    assert.ok(cycle.path.startsWith(fresh));
    const gitConfig = readFileSync(
      join(fresh, "projects", "jul5", "repo", ".git", "config"),
      "utf8",
    );
    assert.ok(gitConfig.includes(join(fresh, "tools", "git-guard", "hooks")));

    // Claude — munged 폴더가 옮겨졌다.
    const newRepo = join(fresh, "projects", "jul5", "repo");
    assert.ok(
      !existsSync(
        join(
          home,
          ".claude",
          "projects",
          claudeProjectDirName(join(home, `.${LEGACY}-design`, "projects", "jul5", "repo")),
        ),
      ),
    );
    assert.ok(existsSync(join(home, ".claude", "projects", claudeProjectDirName(newRepo))));
    assert.equal(report.claudeMoved, 1);

    // omp — 인코딩된 폴더가 옮겨졌다.
    const ompNew = ompSessionDirName(newRepo, home);
    assert.ok(ompNew);
    assert.ok(existsSync(join(home, ".omp", "agent", "sessions", ompNew)));
    assert.equal(report.ompMoved, 1);

    // Codex — 롤아웃 첫 줄의 cwd 만 다시 쓰고 나머지 줄은 그대로.
    const rollout = readFileSync(
      join(home, ".codex", "sessions", "2026", "09", "29", "rollout-2026-09-29T00-00-00-s1.jsonl"),
      "utf8",
    );
    const lines = rollout.split("\n");
    const meta = JSON.parse(lines[0]);
    assert.equal(meta.payload.cwd, newRepo);
    assert.equal(
      lines[1],
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "안녕" } }),
    );
    assert.equal(report.codexRewritten, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("데이터 폴더 이주는 멱원이다 — 두 번째 실행은 아무 것도 하지 않는다", () => {
  const home = makeLegacyHome();
  try {
    migrateLegacyDataHome({ home });
    const fresh = join(home, ".nova-design");
    const projectsBefore = readFileSync(join(fresh, "config", "projects.json"), "utf8");
    const report = migrateLegacyDataHome({ home });
    assert.equal(report.renamedDataDir, false);
    assert.equal(report.rewrotePaths, 0);
    assert.equal(report.claudeMoved, 0);
    assert.equal(report.ompMoved, 0);
    assert.equal(report.codexRewritten, 0);
    assert.equal(readFileSync(join(fresh, "config", "projects.json"), "utf8"), projectsBefore);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("옛·새 폴더가 둘 다 있으면 새 것을 쓰고 경고 한 줄을 남긴다", () => {
  const home = mkdtempSync(join(tmpdir(), "nova-migrate-"));
  try {
    mkdirSync(join(home, `.${LEGACY}-design`), { recursive: true });
    mkdirSync(join(home, ".nova-design"), { recursive: true });
    const notes: string[] = [];
    const report = migrateLegacyDataHome({ home, onNote: (line) => notes.push(line) });
    assert.equal(report.renamedDataDir, false);
    assert.equal(report.bothExist, true);
    assert.equal(notes.length, 1);
    assert.ok(notes[0]?.includes("~/.nova-design"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Claude munged 이름 — 영숫자 밖 글자가 - 로 (실측 모양)", () => {
  // read-legacy — 이 기계에서 실제로 본 폴더 이름의 모양.
  const legacy = ["co", "lo"].join("");
  assert.equal(
    claudeProjectDirName(`/Users/dev/.${legacy}-design/projects/cds/repo`),
    `-Users-dev--${legacy}-design-projects-cds-repo`,
  );
});

test("omp 세션 폴더 이름 — 홈 상대 경로의 구분자만 - 로", () => {
  const home = "/Users/dev";
  assert.equal(
    ompSessionDirName(`${home}/.${LEGACY}-design/projects/jul5/repo`, home),
    `-.${LEGACY}-design-projects-jul5-repo`,
  );
  assert.equal(ompSessionDirName("/elsewhere/repo", home), null);
});

// read-legacy
test("옛 환경 변수 경고 — COLO_DESIGN_* 가 있으면 새 이름을 알린다", () => {
  // read-legacy
  // read-legacy — 옛 접두의 환경 변수.
  // read-legacy
  const legacyPrefix = ["COLO_", "DESIGN_"].join("");
  const lines: string[] = [];
  const found = warnLegacyEnv(
    { [`${legacyPrefix}PORT`]: "7823", PATH: "/bin" } as unknown as NodeJS.ProcessEnv,
    (line) => lines.push(line),
  );
  assert.deepEqual(found, [`${legacyPrefix}PORT`]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.includes("NOVA_DESIGN_"));
  assert.deepEqual(
    warnLegacyEnv({ PATH: "/bin" }, (line) => lines.push(line)),
    [],
  );
  assert.equal(lines.length, 1);
});
