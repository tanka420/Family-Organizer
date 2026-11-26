#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) == 0 ]]
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
stack=/home/family/Family-Organizer
config=/etc/family-organizer
state_dir=/var/lib/family-organizer-updater
service=family-organizer
image_repo=family-organizer-oci-family-organizer

install -d -m 0700 "$config" "$state_dir"
install -d -m 0755 /usr/local/libexec
if [[ ! -f $config/app.env ]]; then
  install -m 0600 "$stack/.env" "$config/app.env"
fi
if [[ ! -f $state_dir/release.env ]]; then
  containers=$(docker ps -q --filter label=com.docker.compose.project=family-organizer-oci \
    --filter "label=com.docker.compose.service=$service")
  [[ $containers =~ ^[a-f0-9]+$ ]]
  version=$(docker exec "$containers" wget -qO- -T 5 http://127.0.0.1:3000/api/health |
    python3 -c 'import json,sys; result=json.load(sys.stdin); assert result["ok"] is True; print(result["version"])')
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$ ]]
  docker image tag "$(docker inspect --format '{{.Image}}' "$containers")" "$image_repo:$version"
  umask 077
  printf 'FAMILY_ORGANIZER_IMAGE=%s:%s\n' "$image_repo" "$version" > "$state_dir/release.env.new"
  mv -T -- "$state_dir/release.env.new" "$state_dir/release.env"
fi

install -m 0600 "$source_dir/compose.oracle.yml" "$config/compose.oracle.yml"
install -m 0755 "$source_dir/deploy/oci-updater.sh" /usr/local/libexec/family-organizer-updater.sh
install -m 0644 "$source_dir/deploy/family-organizer-updater.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable family-organizer-updater.service
systemctl restart family-organizer-updater.service
