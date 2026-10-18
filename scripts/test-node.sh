#!/usr/bin/env bash
set -euo pipefail

# All server fixtures serve the frontend tested by this checkout, including
# fixtures whose isolated documents/state use a different working directory.
export LOCDOC_WEB="$(pwd)/node_modules/.cache/locdoc-verified-web"

# Limit native allocations too: V8's heap flag does not cover Buffer/ArrayBuffer
# storage. RLIMIT_DATA includes anonymous mmap allocations on supported Linux.
# Leave room for V8's virtual code reservations; this is not an RSS limit.
data_kib=2097152
for inherited in "$(ulimit -S -d)" "$(ulimit -H -d)"; do
  if [[ "$inherited" != unlimited && "$inherited" -lt "$data_kib" ]]; then
    data_kib=$inherited
  fi
done
ulimit -c 0
ulimit -S -d "$data_kib"
ulimit -H -d "$data_kib"

# Preserve explicitly requested long sync soaks, with bounded cleanup time.
seconds=600
if [[ ${LOCDOC_SOAK_MS:-} =~ ^[0-9]{1,7}$ ]]; then
  requested_ms=$((10#$LOCDOC_SOAK_MS))
  if (( requested_ms <= 1800000 )); then
    requested=$((requested_ms / 1000 + 120))
    (( requested <= seconds )) || seconds=$requested
  fi
fi
exec timeout --signal=TERM --kill-after=5s "${seconds}s" \
  node --max-old-space-size=256 "$@"
