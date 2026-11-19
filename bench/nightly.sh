#!/bin/bash
set -u

root="$(cd "$(dirname "$0")/.." && pwd)"
node_bin="$(ls -d "$HOME"/.nvm/versions/node/v22.*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${node_bin:+$node_bin:}$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

bench_dir="${DISTILL_BENCH_DIR:-$HOME/.cache/distill-llm/bench}"
log_dir="$bench_dir/logs"
mkdir -p "$log_dir"
exec >>"$log_dir/$(date +%F).log" 2>&1

cd "$root" || exit 1
echo "== $(date '+%F %T') nightly benchmark start (node $(node --version 2>&1), claude $(claude --version 2>&1))"

node bench/fetch.mjs || echo "fetch reported problems, running with the documents that are ready"
node bench/run.mjs --resume --max-cost-usd "${DISTILL_BENCH_BUDGET:-15}"
status=$?
node bench/report.mjs > /dev/null || echo "report failed"

echo "== $(date '+%F %T') nightly benchmark end (runner exit $status)"
exit "$status"
