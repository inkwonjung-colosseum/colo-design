#!/bin/sh
# 가짜 Claude Code 업데이트 — 격리 데몬의 COLO_DESIGN_CLAUDE_INSTALL_CMD 로 쓴다(설정의 `업데이트` 버튼 검증).
# 진행 줄 셋을 흘리고, 데몬이 쓰는 가짜 claude($COLO_DESIGN_CLAUDE_BIN)를 새 버전으로 바꿔 쓴다.
# 버전은 COLD_CLAUDE_NEXT(기본 2.2.0). 대상 인자($1 = latest)는 받기만 한다.
set -eu
NEXT="${COLD_CLAUDE_NEXT:-2.2.0}"
BIN="${COLO_DESIGN_CLAUDE_BIN:?COLO_DESIGN_CLAUDE_BIN}"
echo "Downloading Claude Code $NEXT"; sleep 1
echo "Verifying checksum"; sleep 1
cat > "$BIN" <<SH
#!/bin/sh
case "\$1" in auth) echo '{"loggedIn":true,"subscriptionType":"max"}';;
--version) echo "$NEXT (stub)";; *) exit 1;; esac
SH
chmod +x "$BIN"
echo "Installed Claude Code $NEXT"
