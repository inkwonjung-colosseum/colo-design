import type { Sessions } from "../../hooks/useSessions";
import type { Daemon } from "../../lib/daemon-client";
import { L } from "../labels";
import type { ShellNav } from "../slots";
import { SparkIcon } from "../ui/icons";
import { HomeComposer } from "./HomeComposer";
import { HomeInbox } from "./HomeInbox";

/** 홈(U6) — `<이름>님, 무엇을 만들까요?` · 큰 입력창 · 받은 편지함. */
export function HomeView({
  daemon,
  sessions,
  nav,
}: {
  daemon: Daemon;
  sessions: Sessions;
  nav: ShellNav;
}) {
  const active = daemon.projects.find((project) => project.slug === daemon.activeSlug) ?? null;
  const author = daemon.status?.authorName?.trim();
  return (
    <div className="nx-home">
      <div className="nx-home-inner">
        <h1 className="nx-greet">
          <SparkIcon />
          <span>{author ? L.home.greet(author) : L.transcript.emptyTitle}</span>
        </h1>
        <HomeComposer
          sessions={sessions}
          projects={daemon.projects}
          active={active}
          onSwitch={nav.switchProject}
          onOpened={nav.showThread}
        />
        <div className="nx-home-hint">{L.home.hint}</div>
        <HomeInbox daemon={daemon} onOpenThread={nav.openThread} onSwitch={nav.switchProject} />
      </div>
    </div>
  );
}
