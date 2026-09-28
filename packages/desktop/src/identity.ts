import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 앱의 설치 정체성(RENAME-NOVA-PLAN A1 · §3.2 · §4) — electron 을 가져오지
 * 않는 순수 모듈. 폴더 이름 계산과 이주 판정이 시험의 대상이 되므로 메인
 * 프로세스의 조립(main.ts)과 갈라 둔다.
 */

/** 앱 번들 아이디 — Windows 토스트의 AUMID(NSIS 바로 가기에 새겨진 appId)와
 *  mac 알림 설정의 딥링크. electron-builder.yml 의 appId 와 같은 문자열. */
export const APP_BUNDLE_ID = "org.nova-design.desktop";

/** 제품명 — productName. Electron 이 userData 폴더 이름의 기본값으로 쓴다. */
export const PRODUCT_NAME = "Nova Design";

// read-legacy — 0.3.x 의 설치 정체성. appId 가 바뀌므로 NSIS include 가 옛
// GUID 설치를 먼저 지운다(installer.nsh 와 짝).
// read-legacy
export const LEGACY_APP_BUNDLE_ID = "org.colo-design.desktop";

/** `UUIDv5(LEGACY_APP_BUNDLE_ID, 50e065bc-3134-11e6-9bab-38c9862bdaf3)` —
 *  electron-builder(app-builder-lib NsisTarget)가 설치를 찾는 레지스트리
 *  키(`HKCU\Software\<GUID>`)의 옛 값. 라이브러리로 계산해 박는다. */
export const LEGACY_NSIS_GUID = "8e8a724d-d884-5802-b7a6-73f52ed44cb4";

/** userData 폴더 — productName 이 Electron 기본값을 짓는 같은 규칙. */
export function userDataDir(appData: string): string {
  return join(appData, PRODUCT_NAME);
}

// read-legacy — 0.3.x 의 userData 폴더.
export function legacyUserDataDir(appData: string): string {
  // read-legacy
  return join(appData, "Colo Design");
}

export interface IdentityIo {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
}

const fsIo: IdentityIo = { exists: existsSync, rename: renameSync };

/**
 * userData 이주(§3.3) — 옛 `…/Colo Design` 이 있고 `…/Nova Design` 이 없으면
 * 폴더째 rename 한다. `Local State`(Windows DPAPI 키)와 `Partitions` 이 따라
 * 오므로 잠금과 자물쇠가 함께 옮겨진다. 단일 인스턴스 잠금 **앞에서** 돈다 —
 * 잠금 파일이 userData 안에 살므로. 스모크 폴더는 호출자가 선행 조건으로 뺀다.
 */
export function migrateUserDataFolder(
  appData: string,
  io: IdentityIo = fsIo,
): { renamed: boolean; from: string; to: string } {
  const from = legacyUserDataDir(appData);
  const to = userDataDir(appData);
  if (!io.exists(from) || io.exists(to)) return { renamed: false, from, to };
  io.rename(from, to);
  return { renamed: true, from, to };
}

// ---------------------------------------------------------------------------
// mac 번들 정리 (§4.1 · D-6) — 0.3.x 교체 스크립트가 새 앱을 옛 번들 자리
// (`/Applications/Colo Design.app`)에 놓고 연다. 첫 실행이 이름을 바꾸고 다시
// 실행한다.
// ---------------------------------------------------------------------------

export interface BundleRenameInput {
  /** 패키징된 실행인가(app.isPackaged). */
  packaged: boolean;
  /** process.platform. */
  platform: string;
  /** 지금 도는 실행 파일 — `<번들>/Contents/MacOS/Nova Design`. */
  execPath: string;
  /** 앱 버전 — 시도 표식의 이름에 들어간다. */
  version: string;
  /** 데이터 폴더(`~/.nova-design`) — 시도 표식의 자리. */
  dataDir: string;
  /** 옛 데이터 폴더(`~/.colo-design`) — 이주 전에 적힌 흔적도 본다. */
  legacyDataDir: string;
  exists(path: string): boolean;
}

export type BundleRenamePlan =
  | { action: "relaunch-rename"; from: string; to: string; marker: string }
  | { action: "none"; reason: string };

/** 실행 파일에서 번들 폴더 — `<번들>/Contents/MacOS/<이름>` 의 셋 위. */
export function bundleDirOf(execPath: string): string {
  return dirname(dirname(dirname(execPath)));
}

/** 이 버전의 시도 표식 — 실패가 재실행 고리가 되지 않게 먼저 적는다. */
export function bundleRenameMarkerPath(dataDir: string, version: string): string {
  return join(dataDir, "run", `bundle-rename-${version}`);
}

/**
 * 번들 정리 판정 — 순수 함수. 조건(§4.1): 패키징됨 · darwin · 지금 번들이
 * `Colo Design.app` · 옆에 `Nova Design.app` 이 없음 · 경로에
 * `/AppTranslocation/` 이 없음 · 이 버전의 시도 표식이 없음(옛 자리도).
 */
export function bundleRenamePlan(input: BundleRenameInput): BundleRenamePlan {
  if (!input.packaged) return { action: "none", reason: "not-packaged" };
  if (input.platform !== "darwin") return { action: "none", reason: "not-darwin" };
  const from = bundleDirOf(input.execPath);
  if (!from.endsWith(".app")) return { action: "none", reason: "not-in-bundle" };
  // read-legacy — 옛 번들 이름에서만 돈다.
  // read-legacy
  if (dirname(from) === from || !from.endsWith("/Colo Design.app")) {
    // read-legacy
    return { action: "none", reason: "already-nova" };
  }
  if (input.execPath.includes("/AppTranslocation/")) {
    return { action: "none", reason: "app-translocation" };
  }
  const marker = bundleRenameMarkerPath(input.dataDir, input.version);
  if (
    input.exists(marker) ||
    input.exists(bundleRenameMarkerPath(input.legacyDataDir, input.version))
  ) {
    return { action: "none", reason: "already-attempted" };
  }
  const to = join(dirname(from), "Nova Design.app");
  if (input.exists(to)) return { action: "none", reason: "sibling-exists" };
  return { action: "relaunch-rename", from, to, marker };
}
