#!/usr/bin/env bash
# Regenerate the wire types from the backend's OpenAPI document.
#
#   pnpm gen:api                 # from the sibling checkout, ../../../backend
#   pnpm gen:api --staging       # from the deployed staging backend
#   pnpm gen:api:check           # verify the committed output is current (CI)
#   HABANETA_OPENAPI=<path|url> pnpm gen:api
#
# The spec is vendored here rather than fetched at build time, so a clean
# install can typecheck with no backend running and no network.
set -euo pipefail
cd "$(dirname "$0")/.."

mode="write"
source_desc="sibling checkout"
spec_src="../../../backend/openapi.json"

for arg in "$@"; do
  case "$arg" in
    --check)   mode="check" ;;
    --staging) spec_src="https://habaneta-backend-staging.fly.dev/openapi.json"; source_desc="staging" ;;
    *)         echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
if [ -n "${HABANETA_OPENAPI:-}" ]; then
  spec_src="$HABANETA_OPENAPI"; source_desc="HABANETA_OPENAPI"
fi

tmp_spec="$(mktemp)"; tmp_ts="$(mktemp)"
trap 'rm -f "$tmp_spec" "$tmp_ts"' EXIT

if [ "$mode" = "check" ]; then
  # Deliberately does not re-fetch. The question is whether the committed
  # TypeScript matches the committed spec — not whether the spec matches a
  # backend that might be mid-deploy, which would make CI depend on a
  # deployment's timing.
  cp openapi.json "$tmp_spec"
else
  case "$spec_src" in
    http*)
      echo "fetching spec from $source_desc"
      curl -fsS --max-time 30 "$spec_src" > "$tmp_spec"
      ;;
    *)
      if [ ! -f "$spec_src" ]; then
        echo "no spec at $spec_src — is the backend checked out beside this repo?" >&2
        echo "expected the workspace layout: repos/{backend,clients}" >&2
        exit 1
      fi
      echo "reading spec from $source_desc ($spec_src)"
      cp "$spec_src" "$tmp_spec"
      ;;
  esac
fi

npx --yes openapi-typescript "$tmp_spec" -o "$tmp_ts" >/dev/null

if [ "$mode" = "check" ]; then
  if ! diff -u src/generated.ts "$tmp_ts"; then
    echo
    echo "src/generated.ts does not match openapi.json. Run:  pnpm gen:api" >&2
    exit 1
  fi
  echo "generated types are current"
else
  cp "$tmp_spec" openapi.json
  cp "$tmp_ts" src/generated.ts
  echo "wrote openapi.json + src/generated.ts"
fi
