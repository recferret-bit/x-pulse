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

if printf '%s' "$prompt" | grep -q 'advise_output.json'; then
  if [ ! -f ./advise_payload.json ]; then
    echo "mock-grok-cli: ./advise_payload.json does not exist" >&2
    exit 1
  fi
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const payload = JSON.parse(readFileSync("./advise_payload.json", "utf8"));
    const title = payload.soul?.title || payload.reading || "Draft";
    const body = payload.soul?.launch || payload.brief;
    const other = payload.soul?.constraint || body;
    const kind = payload.contentKind || "text";
    const output = {
      title,
      options: [
        { label: kind, kind, body, formatNote: "Shot from the mock advise." },
        { label: "Text, result first", kind: "text", body, formatNote: "" },
        { label: "Text, constraint first", kind: "text", body: other, formatNote: "" },
      ],
    };
    writeFileSync("./advise_output.json", JSON.stringify(output, null, 2));
  '
  exit 0
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
