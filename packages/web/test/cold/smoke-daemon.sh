#!/bin/bash
# 격리 데몬 — 사용자의 ~/.colo-design 을 건드리지 않고 UI 스모크용 데몬을 띄운다.
# 사용: smoke-daemon.sh <repo-dir> [daemon-port=7899] [web-port=29174]   (먼저 그 repo-dir 에서 pnpm build, 그리고 packages/web 에서 vite --port <web-port>)
set -euo pipefail
R="${1:?repo dir}"; PORT="${2:-7899}"; WEB="${3:-29174}"
T=${SMOKE_STATE_DIR:-/tmp/colo-smoke}/state-$PORT; rm -rf "$T"; mkdir -p "$T"
TOK=smoke$RANDOM$RANDOM
node "$R/scripts/fixture-repo.mjs" "$T/fix" >/dev/null
export HOME="$T/home"; mkdir -p "$HOME/.colo-design/config" "$T/bin" "$T/gh"
printf '{"host":"127.0.0.1","port":%s,"token":"%s"}\n' "$PORT" "$TOK" > "$HOME/.colo-design/config/daemon.json"
# 스모크에서는 에이전트 자동 업데이트를 끈다 — 켜 두면 데몬이 시작 직후 임시 HOME 에 Claude · Codex 를 실제로 내려받는다.
echo '{"agentAutoUpdate":"off"}' > "$HOME/.colo-design/config/machine.json"
if [ "${SMOKE_EMPTY:-}" = "1" ]; then
  echo '{"active":null,"projects":[]}' > "$T/projects.json"
else
cat > "$T/projects.json" <<JSON
{"active":"smoke","projects":[{"slug":"smoke","name":"스모크 서비스","commandsApproved":true,
 "repo":{"url":"$T/fix/remote","baseBranch":"main","branch":null,"handoff":null}}]}
JSON
fi
cat > "$T/bin/claude" <<'SH'
#!/bin/sh
case "$1" in auth) echo '{"loggedIn":true,"subscriptionType":"max"}';;
--version) echo "2.0.0 (stub)";; *) exit 1;; esac
SH
chmod +x "$T/bin/claude"
echo '[{"name":"me","cite":"GET /user","request":{"method":"GET","url":"/user"},"response":{"status":200,"json":{"login":"fixture"}}}]' > "$T/gh/fixtures.json"
export COLO_DESIGN_PORT=$PORT COLO_DESIGN_DEV_AGENTS=1 COLO_DESIGN_DEV_SERVER=http://127.0.0.1:$WEB \
 COLO_DESIGN_CREDENTIAL_STORE=memory COLO_DESIGN_PROJECTS_SETTINGS=$T/projects.json \
 COLO_DESIGN_PROJECTS_DIR=$T/projects COLO_DESIGN_LOG_DIR=$T/logs COLO_DESIGN_RUN_DIR=$T/run \
 COLO_DESIGN_UNDO_LOG=$T/undo.jsonl COLO_DESIGN_PERMISSION_LOG=$T/perm.jsonl \
 COLO_DESIGN_PLAN_USAGE=$T/plan.json COLO_DESIGN_REPO_SETTINGS=$T/repo.json COLO_DESIGN_NPMRC=$T/npmrc \
 COLO_DESIGN_GIT_GUARD_DIR=$T/guard \
 COLO_DESIGN_GITHUB_FIXTURE=$T/gh COLO_DESIGN_GITHUB_API=http://127.0.0.1:9 \
 COLO_DESIGN_REPO_PAT=fixture COLO_DESIGN_GITHUB_SLUG=fixture/smoke
unset ANTHROPIC_API_KEY || true
# 기본은 가짜 claude(로그인만 통과, 세션은 바로 죽음). SMOKE_REAL_CLAUDE=1 이면 사용자의 실제
# Claude Code 와 로그인(키체인)을 쓴다 — 실제 구독을 태우고, 신뢰 목록(.claude.json)에 스모크 폴더가 한 줄 남는다.
if [ "${SMOKE_REAL_CLAUDE:-}" = "1" ]; then
  export CLAUDE_CONFIG_DIR="${REAL_CLAUDE_CONFIG_DIR:-/Users/developjik/.claude}"
else
  export CLAUDE_CONFIG_DIR=$T/claude COLO_DESIGN_CLAUDE_BIN=$T/bin/claude
fi
echo "URL http://127.0.0.1:$WEB/?shell=next&daemon=127.0.0.1:$PORT&token=$TOK" | tee "$T/url.txt"
cd "$R" && exec node packages/daemon/dist/index.js
