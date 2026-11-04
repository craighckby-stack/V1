#!/bin/bash
# The script lives in the service directory — cd relative to itself so it
# works from any checkout path (previously hardcoded /home/z/my-project).
cd "$(dirname "$0")" || exit 1
exec setsid nohup bun --hot index.ts >> service.log 2>&1 < /dev/null
