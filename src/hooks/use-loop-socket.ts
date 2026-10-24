"use client";

import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { usePipelineStore, LoopState } from "@/lib/pipeline-store";

/**
 * Hook that connects to the Loop WebSocket mini-service on port 3003
 * via the Caddy gateway. The gateway requires the URL format:
 *     io("/?XTransformPort=3003")
 * and the path MUST be "/" so Caddy can route to port 3003.
 *
 * On receiving a "state" event, it pushes the new LoopState into the
 * Zustand store so every dashboard component re-renders in real time.
 */
export function useLoopSocket() {
  const setLoopState = usePipelineStore((s) => s.setLoopState);
  const setWsConnected = usePipelineStore((s) => s.setWsConnected);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io("/?XTransformPort=3003", {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setWsConnected(true);
      console.log("[LoopSocket] connected:", socket.id);
    });

    socket.on("disconnect", (reason) => {
      setWsConnected(false);
      console.log("[LoopSocket] disconnected:", reason);
    });

    socket.on("connect_error", (err) => {
      setWsConnected(false);
      console.warn("[LoopSocket] connect_error:", err.message);
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
