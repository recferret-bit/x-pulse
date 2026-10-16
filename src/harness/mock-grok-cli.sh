#!/bin/sh
set -eu

prompt=
have_prompt=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -p)
      shift
      if [ "$#" -eq 0 ]; then
        echo "mock-grok-cli: -p requires a non-empty prompt" >&2
        exit 1
      fi
      prompt=$1
      have_prompt=1
      shift
      ;;
    *)
      echo "mock-grok-cli: unexpected argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$have_prompt" -ne 1 ] || [ -z "$prompt" ]; then
  echo "mock-grok-cli: -p requires a non-empty prompt" >&2
  exit 1
fi

if [ ! -f ./payload_latest.json ]; then
  echo "mock-grok-cli: ./payload_latest.json does not exist" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fixture="$script_dir/../../tests/fixtures/grok_output_sample.json"

if [ ! -f "$fixture" ]; then
  echo "mock-grok-cli: fixture missing: $fixture" >&2
  exit 1
fi

mkdir -p ./reports
cp "$fixture" ./output_latest.json

cat > ./reports/digest_latest.md <<'EOF'
# Mock digest

This is the mock digest.

## Indie GameDev

Readable mechanic captures outperform generic trailers.

## Solana

Concrete architecture notes outperform price talk.
EOF

exit 0
