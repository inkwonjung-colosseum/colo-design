import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";

/**
 * 데스크톱이 웹 UI 를 따로 띄우지 않는 이유 (DESIGN §7): 데몬이 지어진 번들을
 * 스스로 서빙한다. 정적 서빙은 데몬의 다른 일과 아무것도 나누지 않으므로
 * 여기 혼자 산다 — 이 파일이 아는 것은 폴더 하나와 확장자 표뿐이다.
 */

/** Static types for the built web UI. */
const WEB_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/**
 * Static serving of the built web UI (desktop mode): files from `root`,
 * unknown paths fall back to index.html so the SPA routes itself. Path
 * traversal stays inside `root`.
 */
export function serveWeb(root: string, req: IncomingMessage, res: ServerResponse): void {
  const requested = (req.url ?? "/").split("?")[0]!;
  let candidate = requested === "/" ? "index.html" : requested.slice(1);
  candidate = candidate.split("%2e%2e").join("..");
  const file = join(root, candidate);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback: /anything is the app.
    const index = join(root, "index.html");
    if (!existsSync(index)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(index));
    return;
  }
  const type = WEB_TYPES[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(file));
}
