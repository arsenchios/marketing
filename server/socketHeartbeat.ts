import type { WebSocket } from "ws";

// Room sockets have no application messages when viewers only watch the stream.
// Protocol ping/pong detects lost devices without relying on browser timers.
export class SocketHeartbeat {
  private alive = new WeakSet<WebSocket>();

  attach(ws: WebSocket) {
    this.alive.add(ws);
    ws.on("pong", () => this.alive.add(ws));
  }

  tick(sockets: Iterable<WebSocket>) {
    for (const ws of sockets) {
      if (ws.readyState !== 1 || !this.alive.has(ws)) {
        ws.terminate();
        continue;
      }
      this.alive.delete(ws);
      ws.ping();
    }
  }
}
