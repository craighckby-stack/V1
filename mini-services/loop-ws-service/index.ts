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
 *
 * IMPLEMENTATION NOTE: With socket.io `path: "/"`, engine.io would
 * normally intercept every HTTP request including `/health`. We use
 * `httpServer.prependListener('request', ...)` to register a handler
 * that runs BEFORE socket.io's listener, so `/health` returns a real
 * JSON response and only non-/health requests fall through to engine.io.
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

// IMPORTANT: socket.io (engine.io) attaches its own 'request' listener
// when `new Server(httpServer, ...)` is called. With path: "/", that
// listener intercepts EVERY request — including /health. We use
// prependListener here to insert our handler BEFORE socket.io's, so
// /health short-circuits with a real JSON response.
httpServer.prependListener("request", (req, res) => {
  const url = (req.url ?? "").split("?")[0];
  if (url === "/health" || url === "/health/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        port: PORT,
        clients: clientCount,
        lastPollAt,
        nextJsReachable,
        cachedStateReady: cachedState !== null,
        socketIoPath: "/",
      })
    );
    return; // do not fall through to socket.io
  }
  // For all other URLs, do nothing — let the next listener (socket.io) handle it.
});

app.get("/health", (_req, res) => {
  // Kept for express-route discovery tools, but the prependListener above
  // is what actually serves this request before socket.io intercepts.
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

  if (cachedState) {
    socket.emit("state", cachedState);
  }

  socket.on("disconnect", (reason) => {
    clientCount = Math.max(0, clientCount - 1);
    console.log(
      `[LOOP-WS] client disconnected: ${socket.id} reason=${reason} (total=${clientCount})`
    );
  });

  socket.on("error", (err) => {
    console.error(`[LOOP-WS] socket error (${socket.id}):`, err);
  });
});

let pollFailureCount = 0;

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
    if (pollFailureCount % 10 === 0) {
      console.warn(`[LOOP-WS] poll failed (#${pollFailureCount + 1}): ${err?.message ?? err}`);
    }
    pollFailureCount++;
  }
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[LOOP-WS] WebSocket service listening on 0.0.0.0:${PORT}`);
  console.log(`[LOOP-WS] /health available at http://localhost:${PORT}/health`);
  console.log(`[LOOP-WS] Polling ${NEXTJS_STATUS_URL} every ${POLL_INTERVAL_MS}ms`);
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
