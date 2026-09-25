/** 입력창이 말에 싣는 첨부 한 건 — 그림은 비전 블록, 그 밖은 데몬이 인라인하거나 파일로 둔다. */
export interface Attachment {
  /** `image` rides as a vision block; `file` is inlined or staged by the daemon. */
  kind: "image" | "file";
  name: string;
  mediaType: string;
  /** base64, without the data-url prefix. */
  data: string;
  size: number;
}
