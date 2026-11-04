#!/usr/bin/env bash
# Adapted from /qsd/build.sh for the local Next.js user-systemd deployment.
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$ROOT_DIR"
SERVICE="beadswebui.service"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://192.168.1.168:3015/}"
INSTALL_TIMEOUT_SEC="${INSTALL_TIMEOUT_SEC:-900}"
BUILD_TIMEOUT_SEC="${BUILD_TIMEOUT_SEC:-1800}"
SERVICE_TIMEOUT_SEC="${SERVICE_TIMEOUT_SEC:-60}"
WAIT_TIMEOUT_SEC="${WAIT_TIMEOUT_SEC:-120}"
CHECK_ONLY=false
PHASE=preflight
STOP_REQUESTED=false

usage() {
    printf '%s\n' \
        'Usage: bash build.sh [--check]' \
        'Deploy clean main to the existing user beadswebui.service; no Git push or sudo.' \
        '--check validates prerequisites without installing, building, or changing the service.' \
        'Deployment stops the service before npm ci/build; downtime includes both steps.' \
        'Failures are nonzero; no automatic rollback or restart of an incomplete build.' \
        'Override DEPLOY_HEALTH_URL if the local service address changes.' \
        'Timeouts (seconds): INSTALL_TIMEOUT_SEC=900, BUILD_TIMEOUT_SEC=1800,' \
        'SERVICE_TIMEOUT_SEC=60, WAIT_TIMEOUT_SEC=120.'
}

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

for arg in "$@"; do
    case "$arg" in
        --help|-h) usage; exit 0 ;;
        --check) CHECK_ONLY=true ;;
        *) echo "ERROR: unsupported argument '$arg'" >&2; usage >&2; exit 2 ;;
    esac
done
for value in "$INSTALL_TIMEOUT_SEC" "$BUILD_TIMEOUT_SEC" "$SERVICE_TIMEOUT_SEC" "$WAIT_TIMEOUT_SEC"; do
    [[ "$value" =~ ^[1-9][0-9]{0,5}$ ]] || {
        echo 'ERROR: timeouts must be integer seconds between 1 and 999999' >&2
        exit 2
    }
done
for cmd in git node npm systemctl flock timeout curl realpath grep; do
    command -v "$cmd" >/dev/null || fail "'$cmd' is required"
done

case "$HEALTH_URL" in
    http://*|https://*) ;;
    *) fail 'DEPLOY_HEALTH_URL must be an HTTP(S) URL' ;;
esac

SYSTEMCTL=(timeout --kill-after=5s "${SERVICE_TIMEOUT_SEC}s" systemctl --user)
mkdir -p "$ROOT_DIR/tmp/deploy"
# Keep this inode: unlinking a held lock would allow a second deployment.
exec 9>>"$ROOT_DIR/tmp/deploy/build.lock"
flock -n 9 || fail 'another build/deploy is running'

on_exit() {
    local status=$?
    if ((status != 0)); then
        echo "ERROR: deployment failed during $PHASE (exit $status); no automatic rollback attempted" >&2
        if $STOP_REQUESTED; then
            echo "The service may be stopped or unhealthy. Fix the failure and rerun bash build.sh." >&2
            echo "Inspect: systemctl --user status $SERVICE; journalctl --user -u $SERVICE -n 80 --no-pager" >&2
        fi
    fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_release_tree() {
    [[ "$(git symbolic-ref --quiet --short HEAD)" == main ]] || fail 'deployment requires the main branch'
    local status
    status="$(git status --porcelain --untracked-files=all)"
    [[ -z "$status" ]] || fail 'deployment requires a clean worktree (including untracked files)'
}

require_release_tree
REVISION="$(git rev-parse HEAD)"
[[ -f package-lock.json ]] || fail 'package-lock.json is required'
[[ "$("${SYSTEMCTL[@]}" show "$SERVICE" -p LoadState --value)" == loaded ]] || fail "user $SERVICE is not loaded"
SERVICE_ROOT="$("${SYSTEMCTL[@]}" show "$SERVICE" -p WorkingDirectory --value)"
[[ -n "$SERVICE_ROOT" && "$(realpath -- "$SERVICE_ROOT")" == "$ROOT_DIR" ]] || fail 'service WorkingDirectory must match this checkout'
[[ "$("${SYSTEMCTL[@]}" show "$SERVICE" -p NeedDaemonReload --value)" == no ]] || fail 'service configuration needs systemctl --user daemon-reload first'
case "$("${SYSTEMCTL[@]}" show "$SERVICE" -p ActiveState --value)" in
    active|inactive|failed) ;;
    *) fail 'service is transitioning; retry after it settles' ;;
