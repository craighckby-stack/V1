/**
 * Loop WebSocket Mini-Service (port 3003)
 *
 * Streams the Architecture Helper Pipeline autonomous-loop state to the
 * browser in real time. The service polls the Next.js dev server's
 * `/api/autonomous/status` endpoint every second and emits a `state`
 * event to all connected Socket.IO clients whenever the state changes.
 *
 * The Next.js frontend connects via the gateway using:
 *     io("/?XTransformPort=3003")
 * (the path MUST remain `/` so Caddy can route correctly).
 */

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const PORT = 3003;
const NEXTJS_STATUS_URL = "http://localhost:3000/api/autonomous/status";
const POLL_INTERVAL_MS = 1000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

let clientCount = 0;
let cachedState: any = null;
let cachedStateJson = "";
let lastPollAt: string | null = null;
let nextJsReachable = false;

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    port: PORT,
    clients: clientCount,
    lastPollAt,
    nextJsReachable,
    cachedStateReady: cachedState !== null,
  });
});

io.on("connection", (socket) => {
  clientCount++;
  console.log(`[LOOP-WS] client connected: ${socket.id} (total=${clientCount})`);

  // Push the current cached state immediately so the new client doesn't wait for the next poll.
  if (cachedState) {
    socket.emit("state", cachedState);
  }

  socket.on("disconnect", (reason) => {
    clientCount = Math.max(0, clientCount - 1);
    console.log(`[LOOP-WS] client disconnected: ${socket.id} reason=${reason} (total=${clientCount})`);
  });

  socket.on("error", (err) => {
    console.error(`[LOOP-WS] socket error (${socket.id}):`, err);
  });
});

async function pollNextJsState() {
  try {
    const res = await fetch(NEXTJS_STATUS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    lastPollAt = new Date().toISOString();
    if (!res.ok) {
      nextJsReachable = false;
      console.warn(`[LOOP-WS] /api/autonomous/status returned ${res.status}`);
      return;
    }
    nextJsReachable = true;
    const newState = await res.json();
    const newJson = JSON.stringify(newState);
    if (newJson !== cachedStateJson) {
      cachedState = newState;
      cachedStateJson = newJson;
      io.emit("state", newState);
      const summary = `status=${newState?.status} mode=${newState?.config?.mode} totalRuns=${newState?.stats?.totalRuns}`;
      console.log(`[LOOP-WS] state changed -> ${summary}`);
    }
  } catch (err: any) {
    nextJsReachable = false;
    // Only log every 10th failure to avoid spam when Next.js hasn't started yet.
    if (pollFailureCount % 10 === 0) {
      console.warn(`[LOOP-WS] poll failed (#${pollFailureCount + 1}): ${err?.message ?? err}`);
    }
    pollFailureCount++;
  }
}

let pollFailureCount = 0;

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[LOOP-WS] WebSocket service listening on 0.0.0.0:${PORT}`);
  console.log(`[LOOP-WS] Polling ${NEXTJS_STATUS_URL} every ${POLL_INTERVAL_MS}ms`);
  // Kick off polling immediately so we have state ready for the first client.
  pollNextJsState().catch(() => {});
  setInterval(() => {
    pollNextJsState().catch(() => {});
  }, POLL_INTERVAL_MS);
});

process.on("SIGTERM", () => {
  console.log("[LOOP-WS] SIGTERM received, shutting down...");
  io.close(() => {
    httpServer.close(() => {
      console.log("[LOOP-WS] closed");
      process.exit(0);
    });
  });
});

process.on("SIGINT", () => {
  console.log("[LOOP-WS] SIGINT received, shutting down...");
  io.close(() => {
    httpServer.close(() => {
      console.log("[LOOP-WS] closed");
      process.exit(0);
    });
  });
});
