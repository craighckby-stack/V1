#!/bin/bash
cd /home/z/my-project/mini-services/loop-ws-service
exec setsid nohup bun --hot index.ts >> service.log 2>&1 < /dev/null
