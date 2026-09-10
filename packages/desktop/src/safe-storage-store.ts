import type { CredentialStore } from "@cds-design/daemon/credentials";

/**
 * safeStorage 기반 자격 증명 저장소(DESIGN §7: Keychain/DPAPI). Electron 의
 * safeStorage 인터페이스를 생성자로 주입받아 단위 테스트에서는 가짜로
 * 대체한다. 암호문(base64)은 userData 의 credentials.json 하나에 모은다 —
 * 렌더러로는 절대 나가지 않는다.
 */
export interface SafeStorageLike {
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class SafeStorageCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;

  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly file: string,
  ) {}

  async save(item: string, secret: string): Promise<void> {
    const entries = this.read();
    entries[item] = this.safeStorage.encryptString(secret).toString("base64");
    this.write(entries);
  }

  async load(item: string): Promise<string | null> {
    const blob = this.read()[item];
    if (!blob) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(blob, "base64"));
    } catch {
      // 키체인 키가 바뀌는 등 복호화가 실패하면 없던 것으로 취급한다.
      return null;
    }
  }

  async delete(item: string): Promise<void> {
    const entries = this.read();
    delete entries[item];
    this.write(entries);
  }

  /** 모든 항목을 지운다(테스트 정리용). */
  clear(): void {
    this.write({});
  }

  private read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private write(entries: Record<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.cds-design-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

// node: 모듈을 지연 import — Electron 메인 번들에서도 그대로 돈다.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
