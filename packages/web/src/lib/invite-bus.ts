/**
 * 앱 전체에서 초대 파일을 넘겨받는 작은 통로(EventTarget 하나). 설정 창이나 토큰
 * 만료 카드처럼 Shell 바깥에 그려지는 화면의 "초대 파일 열기" 버튼도 이 통로로
 * Shell 의 가져오기 컨트롤러(use-invite-import)에 닿는다 — 초대장을 여는 길은
 * 앱에 하나다.
 */

/** 초대 파일인가 — 이름이 `.colo-invite` 로 끝나는가만 본다(내용은 읽는 쪽이 판단). */
export function isInviteFile(file: File): boolean {
  return file.name.endsWith(".colo-invite");
}

/** 통로를 오가는 소식 — 파일이 도착했거나, 고르기 창을 열어 달라는 요청. */
export type InviteBusMessage = { kind: "file"; file: File } | { kind: "pick" };

const bus = new EventTarget();

/** 초대 파일 한 장을 가져오기 흐름에 넘긴다. */
export function offerInviteFile(file: File): void {
  bus.dispatchEvent(new CustomEvent("invite-offer", { detail: file }));
}

/** 고르기 창을 열어 달라 — 버튼을 누른 화면이 어디든 컨트롤러가 파일 입력을 만든다. */
export function requestInvitePicker(): void {
  bus.dispatchEvent(new CustomEvent("invite-pick"));
}

/** 소식 구독 — 돌려받은 함수로 끊는다. */
export function onInvite(listener: (message: InviteBusMessage) => void): () => void {
  const onOffer = (event: Event) =>
    listener({ kind: "file", file: (event as CustomEvent<File>).detail });
  const onPick = () => listener({ kind: "pick" });
  bus.addEventListener("invite-offer", onOffer);
  bus.addEventListener("invite-pick", onPick);
  return () => {
    bus.removeEventListener("invite-offer", onOffer);
    bus.removeEventListener("invite-pick", onPick);
  };
}
