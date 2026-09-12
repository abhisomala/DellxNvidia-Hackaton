#!/usr/bin/env bash
# Review test suite for the a11y-fix harness.
#
#   remediation/tests/run-all.sh
#
# No dependencies: everything under src/ is plain Node ESM with node: builtins only,
# so this runs without `npm install`. Nothing is written inside the repository.
#
# NOTE: failures here are EXPECTED — see tests/README.md. Each failing assertion
# documents a real defect in the harness, not a broken test.
cd "$(dirname "$0")" || exit 1
REMEDIATION="$(cd .. && pwd)"
REPO="$(cd ../.. && pwd)"

echo "================================================================"
echo " a11y-fix harness — review test suite"
echo " target: $REMEDIATION @ $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo 'not a git checkout')"
echo "================================================================"
echo

js_pass=0; js_fail=0
for f in 0*.test.mjs; do
  out=$(timeout 200 node --test --test-reporter=tap "$f" 2>&1)
  tp=$(printf '%s' "$out" | sed -n 's/^# pass \([0-9]*\)/\1/p' | tail -1)
  tf=$(printf '%s' "$out" | sed -n 's/^# fail \([0-9]*\)/\1/p' | tail -1)
  tt=$(printf '%s' "$out" | sed -n 's/^# tests \([0-9]*\)/\1/p' | tail -1)
  printf '%-34s tests=%-4s pass=%-4s fail=%-4s\n' "$f" "${tt:-?}" "${tp:-?}" "${tf:-?}"
  js_pass=$((js_pass + ${tp:-0}))
  js_fail=$((js_fail + ${tf:-0}))
  printf '%s\n' "$out" | sed -n 's/^not ok [0-9]* - /    FAIL: /p' | grep -v 'subtests failed'
  echo
done

echo "---------------- python ----------------"
pyout=$(timeout 200 python3 -m unittest test_06_bridge 2>&1)
pyfail=$(printf '%s' "$pyout" | sed -n 's/^FAILED (failures=\([0-9]*\).*/\1/p')
pytotal=$(printf '%s' "$pyout" | sed -n 's/^Ran \([0-9]*\) test.*/\1/p')
pyfail=${pyfail:-0}
pytotal=${pytotal:-0}
pypass=$((pytotal - pyfail))
printf '%-34s tests=%-4s pass=%-4s fail=%-4s\n' "test_06_bridge.py" "$pytotal" "$pypass" "$pyfail"
printf '%s\n' "$pyout" | sed -n 's/^FAIL: \([a-z_0-9]*\) .*/    FAIL: \1/p'
echo

echo "================================================================"
printf ' TOTAL  tests=%s  pass=%s  fail=%s\n' \
  "$((js_pass + js_fail + pytotal))" "$((js_pass + pypass))" "$((js_fail + pyfail))"
echo "================================================================"
