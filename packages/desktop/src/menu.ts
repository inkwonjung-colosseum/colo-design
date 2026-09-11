import type { MenuItemConstructorOptions } from "electron";

/**
 * 애플리케이션 메뉴 (PLAN D85 ⓒ). Electron 기본 메뉴의 reload · zoom ·
 * toggleDevTools 역할은 포커스된 창의 webContents 를 겨눈다 — 미리보기 뷰가
 * 창의 자식이라 ⌘R 이 도구 UI 를 통째로 새로 고침하고 ⌘+ 는 도구를 키웠다.
 * 우리가 만든 메뉴는 보기 항목을 미리보기 뷰로 겨눈다: 가속키는 포커스가
 * 채팅에 있어도 뷰에 있어도 같은 곳에 닿는다.
 *
 * `buildMenuTemplate` 는 순수 함수다 — desktop 단위 테스트가 가속키와 역할
 * 배제(기본 reload · zoomIn · packaged 의 toggleDevTools)를 이 파일만 읽고
 * 판정한다. `targets.preview` 가 없으면 보기 항목은 조용히 동작하지 않는다.
 */

/** The slice of PlannerPreviewView the menu aims at. */
export interface MenuPreviewTarget {
  reload(): void;
  history(delta: -1 | 1): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
}

export interface MenuTargets {
  preview: MenuPreviewTarget | null;
  /**
   * 주소로 이동 ⌘L (D85 ⓒ): the view's key-forward channel replays ⌘L into
   * the web, which focuses the address input.
   */
  gotoAddress(): void;
  /** 설정 ⌘, — the web's own chord, replayed so focus does not matter. */
  openSettings(): void;
  /** 개발자 도구는 dev 에서만 — 기획자에게 필요 없고, 문제 해결은 설정에. */
  packaged: boolean;
}

export function buildMenuTemplate(targets: MenuTargets): MenuItemConstructorOptions[] {
  const { preview, packaged } = targets;
  const viewMenu: MenuItemConstructorOptions[] = [
    {
      label: "미리보기 새로 고침",
      id: "preview-reload",
      accelerator: "CmdOrCtrl+R",
      click: () => preview?.reload(),
    },
    { type: "separator" },
    {
      label: "뒤로",
      accelerator: "CmdOrCtrl+[",
      click: () => preview?.history(-1),
    },
    {
      label: "앞으로",
      accelerator: "CmdOrCtrl+]",
      click: () => preview?.history(1),
    },
    {
      label: "주소로 이동",
      accelerator: "CmdOrCtrl+L",
      click: () => targets.gotoAddress(),
    },
    { type: "separator" },
    {
      label: "확대",
      accelerator: "CmdOrCtrl+=",
      click: () => preview?.zoomIn(),
    },
    {
      label: "축소",
      accelerator: "CmdOrCtrl+-",
      click: () => preview?.zoomOut(),
    },
    {
      label: "실제 크기",
      accelerator: "CmdOrCtrl+0",
      click: () => preview?.zoomReset(),
    },
  ];
  // 개발자 도구는 도구 UI 대상 그대로(개발자 것) — dev 에서만.
  if (!packaged) {
    viewMenu.push(
      { type: "separator" },
      {
        label: "개발자 도구",
        accelerator: "Alt+CmdOrCtrl+I",
        role: "toggleDevTools",
      },
    );
  }

  const appMenu: MenuItemConstructorOptions = {
    label: "CDS Design",
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
  const editMenu: MenuItemConstructorOptions = {
    label: "편집",
    submenu: [
      // 컴포저의 undo · copy · paste 가 그것이다 — 기본 역할 그대로.
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };
  const viewItem: MenuItemConstructorOptions = {
    label: "보기",
    submenu: viewMenu,
  };
  // 설정 ⌘, — the web's own chord, replayed so it works from any focus.
  // It lives in the app menu, the place a setting is looked for.
  (appMenu.submenu as MenuItemConstructorOptions[]).splice(2, 0, {
    label: "설정",
    accelerator: "CmdOrCtrl+,",
    click: () => targets.openSettings(),
  });
  const windowMenu: MenuItemConstructorOptions = { label: "창", role: "windowMenu" };
  return [appMenu, editMenu, viewItem, windowMenu];
}
