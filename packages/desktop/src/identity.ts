import { join } from "node:path";

/**
 * 앱의 설치 정체성(RENAME-NOVA-PLAN A1) — electron 을 가져오지 않는 순수
 * 모듈. 설치 정체성의 상수가 시험(nova-names)의 대상이 되므로 메인 프로세스의
 * 조립(main.ts)과 갈라 둔다.
 */

/** 앱 번들 아이디 — Windows 토스트의 AUMID(NSIS 바로 가기에 새겨진 appId)와
 *  mac 알림 설정의 딥링크. electron-builder.yml 의 appId 와 같은 문자열. */
export const APP_BUNDLE_ID = "org.nova-design.desktop";

/** 제품명 — productName. Electron 이 userData 폴더 이름의 기본값으로 쓴다. */
export const PRODUCT_NAME = "Nova Design";

// read-legacy — 0.3.x 의 설치 정체성. 개명으로 appId 가 바뀌어도 옛 설치가
// 새 설치 옆에 남지 않게 NSIS include(build/installer.nsh)가 옛 GUID 설치를
// 설치 맨 앞에서 지운다 — 옛 데이터를 읽는 것이 아니라 치우는 것이다.
export const LEGACY_APP_BUNDLE_ID = "org.colo-design.desktop"; // read-legacy

/** `UUIDv5(LEGACY_APP_BUNDLE_ID, 50e065bc-3134-11e6-9bab-38c9862bdaf3)` —
 *  electron-builder(app-builder-lib NsisTarget)가 설치를 찾는 레지스트리
 *  키(`HKCU\Software\<GUID>`)의 옛 값. 라이브러리로 계산해 박는다. */
export const LEGACY_NSIS_GUID = "8e8a724d-d884-5802-b7a6-73f52ed44cb4";

/** userData 폴더 — productName 이 Electron 기본값을 짓는 같은 규칙. */
export function userDataDir(appData: string): string {
  return join(appData, PRODUCT_NAME);
}
