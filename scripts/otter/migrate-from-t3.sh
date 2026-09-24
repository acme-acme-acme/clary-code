#!/usr/bin/env bash
# Moves a T3 Code data home (threads, projects, settings, attachments) into an
# Otter Code data home on this machine. Works on macOS and Linux, for desktop
# installs and for background services. The source is only read, never changed.
#
# See OTTER.md ("Moving a machine from T3 Code") for when and how to use this.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/otter/migrate-from-t3.sh [options]

  --from DIR          T3 Code home to copy from (the folder that contains userdata/).
                      Default: ~/.t3/orchestrator-preview-2829 if present, else ~/.t3.
  --to DIR            Otter Code home to create. Default: ~/.otter-code.
  --stop-unit NAME    systemd user unit serving --from (for example t3code-pr2829.service).
                      It is stopped for the copy, disabled afterwards, and restarted if
                      anything fails. Never pass T3 Nightly's own t3code.service.
  --wait-idle MIN     Before stopping anything, wait until the source database has had
                      no writes for MIN minutes (no agent mid-turn).
  --install-service   Install and start otter-code.service with the Otter Code runtime
                      already downloaded into --to (Linux or macOS servers, not desktops).
  --dry-run           Print what would happen without changing anything.
  -h, --help          Show this help.

Desktop apps must be quit first (the source app and Otter Code); the script
refuses to run while either database is open.
EOF
}

FROM="" TO="$HOME/.otter-code" STOP_UNIT="" WAIT_IDLE=0 INSTALL_SERVICE=0 DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    --stop-unit) STOP_UNIT="$2"; shift 2 ;;
    --wait-idle) WAIT_IDLE="$2"; shift 2 ;;
    --install-service) INSTALL_SERVICE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