esac

printf '==> Revision: %s\n==> Service: %s\n==> Readiness URL: %s\n' "$REVISION" "$SERVICE" "$HEALTH_URL"
printf '==> Node: %s; npm: %s\n' "$(node --version)" "$(npm --version)"
if $CHECK_ONLY; then
    echo '==> Preflight passed; no install, build, or service change performed'
    exit 0
fi

# The running server reads these same node_modules and .next directories.
# Stop it before either is rewritten; never auto-start partially built output.
PHASE=stop
STOP_REQUESTED=true
"${SYSTEMCTL[@]}" stop "$SERVICE"
# A stop timeout can leave the unit failed after systemd has killed every process.
# State alone is not proof of shutdown: require no tracked PIDs or populated cgroup.
STOP_STATE="$("${SYSTEMCTL[@]}" show "$SERVICE" -p ActiveState --value)"
case "$STOP_STATE" in
    inactive|failed) ;;
    *) fail "service did not stop (state: $STOP_STATE)" ;;
esac
[[ "$("${SYSTEMCTL[@]}" show "$SERVICE" -p MainPID --value)" == 0 &&
    "$("${SYSTEMCTL[@]}" show "$SERVICE" -p ControlPID --value)" == 0 ]] || fail 'service still has a tracked process'
SERVICE_CGROUP="$("${SYSTEMCTL[@]}" show "$SERVICE" -p ControlGroup --value)"
if [[ -n "$SERVICE_CGROUP" ]]; then
    grep -qx 'populated 0' "/sys/fs/cgroup${SERVICE_CGROUP}/cgroup.events" || fail 'cannot confirm the service cgroup is empty'
fi
if [[ "$STOP_STATE" == failed ]]; then
    echo 'WARNING: service stop ended in failed state, but no service processes remain; continuing deployment' >&2
fi

export CI=true NODE_ENV=production NEXT_STANDALONE=""
export BUILD_SHA="$(git rev-parse --short=7 "$REVISION")"
export BUILD_NUMBER="$(git rev-list --count "$REVISION")"
PHASE=install
echo '==> Installing locked dependencies'
timeout --kill-after=30s "${INSTALL_TIMEOUT_SEC}s" npm ci --include=dev --no-audit --no-fund
PHASE=build
echo '==> Building Next.js'
timeout --kill-after=30s "${BUILD_TIMEOUT_SEC}s" npm run build
[[ -s .next/BUILD_ID ]] || fail 'build did not produce .next/BUILD_ID'

# The lock excludes this script's peers, not editors or other Git commands.
PHASE=pre-start
require_release_tree
[[ "$(git rev-parse HEAD)" == "$REVISION" ]] || fail 'HEAD changed during deployment; start cancelled'
PHASE=start
"${SYSTEMCTL[@]}" start "$SERVICE"
PHASE=readiness
DEADLINE=$((SECONDS + WAIT_TIMEOUT_SEC))
while ((SECONDS < DEADLINE)); do
    if "${SYSTEMCTL[@]}" is-active --quiet "$SERVICE"; then
        HTTP_STATUS=""
        if HTTP_STATUS="$(curl --disable --noproxy '*' --silent --output /dev/null \
            --write-out '%{http_code}' --connect-timeout 2 --max-time 5 "$HEALTH_URL")" &&
            [[ "$HTTP_STATUS" == 200 ]]; then
            printf '==> Deployment completed successfully: %s (HTTP 200)\n' "$REVISION"
            exit 0
        fi
    fi
    sleep 2
done
fail "service did not become ready within ${WAIT_TIMEOUT_SEC}s at $HEALTH_URL"
