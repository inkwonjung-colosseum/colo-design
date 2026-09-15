/**
 * The spawned daemon, actually gone — and its children with it.
 *
 * SIGKILL is the reflex, and it is exactly what leaves preview servers
 * behind: only the daemon's own SIGTERM handler runs `server.stop()`, which
 * settles the writers and takes the preview process group down. A suite that
 * killed instead of asking left one `node server.mjs` alive per run, holding
 * a port; a day of runs on one machine left hundreds.
 *
 * The hard kill stays as the deadline, not the plan: a daemon that has not
 * exited in `timeoutMs` is stuck, and the suite must not hang on it.
 */
export function stopDaemon(daemon, timeoutMs = 15_000) {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers();
  const hard = setTimeout(() => {
    daemon.kill("SIGKILL");
    resolve();
  }, timeoutMs);
  daemon.once("exit", () => {
    clearTimeout(hard);
    resolve();
  });
  daemon.kill("SIGTERM");
  return promise;
}
