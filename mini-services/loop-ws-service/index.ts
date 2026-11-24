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

import { createServer } from "http";
import { Server } from "socket.io";

const PORT = 3003;
const NEXTJS_STATUS_URL = "http://localhost:3000/api/autonomous/status";
const POLL_INTERVAL_MS = 1000;

const httpServer = createServer();
// CORS: the dashboard is served by the Next.js gateway. The old `origin: "*`
// let ANY website open a socket to the live loop-state stream — combined
// with the Caddy SSRF this was a cross-origin state-exfil vector. Restrict
// to the configured origin(s).
//
// `LOOP_WS_ALLOWED_ORIGIN` may be a comma-separated list (e.g.
// "https://app.example.com,https://staging.example.com"). In dev
// (NODE_ENV !== "production") it defaults to the two origins a local
// browser actually uses: the Next.js dev server (:3000) AND the Caddy
// gateway (:81). The browser loads the page from the gateway and sends
// `Origin: http://localhost:81` on the socket handshake — a single-origin
// default of `:3000` rejected that, which is why the dashboard always
// fell back to polling with a `[LoopSocket] WS unavailable` warning.
//
// In production `LOOP_WS_ALLOWED_ORIGIN` MUST be set. Unset + production =
// fail-closed (no origin matches → socket never connects → the polling
// fallback in use-loop-socket.ts keeps the dashboard live). This mirrors
// the F-1 middleware fail-closed policy.
const ALLOWED_ORIGINS = (() => {
  const raw = process.env.LOOP_WS_ALLOWED_ORIGIN?.trim();
  if (raw) {
    const origins = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (origins.length === 0) {
      console.warn("[LOOP-WS] LOOP_WS_ALLOWED_ORIGIN is set but contains no valid origins");
    }
    return origins;
  }
  if (process.env.NODE_ENV === "production") {
    // Fail-closed: no default in production.
    return [];
  }
  // Dev defaults: the two local origins the browser actually uses.
  return ["http://localhost:3000", "http://localhost:81"];
})();
const io = new Server(httpServer, {
  path: "/",
  cors: {
    origin: (origin, cb) => {
      // No Origin header = same-origin / non-browser client (curl, the
      // gateway's health check). Allow — the gateway's own auth (F-1
      // middleware) is the real gate, and socket.io still requires a
      // successful handshake.
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`origin ${origin} not allowed by CORS`), false);
    },
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

let clientCount = 0;
interface CachedState { [key: string]: unknown; }
let cachedState: CachedState | null = null;
let cachedStateJson = "";
let lastPollAt: string | null = null;
let nextJsReachable = false;

// --- Single-owner request routing ---------------------------------------
// socket.io's attach() added its own 'request' listener (and with
// path: "/" it claims every URL). Capture it, remove ALL listeners,
// then install ONE router: /health is answered here and NEVER reaches
// engine.io; every other request is delegated untouched.
const engineListeners = httpServer.listeners("request").slice(0) as
  ((req: import("http").IncomingMessage, res: import("http").ServerResponse) => void)[];
httpServer.removeAllListeners("request");

httpServer.on("request", (req, res) => {
  const url = (req.url ?? "").split("?")[0];
  if (url === "/health" || url === "/health/") {
    const body = JSON.stringify({
      status: "ok",
      port: PORT,
      clients: clientCount,
      lastPollAt,
      nextJsReachable,
      cachedStateReady: cachedState !== null,
      socketIoPath: "/",
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return; // engine.io never sees this request
  }
  for (const listener of engineListeners) {
    listener.call(httpServer, req, res);
  }
});
// -------------------------------------------------------------------------

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
  if (cachedState === null && lastPollAt === null) {
    // Skip initial checks if we haven't established any state yet,
    // allowing the first poll to run without unnecessary logging/checks.
    // The initial poll is handled by the startup logic.
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(NEXTJS_STATUS_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    lastPollAt = new Date().toISOString();
    if (!res.ok) {
      nextJsReachable = false;
      console.warn(`[LOOP-WS] /api/autonomous/status returned ${res.status} ${res.statusText}. Next.js unreachable.`);
      return;
    }
    nextJsReachable = true;
    const newState = await res.json();
    const newJson = JSON.stringify(newState);
    
    // Guard against incomplete/malformed state data before comparison/emission
    if (typeof newState !== 'object' || newState === null) {
        console.error("[LOOP-WS] Received non-object state from Next.js API. Skipping update.");
        return;
    }

    if (newJson !== cachedStateJson) {
      cachedState = newState;
      cachedStateJson = newJson;
      io.emit("state", newState);
      
      // Use optional chaining defensively, though the structure is expected
      const summary = `status=${newState?.status} mode=${newState?.config?.mode} totalRuns=${newState?.stats?.totalRuns}`;
      console.log(`[LOOP-WS] state changed -> ${summary}`);
    }
  } catch (err) {
    nextJsReachable = false;
    const errorMessage = err instanceof Error ? err.message : String(err);
    
    if (err instanceof DOMException && err.name === 'AbortError') {
        console.warn(`[LOOP-WS] Poll request to ${NEXTJS_STATUS_URL} timed out after 3s.`);
    } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
        console.warn(`[LOOP-WS] Network error connecting to ${NEXTJS_STATUS_URL}: ${errorMessage}`);
    } else {
      pollFailureCount++;
      if (pollFailureCount % 10 === 0) {
        console.warn(`[LOOP-WS] Poll failed (#${pollFailureCount}) for ${NEXTJS_STATUS_URL}. Last error: ${errorMessage}`);
      }
    }
  }
}

// A telemetry relay must stay alive: log unexpected errors loudly but
// never let one bad request kill the process (that is what took this
// service down before the routing fix).
process.on("uncaughtException", (err) => {
  console.error("[LOOP-WS] UNCAUGHT EXCEPTION (service stays up):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[LOOP-WS] UNHANDLED REJECTION (service stays up):", err);
});

// SINGLE-OWNER RULE (operator, 2026-11-24 — the triple-ws incident): on
// every cold boot, dev.sh's `bun run dev` wrapper AND the dev server's
// instrumentation spawn BOTH start this service; the port-race loser's
// EADDRINUSE used to be swallowed by the uncaughtException resilience
// above (correct for poll errors, wrong for a server that never bound),
// leaving portless zombies that still polled :3000 forever — observed
// live: THREE ws instances after the 04:15:45 cold boot. A loser now
// exits immediately — the port owner is the one true relay.
httpServer.on("error", (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    console.error(
      `[LOOP-WS] port ${PORT} in use — another instance owns it. Exiting (single-owner rule).`
    );
    process.exit(0);
  }
  console.error("[LOOP-WS] server error (staying up for now):", err);
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[LOOP-WS] WebSocket service listening on 0.0.0.0:${PORT}`);
  console.log(`[LOOP-WS] /health available at http://localhost:${PORT}/health`);
  console.log(`[LOOP-WS] Polling ${NEXTJS_STATUS_URL} every ${POLL_INTERVAL_MS}ms`);
  
  // Run initial poll immediately, then set up the recurring interval.
  // This ensures the first poll runs without waiting for setInterval setup overhead.
  pollNextJsState().catch((err) => {
    console.error("[LOOP-WS] Initial poll failed:", err);
  });

  setInterval(() => {
    pollNextJsState().catch((err) => {
      console.error("[LOOP-WS] Poll interval error:", err);
    });
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