import { APP_SHORTCUTS } from "@colo-design/protocol";
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
interface MenuPreviewTarget {
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
  /** 새 대화 ⌘T — the web's own chord, replayed so focus does not matter. */
  newSession(): void;
  /** 개발자 도구는 dev 에서만 — 사용자에게 필요 없고, 문제 해결은 설정에. */
  packaged: boolean;
}

export function buildMenuTemplate(targets: MenuTargets): MenuItemConstructorOptions[] {
  const { preview, packaged } = targets;
  // D92: the menu and the ⌘/ sheet read ONE constant — the accelerators and
  // labels here are the array's, so the two surfaces cannot drift.
  const clickFor: Record<string, () => void> = {
    reload: () => preview?.reload(),
    back: () => preview?.history(-1),
    forward: () => preview?.history(1),
    address: () => targets.gotoAddress(),
    "zoom-in": () => preview?.zoomIn(),
    "zoom-out": () => preview?.zoomOut(),
    "zoom-reset": () => preview?.zoomReset(),
    settings: () => targets.openSettings(),
    "new-session": () => targets.newSession(),
  };
  const item = (id: string): MenuItemConstructorOptions => {
    const shortcut = APP_SHORTCUTS.find((entry) => entry.id === id);
    if (!shortcut || !shortcut.accelerator) throw new Error(`unknown shortcut: ${id}`);
    return {
      label: shortcut.label,
      accelerator: shortcut.accelerator,
      click: clickFor[id],
    };
  };
  const viewMenu: MenuItemConstructorOptions[] = [
    { ...item("reload"), id: "preview-reload" },
    { type: "separator" },
    item("back"),
    item("forward"),
    item("address"),
    { type: "separator" },
    item("zoom-in"),
    item("zoom-out"),
    item("zoom-reset"),
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
    label: "Colo Design",
    submenu: [
      { role: "about" },
      item("new-session"),
      item("settings"),
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
  const windowMenu: MenuItemConstructorOptions = {
    label: "창",
    role: "windowMenu",
  };
  return [appMenu, editMenu, viewItem, windowMenu];
}
