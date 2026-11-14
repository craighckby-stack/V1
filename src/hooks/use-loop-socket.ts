"use client";

import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { usePipelineStore, LoopState } from "@/lib/pipeline-store";

/** Cap on reconnection attempts (audit H5). `Infinity` meant an endless
 *  retry + console spam storm whenever the WS service was down — the
 *  dashboard kept logging `connect_error` forever instead of settling
 *  into the polling fallback. 20 attempts at ~1s backoff ≈ 20s of trying,
 *  then socket.io gives up and the status polling in page.tsx takes over.
 *  socket.io auto-reconnects on the next page load. */
const MAX_RECONNECT_ATTEMPTS = 20;

/** One-shot latch so the connect_error warning doesn't repeat. */
let warnedOnce = false;

export function useLoopSocket() {
  const setLoopState = usePipelineStore((s) => s.setLoopState);
  const setWsConnected = usePipelineStore((s) => s.setWsConnected);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io("/?XTransformPort=3003", {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setWsConnected(true);
      if (process.env.NODE_ENV !== "production") {
        console.log("[LoopSocket] connected:", socket.id);
      }
    });

    socket.on("disconnect", (reason) => {
      setWsConnected(false);
      if (process.env.NODE_ENV !== "production") {
        console.log("[LoopSocket] disconnected:", reason);
      }
    });

    socket.on("connect_error", (err) => {
      setWsConnected(false);
      // Warn ONCE per dead-service episode instead of every attempt —
      // the polling fallback keeps the dashboard live, and the operator
      // doesn't need 20 identical warnings in the browser console.
      if (process.env.NODE_ENV !== "production" && !warnedOnce) {
        warnedOnce = true;
        console.warn("[LoopSocket] WS unavailable — falling back to status polling:", err.message);
      }
    });

    socket.on("state", (state: LoopState) => {
      setLoopState(state);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [setLoopState, setWsConnected]);
}

/** Poll /api/autonomous/status as a fallback when the WS service is unavailable. */
export async function fetchLoopState(): Promise<LoopState | null> {
  try {
    const res = await fetch("/api/autonomous/status");
    if (!res.ok) return null;
    return (await res.json()) as LoopState;
  } catch {
    return null;
  }
}
