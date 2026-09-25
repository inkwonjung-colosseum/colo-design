/**
 * 셸의 이동 상태 — 홈과 대화, 좁은 창의 탭, 사이드바의 접힘과 서랍. 주소에
 * 싣지 않고 셸이 쥔다(PLAN-UI 단계 1). 어느 대화가 열렸는지는 `useSessions`
 * 의 `activeId` 가 주인이다 — 여기엔 두 번째 사본을 두지 않는다.
 */
export interface NavState {
  /** `home` 큰 입력창과 받은 편지함(U6) · `thread` 대화 + 미리보기. */
  view: "home" | "thread";
  /** 좁은 창(900px 아래)의 두 탭 중 앞에 선 것(U16). 넓은 창은 읽지 않는다. */
  tab: "chat" | "preview";
  /** 좁은 창의 사이드바 서랍이 열려 있는가(`≡` · 스크림). */
  drawer: boolean;
  /** 넓은 창의 사이드바가 접혀 있는가 — 설정에 남는 값이 씨앗이다. */
  collapsed: boolean;
}

export type NavAction =
  | { type: "home" }
  | { type: "thread" }
  | { type: "tab"; tab: NavState["tab"] }
  | { type: "drawer"; open: boolean }
  | { type: "collapse"; collapsed: boolean }
  /** 활성 프로젝트가 바뀌었다 — 옛 셸처럼 홈부터. 이어진 점프가 대화를 열면 그것이 이긴다. */
  | { type: "project-changed" };

export function initialNav(collapsed: boolean): NavState {
  return { view: "home", tab: "chat", drawer: false, collapsed };
}

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case "home":
      return { ...state, view: "home", drawer: false };
    case "thread":
      // 대화를 여는 손은 서랍을 닫는다 — 좁은 창에서 고른 행이 스크림 뒤에 숨지 않게.
      return { ...state, view: "thread", drawer: false };
    case "tab":
      return state.tab === action.tab ? state : { ...state, tab: action.tab };
    case "drawer":
      return state.drawer === action.open ? state : { ...state, drawer: action.open };
    case "collapse":
      return state.collapsed === action.collapsed
        ? state
        : { ...state, collapsed: action.collapsed };
    case "project-changed":
      return { ...state, view: "home", tab: "chat", drawer: false };
  }
}
