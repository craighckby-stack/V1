#!/bin/bash
# Start the fleet-harvester mini-service detached (port 3010).
# Mirrors loop-ws-service/start-service.sh: setsid creates a new session so
# the service survives the parent shell exiting; nohup ignores SIGHUP;
# < /dev/null detaches stdin.
cd "$(dirname "$0")" || exit 1
exec setsid nohup bun --hot index.ts >> harvester.log 2>&1 < /dev/null
