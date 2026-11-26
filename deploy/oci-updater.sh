#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

stack=/home/family/Family-Organizer
data=$stack/data
queue=$data/update
config=/etc/family-organizer
state_dir=/var/lib/family-organizer-updater
release_env=$state_dir/release.env
transaction=$state_dir/rollback
rollback_snapshot=update/oci-rollback.db.gz
image_repo=family-organizer-oci-family-organizer
github_repo=tanka420/Family-Organizer
service=family-organizer
version_pattern='[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?'

as_family() { setpriv --reuid=family --regid=family --clear-groups -- "$@"; }
compose() {
  docker compose --project-directory "$stack" --env-file "$config/app.env" \
    --env-file "$release_env" -f "$config/compose.oracle.yml" "$@"
}
health() {
  compose exec -T "$service" wget -qO- -T 5 http://127.0.0.1:3000/api/health </dev/null |
    python3 -c 'import json,sys; result=json.load(sys.stdin); assert result["ok"] is True; print(result["version"])'
}
use_version() {
  printf 'FAMILY_ORGANIZER_IMAGE=%s:%s\n' "$image_repo" "$1" > "$release_env.new"
  mv -T -- "$release_env.new" "$release_env"
}

request_id= action= result= message= previous= finished_at= phase=idle
current=
as_family mkdir -p "$queue"

write_state() {
  local dir=$1
  shift
  printf '%s\n' "heartbeat=$(date +%s)" "$@" |
    as_family bash -c 'set -e; tmp=$(mktemp "$1/state.XXXXXXXX"); trap '\''rm -f -- "$tmp"'\'' EXIT; cat > "$tmp"; chmod 0644 "$tmp"; mv -T -- "$tmp" "$1/state.env"' _ "$dir"
}
report() {
  write_state "$queue" "phase=$phase" "request_id=$request_id" "action=$action" \
    "result=$result" "message=$message" "current=$current" "previous=$previous" \
    "finished_at=$finished_at" 'script_version=oci-2'
}

