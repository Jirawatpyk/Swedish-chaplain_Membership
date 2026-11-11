#!/usr/bin/env bash
# Installs Chromium for the e2e jobs, surviving a short apt mirror outage.
#
# On 11 Nov 2026 both e2e @critical jobs on #781 failed before any test ran:
# `playwright install --with-deps chromium` could not resolve
# azure.archive.ubuntu.com / security.ubuntu.com and apt exited 100. The
# browser download (Playwright's CDN) never failed; only the system-library
# step (apt) did. So the two are split:
#   1. the browser download, retried;
#   2. the system libraries, two tries of at most 5 minutes each: with the
#      mirror's DNS down, every apt URL waits ~20 s, so one unbounded try
#      took ~10 minutes and three of them used up the job's 45-minute
#      budget before any test ran (#782's first run);
#   3. if apt is still down, check that Chromium launches anyway (the
#      ubuntu-24.04 image already ships most of its libraries). It launches:
#      a warning, and the job goes on. It does not: the job fails, named.
set -uo pipefail

retry() {
  local label=$1; shift
  local delays=$1; shift
  local attempt=1
  for delay in $delays 0; do
    if "$@"; then return 0; fi
    if [ "$delay" -eq 0 ]; then break; fi
    echo "$label: attempt $attempt failed; retrying in ${delay}s"
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  return 1
}

if ! retry "browser download" "15 30" pnpm exec playwright install chromium; then
  echo "::error title=Chromium download failed::playwright install chromium failed 3 times."
  exit 1
fi

# One bounded try. A timed-out try can leave apt-get running and holding
# the dpkg lock, so the next try stops it first.
install_deps() {
  sudo pkill -x apt-get 2>/dev/null || true
  timeout --kill-after=15 300 pnpm exec playwright install-deps chromium
}

if retry "system libraries" "30" install_deps; then
  exit 0
fi

if node -e "require('playwright').chromium.launch().then((b) => b.close()).catch((e) => { console.error(e.message); process.exit(1); })"; then
  echo "::warning title=apt mirror unavailable::playwright install-deps failed twice, but Chromium launches with the libraries already on the runner. Continuing."
  exit 0
fi

echo "::error title=Chromium libraries missing::playwright install-deps failed twice (apt mirror unreachable?) and Chromium does not launch without them."
exit 1
