#!/bin/bash
# 一次性把「假 Agent + dev server + playwright」放在同一个进程组里跑，
# 避免 dev server 在用例中途被回收导致 ERR_CONNECTION_REFUSED。
set -u
export PATH="/usr/local/bin:/usr/bin:/bin:/Users/cospeyton/.bun/bin"
cd "$(dirname "$0")/.." || exit 1

PORT_WEB=3100
PORT_AGENT=17399

cleanup() {
    [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
    [ -n "${VITE_PID:-}" ] && kill "$VITE_PID" 2>/dev/null
    wait 2>/dev/null
}
trap cleanup EXIT

lsof -nP -iTCP:$PORT_WEB -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null
lsof -nP -iTCP:$PORT_AGENT -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null
sleep 1

node e2e/mock-agent.mjs > /tmp/e2e-mock.log 2>&1 &
MOCK_PID=$!
npx vite --host 127.0.0.1 --port $PORT_WEB --strictPort > /tmp/e2e-vite.log 2>&1 &
VITE_PID=$!

for i in $(seq 1 60); do
    agent_ok=$(curl -s -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:$PORT_AGENT/health || true)
    web_ok=$(curl -s -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:$PORT_WEB/ || true)
    [ "$agent_ok" = "200" ] && [ "$web_ok" = "200" ] && break
    sleep 1
done

echo "mock=$agent_ok web=$web_ok"
if [ "$agent_ok" != "200" ] || [ "$web_ok" != "200" ]; then
    echo "服务没起来，日志："
    tail -20 /tmp/e2e-mock.log /tmp/e2e-vite.log
    exit 1
fi

if [ "${1:-}" = "debug" ]; then
    node "e2e/${2:-debug-layout.mjs}"
    exit $?
fi

npx playwright test --reporter=list
