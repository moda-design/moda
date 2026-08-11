#!/bin/sh
# Fan the canonical shared references into each skill's references/ directory.
# Skills must be self-contained at install time (installers copy directories),
# so the per-skill copies are committed build artifacts of this script.
# scripts/validate.py fails the build when a copy drifts from its canonical
# source — edit shared/references/, re-run this, commit both.
set -eu
cd "$(dirname "$0")/.."

fan() {
  skill="$1"
  shift
  mkdir -p "skills/$skill/references"
  for ref in "$@"; do
    cp "shared/references/$ref.md" "skills/$skill/references/$ref.md"
  done
}

fan moda-deck markup edit-code reading-and-verifying gotchas design-quality \
  brand export omni-and-media deck-design deck-playbooks charts
fan moda-one-pager markup edit-code reading-and-verifying gotchas design-quality \
  brand export omni-and-media document-design
fan moda-brand brand gotchas markup design-quality
fan moda-edit edit-code reading-and-verifying gotchas markup design-quality

echo "fanout complete"
