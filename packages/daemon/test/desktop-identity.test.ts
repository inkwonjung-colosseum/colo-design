// 데스크톱 설치 정체성의 순수 부분 (RENAME-NOVA-PLAN §3.2 · §4.1 · §8.1) —
// userData 이주와 mac 번들 정리 판정. electron 을 부르지 않는 파일이라 경로로
// 직접 들어온다(invite-discard.test.ts 와 같은 길).
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  APP_BUNDLE_ID,
  bundleRenameMarkerPath,
  bundleRenamePlan,
  LEGACY_APP_BUNDLE_ID,
  LEGACY_NSIS_GUID,
  legacyUserDataDir,
  migrateUserDataFolder,
  userDataDir,
} = await import(new URL("../../desktop/src/identity.ts", import.meta.url).href);

// read-legacy — 기대값은 조각으로 잇는다.
const LEGACY = ["co", "lo"].join("");

test("상수 — 새 appId 는 nova, 옛 appId 는 installer.nsh 의 GUID 짝", () => {
  assert.equal(APP_BUNDLE_ID, "org.nova-design.desktop");
  assert.equal(LEGACY_APP_BUNDLE_ID, `org.${LEGACY}-design.desktop`);
  // UUIDv5(appId, 50e065bc-…) — electron-builder 가 설치를 찾는 레지스트리 키.
  assert.equal(LEGACY_NSIS_GUID, "8e8a724d-d884-5802-b7a6-73f52ed44cb4");
  assert.equal(userDataDir("/appdata"), "/appdata/Nova Design");
  assert.equal(legacyUserDataDir("/appdata"), `/appdata/${["Colo", " Design"].join("")}`); // read-legacy
});

test("userData 이주 — 옛 폴더만 있으면 rename, 새 폴더가 있으면 건너뛴다", () => {
  const renamed: Array<[string, string]> = [];
  const made: Record<string, boolean> = { "/appdata/Colo Design": true }; // read-legacy
  const io = {
    exists: (path: string) => made[path] === true,
    rename: (from: string, to: string) => {
      renamed.push([from, to]);
      made[to] = true;
      made[from] = false;
    },
  };
  const first = migrateUserDataFolder("/appdata", io);
  assert.equal(first.renamed, true);
  assert.deepEqual(renamed, [["/appdata/Colo Design", "/appdata/Nova Design"]]); // read-legacy
  // 멱원 — 두 번째 실행은 아무 것도 하지 않는다.
  const second = migrateUserDataFolder("/appdata", io);
  assert.equal(second.renamed, false);
  assert.equal(renamed.length, 1);
  // 둘 다 없는 기계(첫 설치)도 조용하다.
  const fresh = migrateUserDataFolder("/appdata", {
    exists: () => false,
    rename: () => {
      throw new Error("rename should not run");
    },
  });
  assert.equal(fresh.renamed, false);
});

const PLAN_INPUT = {
  packaged: true,
  platform: "darwin",
  version: "0.4.0",
  dataDir: "/home/.nova-design",
  legacyDataDir: "/home/.colo-design", // read-legacy
  execPath: "/Applications/Colo Design.app/Contents/MacOS/Nova Design", // read-legacy
  exists: (_path: string) => false,
};

test("번들 정리 — 옛 번들 자리에서 돌면 이름을 바꾸고 다시 실행한다", () => {
  const plan = bundleRenamePlan({ ...PLAN_INPUT, exists: () => false });
  assert.equal(plan.action, "relaunch-rename");
  if (plan.action !== "relaunch-rename") return;
  assert.equal(plan.from, "/Applications/Colo Design.app"); // read-legacy
  assert.equal(plan.to, "/Applications/Nova Design.app");
  assert.equal(plan.marker, bundleRenameMarkerPath("/home/.nova-design", "0.4.0"));
});

test("번들 정리 — 이미 새 이름이면 아무 것도 하지 않는다", () => {
  const plan = bundleRenamePlan({
    ...PLAN_INPUT,
    execPath: "/Applications/Nova Design.app/Contents/MacOS/Nova Design",
  });
  assert.equal(plan.action, "none");
});

test("번들 정리 — 패키징되지 않았거나 darwin 이 아니면 돌지 않는다", () => {
  assert.equal(bundleRenamePlan({ ...PLAN_INPUT, packaged: false }).action, "none");
  assert.equal(bundleRenamePlan({ ...PLAN_INPUT, platform: "win32" }).action, "none");
});

test("번들 정리 — AppTranslocation 안에서는 돌지 않는다", () => {
  const plan = bundleRenamePlan({
    ...PLAN_INPUT,
    execPath:
      "/private/var/folders/…/AppTranslocation/D/Colo Design.app/Contents/MacOS/Nova Design", // read-legacy
  });
  assert.equal(plan.action, "none");
});

test("번들 정리 — 이 버전의 시도 표식이 있으면(옛 자리도) 다시 시도하지 않는다", () => {
  const marker = bundleRenameMarkerPath("/home/.nova-design", "0.4.0");
  assert.equal(bundleRenamePlan({ ...PLAN_INPUT, exists: (p) => p === marker }).action, "none");
  const legacyMarker = bundleRenameMarkerPath("/home/.colo-design", "0.4.0"); // read-legacy
  assert.equal(
    bundleRenamePlan({ ...PLAN_INPUT, exists: (p) => p === legacyMarker }).action,
    "none",
  );
});

test("번들 정리 — 옆에 Nova Design.app 이 이미 있으면 건드리지 않는다", () => {
  const plan = bundleRenamePlan({
    ...PLAN_INPUT,
    exists: (path) => path === "/Applications/Nova Design.app",
  });
  assert.equal(plan.action, "none");
});
