/**
 * 단축키 상수 (PLAN D92) — 데스크톱의 앱 메뉴(menu.ts)와 웹의 ⌘/ 시트가
 * **같은 배열**을 읽는다. 두 벌이 어긋날 길이 없다: 메뉴의 가속키 집합은 이
 * 상수의 accelerator 들이고, 시트의 행은 이 상수의 순서 그대로다.
 * `accelerator` 이 없는 행은 포인터 조합(⌥+클릭)이거나 웹 워크스페이스가
 * 혼자 처리하는 코드(⌘/, ⌘⇧P)라 메뉴에 없는 것이다.
 */

export interface AppShortcut {
  id: string;
  /** What it does, in the planner's words. */
  label: string;
  /** How it is drawn on paper — the sheet and the menu both show this. */
  keys: string;
  /** Electron accelerator; absent for pointer-only shortcuts. */
  accelerator?: string;
}

export const APP_SHORTCUTS: AppShortcut[] = [
  { id: "find", label: "찾기", keys: "⌘K", accelerator: "CmdOrCtrl+K" },
  {
    id: "new-session",
    label: "새 대화",
    keys: "⌘T",
    accelerator: "CmdOrCtrl+T",
  },
  { id: "settings", label: "설정", keys: "⌘,", accelerator: "CmdOrCtrl+," },
  {
    id: "address",
    label: "주소로 이동",
    keys: "⌘L",
    accelerator: "CmdOrCtrl+L",
  },
  {
    id: "reload",
    label: "미리보기 새로 고침",
    keys: "⌘R",
    accelerator: "CmdOrCtrl+R",
  },
  { id: "back", label: "뒤로", keys: "⌘[", accelerator: "CmdOrCtrl+[" },
  { id: "forward", label: "앞으로", keys: "⌘]", accelerator: "CmdOrCtrl+]" },
  { id: "zoom-in", label: "화면 크게", keys: "⌘=", accelerator: "CmdOrCtrl+=" },
  { id: "zoom-out", label: "화면 작게", keys: "⌘-", accelerator: "CmdOrCtrl+-" },
  {
    id: "zoom-reset",
    label: "화면 실제 크기",
    keys: "⌘0",
    accelerator: "CmdOrCtrl+0",
  },
  // ⌘= · ⌘- · ⌘0 이 키우는 것은 앱 전체(U19) — 미리보기 칸만 키우는 자기
  // 배율은 `···` 메뉴 안의 조작이라 가속키가 없다(menu.ts 의 item() 이 이
  // id 를 부르지 않으므로 메뉴는 읽지 않는다).
  { id: "preview-zoom", label: "미리보기 배율", keys: "··· 메뉴" },
  { id: "pin", label: "핀 찍기", keys: "⌥+클릭 · 끌면 영역" },
  // 웹 워크스페이스가 혼자 처리하는 코드(PageWorkspace keydown의 ⌘⇧P)라
  // 가속키가 없다 — 데스크톱 메뉴가 읽어도 click 없는 항목이 되니 일부러
  // 밖에 둔다. 아래 ⌘/ 와 같은 판이다.
  { id: "pin-mode", label: "핀 모드", keys: "⌘⇧P" },
  // 입력창이 혼자 처리하는 키(Composer 의 onKeyDown) — 빈 입력창에서 보낸
  // 말을 하나씩 거슬러 불러온다. 맨 화살표는 커서의 것이라 ⌥ 와 함께다.
  { id: "recall", label: "보낸 말 다시 불러오기", keys: "⌥↑ · ⌥↓" },
  // 시트 자신의 행 — 가속키가 없다: ⌘/ 는 웹(워크스페이스 keydown)이
  // 혼자 처리하고, 데스크톱 메뉴에는 앉지 않는다(메뉴가 읽어도 click 이
  // 없는 항목이 되니 일부러 밖에 둔다).
  { id: "shortcuts", label: "단축키", keys: "⌘/" },
];