run() { if [[ $DRY_RUN -eq 1 ]]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

# Prints the pids that have any of the given files open.
open_pids() {
  local f p pids=""
  for f in "$@"; do
    [[ -e "$f" ]] || continue
    if command -v lsof >/dev/null 2>&1; then
      pids="$pids $(lsof -t -- "$f" 2>/dev/null | tr '\n' ' ')"
    else
      for p in /proc/[0-9]*; do
        ls -l "$p/fd" 2>/dev/null | grep -qF -- "$f" && pids="$pids ${p#/proc/}"
      done
    fi
  done
  printf '%s\n' $pids | sort -u | tr '\n' ' '
}

describe_pids() {
  local p
  for p in $1; do ps -o pid=,command= -p "$p" 2>/dev/null | cut -c1-120; done
}

if [[ -z "$FROM" ]]; then
  for candidate in "$HOME/.t3/orchestrator-preview-2829" "$HOME/.t3"; do
    [[ -d "$candidate/userdata" ]] && { FROM="$candidate"; break; }
  done
fi
[[ -n "$FROM" && -d "$FROM/userdata" ]] || die "no T3 Code home found; pass --from"
SRC="$FROM/userdata"
DST="$TO/userdata"
if [[ -d "$TO" && "$(cd "$FROM" && pwd)" == "$(cd "$TO" && pwd)" ]]; then
  die "--from and --to are the same folder"
fi

# V2 homes keep threads in statev2.sqlite; T3 Nightly (V1) homes in state.sqlite,
# which Otter Code imports into statev2.sqlite on its first start.
if [[ -f "$SRC/statev2.sqlite" ]]; then DB="statev2.sqlite"
elif [[ -f "$SRC/state.sqlite" ]]; then DB="state.sqlite"
else die "no state database in $SRC"; fi
log "Source:      $SRC ($DB, environment $(cat "$SRC/environment-id" 2>/dev/null || echo unknown))"
log "Destination: $DST"

if [[ "$WAIT_IDLE" -gt 0 ]]; then
  log "Waiting until $DB has had no writes for $WAIT_IDLE minutes..."
  while :; do
    newest=$(mtime "$SRC/$DB")
    [[ -f "$SRC/$DB-wal" ]] && newest=$(( $(mtime "$SRC/$DB-wal") > newest ? $(mtime "$SRC/$DB-wal") : newest ))
    idle=$(( $(date +%s) - newest ))
    [[ $idle -ge $(( WAIT_IDLE * 60 )) ]] && break
    [[ $DRY_RUN -eq 1 ]] && { log "[dry-run] idle for ${idle}s; would keep waiting"; break; }
    sleep 60
  done
fi

stopped_unit=0
restore_unit() {
  if [[ $stopped_unit -eq 1 ]]; then
    printf 'Restoring %s after the failure above.\n' "$STOP_UNIT" >&2
    systemctl --user start "$STOP_UNIT" || true
  fi
}
trap restore_unit ERR

if [[ -n "$STOP_UNIT" ]]; then
  [[ "$STOP_UNIT" != "t3code.service" ]] || die "refusing to stop t3code.service (T3 Nightly)"
  log "Stopping $STOP_UNIT"
  run systemctl --user stop "$STOP_UNIT"
  [[ $DRY_RUN -eq 1 ]] || stopped_unit=1
fi

src_users=$(open_pids "$SRC/$DB" "$SRC/$DB-wal")
if [[ -n "${src_users// /}" && $DRY_RUN -eq 0 ]]; then
  describe_pids "$src_users" >&2
  die "the source database is open by the processes above; quit that app or pass --stop-unit"
fi
dst_users=$(open_pids "$DST/statev2.sqlite" "$DST/state.sqlite")
if [[ -n "${dst_users// /}" ]]; then
  describe_pids "$dst_users" >&2
  die "the destination is in use (Otter Code is running); quit it or stop otter-code.service first"
fi

# A first launch before migrating leaves a nearly empty home; keep it as a backup.
if [[ -e "$DST" ]]; then
  size_kb=$(du -sk "$DST" | cut -f1)
  threads=""
  if command -v sqlite3 >/dev/null 2>&1 && [[ -f "$DST/statev2.sqlite" ]]; then
    threads=$(sqlite3 "file:$DST/statev2.sqlite?mode=ro" 'select count(*) from projection_threads;' 2>/dev/null || true)
  fi
  if [[ "$threads" == "0" || ( -z "$threads" && $size_kb -lt 65536 ) ]]; then
    backup="$DST.empty-$(date +%Y%m%d-%H%M%S)"
    log "Moving the empty existing destination aside to $backup"
    run mv "$DST" "$backup"
  else
    die "$DST already holds data (${threads:-?} threads, ${size_kb} KB); move it aside yourself if you mean to replace it"
  fi
fi

run mkdir -p "$DST"
# Not copied: databases (copied below), per-run files, and anything tied to the old
# app or account: desktop client files encrypted with the old app's Keychain key,
# and the stored T3 Connect link (secrets/cloud-*), which points at T3's relay.
log "Copying settings, secrets, and attachments"
run rsync -a \
  --exclude 'state.sqlite*' --exclude 'statev2.sqlite*' \
  --exclude 'server-runtime.json' --exclude 'logs' --exclude 'caches' \
  --exclude 'connection-catalog.json' --exclude 'clerk-tokens.json' --exclude 'cloud-auth-token.json' \
  --exclude 'secrets/cloud-*' \
  "$SRC/" "$DST/"

log "Copying $DB (nothing has it open, so a file copy is consistent)"
for f in "$DB" "$DB-wal" "$DB-shm"; do
  [[ -f "$SRC/$f" ]] && run cp -p "$SRC/$f" "$DST/$f"
done
if [[ $DRY_RUN -eq 0 ]] && command -v sqlite3 >/dev/null 2>&1; then
  [[ "$(sqlite3 "$DST/$DB" 'PRAGMA quick_check;')" == "ok" ]] || die "integrity check failed on the copy"
  log "Integrity check: ok"
fi

if [[ -n "$STOP_UNIT" ]]; then
  log "Disabling $STOP_UNIT (its data stays in $FROM as a fallback)"
  run systemctl --user disable "$STOP_UNIT"
fi

if [[ $INSTALL_SERVICE -eq 1 ]]; then
  runtime=$(ls -d "$TO"/runtime/versions/*/t3 2>/dev/null | sort -V | tail -1 || true)
  [[ -n "$runtime" ]] || die "no Otter Code runtime in $TO/runtime; install one first (see OTTER.md)"
  log "Installing the background service with $runtime"
  run "$runtime" service install --base-dir "$TO"
  if [[ $DRY_RUN -eq 0 ]]; then
    env_id=$(cat "$DST/environment-id")
    for _ in $(seq 1 90); do
      if [[ -f "$DST/server-runtime.json" ]]; then
        port=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$DST/server-runtime.json")
        curl -fsS -m 3 "http://127.0.0.1:$port/.well-known/t3/environment" 2>/dev/null | grep -q "$env_id" && break
      fi
      sleep 2
    done
    curl -fsS -m 3 "http://127.0.0.1:$port/.well-known/t3/environment" 2>/dev/null | grep -q "$env_id" \
      || die "the Otter Code service did not come up with environment $env_id"
    log "Otter Code service is healthy on port $port"
  fi
fi

trap - ERR
log ""
log "Done. The environment ID is kept, so existing connections to this machine still match."
log "T3 Connect was not carried over; link this machine again (see OTTER.md, \"T3 Connect\")."
