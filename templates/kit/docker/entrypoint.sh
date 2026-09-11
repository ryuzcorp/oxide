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

echo "kit: deploy uploaded; celld will load it on start"
echo "kit: open ${BETTER_AUTH_URL}"
