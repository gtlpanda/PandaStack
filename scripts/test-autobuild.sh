#!/usr/bin/env bash
# test-autobuild.sh — autobuild's own suite (graphs/autobuild/tool/test/*.test.mjs, node:test, a fake
# claude, throwaway git projects). Ends with TEST-AUTOBUILD: N passed, M failed. A missing node fails.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/graphs/autobuild/tool" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "TEST-AUTOBUILD: 0 passed, 1 failed (node not installed)"
  exit 1
fi
out="$(node --test --test-reporter=tap test/*.test.mjs 2>&1)"; rc=$?
printf '%s\n' "$out" | grep -E '^(not )?ok ' | sed -E 's/^ok [0-9]+ - /  ok   /; s/^not ok [0-9]+ - /  FAIL /'
passed="$(grep -cE '^ok ' <<< "$out")"; failed="$(grep -cE '^not ok ' <<< "$out")"
[ "$rc" -eq 0 ] || [ "$failed" -gt 0 ] || { printf '%s\n' "$out" | tail -20; failed=1; }
echo "TEST-AUTOBUILD: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
