import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
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
 *
 * 방이 비면 파일도 남지 않는다(결함 4 — E2E 2026-09-20 실측: 소비·폐기된
 * 방 파일이 `queue-*.json` 180건으로 쌓였다). 저장소 디렉터리의 방 파일 수는
 * `MAX_QUEUE_FILES` 를 넘지 않게 정리한다 — 넘치면 가장 오래된 방부터 lost 로
 * 편입해 회복 가능성은 남기되, 오래된 대기가 배달을 노리는 일은 없게 한다.
 */

/** `Session.held` 와 같은 모양 — bytes 포함. 구조적으로만 계약한다. */
export interface StoredSend {
  id: string;
  text: string;
  attachments: Array<{ name: string; mediaType: string; data: string }>;
  /** 화면 게이트 입력 — deliver 때 소비된다. 옛 파일엔 없다(없으면 없는 대로).
   *  옛 행이 실은 state 키는 그냥 무시된다(2026-09-21 상태 축 철거). */
  pins?: Array<{ screen: string }>;
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
/** 저장소 디렉터리의 방 파일 수 상한 — 넘치면 가장 오래된 방부터 정리한다. */
const MAX_QUEUE_FILES = 200;
/** 회복 대기의 수명. 그 너머의 말은 계획자가 이미 잊었다고 본다. */
const LOST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A bounded view of one send, for the wire: words and counts, never bytes. */
function summarize(send: StoredSend): Omit<LostSend, "lostAt"> {
  return {
    id: send.id,
    text: send.text,
    images: send.attachments.filter((part) => part.mediaType.startsWith("image/")).length,
    files: send.attachments.filter((part) => !part.mediaType.startsWith("image/")).length,
    ...(send.truncated ? { truncated: true } : {}),
  };
}

/** Attachment bytes beyond the budget are dropped at WRITE time — the file stays bounded. */
function budget(item: StoredSend): StoredSend {
  const bytes = item.attachments.reduce((sum, part) => sum + (part.data.length * 3) / 4, 0);
  if (bytes <= MAX_ITEM_BYTES) return item;
  return { ...item, attachments: [], truncated: true };
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
    // The id becomes a filename: sessions mint UUIDs (and providers' resume
    // ids are word-safe too), so anything outside that alphabet — a `/`, a
    // `..` — is a wire value trying to leave this directory.
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error(`잘못된 세션 id 입니다: ${sessionId.slice(0, 32)}`);
    }
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
      // 옛 파일은 `images` 로 적혔다 — 이름만 다른 같은 바이트라 읽을 때 옮긴다.
      const migrate = <
        T extends StoredSend & { images?: Array<{ mediaType: string; data: string }> },
      >(
        item: T,
      ): T => ({
        ...item,
        attachments:
          item.attachments ??
          (item.images ?? []).map((image, index) => ({
            name: `이미지 ${index + 1}`,
            mediaType: image.mediaType,
            data: image.data,
          })),
      });
      return { held: (parsed.held ?? []).map(migrate), lost: kept.map(migrate) };
    } catch (error) {
      // 파일이 없는 것은 첫 대화의 빈 방이다. 그러나 존재하는데 읽지 못하는
      // 것은 소식이다 — 정전이 남긴 조각에 약속한 턴이 남아 있을 수 있으므로
      // 빈 방인 척하면 다음 저장이 그렇게 봉인한다. projects.json.corrupt 와
      // 같은 자세로 옆에 옮겨 둔다: 회복은 계획자의 손으로.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          const path = this.file(sessionId);
          if (existsSync(path)) renameSync(path, `${path}.corrupt`);
        } catch {
          // The quarantine is best effort — an unwritable disk has bigger
          // problems, and refusing to boot helps nobody.
        }
      }
      return { held: [], lost: [] };
    }
  }

  private write(sessionId: string, file: QueueFile): void {
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(sessionId);
    const temporary = `${target}.colo-design-${process.pid}`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      // rename은 이름만 옮길 뿐이므로 내용이 먼저 디스크에 봉인돼야 한다 —
      // fsync 가 없으면 정전이 이름은 온전하고 내용은 없는 방을 남긴다.
      writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Between the two writes a reader sees the old file — no half-written room.
    renameSync(temporary, target);
  }

  /**
   * 쓰기의 문 — 방이 완전히 비었으면 파일도 지운다. 빈 방 파일은 아무도 읽지
   * 않으면서 저장소 디렉터리에 쌓여 결함 4(E2E 2026-09-20)의 180건이 됐다.
   */
  private persist(sessionId: string, file: QueueFile): void {
    if (file.held.length === 0 && file.lost.length === 0) {
      rmSync(this.file(sessionId), { force: true });
      return;
    }
    this.write(sessionId, file);
  }

  /** The live room's mirror. Emptying the room empties the held side, not the lost one. */
  saveHeld(sessionId: string, held: StoredSend[]): void {
    const file = this.load(sessionId);
    const bounded = held.map(budget);
    this.persist(sessionId, { held: bounded, lost: file.lost });
    this.enforceFileCap();
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
    this.persist(sessionId, { held: [], lost: kept });
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
    this.persist(sessionId, {
      held: file.held,
      lost: file.lost.filter((lost) => lost.id !== itemId),
    });
    // 핀은 말의 일부이지 첨부가 아니다 — 상한을 넘어 바이트를 버린 말에서도
    // 글자와 함께 살아남는다. 그것이 화면 확인 게이트의 입력이므로,
    // 여기서 떨굴 핀은 되살린 말의 턴을 검증 밖으로 내보낸다(감사 C4).
    const pins = item.pins?.length ? { pins: item.pins } : {};
    if (item.truncated) return { text: item.text, attachments: [], ...pins };
    // removeHeld 과 같은 이유 — 프로토콜 타입 밖의 동행 바이트(회귀 보고).
    return {
      text: item.text,
      attachments: item.attachments,
      ...pins,
    };
  }

  dismissLost(sessionId: string, itemId: string): void {
    const file = this.load(sessionId);
    this.persist(sessionId, {
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
   * 배달 대상 세션은 이 데몬에 살아 있지 않으므로 새 세션·스레드를 만들어
   * 배달하는 일은 없다 — lost 방이 답이고, 되살리기는 언제나 계획자의 손으로
   * 입력창을 거친다. Returns how many files carried orphans.
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
    this.enforceFileCap();
    return swept;
  }

  /**
   * 저장소 디렉터리의 방 파일 수 상한(결함 4 — E2E 2026-09-20 실측: 180건
   * 누적). 상한을 넘으면 초과분만큼 가장 오래된 방부터 정리한다 — 수명이
   * 지난 lost 만 남은 죽은 방은 파일까지 치우고, 대기가 남은 방은 lost 로
   * 편입해 회복 가능성은 남기되 오래된 대기가 배달을 노리는 일은 없게 한다.
   * 이미 회복 대기인 방은 유일하게 그대로 둘 수 있는 방이다 — 편입도 삭제도
   * 회복 가능성을 침해한다. 편입은 방 파일 수를 줄이지 못하므로(방금 잃은
   * 말은 회복 패널의 몫) 한 번의 검사에 초과분만큼만 옮긴다 — 다음 쓰기와
   * 기동 청소가 이어서 걷는다.
   */
  private enforceFileCap(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.dir).filter((name) => /^queue-.+\.json$/.test(name));
    } catch {
      return;
    }
    let count = entries.length;
    let budget = count - MAX_QUEUE_FILES;
    if (budget <= 0) return;
    const oldest = entries
      .map((name) => {
        try {
          return { name, mtime: statSync(join(this.dir, name)).mtimeMs };
        } catch {
          return { name, mtime: 0 };
        }
      })
      .sort((a, b) => a.mtime - b.mtime);
    for (const { name } of oldest) {
      if (count <= MAX_QUEUE_FILES || budget <= 0) break;
      const sessionId = name.slice("queue-".length, -".json".length);
      try {
        // load 가 이미 수명이 지난 lost 는 걸러 둔다.
        const file = this.load(sessionId);
        if (file.held.length === 0 && file.lost.length > 0) continue;
        if (file.held.length === 0) {
          // 죽은 방 — 빈 방 파일이 쌓이는 길이다. persist 가 파일을 지운다.
          this.persist(sessionId, file);
          count -= 1;
          continue;
        }
        this.moveHeldToLost(sessionId, file.held);
        budget -= 1;
      } catch {
        // 파일 이름이 세션 id 의 자격을 벗어났으면(와이어 값) 편입 대상이
        // 아니다 — 한 방의 실패가 저장소 정리를 멈추게 두지 않는다.
      }
    }
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
