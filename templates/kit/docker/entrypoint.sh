#!/bin/sh
# One-shot: vite build → celld deploy into the fleet bucket.
# celld starts after this job (needs deploy/current.json).
set -eu

: "${AWS_ACCESS_KEY_ID:?}"
: "${AWS_SECRET_ACCESS_KEY:?}"
: "${S3_ENDPOINT:?}"
: "${CELLD_BUCKET:?}"
: "${BETTER_AUTH_SECRET:?}"

AWS_REGION="${AWS_REGION:-us-east-1}"
BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:8080}"
CELLD_ESBUILD="${CELLD_ESBUILD:-/usr/local/bin/esbuild}"
export CELLD_ESBUILD

umask 077
# printf — secrets may contain `$`, backticks, or newlines' first line only.
{
  printf 'BETTER_AUTH_SECRET=%s\n' "${BETTER_AUTH_SECRET}"
  printf 'BETTER_AUTH_URL=%s\n' "${BETTER_AUTH_URL}"
} > .dev.vars

echo "kit: vite build"
bun run build

echo "kit: celld deploy ${CELLD_BUCKET} via ${S3_ENDPOINT}"
celld deploy dist \
  --bucket "${CELLD_BUCKET}" \
  --endpoint "${S3_ENDPOINT}" \
  --region "${AWS_REGION}"

# Adopt the new deployment now instead of waiting for the node's poll
# (CELLD_DEPLOY_POLL_S). On the first `compose up` celld is not running yet
# (it starts after this job), so the reload is skipped and celld loads
# deploy/current.json on start.
RELOAD_URL="${CELLD_RELOAD_URL:-http://celld:8081/reload}"
echo "kit: POST ${RELOAD_URL}"
if reload_body=$(curl -fsS --max-time 60 -X POST "${RELOAD_URL}" 2>&1); then
  echo "kit: celld reloaded ${reload_body}"
else
  code=$?
  if [ "${code}" -eq 7 ]; then
    echo "kit: celld not running yet; it loads deploy/current.json on start"
  else
    echo "kit: reload failed (curl ${code}): ${reload_body}" >&2
    exit 1
  fi
fi

echo "kit: open ${BETTER_AUTH_URL}"
