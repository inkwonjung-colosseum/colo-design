import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LostSend, QueuedSendPayload } from "@colo-design/protocol";
import { COLO_DESIGN_DIR } from "./environment.js";

/**
 * 대기 줄의 디스크 절반 (PLAN D86 의 확장). 메모리의 `Session.held` 가 진실의
 * 원천이지만, 데몬이 죽으면 그 줄은 이벤트조차 못 남긴다 — 약속("다음 턴에
 * 보냅니다")받은 말이 조용히 사라진다. 그래서 줄의 모든 변화를 여기에
 * 기록한다(write-through): 강제 종료(SIGKILL·정전)까지 덮는다.
 *
 * 파일 하나가 한 세션의 방 전체다: `held`(아직 대기 중)와 `lost`(전달하지
 * 못해 회복 대기). 데몬이 살아 있는 동안 held 쪽은 메모리의 거울이고, 기동
 * 때 파일에 남은 held는 그 턴이 이미 죽었음을 뜻하므로 `sweepOrphans` 가
 * lost로 전환한다 — 자동 재전송은 없다. 되살리기는 언제나 계획자의 손으로
 * 입력창을 거친다.
 *
 * 크기 상한: 첨부 base64가 항목당 `MAX_ITEM_BYTES`(디코딩 추정)를 넘으면
 * 바이트는 버리고 `truncated` 만 남긴다 — 단어는 언제나 온전히 저장된다.
 * lost 방은 세션당 `MAX_LOST_ITEMS` 건, 30일 — 읽을 때 정리한다.
 */

/** `Session.held` 와 같은 모양 — bytes 포함. 구조적으로만 계약한다. */
export interface StoredSend {
  id: string;
  text: string;
  images: Array<{ mediaType: string; data: string }>;
  /** 쓰는 시점에 첨부가 상한을 넘어 바이트가 버려졌다는 표식. */
  truncated?: boolean;
}

interface StoredLost extends StoredSend {
  lostAt: number;
}

interface QueueFile {
  held: StoredSend[];
  lost: StoredLost[];
}

/** 항목당 첨부 예산 — 디코딩 추정(base64 × 3/4). 상회분은 버려진다. */
const MAX_ITEM_BYTES = 8 * 1024 * 1024;
/** lost 방의 깊이 — 가장 오래된 것부터 잘린다. */
const MAX_LOST_ITEMS = 20;
/** 회복 대기의 수명. 그 너머의 말은 계획자가 이미 잊었다고 본다. */
const LOST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A bounded view of one send, for the wire: words and counts, never bytes. */
function summarize(send: StoredSend): Omit<LostSend, "lostAt"> {
  return {
    id: send.id,
    text: send.text,
    images: send.images.length,
    ...(send.truncated ? { truncated: true } : {}),
  };
}

/** Attachment bytes beyond the budget are dropped at WRITE time — the file stays bounded. */
function budget(item: StoredSend): StoredSend {
  const bytes = item.images.reduce((sum, part) => sum + (part.data.length * 3) / 4, 0);
  if (bytes <= MAX_ITEM_BYTES) return item;
  return { ...item, images: [], truncated: true };
}

/** What a live Session needs from the disk — already bound to its own file. */
export interface QueueDisk {
  saveHeld(items: StoredSend[]): void;
  moveToLost(items: StoredSend[]): LostSend[];
  clear(): void;
}

export class QueueStore {
  private readonly dir: string;

  constructor(dir: string = process.env.COLO_DESIGN_RUN_DIR ?? join(COLO_DESIGN_DIR, "run")) {
    this.dir = dir;
  }

  private file(sessionId: string): string {
    return join(this.dir, `queue-${sessionId}.json`);
  }

