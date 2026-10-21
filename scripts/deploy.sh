#!/usr/bin/env bash
# Build, smoke test, back up and switch Locdoc releases. Run with --help.
set -euo pipefail
umask 077
LC_COLLATE=C

usage() {
  cat <<'EOF'
Usage: scripts/deploy.sh [deploy] [--rehearse] [--force] [--no-restart]
       scripts/deploy.sh rollback [RELEASE] [--no-restart]
       scripts/deploy.sh restore SNAPSHOT [--no-restart]
       scripts/deploy.sh install-unit [--no-restart]
       scripts/deploy.sh status

deploy        Build the committed checkout into target/stage and target/stage-web,
              smoke test it with temporary folders, back up the state folder into
              the new release, point `current` at it and restart the service.
              Any failed check after the switch restores the previous release.
  --rehearse  Also start the staged build against copies of the state database
              and documents folder; comment counts must not change and document
              and revision counts must not drop.
  --force     Deploy even if the commit is already current.
rollback      Point `current` at RELEASE (default: the previous release recorded
              in the current manifest), restart and run the same checks.
restore       Restore SNAPSHOT, a folder holding state/ (locdoc.sqlite from
              SQLite's backup API, owner.key, root.identity, fonts) and docs/,
              such as an rsnapshot hourly.N folder. Checks the snapshot, stops
              the service and copies the snapshot next to the live data. Then
              moves the documents folder to DOCS.before-restore-TIME and the
              state files into STATE/before-restore-TIME, puts the copies in
              their place, runs current/locdoc --restored, starts the service
              and runs the same checks. A failure or interruption before those
              checks pass stops the service, puts the previous data back, keeps
              the restored copies as *failed-restore-TIME and starts the service
              again. Nothing is deleted and the snapshot is never changed.
install-unit  Install deployment/locdoc-release.conf as the unit's release.conf
              drop-in. Without a current release, the running build is adopted
              as the first release. The running process is not restarted.
status        Show the current release and the retained releases.
--no-restart  Never reload or restart units. Deploy, rollback and restore skip
              systemctl, require LOCDOC_STATE and LOCDOC_DOCS and check only the
              release files and the database; install-unit skips daemon-reload.
              For temporary folders only: LOCDOC_RELEASES must be set to another
              folder than the default, and for install-unit XDG_CONFIG_HOME
              to another folder than ~/.config.

Environment:
  LOCDOC_RELEASES    release folder (default ~/.local/share/locdoc/releases)
  LOCDOC_SERVICE     systemd user unit (default locdoc)
  LOCDOC_HEALTH_URL  service URL (default http:// plus the service's LOCDOC_BIND)
  LOCDOC_STATE, LOCDOC_DOCS
                     state and documents folders (default: those of the running
                     service; when set they must match it)
  LOCDOC_DEPLOY_TEST_FAIL=smoke|activate|restore
                     test only: fail the smoke test, the post-switch checks or a
                     restore after its pass, before the service starts
EOF
}

project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
caller=$PWD
releases=${LOCDOC_RELEASES:-$HOME/.local/share/locdoc/releases}
[[ $releases == /* ]] || releases=$caller/$releases
releases=${releases%/}
service=${LOCDOC_SERVICE:-locdoc}
fail_at=${LOCDOC_DEPLOY_TEST_FAIL:-}
settle_seconds=3
restart=1 force=0 rehearse=0
command= target=
state= docs= health= running_pid=
work= incoming= activating= revert_to= failure=
pids=()
# Restore progress, so a failure or interrupt can put the live data back.
snapshot= snapshot_fd= snapshot_sha= restoring= restore_stamp= state_lock=
aside_docs= aside_state= state_aside=0 docs_placed=0 started=0
# State files a snapshot replaces. The database always moves with its journals.
state_files=(locdoc.sqlite locdoc.sqlite-wal locdoc.sqlite-shm locdoc.sqlite-journal
  owner.key root.identity fonts restore-report.json)

# Small JSON, SQLite and /proc helpers. SQLite copies use the online backup
# API, never a file copy of a database that may have active WAL writes.
read -r -d '' py_helper <<'PY' || true
import json, os, shlex, socket, sqlite3, sys
from pathlib import Path

def connect(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)

def fsync(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

command, args = sys.argv[1], sys.argv[2:]
if command == "backup":
    source, copy = connect(args[0]), sqlite3.connect(args[1])
    source.backup(copy)
    copy.execute("PRAGMA journal_mode=DELETE").fetchall()
    copy.close()
    source.close()
    os.chmod(args[1], 0o600)
    fsync(args[1])
elif command == "inspect":
    db = connect(args[0])
    integrity = "\n".join(row[0] for row in db.execute("PRAGMA integrity_check"))
    tables = [row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    counts = {t: db.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in tables}
    json.dump({"integrity": integrity, "counts": counts}, sys.stdout, sort_keys=True)
elif command == "compare":
    # exact: nothing may change. startup: projecting accepted text at startup
    # may add an autosave revision, and the owner tree request indexes files
    # that had no row yet. grow: a live service may add any rows.
    before, after = (json.load(open(path)) for path in args[:2])
    problems = [f"integrity_check: {d['integrity'][:200]}" for d in (before, after) if d["integrity"] != "ok"]
    for table in ("docs", "revisions", "comments"):
        b, a = before["counts"].get(table, 0), after["counts"].get(table, 0)
        grows = args[2] == "grow" or (args[2] == "startup" and table != "comments")
        if a < b if grows else a != b:
            problems.append(f"{table} rows {b} -> {a}")
    if problems:
        print("; ".join(problems))
        sys.exit(1)
elif command == "get":
    try:
        value = json.load(open(args[0])).get(args[1])
    except FileNotFoundError:
        value = None
    print("" if value is None else value)
elif command == "rows":
    count = json.load(open(args[0]))["counts"].get(args[1])
    print("" if count is None else count)
elif command == "space":
    # destination=source pairs. Copies onto one filesystem must fit together,
    # with 64 MiB to spare.
    need, free = {}, {}
    for pair in args:
        dest, _, source = pair.partition("=")
        while not os.path.isdir(dest):
            dest = os.path.dirname(dest)
        device = os.stat(dest).st_dev
        stats = os.statvfs(dest)
        free[device] = (dest, stats.f_bavail * stats.f_frsize)
        size = 0
        for root, dirs, files in os.walk(source):
            size += sum(os.lstat(os.path.join(root, name)).st_blocks * 512 for name in dirs + files)
        need[device] = need.get(device, 0) + size
    short = [f"{dest} needs {((need[d] + (64 << 20) - avail) >> 20) + 1} MiB more"
             for d, (dest, avail) in free.items() if need[d] + (64 << 20) > avail]
    if short:
        print("; ".join(short))
        sys.exit(1)
elif command == "exec-env":
    # environ-file folder state docs program args...: run a program in that
    # folder with a NUL-separated environment saved from /proc, naming the
    # state and documents folders explicitly.
    raw = Path(args[0]).read_bytes().split(b"\0")
    env = dict(item.partition(b"=")[::2] for item in raw if item)
    env[b"LOCDOC_STATE"], env[b"LOCDOC_DOCS"] = os.fsencode(args[2]), os.fsencode(args[3])
    os.chdir(args[1])
    os.execve(args[4], args[4:], env)
elif command == "write":
    # key=value pairs; @path embeds a JSON file and an empty value is null.
    data = {}
    for pair in args[1:]:
        key, _, value = pair.partition("=")
        data[key] = json.load(open(value[1:])) if value.startswith("@") else value or None
    temporary = args[0] + ".tmp"
    with open(temporary, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.rename(temporary, args[0])
elif command == "fsync":
    for path in args:
        for root, dirs, files in os.walk(path):
            for name in files:
                fsync(os.path.join(root, name))
            fsync(root)
        fsync(os.path.dirname(os.path.abspath(path)))
elif command == "port":
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        print(s.getsockname()[1])
elif command == "unit-env":
    env = dict(item.partition("=")[::2] for item in shlex.split(args[0]))
    print(env.get(args[1], args[2] if len(args) > 2 else ""))
elif command == "proc-env":
    raw = Path(f"/proc/{args[0]}/environ").read_bytes().split(b"\0")
    env = dict(item.decode(errors="replace").partition("=")[::2] for item in raw if item)
    print(env.get(args[1], args[2] if len(args) > 2 else ""))
PY
py() { python3 -I -c "$py_helper" "$@"; }

say() { printf 'deploy: %s\n' "$*" >&2; }
die() {
  say "error: $*"
  exit 1
}
fail() {
  failure=$*
  return 1
}
sha256() {
  local sum
  sum=$(sha256sum -- "$1") || return 1
  printf '%s\n' "${sum%% *}"
}

stop_server() {
  local pid=$1 i
  kill -INT "$pid" 2>/dev/null || true
  for ((i = 0; i < 100; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  local kept=()
  for i in "${pids[@]}"; do [[ $i == "$pid" ]] || kept+=("$i"); done
  pids=("${kept[@]}")
}

cleanup() {
  local status=$?
  set +e
  # A second Ctrl-C, a closed terminal or a closed stderr pipe must not stop
  # the restore halfway.
  trap '' INT TERM HUP PIPE
  for pid in "${pids[@]}"; do stop_server "$pid"; done
  if [[ -n $activating ]]; then
    # Interrupted between the switch and its checks: restore the old release.
    if [[ -n $revert_to ]]; then
      [[ $command != deploy || -e $releases/$activating/FAILED ]] ||
        printf 'interrupted\n' >"$releases/$activating/FAILED"
      swap_current "$revert_to"
      say "interrupted while switching to $activating; restored $revert_to"
      ((restart)) && systemctl --user restart -- "$service"
    else
      say "interrupted while switching to $activating; no previous release to restore"
    fi
  fi
  # A restore failed or was interrupted before its service started.
  [[ -z $restoring ]] || put_back
  rm -f -- "$releases/.current.$$"
  [[ -n $incoming ]] && rm -rf -- "$incoming"
  [[ -n $work ]] && rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

make_work() {
  work=$(mktemp -d "${TMPDIR:-/tmp}/locdoc-deploy.XXXXXX")
}

lock_releases() {
  mkdir -p -- "$releases"
  exec {lock_fd}>"$releases/.deploy.lock"
  flock -n "$lock_fd" || die "another deploy or rollback is using $releases"
}

current_release() {
  local name
  [[ -L $releases/current ]] || return 0
  name=$(readlink -- "$releases/current")
  [[ $name != */* && -d $releases/$name ]] || die "$releases/current points at an unexpected target: $name"
  printf '%s\n' "$name"
}

# Replace `current` atomically: create the link under a temporary name, then
# rename it over the old one and persist the directory entry.
swap_current() {
  local link=$releases/.current.$$
  rm -f -- "$link"
  ln -s -- "$1" "$link"
  mv -fT -- "$link" "$releases/current"
  fsync_dir "$releases"
}

fsync_dir() {
  python3 -I -c 'import os, sys; os.fsync(os.open(sys.argv[1], os.O_RDONLY))' "$1"
}

release_names() {
  local dir
  for dir in "$releases"/[0-9]*T[0-9]*Z-*/; do
    [[ -d $dir ]] && basename -- "$dir"
  done
  return 0
}

bundle_of() {
  local match
  match=$(grep -o 'src="/assets/[^"]*\.js"' -- "$1/index.html") || return 1
  match=${match%%$'\n'*}
  match=${match#src=\"}
  printf '%s\n' "${match%\"}"
}

wait_health() { # url pid|service seconds
  local url=$1 pid=$2 deadline=$((SECONDS + $3))
  while ((SECONDS < deadline)); do
    # A manual restart resets NRestarts, so any count is a crash since then.
    if [[ $pid == service ]]; then
      if [[ $(service_show NRestarts) != 0 || $(service_show ActiveState) == failed ]]; then
        fail "the $service service exited during startup (see journalctl --user -u $service)"
        return 1
      fi
    elif ! kill -0 "$pid" 2>/dev/null; then
      fail "the server exited during startup"
      return 1
    fi
    [[ $(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url/api/config") == 200 ]] && return 0
    sleep 0.5
  done
  fail "$url/api/config did not return 200 within $3 seconds"
}

check_index() { # url web
  local bundle page
  bundle=$(bundle_of "$2") || fail "$2/index.html references no script bundle" || return 1
  page=$(curl -fsS --max-time 5 "$1/") || fail "could not load $1/" || return 1
  [[ $page == *"$bundle"* ]] || fail "$1/ does not reference $bundle"
}

start_server() { # binary web port state docs log
  LOCDOC_BIND=127.0.0.1:$3 LOCDOC_PUBLIC_URL=http://127.0.0.1:$3 LOCDOC_WEB=$2 \
    LOCDOC_STATE=$4 LOCDOC_DOCS=$5 RUST_LOG=locdoc=info "$1" >"$6" 2>&1 &
  server_pid=$!
  pids+=("$server_pid")
}

# Start a staged build on a free loopback port and check health, the served
# bundle and an owner request against its fresh state.
probe_server() { # label binary web state docs expect-path
  local label=$1 dir port key base log attempt
  dir=$(dirname -- "$4")
  log=$dir/server.log
  # Another process can take the free port before the server binds it.
  for attempt in 1 2 3; do
    port=$(py port)
    base=http://127.0.0.1:$port
    start_server "$2" "$3" "$port" "$4" "$5" "$log"
    wait_health "$base" "$server_pid" 60 && break
    stop_server "$server_pid"
    if ((attempt == 3)) || ! grep -qF AddrInUse -- "$log"; then
      tail -n 20 -- "$log" >&2 || true
      die "$label: $failure"
    fi
    say "$label: port $port was taken; trying another"
  done
  if ! check_index "$base" "$3"; then
    tail -n 20 -- "$log" >&2 || true
    die "$label: $failure"
  fi
  [[ $label != "smoke test" || $fail_at != smoke ]] || die "smoke test: failure injected by LOCDOC_DEPLOY_TEST_FAIL"
  key=$(<"$4/owner.key")
  curl -fsS --max-time 10 -H "Authorization: Bearer $key" "$base/api/tree" >"$dir/tree.json" ||
    die "$label: the owner tree request failed"
  [[ -z $6 ]] || grep -qF -- "\"$6\"" "$dir/tree.json" || die "$label: $6 is missing from the document tree"
  # The answers above came from this server only if it still holds the port.
  kill -0 "$server_pid" 2>/dev/null || die "$label: the server exited during the checks"
  stop_server "$server_pid"
  if sed 's/\x1b\[[0-9;]*m//g' -- "$log" | grep -E '(^|[[:space:]])ERROR[[:space:]]' >&2; then
    die "$label: the server logged errors"
  fi
}

smoke() { # binary web
  local dir=$work/smoke
  mkdir -p -- "$dir/state" "$dir/docs"
  printf '# Deploy smoke test\n' >"$dir/docs/smoke.md"
  say "smoke testing the staged build"
  probe_server "smoke test" "$1" "$2" "$dir/state" "$dir/docs" smoke.md
  rm -rf -- "$dir"
}

# A copy of the production database and documents, without owner.key and
# root.identity, so the copy creates its own key and binds its own folder.
rehearse_copy() { # binary web
  local dir=$work/rehearse output
  mkdir -p -- "$dir/state" "$dir/docs"
  say "rehearsing against copies of $state and $docs"
  py backup "$state/locdoc.sqlite" "$dir/state/locdoc.sqlite"
  cp -a -- "$docs/." "$dir/docs/"
  [[ ! -d $state/fonts ]] || cp -a -- "$state/fonts" "$dir/state/fonts"
  py inspect "$dir/state/locdoc.sqlite" >"$dir/before.json"
  probe_server "rehearsal" "$1" "$2" "$dir/state" "$dir/docs" ""
  py inspect "$dir/state/locdoc.sqlite" >"$dir/after.json"
  output=$(py compare "$dir/before.json" "$dir/after.json" startup) ||
    die "rehearsal: startup changed the copied database: $output"
  rm -rf -- "$dir"
}

backup_state() { # destination database-json
  local dest=$1 name output
  mkdir -- "$dest"
  py backup "$state/locdoc.sqlite" "$dest/locdoc.sqlite"
  for name in owner.key root.identity; do
    [[ ! -f $state/$name ]] || cp -- "$state/$name" "$dest/$name"
  done
  [[ ! -d $state/fonts ]] || cp -R -- "$state/fonts" "$dest/fonts"
  find "$dest" -type d -exec chmod 700 {} + -o -type f -exec chmod 600 {} +
  py fsync "$dest"
  py inspect "$dest/locdoc.sqlite" >"$2"
  output=$(py compare "$2" "$2" exact) || die "the state database backup failed its check: $output"
}

service_show() {
  systemctl --user show -p "$1" --value -- "$service"
}

require_unit() {
  local exec_start environment
  [[ $(service_show LoadState) == loaded ]] || die "the $service user unit is not loaded"
  [[ $(service_show NeedDaemonReload) == no ]] ||
    die "the $service unit changed on disk; run systemctl --user daemon-reload first"
  exec_start=$(service_show ExecStart)
  environment=$(service_show Environment)
  if [[ $exec_start != *"path=$releases/current/locdoc ;"* ||
    $(py unit-env "$environment" LOCDOC_WEB) != "$releases/current/web" ]]; then
    die "the $service unit must run $releases/current/locdoc with LOCDOC_WEB=$releases/current/web." \
      "Install the release drop-in with: scripts/deploy.sh install-unit"
  fi
}

absolute() { # base path
  if [[ $2 == /* ]]; then printf '%s\n' "$2"; else printf '%s\n' "$1/$2"; fi
}

# The running process is the authority for the folders a deploy backs up and
# checks; explicit LOCDOC_STATE/LOCDOC_DOCS must agree with it.
resolve_paths() { # [restore]
  local pid cwd pair bind=127.0.0.1:3477 running_state running_docs
  if ((restart)); then
    require_unit
    pid=$(service_show MainPID)
    if [[ $pid =~ ^[1-9][0-9]*$ ]]; then
      running_pid=$pid
      cwd=$(readlink -- "/proc/$pid/cwd")
      running_state=$(absolute "$cwd" "$(py proc-env "$pid" LOCDOC_STATE .locdoc)")
      running_docs=$(absolute "$cwd" "$(py proc-env "$pid" LOCDOC_DOCS docs)")
      bind=$(py proc-env "$pid" LOCDOC_BIND "$bind")
      for pair in "LOCDOC_STATE:$running_state" "LOCDOC_DOCS:$running_docs"; do
        local name=${pair%%:*} value=${pair#*:}
        if [[ -n ${!name:-} && $(realpath -m -- "$(absolute "$caller" "${!name}")") != "$(realpath -m -- "$value")" ]]; then
          die "$name=${!name} does not match the running service ($value)"
        fi
      done
      state=$running_state docs=$running_docs
    else
      [[ -n ${LOCDOC_STATE:-} && -n ${LOCDOC_DOCS:-} ]] ||
        die "the $service service is not running; start it or set LOCDOC_STATE and LOCDOC_DOCS"
      state=$(absolute "$caller" "$LOCDOC_STATE") docs=$(absolute "$caller" "$LOCDOC_DOCS")
    fi
    case $bind in
      0.0.0.0:*) bind=127.0.0.1:${bind##*:} ;;
      \[::\]:*) bind=[::1]:${bind##*:} ;;
    esac
    health=${LOCDOC_HEALTH_URL:-http://$bind}
    health=${health%/}
  else
    [[ -n ${LOCDOC_STATE:-} && -n ${LOCDOC_DOCS:-} ]] || die "--no-restart needs LOCDOC_STATE and LOCDOC_DOCS"
    state=$(absolute "$caller" "$LOCDOC_STATE") docs=$(absolute "$caller" "$LOCDOC_DOCS")
  fi
  if [[ ${1:-} == restore ]]; then
    # A restore may replace a lost database or documents folder.
    state=$(realpath -m -- "$state") docs=$(realpath -m -- "$docs")
    [[ -d $(dirname -- "$docs") ]] || die "$(dirname -- "$docs") is not a folder"
    return 0
  fi
  [[ -f $state/locdoc.sqlite ]] || die "$state/locdoc.sqlite does not exist"
  [[ -d $docs ]] || die "$docs is not a folder"
}

# Post-switch checks. They report through $failure instead of exiting so the
# caller can restore the previous release.
check_release() { # name database-before old-invocation
  local name=$1 pid invocation exe output expected
  expected=$(py get "$releases/$name/manifest.json" binary_sha256)
  [[ -n $expected && $(sha256 "$releases/current/locdoc") == "$expected" ]] ||
    fail "current/locdoc does not match the $name manifest" || return 1
  if ((restart)); then
    wait_health "$health" service 90 || return 1
    invocation=$(service_show InvocationID)
    [[ -n $invocation && $invocation != "$3" ]] || fail "the $service service was not restarted" || return 1
    [[ $(service_show ActiveState) == active ]] || fail "the $service service is not active" || return 1
    pid=$(service_show MainPID)
    exe=$(readlink -- "/proc/$pid/exe") || fail "could not inspect process $pid" || return 1
    [[ $exe == "$(realpath -- "$releases/$name/locdoc")" ]] || fail "the service runs $exe, not $name" || return 1
    [[ $(py proc-env "$pid" LOCDOC_WEB) == "$releases/current/web" ]] ||
      fail "the service does not serve $releases/current/web" || return 1
    [[ $(realpath -m -- "$(absolute "$(readlink -- "/proc/$pid/cwd")" "$(py proc-env "$pid" LOCDOC_STATE .locdoc)")") == \
      "$(realpath -m -- "$state")" ]] || fail "the restarted service uses a different state folder" || return 1
    check_index "$health" "$releases/$name/web" || return 1
    sleep "$settle_seconds"
    [[ $(service_show InvocationID) == "$invocation" && $(service_show ActiveState) == active ]] ||
      fail "the $service service stopped or restarted after startup" || return 1
    output=$(
      journalctl --user "_SYSTEMD_INVOCATION_ID=$invocation" --no-pager -q -o cat -p err || true
      journalctl --user "_SYSTEMD_INVOCATION_ID=$invocation" --no-pager -q -o cat |
        sed 's/\x1b\[[0-9;]*m//g' | grep -E '(^|[[:space:]])ERROR[[:space:]]' || true
    )
    [[ -z $output ]] || fail "error-level journal lines since the restart: ${output:0:600}" || return 1
  fi
  py inspect "$state/locdoc.sqlite" >"$work/after.json" || fail "could not read the state database" || return 1
  output=$(py compare "$2" "$work/after.json" grow) || fail "state database check: $output" || return 1
  [[ $fail_at != activate ]] || fail "failure injected by LOCDOC_DEPLOY_TEST_FAIL"
}

# Point current at a release, restart and check it. On failure the previous
# release becomes current again and the script exits non-zero.
activate() { # name previous database-before
  local name=$1 previous=$2 invocation= reason
  revert_to=$previous activating=$name
  swap_current "$name"
  if ((restart)); then
    invocation=$(service_show InvocationID)
    if ! systemctl --user restart -- "$service"; then
      failure="systemctl --user restart $service failed"
    elif check_release "$name" "$3" "$invocation"; then
      activating=
      return 0
    fi
  elif check_release "$name" "$3" ""; then
    activating=
    return 0
  fi
  # Keep $activating until the previous release is current and restarted, so
  # an exit here (even a failed write to stderr) still restores it.
  reason=$failure
  [[ $command != deploy ]] || printf '%s\n' "$reason" >"$releases/$name/FAILED"
  if [[ -z $previous ]]; then
    activating=
    die "$name failed: $reason; there is no previous release to restore"
  fi
  swap_current "$previous"
  if ((restart)) && ! systemctl --user restart -- "$service"; then
    activating=
    die "$name failed: $reason; $previous is current again but failed to restart"
  fi
  activating=
  say "$name failed: $reason"
  if ((restart)); then
    if ! wait_health "$health" service 90 || ! check_index "$health" "$releases/$previous/web"; then
      die "$reason; $previous is current again but failed its health check: $failure"
    fi
  fi
  die "$reason; restored $previous"
}

# Keep the newest five releases plus the current one and its predecessor.
prune() {
  local names current previous i
  mapfile -t names < <(release_names)
  current=$(current_release)
  previous=$(py get "$releases/$current/manifest.json" previous)
  for ((i = 0; i < ${#names[@]} - 5; i++)); do
    [[ ${names[i]} == "$current" || ${names[i]} == "$previous" ]] && continue
    say "removing old release ${names[i]}"
    rm -rf -- "${releases:?}/${names[i]}"
  done
}

cmd_deploy() {
  local commit short current current_commit name built bundle changes
  cd -- "$project"
  changes=$(git status --porcelain) || die "could not read the git status of $project"
  [[ -z $changes ]] || die "the checkout has uncommitted changes"
  commit=$(git rev-parse HEAD)
  short=$(git rev-parse --short=12 HEAD)
  resolve_paths
  lock_releases
  current=$(current_release)
  current_commit=$(py get "$releases/$current/manifest.json" commit)
  if [[ -n $current && $current_commit == "$commit" ]] && ((!force)); then
    die "$short is already current ($current); pass --force to deploy it again"
  fi
  [[ -x node_modules/.bin/vite ]] || die "node_modules is missing; run npm ci"

  say "building $short into target/stage and target/stage-web"
  CARGO_TARGET_DIR=target/stage nice -n 10 cargo build --release --locked
  nice -n 10 node_modules/.bin/vite build --outDir target/stage-web --emptyOutDir --logLevel warn
  built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  changes=$(git status --porcelain) || die "could not read the git status of $project"
  [[ $(git rev-parse HEAD) == "$commit" && -z $changes ]] ||
    die "the checkout changed during the build; nothing was deployed"
  bundle=$(bundle_of target/stage-web) || die "the staged index references no script bundle"

  make_work
  smoke target/stage/release/locdoc target/stage-web
  ((!rehearse)) || rehearse_copy target/stage/release/locdoc target/stage-web

  name=$(date -u +%Y%m%dT%H%M%SZ)-$short
  [[ ! -e $releases/$name ]] || die "$releases/$name already exists"
  incoming=$releases/.incoming-$name
  mkdir -- "$incoming"
  cp -- target/stage/release/locdoc "$incoming/locdoc"
  chmod 700 -- "$incoming/locdoc"
  cp -R -- target/stage-web "$incoming/web"
  say "backing up $state into $name/backup"
  backup_state "$incoming/backup" "$work/before.json"
  py write "$incoming/manifest.json" release="$name" kind=build commit="$commit" built_at="$built" \
    binary_sha256="$(sha256 "$incoming/locdoc")" web_index_sha256="$(sha256 "$incoming/web/index.html")" \
    bundle="$bundle" previous="$current" state="$state" docs="$docs" database="@$work/before.json"
  py fsync "$incoming"
  mv -T -- "$incoming" "$releases/$name"
  incoming=
  fsync_dir "$releases"

  say "switching to $name"
  activate "$name" "$current" "$work/before.json"
  prune
  say "deployed $name${current:+ (previous: $current)}"
}

cmd_rollback() {
  local current name output
  resolve_paths
  lock_releases
  current=$(current_release)
  [[ -n $current ]] || die "there is no current release"
  name=${target:-$(py get "$releases/$current/manifest.json" previous)}
  [[ -n $name ]] || die "$current records no previous release; name one (see scripts/deploy.sh status)"
  # Only dated release folders; `current` itself would become a symlink loop.
  [[ $name == [0-9]*T[0-9]*Z-* && $name != */* && -d $releases/$name ]] || die "release $name does not exist"
  [[ $name != "$current" ]] || die "$name is already current"
  [[ -x $releases/$name/locdoc && -f $releases/$name/web/index.html && -f $releases/$name/manifest.json ]] ||
    die "release $name is incomplete"
  [[ ! -f $releases/$name/FAILED ]] || say "warning: $name failed its checks when it was deployed"
  make_work
  py inspect "$state/locdoc.sqlite" >"$work/before.json"
  output=$(py compare "$work/before.json" "$work/before.json" exact) ||
    die "the state database fails its check ($output); restore a backup instead"
  say "rolling back from $current to $name"
  activate "$name" "$current" "$work/before.json"
  say "rolled back to $name (from $current)"
}

# The documents folder moves aside as a whole, so it must not hold anything
# else, and the snapshot must be neither live folder.
check_restore_paths() {
  local other
  for other in "$state" "$snapshot" "$(realpath -m -- "$releases")" "$(realpath -m -- "$project")" \
    "$(realpath -m -- "$HOME")"; do
    [[ $other != "$docs" && $other != "$docs"/* ]] || die "the documents folder $docs contains $other"
  done
  for other in "$docs" "$state"; do
    [[ $other != "$snapshot" && $other != "$snapshot"/* && $snapshot != "$other"/* ]] ||
      die "the snapshot $snapshot overlaps $other"
  done
}

# The snapshot needs a database, an owner key and a documents folder, and room
# to copy them. Its database is checked on a copy: even a read-only open of a
# WAL database creates files next to it.
preflight() { # snapshot
  local snap=$1 name output
  for name in state/locdoc.sqlite state/owner.key; do
    [[ -f $snap/$name ]] || die "$snapshot has no $name"
  done
  [[ -s $snap/state/owner.key ]] || die "$snapshot/state/owner.key is empty"
  [[ -d $snap/docs && ! -L $snap/docs ]] || die "$snapshot has no docs folder"
  mkdir -- "$work/snapshot"
  for name in locdoc.sqlite locdoc.sqlite-wal; do
    [[ ! -f $snap/state/$name ]] || cp -- "$snap/state/$name" "$work/snapshot/$name"
  done
  snapshot_sha=$(sha256 "$work/snapshot/locdoc.sqlite")
  py inspect "$work/snapshot/locdoc.sqlite" >"$work/snapshot.json" 2>"$work/snapshot.err" ||
    die "$snapshot/state/locdoc.sqlite cannot be read: $(tail -n 1 -- "$work/snapshot.err")"
  output=$(py compare "$work/snapshot.json" "$work/snapshot.json" exact) ||
    die "$snapshot/state/locdoc.sqlite fails its check: $output"
  [[ -n $(py rows "$work/snapshot.json" docs) ]] || die "$snapshot/state/locdoc.sqlite is not a Locdoc database"
  output=$(py space "$(dirname -- "$docs")=$snap/docs" "$state=$snap/state") ||
    die "not enough free space to restore $snapshot: $output"
}

# Locdoc holds this lock while it uses a state folder. Holding it while data
# moves keeps a server from starting on half of it.
take_state_lock() {
  [[ -z $state_lock ]] || return 0
  exec {state_lock}>>"$state/.instance.lock" || return 1
  flock -n "$state_lock" && return 0
  exec {state_lock}>&-
  state_lock=
  return 1
}

release_state_lock() {
  [[ -z $state_lock ]] || exec {state_lock}>&-
  state_lock=
}

aside_paths() {
  printf '%s\n' "${aside_docs:+$aside_docs and }$aside_state"
}

# Copy the snapshot next to the live data, then swap them: the live documents
# folder and state files move aside and the copies take their place. The live
# data is untouched until the copies are complete, and root.identity never
# leaves the state folder, so a server started after this script was killed
# runs on the live data or refuses the documents folder. Each step is recorded
# before it is taken; put_back undoes whatever happened.
replace_data() { # snapshot
  local snap=$1 name staged
  mkdir -p -- "$state"
  take_state_lock || die "another Locdoc process is using $state; stop it first"
  restore_stamp=$(date -u +%Y%m%dT%H%M%SZ)
  aside_state=$state/before-restore-$restore_stamp
  staged=$state/.restoring-$restore_stamp
  [[ ! -e $docs.before-restore-$restore_stamp && ! -e $aside_state ]] ||
    die "data from a restore at $restore_stamp is already aside"
  say "copying the snapshot next to the live data"
  cp -a -- "$snap/docs" "$docs.restoring-$restore_stamp" || die "could not copy $snapshot/docs"
  py fsync "$docs.restoring-$restore_stamp"
  mkdir -- "$staged" || die "could not create $staged"
  for name in locdoc.sqlite locdoc.sqlite-wal owner.key root.identity fonts; do
    [[ ! -e $snap/state/$name ]] || cp -a -- "$snap/state/$name" "$staged/$name" ||
      die "could not copy $snapshot/state/$name"
  done
  [[ $(sha256 "$staged/locdoc.sqlite") == "$snapshot_sha" ]] ||
    die "$snapshot/state/locdoc.sqlite changed after its check"
  # A backup without one gets the identity the restore pass records first,
  # which matches no folder.
  [[ -e $staged/root.identity ]] || printf '{"device":0,"inode":0}' >"$staged/root.identity"
  py fsync "$staged"
  say "moving the live data aside"
  if [[ -e $docs || -L $docs ]]; then
    aside_docs=$docs.before-restore-$restore_stamp
    mv -T -- "$docs" "$aside_docs" || die "could not move $docs aside"
  fi
  docs_placed=1
  mv -T -- "$docs.restoring-$restore_stamp" "$docs" || die "could not move the copied documents to $docs"
  fsync_dir "$(dirname -- "$docs")"
  mkdir -- "$aside_state" || die "could not create $aside_state"
  for name in "${state_files[@]}"; do
    [[ -e $state/$name || -L $state/$name ]] || continue
    if [[ $name == root.identity ]]; then
      # The copied one replaces it in place below.
      cp -a -- "$state/$name" "$aside_state/$name" || die "could not copy $state/$name aside"
    else
      mv -T -- "$state/$name" "$aside_state/$name" || die "could not move $state/$name aside"
    fi
  done
  state_aside=1
  py fsync "$aside_state"
  for name in locdoc.sqlite locdoc.sqlite-wal owner.key fonts root.identity; do
    [[ ! -e $staged/$name ]] || mv -T -- "$staged/$name" "$state/$name" ||
      die "could not move the copied $name into $state"
  done
  rmdir -- "$staged"
  fsync_dir "$state"
}

# The current release's restore pass, with the service's own environment and
# working folder when it was running. It takes the state lock itself.
restore_pass() {
  local binary=$releases/current/locdoc status=0
  release_state_lock
  say "running $binary --restored"
  if [[ -f $work/unit.environ ]]; then
    py exec-env "$work/unit.environ" "$(<"$work/unit.cwd")" "$state" "$docs" "$binary" --restored \
      {snapshot_fd}<&- >&2 || status=$?
  else
    LOCDOC_STATE=$state LOCDOC_DOCS=$docs "$binary" --restored {snapshot_fd}<&- >&2 || status=$?
  fi
  take_state_lock || die "another Locdoc process started on $state during the restore"
  ((status == 0)) || die "the restore pass failed with status $status"
  [[ $(py get "$state/restore-report.json" completed) == True ]] ||
    die "the restore pass did not complete; see $state/restore-report.json"
}

# Undo replace_data after a failure or interrupt before the restored service
# passed its checks, then start the service again. A service started on the
# restored data stops first; the restored copies stay next to the live data.
put_back() {
  local name failed=failed-restore-$restore_stamp kept_docs= kept_state=
  restoring=
  if ((started)) && ! systemctl --user stop -- "$service"; then
    say "systemctl --user stop $service failed; the restored data stays in place and the previous data is in $(aside_paths)"
    return 0
  fi
  if [[ -z $restore_stamp ]]; then
    : # Nothing was copied or moved yet.
  elif ! take_state_lock; then
    say "another Locdoc process is using $state; the previous data stays in $(aside_paths)"
  else
    say "putting the previous data back"
    # The restored documents, in place or still staged, are kept.
    if [[ -e $docs.restoring-$restore_stamp ]]; then
      mv -T -- "$docs.restoring-$restore_stamp" "$docs.$failed" && kept_docs=$docs.$failed
    elif ((docs_placed)) && [[ -e $docs || -L $docs ]]; then
      mv -T -- "$docs" "$docs.$failed" && kept_docs=$docs.$failed
    fi
    if [[ -n $aside_docs && ! -e $aside_docs && ! -L $aside_docs ]]; then
      aside_docs= # It never moved.
    elif [[ -n $aside_docs ]] && [[ ! -e $docs && ! -L $docs ]] && mv -T -- "$aside_docs" "$docs"; then
      aside_docs=
    fi
    mkdir -p -- "$state/$failed"
    if ((state_aside)); then
      # Every state file in place came from the snapshot or the pass.
      for name in "${state_files[@]}"; do
        [[ ! -e $state/$name && ! -L $state/$name ]] || mv -T -- "$state/$name" "$state/$failed/$name"
      done
    fi
    [[ ! -e $state/.restoring-$restore_stamp ]] ||
      mv -T -- "$state/.restoring-$restore_stamp" "$state/$failed/copying"
    rmdir -- "$state/$failed" 2>/dev/null || kept_state=$state/$failed
    if [[ -d $aside_state ]]; then
      for name in "${state_files[@]}"; do
        [[ -e $aside_state/$name || -L $aside_state/$name ]] || continue
        if [[ ! -e $state/$name && ! -L $state/$name ]]; then
          mv -T -- "$aside_state/$name" "$state/$name"
        elif [[ $name == root.identity ]] && cmp -s -- "$aside_state/$name" "$state/$name"; then
          rm -f -- "$aside_state/$name" # A copy of the one that never left.
        fi
      done
      rmdir -- "$aside_state" 2>/dev/null && aside_state=
    else
      aside_state=
    fi
    fsync_dir "$state"
    fsync_dir "$(dirname -- "$docs")"
    if [[ -n $aside_docs || -n $aside_state ]]; then
      say "could not put everything back; the previous data is still in $(aside_paths)"
    else
      say "put the previous data back"
    fi
    [[ -z $kept_docs$kept_state ]] ||
      say "the restored copies are kept in ${kept_docs:+$kept_docs${kept_state:+ and }}$kept_state"
  fi
  release_state_lock
  if ((restart)); then
    say "starting $service again"
    systemctl --user start -- "$service" || say "systemctl --user start $service failed"
  fi
}

cmd_restore() {
  local snap current invocation= output
  [[ -n $target ]] || die "name the snapshot folder to restore (see --help)"
  snapshot=$(realpath -e -- "$(absolute "$caller" "$target")" 2>/dev/null) || die "$target does not exist"
  [[ -d $snapshot ]] || die "$snapshot is not a folder"
  # rsnapshot renames hourly.N every hour; keep copying from the folder named.
  exec {snapshot_fd}<"$snapshot"
  snap=/proc/$$/fd/$snapshot_fd
  resolve_paths restore
  check_restore_paths
  lock_releases
  current=$(current_release)
  [[ -n $current && -x $releases/$current/locdoc ]] || die "there is no current release to run the restore pass"
  make_work
  say "checking $snapshot"
  preflight "$snap"
  restoring=1
  if ((restart)); then
    if [[ -n $running_pid ]]; then
      cp -- "/proc/$running_pid/environ" "$work/unit.environ" &&
        readlink -- "/proc/$running_pid/cwd" >"$work/unit.cwd" ||
        die "could not read the environment of the running $service service"
    fi
    invocation=$(service_show InvocationID)
    say "stopping $service"
    systemctl --user stop -- "$service" || die "systemctl --user stop $service failed"
  fi
  replace_data "$snap"
  restore_pass
  py inspect "$state/locdoc.sqlite" >"$work/restored.json" || die "could not read the restored database"
  output=$(py compare "$work/restored.json" "$work/restored.json" exact) ||
    die "the restored database fails its check: $output"
  [[ $fail_at != restore ]] || die "restore: failure injected by LOCDOC_DEPLOY_TEST_FAIL"
  release_state_lock
  if ((restart)); then
    say "starting $service"
    started=1
    systemctl --user start -- "$service" || die "systemctl --user start $service failed"
  fi
  check_release "$current" "$work/restored.json" "$invocation" || die "$failure"
  # The restored service passed its checks and keeps the restored data.
  restoring=
  say "restored $snapshot"
  [[ -z $aside_docs ]] || say "the previous documents folder is $aside_docs"
  say "the previous state files are in $aside_state"
  say "report: $state/restore-report.json"
  say "delete the previous data once you have checked the restored workspace"
}

# Copy the build the service runs now into a first release, so installing the
# drop-in never points the unit at a missing binary.
adopt_running() {
  local pid cwd binary web name dir bundle
  pid=$(service_show MainPID)
  [[ $pid =~ ^[1-9][0-9]*$ ]] || die "there is no current release and $service is not running to adopt"
  cwd=$(readlink -- "/proc/$pid/cwd")
  binary=/proc/$pid/exe
  web=$(absolute "$cwd" "$(py proc-env "$pid" LOCDOC_WEB dist)")
  [[ -f $web/index.html ]] || die "the running service's web folder $web has no index.html"
  bundle=$(bundle_of "$web") || die "$web/index.html references no script bundle"
  name=$(date -u +%Y%m%dT%H%M%SZ)-adopted
  dir=$releases/$name
  incoming=$releases/.incoming-$name
  mkdir -- "$incoming"
  cp -- "$binary" "$incoming/locdoc"
  chmod 700 -- "$incoming/locdoc"
  cp -R -- "$web" "$incoming/web"
  py write "$incoming/manifest.json" release="$name" kind=adopted commit= \
    source_binary="$(readlink -- "$binary")" source_web="$web" bundle="$bundle" \
    binary_sha256="$(sha256 "$incoming/locdoc")" web_index_sha256="$(sha256 "$incoming/web/index.html")" previous=
  py fsync "$incoming"
  mv -T -- "$incoming" "$dir"
  incoming=
  fsync_dir "$releases"
  swap_current "$name"
  say "adopted the running build as $name"
}

cmd_install_unit() {
  local dir file current temporary escaped
  [[ $releases != *[[:space:]\"\'\\]* ]] || die "LOCDOC_RELEASES cannot contain spaces, quotes or backslashes"
  lock_releases
  current=$(current_release)
  if [[ -z $current ]]; then
    adopt_running
    current=$(current_release)
  fi
  dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$service.service.d
  file=$dir/release.conf
  mkdir -p -- "$dir"
  temporary=$dir/.release.conf.$$
  if [[ $releases == "$HOME/.local/share/locdoc/releases" ]]; then
    cp -- "$project/deployment/locdoc-release.conf" "$temporary"
  else
    # Unit files expand %; a literal one is written as %%.
    escaped=${releases//%/%%}
    escaped=${escaped//&/\\&}
    sed "s|%h/.local/share/locdoc/releases|${escaped//|/\\|}|g" \
      "$project/deployment/locdoc-release.conf" >"$temporary"
  fi
  if [[ -f $file ]] && ! cmp -s -- "$file" "$temporary"; then
    cp -- "$file" "$releases/$current/replaced-release.conf"
    say "saved the old drop-in as $releases/$current/replaced-release.conf"
  fi
  mv -fT -- "$temporary" "$file"
  say "installed $file"
  if ((restart)); then
    systemctl --user daemon-reload
    require_unit
    say "the running process keeps its build until the next deploy or rollback restarts $service"
  fi
}

cmd_status() {
  local current name marker commit
  current=$(current_release)
  printf 'releases: %s\ncurrent: %s\n' "$releases" "${current:-none}"
  [[ -z $current ]] || printf 'previous: %s\n' "$(py get "$releases/$current/manifest.json" previous)"
  while IFS= read -r name; do
    marker=' '
    [[ $name != "$current" ]] || marker='*'
    commit=$(py get "$releases/$name/manifest.json" commit)
    commit=${commit:0:12}
    [[ ! -f $releases/$name/FAILED ]] || commit+=' (failed checks)'
    printf '%s %s %s\n' "$marker" "$name" "$commit"
  done < <(release_names)
}

while (($#)); do
  case $1 in
    -h | --help | help)
      usage
      exit 0
      ;;
    --force) force=1 ;;
    --rehearse) rehearse=1 ;;
    --no-restart) restart=0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *)
      if [[ -z $command ]]; then
        command=$1
      elif [[ ($command == rollback || $command == restore) && -z $target ]]; then
        target=$1
      else
        die "unexpected argument $1 (see --help)"
      fi
      ;;
  esac
  shift
done
command=${command:-deploy}
case $fail_at in '' | smoke | activate | restore) ;; *) die "LOCDOC_DEPLOY_TEST_FAIL must be smoke, activate or restore" ;; esac
# The service reads the default release folder and the user's systemd
# configuration on its next restart, so --no-restart runs must not change them.
if ((!restart)) && [[ $command != status ]]; then
  default_releases=$HOME/.local/share/locdoc/releases
  [[ -n ${LOCDOC_RELEASES:-} && $(realpath -m -- "$releases") != "$(realpath -m -- "$default_releases")" ]] ||
    die "--no-restart needs LOCDOC_RELEASES set to a folder other than $default_releases"
  [[ $command != install-unit ||
    (-n ${XDG_CONFIG_HOME:-} && $(realpath -m -- "$XDG_CONFIG_HOME") != "$(realpath -m -- "$HOME/.config")") ]] ||
    die "install-unit --no-restart needs XDG_CONFIG_HOME set to a folder other than $HOME/.config"
fi
case $command in
  deploy) cmd_deploy ;;
  rollback) cmd_rollback ;;
  restore) cmd_restore ;;
  install-unit) cmd_install_unit ;;
  status) cmd_status ;;
  *) die "unknown command $command (see --help)" ;;
esac
