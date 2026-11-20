#!/bin/bash
# Start the fleet-harvester mini-service detached (port 3010).
#
# `setsid -f` force-forks into a new session and reparents the child to
# init (PPID=1) immediately, so the service survives the launching shell
# exiting. Plain `setsid` without `-f` does NOT fork when the caller is
# not a process-group leader, and the child dies with the shell — `-f`
# is required in this sandbox. Uses `bun index.ts` (no --hot) for
# detached stability; `bun run dev` keeps --hot for interactive use.
cd "$(dirname "$0")" || exit 1
setsid -f bun index.ts >> harvester.log 2>&1 < /dev/null
