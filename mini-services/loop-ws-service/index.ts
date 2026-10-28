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
 * REQUEST ROUTING (bug fix, previously ERR_HTTP_HEADERS_SENT crash):
 * With socket.io `path: "/"`, engine.io's auto-attached request listener
 * intercepts EVERY http request. The old code used prependListener to
 * answer /health first — but Node fires ALL 'request' listeners, so
 * engine.io still ran for /health and its cors middleware tried to set
 * headers on a response that was already sent → uncaught exception →
 * process exit. The correct fix is a single owner of the 'request'
 * event: we remove engine.io's listener and re-attach it behind our own
 * router that answers /health itself and delegates everything else.
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { Server, Socket } from "socket.io";

const PORT = 3003;
const NEXTJS_STATUS_URL = "http://localhost:3000/api/autonomous/status";
const POLL_INTERVAL_MS = 1000;

interface AutonomousState {
  status?: string;
  config?: {
    mode?: string;
  };
  stats?: {
    totalRuns?: number;
  };
  [key: string]: unknown;
}

const httpServer = createServer();
const io = new Server(httpServer, {
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

let clientCount = 0;
let cachedState: AutonomousState | null = null;
let cachedStateJson = "";
let lastPollAt: string | null = null;
let nextJsReachable = false;
let pollFailureCount = 0;

/**
 * Handles incoming HTTP requests, intercepting /health checks
 * and delegating all other requests to the Engine.IO socket handler.
 */
function configureRequestRouting(
  server: ReturnType<typeof createServer>
): void {
  const engineListeners = server.listeners("request").slice(0) as ((
    req: IncomingMessage,
    res: ServerResponse
  ) => void)[];
  
  server.removeAllListeners("request");

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? "").split("?")[0];
    if (url === "/health" || url === "/health/") {
      const responseBody = JSON.stringify({
        status: "ok",
        port: PORT,
        clients: clientCount,
        lastPollAt,
        nextJsReachable,
        cachedStateReady: cachedState !== null,
        socketIoPath: "/",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(responseBody);
      return;
    }

    for (const listener of engineListeners) {
      listener.call(server, req, res);
    }
  });
}

/**
 * Sets up Socket.IO connection event handlers.
 */
function configureSocketHandlers(socket: Socket): void {
  clientCount++;
  console.log(`[LOOP-WS] client connected: ${socket.id} (total=${clientCount})`);

  if (cachedState) {
    socket.emit("state", cachedState);
  }

  socket.on("disconnect", (reason: string) => {
    clientCount = Math.max(0, clientCount - 1);
    console.log(
      `[LOOP-WS] client disconnected: ${socket.id} reason=${reason} (total=${clientCount})`
    );
  });

  socket.on("error", (err: Error) => {
    console.error(`[LOOP-WS] socket error (${socket.id}):`, err);
  });
}

/**
 * Polls the Next.js status endpoint and broadcasts state changes to connected clients.
 */
async function pollNextJsState(): Promise<void> {
  try {
    const response = await fetch(NEXTJS_STATUS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    
    lastPollAt = new Date().toISOString();
    
    if (!response.ok) {
      nextJsReachable = false;
      console.warn(`[LOOP-WS] /api/autonomous/status returned ${response.status}`);
      return;
    }
    
    nextJsReachable = true;
    const newState = (await response.json()) as AutonomousState;
    const newJson = JSON.stringify(newState);
    
    if (newJson !== cachedStateJson) {
      cachedState = newState;
      cachedStateJson = newJson;
      io.emit("state", newState);
      const summary = `status=${newState?.status} mode=${newState?.config?.mode} totalRuns=${newState?.stats?.totalRuns}`;
      console.log(`[LOOP-WS] state changed -> ${summary}`);
    }
  } catch (err: unknown) {
    nextJsReachable = false;
    if (pollFailureCount % 10 === 0) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.warn(`[LOOP-WS] poll failed (#${pollFailureCount + 1}): ${errorMessage}`);
    }
    pollFailureCount++;
  }
}

/**
 * Gracefully terminates the server and all active socket connections.
 */
function initiateGracefulShutdown(signal: string): void {
  console.log(`[LOOP-WS] ${signal} received, shutting down...`);
  io.close(() => {
    httpServer.close(() => {
      console.log("[LOOP-WS] closed");
      process.exit(0);
    });
  });
}

// --- Initialize Subsystems ----------------------------------------------
configureRequestRouting(httpServer);
io.on("connection", configureSocketHandlers);

// A telemetry relay must stay alive: log unexpected errors loudly but
// never let one bad request kill the process (that is what took this
// service down before the routing fix).
process.on("uncaughtException", (err: Error) => {
  console.error("[LOOP-WS] UNCAUGHT EXCEPTION (service stays up):", err);
});

process.on("unhandledRejection", (err: unknown) => {
  console.error("[LOOP-WS] UNHANDLED REJECTION (service stays up):", err);
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[LOOP-WS] WebSocket service listening on 0.0.0.0:${PORT}`);
  console.log(`[LOOP-WS] /health available at http://localhost:${PORT}/health`);
  console.log(`[LOOP-WS] Polling ${NEXTJS_STATUS_URL} every ${POLL_INTERVAL_MS}ms`);
  
  pollNextJsState().catch(() => {});
  setInterval(() => {
    pollNextJsState().catch(() => {});
  }, POLL_INTERVAL_MS);
});

process.on("SIGTERM", () => initiateGracefulShutdown("SIGTERM"));
process.on("SIGINT", () => initiateGracefulShutdown("SIGINT"));
