#!/usr/bin/env python3
"""PR 상태 감시 릴레이 — Claude Code SessionStart hook 에서 실행된다.

계약 (2026-09-14 위원회 합의의 Claude Code 이식):
- 침묵이 기본 출력이다. 변화가 있을 때만 몇 줄 출력하고, 출력은 세션
  컨텍스트로 주입되어 에이전트가 사용자에게 전달한다.
- 사용자는 git 개념이 없다 — 출력에 git 용어(PR/머지/브랜치/체크)를
  쓰지 않는다. "작업 / 검증 / 반영 / 피드백"으로만 말한다.
- 우리가 연 루프만 닫는다: 검증 실패를 알렸으면 회복도 알린다.
  반영 완료는 여는 세션이 "검증 중"이라는 루프를 열었으므로 1회 닫는다.
- 상태의 진실 원천은 이 스크립트가 아니라 상태 파일이다. 매번 파일을
  다시 읽고 지문 동등성으로 비교한다(커서·updatedAt 금지).
- renovate PR 은 침묵. 예외는 검증 실패(의존성이 빌드를 깬 진짜 신호).
- 이 스크립트는 세션 시작을 절대 막지 않는다: 어떤 실패든 조용히 exit 0.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

TIMEOUT = 12          # 개별 gh 호출 상한(초)
MAX_PR_DETAIL = 5     # 이 수를 넘는 열린 PR 은 코멘트 표면 조회를 건너뛴다
MAX_MESSAGES = 6      # 알림 상한 — 넘으면 상위만 보여준다
STALE_HOURS = 24      # 녹색인데 이 시간 이상 반영 안 된 작업 = 점검 대상


def silent_exit() -> None:
    sys.exit(0)


def run_gh(args: list[str]) -> str | None:
    try:
        r = subprocess.run(
            ["gh", *args], capture_output=True, text=True, timeout=TIMEOUT
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


def gh_json(args: list[str]):
    out = run_gh(args)
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def repo_slug() -> str | None:
    """프로젝트 원격에서 owner/repo 를 뽑는다. 실패하면 조용히 종료."""
    try:
        r = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    url = r.stdout.strip()
    if url.endswith(".git"):
        url = url[:-4]
    tail = url.split(":")[-1].rstrip("/")
    parts = tail.split("/")
    if len(parts) < 2:
        return None
    return f"{parts[-2]}/{parts[-1]}"


def is_bot(login: str | None) -> bool:
    if not login:
        return True
    l = login.lower()
    return l.endswith("[bot]") or "renovate" in l or "github-actions" in l


def comment_surfaces(slug: str, n: int) -> list[dict]:
    """PR 의 세 코멘트 표면(issue/review/review-comment)에서 마지막 항목들."""
    out = []
    for path in (
        f"repos/{slug}/issues/{n}/comments",
        f"repos/{slug}/pulls/{n}/reviews",
        f"repos/{slug}/pulls/{n}/comments",
    ):
        data = gh_json(["api", path, "-f", "per_page=100"])
        if isinstance(data, list) and data:
            out.append(data[-1])
    return out


def fingerprint(pr: dict, comments: list[dict]) -> str:
    payload = {
        "n": pr["number"],
        "draft": pr.get("isDraft"),
        "merge": pr.get("mergeStateStatus"),
        "review": pr.get("reviewDecision"),
        "checks": sorted(
            (c.get("name", ""), c.get("status", ""), c.get("conclusion") or "")
            for c in pr.get("statusCheckRollup") or []
        ),
        "comments": [c.get("node_id") or c.get("id") for c in comments],
    }
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


def check_state(pr: dict) -> tuple[bool, bool, str]:
    """(실패 있음, 전부 통과, 첫 실패 검증 이름)"""
    rollup = pr.get("statusCheckRollup") or []
    failed, passed = False, True
    first_fail = ""
    for c in rollup:
        status, concl = c.get("status", ""), c.get("conclusion")
        if concl == "FAILURE" or (status == "COMPLETED" and concl not in ("SUCCESS", "NEUTRAL", "SKIPPED")):
            failed = True
            passed = False
            if not first_fail:
                first_fail = c.get("name", "검증")
        elif concl != "SUCCESS" and status != "COMPLETED":
            passed = False  # 진행 중이면 '전부 통과'가 아니다
    if not rollup:
        passed = False
    return failed, passed, first_fail


def excerpt(text: str, limit: int = 60) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def main() -> None:
    slug = repo_slug()
    if not slug:
        silent_exit()

    prs = gh_json(
        ["pr", "list", "-R", slug, "--state", "open", "--limit", "50", "--json",
         "number,title,author,mergeStateStatus,reviewDecision,statusCheckRollup,"
         "headRefOid,isDraft,createdAt,url"]
    )
    if prs is None:
        silent_exit()

    state_file = Path.home() / ".paseo" / "state" / f"{slug.replace('/', '-')}-pr-watch.json"
    state: dict = {}
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
        except (json.JSONDecodeError, OSError):
            state = {}
    known: dict = state.get("prs", {})
    reported: dict = state.get("reported", {})
    first_run = not state.get("prs") and not state.get("reported")

    messages: list[str] = []
    new_known: dict = {}
    now = time.time()

    detailed = [p for p in prs if not is_bot(p.get("author", {}).get("login"))]
    detail_set = {p["number"] for p in detailed[:MAX_PR_DETAIL]}

    for pr in prs:
        n = pr["number"]
        title = pr.get("title", "")
        url = pr.get("url", "")
        author = pr.get("author", {}).get("login", "")
        bot = is_bot(author)
        prev = known.get(str(n)) or {}

        comments: list[dict] = []
        if n in detail_set and not pr.get("isDraft"):
            comments = comment_surfaces(slug, n)

        fp = fingerprint(pr, comments)
        failed, passed, first_fail = check_state(pr)

        if pr.get("isDraft"):
            # 초안은 진행 중인 일 — 알림 없이 지문만 기록한다.
            new_known[str(n)] = {"fp": fp, "failed": failed}
            continue
        new_known[str(n)] = {
            "fp": fp,
            "failed": failed,
            "stale_reported": prev.get("stale_reported", False),
        }

        if prev.get("fp") == fp:
            continue  # 변화 없음 — 침묵

        if not prev:
            if not bot:
                messages.append(f"🔔 작업 #{n} «{title}» — 검증 대기")
        else:
            # 1) 검증 실패(최초) / 회복
            if failed and not prev.get("failed"):
                if bot:
                    messages.append(
                        f"📦 라이브러리 갱신 #{n} 검증 실패 — 갱신이 빌드를 깨뜨렸어요: {url}"
                    )
                else:
                    messages.append(
                        f"🛠 작업 #{n} «{title}» 검증 실패({first_fail}) — 확인해 볼게요. {url}"
                    )
            elif passed and prev.get("failed"):
                messages.append(f"✅ 작업 #{n} 검증이 회복됐어요 — 통과하면 자동으로 반영돼요")

            # 2) 피드백 (사람이 남긴 말 — 봇·본인 작성 제외)
            if not bot:
                new_ids = {c.get("node_id") or c.get("id") for c in comments}
                old_ids = set(prev.get("comment_ids") or [])
                fresh = [c for c in comments
                         if (c.get("node_id") or c.get("id")) in (new_ids - old_ids)]
                if not fresh:
                    fresh = [c for c in comments if not is_bot(c.get("user", {}).get("login"))
                             and (c.get("node_id") or c.get("id")) not in old_ids]
                # note: prev 에 comment_ids 를 저장하지 않는 이상 최초 비교는
                # 지문 변화로만 잡는다 — 아래 reviewDecision 과 함께 1회 보고.
                rd = pr.get("reviewDecision")
                if rd == "CHANGES_REQUESTED" and prev.get("review") != rd:
                    messages.append(
                        f"💬 작업 #{n} «{title}» 에 피드백이 왔어요 — 이어서 반영할까요? {url}"
                    )
                elif fresh and not is_bot(fresh[-1].get("user", {}).get("login")):
                    c = fresh[-1]
                    who = c.get("user", {}).get("login", "?")
                    messages.append(
                        f"💬 작업 #{n} «{title}» 피드백({who}): «{excerpt(c.get('body',''))}» "
                        f"이어서 반영할까요? {url}"
                    )

            # 3) 반영 경로 이상
            ms = pr.get("mergeStateStatus")
            if ms == "DIRTY":
                messages.append(
                    f"♻️ 작업 #{n} «{title}» 최근 변경과 겹쳐서 자동 반영이 안 돼요 — 다시 만들어 드릴까요?"
                )
            elif passed and ms == "BLOCKED":
                messages.append(f"⚙️ 작업 #{n} 검증은 통과했는데 반영이 규칙에 막혀 있어요 — 점검 필요")
            elif passed and ms not in ("BLOCKED", "DIRTY", "BEHIND"):
                age_h = (now - _ts(pr.get("createdAt"))) / 3600
                if age_h > STALE_HOURS and not prev.get("stale_reported"):
                    messages.append(f"⏳ 작업 #{n} «{title}» 하루 넘게 반영이 안 됐어요 — 점검할까요?")
                    new_known[str(n)]["stale_reported"] = True

    # 4) 사라진 작업 — 우리가 "검증 중" 루프를 열었으므로 1회 닫는다.
    seen = {p["number"] for p in prs}
    merged = gh_json(["pr", "list", "-R", slug, "--state", "merged", "--limit", "10",
                      "--json", "number,title"]) or []
    merged_titles = {m["number"]: m.get("title", "") for m in merged}
    for n_str, prev in known.items():
        n = int(n_str)
        if n in seen or reported.get(n_str):
            continue
        if n in merged_titles:
            messages.append(f"✅ 작업 #{n} «{merged_titles[n]}» 완료돼서 최종본에 반영됐어요")
            reported[n_str] = "merged"
        else:
            messages.append(f"❌ 작업 #{n} 반영 없이 닫혔어요 — 필요하면 다시 만들게요")
            reported[n_str] = "closed"

    state["prs"] = new_known
    state["reported"] = reported
    state["last_check"] = int(now)
    try:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1))
        tmp.replace(state_file)
    except OSError:
        pass  # 상태 저장 실패는 다음 틱의 중복 알림으로만 나타난다 — 치명적 아님

    if first_run or not messages:
        silent_exit()  # 첫 실행은 기준선 수립만 — 알림 없음

    if len(messages) > MAX_MESSAGES:
        shown = messages[:MAX_MESSAGES]
        print("\n".join(shown))
        print(f"… 외 {len(messages) - MAX_MESSAGES}건")
    else:
        print("\n".join(messages))


def _ts(iso: str | None) -> float:
    if not iso:
        return time.time()
    try:
        from datetime import datetime, timezone
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


if __name__ == "__main__":
    main()
