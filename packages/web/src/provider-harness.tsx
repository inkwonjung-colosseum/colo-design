/** Throwaway visual harness: the settings dialog's provider room with a fake
 * status, so the redesigned cards can be seen without a daemon. Delete with
 * provider-harness.html after review. */

import type { DaemonStatus, EffortLevel } from "@colo-design/protocol";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsDialog } from "./components/dialogs/SettingsDialog";
import type { ChatSettings, Settings } from "./lib/settings";
import "./styles.css";

const models = (levels: EffortLevel[] | null) => [
  {
    value: "opus",
    displayName: "Opus 4.5",
    resolvedModel: null,
    description: "가장 꼼꼼한 모델",
    supportsEffort: true,
    supportedEffortLevels: levels,
  },
  {
    value: "sonnet",
    displayName: "Sonnet 4.5",
    resolvedModel: null,
    description: "일상 작업용",
    supportsEffort: true,
    supportedEffortLevels: levels,
  },
  {
    value: "haiku",
    displayName: "Haiku 4.5",
    resolvedModel: null,
    description: "가장 빠른 모델",
    supportsEffort: false,
    supportedEffortLevels: levels,
  },
];

const status: DaemonStatus = {
  modelsByProvider: {
    claude: models(["low", "medium", "high"]),
    codex: models(["medium", "high", "xhigh"]),
    omp: models(null),
  },
  providers: [
    {
      id: "claude",
      label: "Claude Code",
      available: true,
      version: "2.1.20",
      loggedIn: true,
      modes: [],
    },
    {
      id: "codex",
      label: "Codex",
      available: true,
      version: "0.55.1",
      loggedIn: false,
      modes: [],
    },
    {
      id: "omp",
      label: "Oh My Pi",
      available: false,
      reason: "설치가 필요합니다 — 터미널에서 npm i -g omp",
      modes: [],
    },
  ],
} as DaemonStatus;

const chat: ChatSettings = {
  provider: "claude",
  model: "opus",
  effort: "high",
  byProvider: { codex: { model: "sonnet", effort: "medium" } },
  disabledProviders: ["omp"],
  permissionMode: "bypassPermissions",
  showThinking: false,
  showTools: false,
};

function Harness() {
  const settings: Settings = {
    theme: "light",
    sendKey: "enter",
    midTurnSend: "queue",
    openLinksInApp: false,
    uiScale: "normal",
    contentScale: "normal",
    codeScale: "normal",
    notifications: { done: "long", sound: true },
    sessionTitles: {},
    layout: { previewWidth: null, sidebarWidth: null, sidebarCollapsed: false },
    chat,
  };
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: 40 }}>
      <SettingsDialog
        settings={settings}
        onChange={() => undefined}
        onChatChange={(patch) => console.log("onChatChange", patch)}
        daemonUrl="ws://127.0.0.1:7823"
        status={status}
        connection="open"
        daemon={{ connection: "open" } as never}
        onOpenOnboarding={() => undefined}
        onReconnect={() => undefined}
        onForgetUrl={() => undefined}
        onClose={() => undefined}
        initialCategory="providers"
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
}
