import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";

type Seat = {
  ws: WebSocket;
  session: string;
  tab: string;
  role: "primary" | "guest";
  event: string;
  alive: boolean;
};
const signal = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("description"),
    pair: z.string().uuid(),
    description: z.object({
      type: z.enum(["offer", "answer"]),
      sdp: z.string().max(60000),
    }),
  }),
  z.object({
    type: z.literal("candidate"),
    pair: z.string().uuid(),
    candidate: z.object({
      candidate: z.string().max(4096),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().int().nullable().optional(),
      usernameFragment: z.string().nullable().optional(),
    }),
  }),
  z.object({type:z.literal("diagnostic"), pair:z.string().uuid(), stage:z.enum(["ice","connection"]), state:z.enum(["new","checking","connecting","connected","completed","disconnected","failed","closed"])}),
  z.object({ type: z.literal("network-summary"), pair: z.string().uuid(), values: z.object({
    host: z.number().int().min(0).max(1000),
    public: z.number().int().min(0).max(1000),
    relay: z.number().int().min(0).max(1000),
    received: z.number().int().min(0).max(1000),
    iceError: z.number().int().min(0).max(999),
    relayConfigured: z.number().int().min(0).max(1),
  }).strict() }),
  z.object({ type: z.literal("unavailable"), pair: z.string().uuid() }),
  z.object({ type: z.literal("route"), pair: z.string().uuid(), relay: z.boolean() }),
  z.object({ type: z.literal("restart"), pair: z.string().uuid() }),
  z.object({ type: z.literal("camera"), pair: z.string().uuid(), enabled: z.boolean() }),
]);
// Signaling only: the existing media sender remains the sole broadcast encoder.
export class SpeakerRooms {
  rooms = new Map<string, { primary?: Seat; guest?: Seat; pair?: string }>();
  constructor(private authorize: (seat: Seat) => Promise<boolean>, private diagnostic: (event:string, kind:string, values?:Record<string,number>) => void = () => {}) {}
  send(seat: Seat | undefined, message: unknown) {
    if (!seat || seat.ws.readyState !== WebSocket.OPEN) return;
    if (seat.ws.bufferedAmount > 128 * 1024) {
      seat.ws.close(4008, "Slow signaling");
      return;
    }
    seat.ws.send(JSON.stringify(message));
  }
  primary(event: string) {
    return this.rooms.get(event)?.primary;
  }
  guest(event: string) {
    const seat = this.rooms.get(event)?.guest;
    return seat?.ws.readyState === WebSocket.OPEN ? seat : undefined;
  }
  guestSession(event: string, session: string) {
    return this.rooms.get(event)?.guest?.session === session;
  }
  attach(
    ws: WebSocket,
    event: string,
    session: string,
    tab: string,
    role: Seat["role"],
  ) {
    const room = this.rooms.get(event) || {};
    if (
      room[role] ||
      (role === "guest" ? room.primary : room.guest)?.session === session
    ) {
      ws.close(4009, "Speaker seat occupied");
      return;
    }
    const seat: Seat = { ws, event, session, tab, role, alive: true };
    room[role] = seat;
    this.rooms.set(event, room);
    const pair = () => {
      room.pair = randomUUID();
      for (const s of [room.primary, room.guest])
        this.send(s, { type: "paired", pair: room.pair });
    };
    this.send(seat, { type: "waiting" });
    if (room.primary && room.guest) pair();
    let count = 0,
      since = Date.now();
    let queue = Promise.resolve();
    ws.on("message", (data, binary) => {
      if (Date.now() - since > 10000) {
        since = Date.now();
        count = 0;
      }
      if (
        binary ||
        Buffer.byteLength(data.toString()) > 65536 ||
        ++count > 150
      ) {
        ws.close(4008, "Signaling limit");
        return;
      }
      queue = queue
        .then(async () => {
          if (room[role] !== seat || ws.readyState !== WebSocket.OPEN) return;
          if (!(await this.authorize(seat))) {
            ws.close(4003, "Access revoked");
            return;
          }
          const message = signal.parse(JSON.parse(data.toString()));
          if (message.pair !== room.pair) return;
          if (message.type === "diagnostic") {
            this.diagnostic(event, `speaker_${role}_${message.stage}_${message.state}`);
            return;
          }
          if (message.type === "network-summary") {
            this.diagnostic(event, `speaker_${role}_network`, message.values);
            return;
          }
          if (message.type === "route") {
            this.diagnostic(event, `speaker_${role}_route`, { relay: Number(message.relay) });
            return;
          }
          const other = role === "primary" ? room.guest : room.primary;
          if (!other || !(await this.authorize(other))) return;
          if (message.type === "unavailable") {
            this.send(room.primary, message);
            this.send(room.guest, message);
            delete room.pair;
            return;
          }
          if (message.type === "restart") {
            pair();
            return;
          }
          if (
            message.type === "description" &&
            message.description.type !==
              (role === "primary" ? "offer" : "answer")
          )
            throw Error();
          this.send(other, message);
        })
        .catch(() => ws.close(4003, "Invalid signal"));
    });
    ws.on("pong", () => {
      seat.alive = true;
    });
    ws.on("close", () => {
      if (room[role] !== seat) return;
      delete room[role];
      delete room.pair;
      this.send(role === "primary" ? room.guest : room.primary, {
        type: "waiting",
      });
      if (!room.primary && !room.guest) this.rooms.delete(event);
    });
  }
  revoke(sessions: Set<string>) {
    for (const room of this.rooms.values())
      for (const s of [room.primary, room.guest])
        if (s && sessions.has(s.session)) s.ws.close(4003, "Access revoked");
  }
  async tick() {
    for (const room of this.rooms.values())
      for (const s of [room.primary, room.guest]) {
        if (!s) continue;
        if (!s.alive) {
          s.ws.terminate();
          continue;
        }
        if (!(await this.authorize(s))) {
          s.ws.close(4003, "Access revoked");
          continue;
        }
        s.alive = false;
        s.ws.ping();
      }
  }
}
