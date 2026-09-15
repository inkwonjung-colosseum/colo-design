/**
 * Shared scaffolding for the repo-*.test.mjs files — the pieces the old
 * single-file suite kept at module scope. Importing this module also arms the
 * after() sweep that stops every workspace bringUp() left running, so a split
 * file cannot orphan a preview server the way --test-force-exit once did.
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { promisify } from "node:util";
import { RepoWorkspace } from "../dist/repo.js";

export function workdir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A repo root carrying exactly the files a derivation reads. */
export function repoRoot(prefix, files) {
  const root = workdir(prefix);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(
      join(root, name),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
  return root;
}

export const stubPullRequestClient = (requests) => ({
  async createPullRequest(input) {
    requests.push(input);
    return {
      number: 7,
      url: "https://github.com/colosseumcoinckr/colo-design-e2e/pull/7",
      title: input.title,
      state: "open",
    };
  },
  async updatePullRequest(input) {
    requests.push(input);
    return {
      number: 7,
      url: "https://github.com/colosseumcoinckr/colo-design-e2e/pull/7",
      title: input.title,
      state: "open",
    };
  },
});

export const promisifiedRun = async (command, args) =>
  (await promisify(execFileCb)(command, args)).stdout;

export const clone = (dir, fixture) =>
  new RepoWorkspace({
    root: join(dir, "work"),
    url: fixture.remote,
    onStatus: () => undefined,
  });

/**
 * Brought-up workspaces, stopped together when the file is done. A test that
 * syncs or pulls again after `bringUp` starts a SECOND preview server and
 * most have no reason to say so; `--test-force-exit` then orphaned it, and
 * the machine collected hundreds of `node server.mjs` across a day's runs.
 */
const liveWorkspaces = new Set();

export const bringUp = async (dir, fixture) => {
  const workspace = clone(dir, fixture);
  liveWorkspaces.add(workspace);
  await workspace.sync();
  await workspace.stop();
  return workspace;
};

after(async () => {
  for (const workspace of liveWorkspaces) await workspace.stop().catch(() => undefined);
});
