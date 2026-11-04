#!/bin/bash
# Resolve the project root from this script's location so it works from any
# checkout path (previously hardcoded /home/z/my-project).
cd "$(dirname "$0")" || exit 1
exec bun run dev