  private load(sessionId: string): QueueFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file(sessionId), "utf8")) as QueueFile;
      const alive = (item: StoredLost) => Date.now() - item.lostAt < LOST_TTL_MS;
      const lost = (parsed.lost ?? []).filter(alive);
      // Keep the newest depth worth of recovery; the rest has aged out.
      const kept =
        lost.length > MAX_LOST_ITEMS
          ? [...lost].sort((a, b) => b.lostAt - a.lostAt).slice(0, MAX_LOST_ITEMS)
          : lost;
      return { held: parsed.held ?? [], lost: kept };
    } catch {
      return { held: [], lost: [] };
    }
  }

  private write(sessionId: string, file: QueueFile): void {
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(sessionId);
    const temporary = `${target}.colo-design-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    // Between the two writes a reader sees the old file — no half-written room.
    renameSync(temporary, target);
  }

  /** The live room's mirror. Emptying the room empties the held side, not the lost one. */
  saveHeld(sessionId: string, held: StoredSend[]): void {
    const file = this.load(sessionId);
    const bounded = held.map(budget);
    const nothing = file.held.length === 0 && bounded.length === 0;
    if (nothing && file.lost.length === 0) return;
    this.write(sessionId, { held: bounded, lost: file.lost });
  }

  /** The room's contents become recovery rows. Returns the lost room as the wire sees it. */
  moveHeldToLost(sessionId: string, held: StoredSend[]): LostSend[] {
    const file = this.load(sessionId);
    const now = Date.now();
    const lost = [...file.lost, ...held.map(budget).map((item) => ({ ...item, lostAt: now }))];
    const kept =
      lost.length > MAX_LOST_ITEMS
        ? [...lost].sort((a, b) => b.lostAt - a.lostAt).slice(0, MAX_LOST_ITEMS)
        : lost;
    this.write(sessionId, { held: [], lost: kept });
    return kept.map((item) => ({ ...summarize(item), lostAt: item.lostAt }));
  }

  lostItems(sessionId: string): LostSend[] {
    return this.load(sessionId).lost.map((item) => ({ ...summarize(item), lostAt: item.lostAt }));
  }

  /** 되살리기: the whole send back, bytes included when they survived the write. */
  takeLost(sessionId: string, itemId: string): QueuedSendPayload {
    const file = this.load(sessionId);
    const item = file.lost.find((lost) => lost.id === itemId);
    if (!item) return null;
    this.write(sessionId, {
      held: file.held,
      lost: file.lost.filter((lost) => lost.id !== itemId),
    });
    if (item.truncated) return { text: item.text, images: [] };
    return { text: item.text, images: item.images };
  }

  dismissLost(sessionId: string, itemId: string): void {
    const file = this.load(sessionId);
    this.write(sessionId, {
      held: file.held,
      lost: file.lost.filter((lost) => lost.id !== itemId),
    });
  }

  /** 유저가 스스로 닫은 대화의 방은 조용히 사라진다 — 닫는 창에 뒷말은 소식이 아니다. */
  clear(sessionId: string): void {
    rmSync(this.file(sessionId), { force: true });
  }

  /**
   * 기동 때의 청소: 프로세스가 죽어도 파일에 남아 있던 held는 그 턴이 죽었다는
   * 뜻이다 — lost로 전환해 재접속한 창이 회복 패널로 되찾을 수 있게 한다.
   * Returns how many files carried orphans.
   */
  sweepOrphans(): number {
    let swept = 0;
    let entries: string[] = [];
    try {
      entries = readdirSync(this.dir).filter((name) => /^queue-.+\.json$/.test(name));
    } catch {
      return 0;
    }
    for (const name of entries) {
      const sessionId = name.slice("queue-".length, -".json".length);
      const file = this.load(sessionId);
      if (file.held.length === 0) continue;
      this.moveHeldToLost(sessionId, file.held);
      swept += 1;
    }
    return swept;
  }

  /** A session-shaped handle — the Session takes one at birth. */
  for(sessionId: string): QueueDisk {
    return {
      saveHeld: (items) => this.saveHeld(sessionId, items),
      moveToLost: (items) => this.moveHeldToLost(sessionId, items),
      clear: () => this.clear(sessionId),
    };
  }
}
