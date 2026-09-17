/**
 * 단축키 상수 (PLAN D92) — 데스크톱의 앱 메뉴(menu.ts)와 웹의 ⌘/ 시트가
 * **같은 배열**을 읽는다. 두 벌이 어긋날 길이 없다: 메뉴의 가속키 집합은 이
 * 상수의 accelerator 들이고, 시트의 행은 이 상수의 순서 그대로다.
 * `accelerator` 이 없는 행은 마우스·키 조합(⌥+클릭)이라 메뉴에 없는 것이다.
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
  {
    id: "tab-previous",
    label: "이전 탭",
    keys: "⌘⇧[",
    accelerator: "CmdOrCtrl+Shift+[",
  },
  {
    id: "tab-next",
    label: "다음 탭",
    keys: "⌘⇧]",
    accelerator: "CmdOrCtrl+Shift+]",
  },
  { id: "zoom-in", label: "확대", keys: "⌘=", accelerator: "CmdOrCtrl+=" },
  { id: "zoom-out", label: "축소", keys: "⌘-", accelerator: "CmdOrCtrl+-" },
  {
    id: "zoom-reset",
    label: "실제 크기",
    keys: "⌘0",
    accelerator: "CmdOrCtrl+0",
  },
  { id: "pin", label: "핀 찍기", keys: "⌥+클릭" },
  { id: "interrupt-send", label: "끊고 보내기", keys: "⌥Enter" },
  // 시트 자신의 행 — 가속키가 없다: ⌘/ 는 웹(워크스페이스 keydown)이
  // 혼자 처리하고, 데스크톱 메뉴에는 앉지 않는다(메뉴가 읽어도 click 이
  // 없는 항목이 되니 일부러 밖에 둔다).
  { id: "shortcuts", label: "단축키", keys: "⌘/" },
];
