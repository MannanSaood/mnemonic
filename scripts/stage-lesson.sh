#!/usr/bin/env bash
# Copy one lesson's files from the working folder into the clean build copy (../mnemonic-ci).
# Usage: scripts/stage-lesson.sh <slug> [track]
set -e
slug=$1; track=${2:-design-patterns}
src=$(pwd); dst=$(realpath ../mnemonic-ci)
mkdir -p "$dst/content/$track" && cp "content/$track/$slug.mdx" "$dst/content/$track/"
mkdir -p "$dst/src/playgrounds/$slug" && cp -r "src/playgrounds/$slug/." "$dst/src/playgrounds/$slug/"
[ -f "tests/$slug.test.ts" ] && cp "tests/$slug.test.ts" "$dst/tests/"
[ -f "content/glossary/$slug.yaml" ] && mkdir -p "$dst/content/glossary" && cp "content/glossary/$slug.yaml" "$dst/content/glossary/"
echo "staged $slug"
