/**
 * The transport every REST client in the daemon speaks, plus the
 * recorded-fixture implementation of it.
 *
 * The GitHub client needs "one request in, one structured response out" and
 * an offline suite that is real — a DaemonServer driven end to end against
 * recorded pairs rather than a hand-written mock. That mechanism lives here;
 * the site-specific pieces (base url, which env var selects fixtures) stay
 * with the client's transport factory.
 *
 * A fixture directory holds `fixtures.json`: an array of
 * `{ name, cite, request, response }` pairs. `cite` names the REST endpoint
 * the pair replays; `request.url` is path+query (site-independent). Pairs are
 * consumed in order, so the same GET can be replayed with different responses
 * (the version-conflict simulation depends on that).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Fetch-shaped: one request in, one structured response out. */
export interface RestTransport {
  request(input: {
    method: "GET" | "POST" | "PUT" | "PATCH";
    /** Path with query, e.g. "/wiki/api/v2/pages/1?body-format=storage". */
    url: string;
    headers: Record<string, string>;
    body?: Uint8Array;
  }): Promise<{
    status: number;
    body: Uint8Array;
    /**
     * Lower-cased response headers, when the transport can produce them.
     * GitHub reports a classic token's scopes only in `x-oauth-scopes`, and
     * without it the onboarding gate cannot tell a `repo`-scoped token from a
     * read-only one.
     */
    headers?: Record<string, string>;
  }>;
}

export interface FixturePair {
  name: string;
  cite: string;
  request: {
    method: string;
    url: string;
    /** Deep-equal assertion on the parsed JSON request body. */
    bodyJson?: unknown;
    /** Substrings the raw request body must contain (multipart uploads). */
    bodyContains?: string[];
  };
  response: {
    status: number;
    json?: unknown;
    bodyBase64?: string;
    /** Recorded response headers, lower-cased (e.g. `x-oauth-scopes`). */
    headers?: Record<string, string>;
  };
}

export function loadFixturePairs(dir: string): FixturePair[] {
  const raw = JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf8")) as FixturePair[];
  if (!Array.isArray(raw)) throw new Error("fixtures.json은 배열이어야 합니다");
  return raw;
}

export class FixtureTransport implements RestTransport {
  private readonly used: boolean[];

  constructor(readonly pairs: FixturePair[]) {
    this.used = new Array(pairs.length).fill(false);
  }

  get pending(): number {
    return this.used.filter((consumed) => !consumed).length;
  }

  async request(input: {
    method: "GET" | "POST" | "PUT" | "PATCH";
    url: string;
    headers: Record<string, string>;
    body?: Uint8Array;
  }): Promise<{
    status: number;
    body: Uint8Array;
    headers?: Record<string, string>;
  }> {
    const text = input.body ? new TextDecoder().decode(input.body) : "";
    const parsed = text && looksLikeJson(text) ? safeJson(text) : undefined;

    for (let index = 0; index < this.pairs.length; index += 1) {
      if (this.used[index]) continue;
      const pair = this.pairs[index]!;
      if (pair.request.method !== input.method || pair.request.url !== input.url) continue;
      if (pair.request.bodyJson !== undefined && !deepEqual(pair.request.bodyJson, parsed))
        continue;
      if (
        pair.request.bodyContains &&
        !pair.request.bodyContains.every((part) => text.includes(part))
      )
        continue;

      this.used[index] = true;
      const bytes = pair.response.bodyBase64
        ? Buffer.from(pair.response.bodyBase64, "base64")
        : Buffer.from(
            pair.response.json === undefined ? "" : JSON.stringify(pair.response.json),
            "utf8",
          );
      return {
        status: pair.response.status,
        body: new Uint8Array(bytes),
        ...(pair.response.headers ? { headers: pair.response.headers } : {}),
      };
    }

    const available = this.pairs
      .map((pair, index) =>
        this.used[index] ? null : `${pair.request.method} ${pair.request.url}`,
      )
      .filter(Boolean)
      .slice(0, 8)
      .join(", ");
    // A same-endpoint pair that failed only its body assertion is worth
    // saying apart from "no fixture at all".
    const mismatched = this.pairs.find(
      (pair) =>
        pair.request.method === input.method &&
        pair.request.url === input.url &&
        !this.used[this.pairs.indexOf(pair)],
    );
    const hint = mismatched ? ` (본문 불일치 — ${bodyMismatch(parsed, text, mismatched)})` : "";
    throw new Error(
      `fixture에 응답이 없습니다: ${input.method} ${input.url}${hint} (남은 fixture: ${available || "없음"})`,
    );
  }
}

function bodyMismatch(parsed: unknown, raw: string, pair: FixturePair): string {
  const actual = parsed !== undefined ? JSON.stringify(parsed) : raw;
  const expected = pair.request.bodyJson !== undefined ? JSON.stringify(pair.request.bodyJson) : "";
  for (let i = 0; i < Math.max(actual.length, expected.length); i += 1) {
    if (actual[i] !== expected[i]) {
      return `첫 차이 @${i}: 받은 ${JSON.stringify(actual.slice(Math.max(0, i - 40), i + 80))} / 기대한 ${JSON.stringify(expected.slice(Math.max(0, i - 40), i + 80))}`;
    }
  }
  return `길이 ${actual.length} vs ${expected.length}`;
}

function looksLikeJson(text: string): boolean {
  const first = text.trim()[0];
  return first === "{" || first === "[";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (!deepEqual(ka, kb)) return false;
    return ka.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}