from_request() { sed -n "s/^$1=//p" <<< "$request" | head -n 1; }
save_rollback_db() {
  as_family python3 - "$data" "$rollback_snapshot" <<'PY'
import gzip
import os
import shutil
import sqlite3
import sys
import tempfile
from contextlib import closing
from pathlib import Path

data = Path(sys.argv[1])
with tempfile.TemporaryDirectory(dir=data) as folder:
    raw = Path(folder) / 'backup.db'
    compressed = Path(folder) / 'backup.gz'
    with closing(sqlite3.connect((data / 'family.db').as_uri() + '?mode=ro', uri=True)) as db:
        with closing(sqlite3.connect(raw)) as backup:
            db.backup(backup)
    with raw.open('rb') as source, gzip.open(compressed, 'wb') as output:
        shutil.copyfileobj(source, output)
    os.replace(compressed, data / sys.argv[2])
PY
}
restore_db() {
  as_family python3 - "$data" "$1" <<'PY'
import gzip
import os
import shutil
import sys
import tempfile
from pathlib import Path

data = Path(sys.argv[1])
snapshot = data / sys.argv[2]
with tempfile.NamedTemporaryFile(dir=data, delete=False) as temp:
    try:
        with gzip.open(snapshot, 'rb') as contents:
            header = contents.read(16)
            if header != b'SQLite format 3\x00':
                raise ValueError('Invalid SQLite backup')
            temp.write(header)
            shutil.copyfileobj(contents, temp)
        temp.flush()
        os.fsync(temp.fileno())
        for name in ('family.db-wal', 'family.db-shm'):
            (data / name).unlink(missing_ok=True)
        os.replace(temp.name, data / 'family.db')
    finally:
        Path(temp.name).unlink(missing_ok=True)
PY
}
build_release() (
  set -e
  local version=$1 work revision
  work=$(mktemp -d "$state_dir/source.XXXXXXXX")
  trap 'rm -rf -- "$work"' EXIT
  curl -fsS --max-time 20 "https://api.github.com/repos/$github_repo/releases/tags/v$version" |
    python3 -c 'import json,sys; release=json.load(sys.stdin); assert not release["draft"] and release["tag_name"] == sys.argv[1]' "v$version" || exit 1
  # Docker COPY giữ quyền từ checkout. Các tệp nguồn phải đọc được bởi UID trong container.
  (umask 022; git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$version" \
    "https://github.com/$github_repo.git" "$work") || exit 1
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["version"] == sys.argv[2]' "$work/package.json" "$version" || exit 1
  revision=$(git -C "$work" rev-parse HEAD) || exit 1
  docker build --tag "$image_repo:$version" --build-arg "GIT_SHA=$revision" "$work"
)
wait_with_heartbeat() {
  "$@" &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    report
    sleep 4
  done
  wait "$pid"
}
start_version() {
  use_version "$1" && compose up -d --no-build --pull never --no-deps --wait --wait-timeout 90 "$service" &&
    [[ $(health) == "$1" ]]
}
recover_version() {
  compose stop "$service" && { [[ -z $2 ]] || restore_db "$2"; } &&
    wait_with_heartbeat start_version "$1" && rm -f -- "$transaction" &&
    as_family rm -f -- "$data/$rollback_snapshot"
}
set_transaction() {
  printf '%s %s\n' "$previous" "$1" > "$transaction.new" && mv -T -- "$transaction.new" "$transaction"
}
wait_health() {
  local end=$((SECONDS + 90))
  while (( SECONDS < end )); do
    [[ $(health 2>/dev/null) == "$current" ]] && return 0
    sleep 2
  done
  return 1
}
apply_update() {
  local target=$1 backup=$2 restore=$3
  if [[ ! $target =~ ^$version_pattern$ || $target == "$current" ||
        ! $backup =~ ^update/snapshots/pre-update_[A-Za-z0-9._-]+\.db\.gz$ ]]; then
    message='Yêu cầu cập nhật không hợp lệ.'
    return 1
  fi
  if [[ -n $restore && ! $restore =~ ^update/snapshots/pre-update_[A-Za-z0-9._-]+\.db\.gz$ ]]; then
    message='Đường dẫn bản sao lưu không hợp lệ.'
    return 1
  fi
  if ! as_family test -s "$data/$backup" || { [[ -n $restore ]] && ! as_family test -s "$data/$restore"; }; then
    message='Không tìm thấy bản sao lưu SQLite.'
    return 1
  fi
  phase=pulling
  if ! wait_with_heartbeat build_release "$target"; then
    message='Không build được GitHub Release của fork. Xem nhật ký systemd.'
    return 1
  fi
  previous=$current
  phase=restarting
  set_transaction '' || return 1
  if ! compose stop "$service"; then
    rm -f -- "$transaction"
    message='Không dừng được app để cập nhật.'
    return 1
  fi
  if ! save_rollback_db || ! set_transaction "$rollback_snapshot"; then
    message='Không tạo được bản sao SQLite trước khi thay container.'
    recover_version "$previous" '' || return 1
    return 1
  fi
  if { [[ -z $restore ]] || restore_db "$restore"; } && wait_with_heartbeat start_version "$target"; then
    current=$target
    rm -f -- "$transaction"
    as_family rm -f -- "$data/$rollback_snapshot"
    message="Đã cập nhật lên v$target."
    return 0
  fi
  phase=rolling_back
  compose logs --tail 25 "$service" || true
  if recover_version "$previous" "$rollback_snapshot"; then
    result=rolled_back
    message="Bản v$target bị lỗi. Đã khôi phục v$previous và bản sao lưu SQLite."
    return 0
  fi
  message="Cập nhật v$target và khôi phục v$previous bị lỗi. Xem nhật ký systemd."
  return 1
}

if [[ -f $transaction ]]; then
  read -r previous backup < "$transaction"
  phase=rolling_back
  recover_version "$previous" "$backup"
fi
current=$(health)
[[ $current =~ ^$version_pattern$ ]]
phase=idle
if as_family test -f "$queue/request.processing"; then
  as_family rm -f -- "$queue/request.processing"
  result=failed
  message='Tiến trình cập nhật trước bị gián đoạn. Xem nhật ký systemd.'
  finished_at=$(date +%s)
fi

while true; do
  if [[ ! -f $transaction ]] && as_family mv -T -- "$queue/request.env" "$queue/request.processing" 2>/dev/null; then
    request=$(as_family timeout 2 head -c 4096 -- "$queue/request.processing" || true)
    request_id=$(from_request id)
    [[ $request_id =~ ^[a-f0-9-]{36}$ ]] || request_id=
    action=$(from_request action)
    result= message= finished_at=
    case "$action" in
      update)
        if apply_update "$(from_request target)" "$(from_request backup)" "$(from_request restore)"; then
          result=${result:-ok}
        else
          result=failed
        fi ;;
      restart)
        phase=restarting
        if wait_with_heartbeat compose restart "$service" && wait_with_heartbeat wait_health; then
          result=ok message='Đã khởi động lại ứng dụng.'
        else
          result=failed message='Khởi động lại thất bại. Xem nhật ký systemd.'
        fi ;;
      *) action=; result=failed message='Hành động cập nhật không hợp lệ cho stack OCI.' ;;
    esac
    as_family rm -f -- "$queue/request.processing"
    phase=idle finished_at=$(date +%s)
    printf '%s\n' "$message" | as_family bash -c 'tmp=$(mktemp "$1/log.XXXXXXXX") && cat > "$tmp" && mv -T -- "$tmp" "$1/log.txt"' _ "$queue"
  fi
  report
  sleep 4
done
