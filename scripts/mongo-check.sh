#!/usr/bin/env bash
# MongoDB health check for this machine.
#
#   scripts/mongo-check.sh            # service, port, ping, per-database counts
#   scripts/mongo-check.sh --deep     # also round-trips documents via db.live_roundtrip
#
# --deep writes three synthetic documents, so it targets MONGODB_DATABASE and
# defaults to the scratch database scanner_verify rather than the shared scanner.
# Exit 0 only if every check passes.
set -u
cd "$(dirname "$0")/.." || exit 1

URI="${MONGODB_URI:-mongodb://127.0.0.1:27017}"
fail=0
check() { if "$@" >/dev/null 2>&1; then echo "  [PASS] $label"; else echo "  [FAIL] $label"; fail=1; fi; }

echo "MongoDB health check: $URI"

label="systemd user unit mongod-local is active"
check systemctl --user is-active --quiet mongod-local

label="port 27017 is listening"
check sh -c "ss -ltn | grep -q ':27017 '"

label="server answers ping"
check mongosh "$URI" --quiet --eval 'quit(db.runCommand({ping: 1}).ok === 1 ? 0 : 1)'

if [ "$fail" -eq 0 ]; then
  mongosh "$URI" --quiet --eval '
    const v = db.version();
    print(`  server version ${v}`);
    for (const name of ["scanner", "scanner_test"]) {
      const d = db.getSiblingDB(name);
      const counts = ["scans", "patches", "audit_log"].map(c => `${c}=${d[c].countDocuments()}`);
      print(`  ${name}: ${counts.join(" ")}`);
    }'
fi

if [ "${1:-}" = "--deep" ] && [ "$fail" -eq 0 ]; then
  label="live round-trip through db.mongo_store (${MONGODB_DATABASE:-scanner_verify})"
  MONGODB_URI="$URI" MONGODB_DATABASE="${MONGODB_DATABASE:-scanner_verify}" \
    python3 -m db.live_roundtrip >/dev/null 2>&1 && echo "  [PASS] $label" || { echo "  [FAIL] $label"; fail=1; }
fi

if [ "$fail" -eq 0 ]; then echo "MONGODB OK"; else
  echo "MONGODB CHECK FAILED - try: systemctl --user start mongod-local;" \
       "journalctl --user -u mongod-local -n 50 --no-pager"
fi
exit "$fail"
