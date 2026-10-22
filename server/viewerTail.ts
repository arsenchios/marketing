import type {
  MediaStatus,
  Recording,
  RoomSnapshot,
} from "../shared/contracts.ts";
export const VIEWER_TAIL_MS = 5 * 60_000;
type Tail = {
  media: MediaStatus;
  recordings: Recording[];
  sessions: Set<string>;
  until?: number;
};
/** Ephemeral, session-bound access to the final live fragments; never an archive grant. */
export class ViewerTail {
  private rows = new Map<string, Tail>();
  update(data: RoomSnapshot, sessions: string[], now = Date.now()) {
    for (const [id, row] of this.rows)
      if (row.until && row.until <= now) this.rows.delete(id);
    const id = data.event.id,
      old = this.rows.get(id);
    if (["stopping", "ended"].includes(data.event.state)) {
      if (old && !old.until) old.until = now + VIEWER_TAIL_MS;
    } else if (
      ["starting", "live", "reconnecting"].includes(data.event.state) &&
      data.media.runId
    ) {
      if (old?.until && old.media.runId === data.media.runId) return;
      this.rows.set(id, {
        media: structuredClone(data.media),
        recordings: data.recordings.filter((r) => r.id === data.media.runId),
        sessions: new Set(sessions),
      });
    } else this.rows.delete(id);
  }
  get(event: string, session: string, now = Date.now()) {
    const row = this.rows.get(event);
    return row?.until && row.until > now && row.sessions.has(session)
      ? row
      : undefined;
  }
  holds(run: string, now = Date.now()) {
    return [...this.rows.values()].some(
      (row) =>
        row.media.runId === run &&
        !!row.until &&
        row.until > now &&
        row.sessions.size > 0,
    );
  }
  canRead(
    event: string,
    session: string,
    run: string,
    part: string,
    now = Date.now(),
  ) {
    const row = this.get(event, session, now);
    return (
      !!row &&
      row.media.runId === run &&
      !!row.media.playlist?.endsWith(`/${run}/${part}/stream.m3u8`)
    );
  }
}
