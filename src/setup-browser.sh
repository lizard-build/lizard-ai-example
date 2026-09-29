#!/bin/sh
set -eu
# Persistent browser assets are separate from disposable daemon sockets and PIDs.
exec 9>/opt/telegram-codex/browser-install.lock
if [ "${1:-}" = '--restore' ]; then flock -w 3 9; else flock -n 9 || exit 0; fi
if [ -f /opt/telegram-codex/browser-ready-v3 ]; then exit 0; fi
. /etc/os-release
browser_root="/workspace/.tools/browser-0.27.0-${ID}-${VERSION_ID}-$(uname -m)-v1"
browser_libs="$browser_root/libs"
mkdir -p "$browser_root/browsers" /root/.agent-browser
# Preserve an old cache on first migration. Existing browser processes can finish.
if [ ! -L /root/.agent-browser/browsers ] && [ -e /root/.agent-browser/browsers ]; then
  cp -R /root/.agent-browser/browsers/. "$browser_root/browsers/"
  mv /root/.agent-browser/browsers "/root/.agent-browser/browsers-before-volume-$(date +%s)"
fi
ln -sfn "$browser_root/browsers" /root/.agent-browser/browsers
if [ ! -f "$browser_root/libs-ready" ]; then
  if [ "${1:-}" = '--restore' ]; then exit 42; fi
  mkdir -p /opt/telegram-codex/apt/lists/partial /opt/telegram-codex/apt/archives/partial
  apt_get() {
    apt-get -o APT::Sandbox::User=root \
      -o Dir::State::lists=/opt/telegram-codex/apt/lists \
      -o Dir::Cache::archives=/opt/telegram-codex/apt/archives "$@"
  }
  apt_get update
  DEBIAN_FRONTEND=noninteractive apt_get install --download-only --reinstall -y --no-install-recommends \
    libglib2.0-0 libnss3 libnspr4 libatk-bridge2.0-0 libatk1.0-0 libdbus-1-3 \
    libcups2 libxcb1 libxkbcommon0 libasound2 libgbm1 libx11-6 libxext6 \
    libcairo2 libpango-1.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libatspi2.0-0 fonts-liberation fonts-noto-color-emoji
  mkdir -p "$browser_libs"
  for browser_deb in /opt/telegram-codex/apt/archives/*.deb; do
    dpkg-deb --fsys-tarfile "$browser_deb" | tar --no-same-owner -xf - -C "$browser_libs"
  done
  touch "$browser_root/libs-ready"
fi
# These tiny files belong to the new root filesystem and must be restored every boot.
case "$(uname -m)" in
  x86_64) browser_triplet=x86_64-linux-gnu ;;
  aarch64) browser_triplet=aarch64-linux-gnu ;;
  *) echo 'Unsupported browser platform' >&2; exit 1 ;;
esac
printf '%s\n' "$browser_libs/usr/lib/$browser_triplet" "$browser_libs/lib/$browser_triplet" > /etc/ld.so.conf.d/telegram-browser.conf
ldconfig -X
mkdir -p /etc/fonts/conf.d
if [ ! -f /etc/fonts/fonts.conf ]; then cp "$browser_libs/etc/fonts/fonts.conf" /etc/fonts/fonts.conf; fi
printf '%s\n' "<fontconfig><dir>$browser_libs/usr/share/fonts</dir><cachedir>/tmp/fontconfig-cache</cachedir></fontconfig>" > /etc/fonts/conf.d/99-telegram-browser.conf
if [ "${1:-}" = '--restore' ]; then
  test -f "$browser_root/browser-ready"
  test -n "$(find "$browser_root/browsers" -type f -name chrome -perm /111 -print -quit)"
  touch /opt/telegram-codex/browser-ready-v3
  exit 0
fi
if [ ! -f "$browser_root/browser-ready" ]; then
  agent-browser install
  agent-browser skills get core --json >/dev/null
fi
agent-browser --session bootstrap --args '--no-sandbox,--disable-dev-shm-usage' open about:blank
agent-browser --session bootstrap close
touch "$browser_root/browser-ready"
touch /opt/telegram-codex/browser-ready-v3
