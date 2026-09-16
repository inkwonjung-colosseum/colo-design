import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * One machine turn (비개발자 저장): the same SDK entry the sessions use,
 * aimed at a single answer-nothing-else turn — no tools to run, no
 * settings to load, and haiku answering: reading a diff and saying what
 * it did is haiku's job, and its latency is what the leashes assume. The
 * prompt is everything this call may read; the transcript lands beside
 * the summary's, out of the conversation store. Null means "use the
 * fallback".
 */
export async function claudeOneShot(
  prompt: string,
  opts: { cwd: string; executable: string | null; model: string; timeoutMs: number },
): Promise<string | null> {
  if (!opts.executable) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const conversation = query({
      prompt,
      options: {
        cwd: opts.cwd,
        pathToClaudeCodeExecutable: opts.executable,
        model: opts.model,
        maxTurns: 1,
        tools: [],
        settingSources: [],
        abortController: controller,
      },
    });
    let answer: string | null = null;
    for await (const message of conversation) {
      if (message.type === "result" && message.subtype === "success" && !message.is_error) {
        answer = message.result;
      }
    }
    return answer;
  } finally {
    clearTimeout(timeout);
  }
}
