import { createHash } from "node:crypto";
import type {
  AnalyticsDetail,
  StatsEvent,
  StatsPerson,
  StatsReport,
  StatsRow,
  StatsTimeline,
} from "../shared/statistics.ts";
type Interval = [number, number];
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const [a, b] of intervals
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else result.push([a, b]);
  }
  return result;
}
const duration = (rows: Interval[]) =>
  rows.reduce((sum, [a, b]) => sum + (b - a) / 1000, 0);
export function deviceClass(ua: string) {
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobile|iPhone|iPod/i.test(ua)) return "mobile";
  return ua ? "desktop" : "unknown";
}
export function sourceHost(value?: string) {
  try {
    const u = new URL(value || "");
    return /^https?:$/.test(u.protocol) ? u.hostname.slice(0, 150) : "";
  } catch {
    return "";
  }
}
export function buildStatistics(
  rows: StatsRow[],
  events: StatsEvent[],
  selectedId: string | null,
  since: string,
  now = Date.now(),
  truncated = false,
): StatsReport {
  const people = new Map<string, StatsPerson>();
  const watch = new Map<string, Interval[]>(),
    presence = new Map<string, Interval[]>();
  const live = new Map<string, Interval[]>(),
    replay = new Map<string, Interval[]>();
  const tabs = new Map<
    string,
    { person: string; points: number[]; exits: number[] }
  >();
  const played = new Set<string>(),
    clickers = new Set<string>(),
    offers = new Set<string>();
  const buckets = new Map<
    number,
    StatsTimeline & { audience: Set<string>; players: Set<string> }
  >();
  const origin = selectedId
    ? Date.parse(
        events.find((e) => e.id === selectedId)?.startedAt ||
          rows[0]?.at ||
          new Date(now).toISOString(),
      )
    : 0;
  const width = selectedId ? 60000 : 86400000;
  const bucket = (at: number) => {
    const index = Math.floor((at - origin) / width);
    if (!buckets.has(index))
      buckets.set(index, {
        label: selectedId
          ? `${index} мин`
          : new Date(index * width).toISOString().slice(0, 10),
        minute: selectedId ? index : null,
        present: 0,
        watching: 0,
        entries: 0,
        exits: 0,
        messages: 0,
        clicks: 0,
        audience: new Set(),
        players: new Set(),
      });
    return buckets.get(index)!;
  };
  let buffering = 0,
    errors = 0,
    detailedSince: string | null = null;
  for (const r of rows) {
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || at > now) continue;
    const key = r.event_id + ":" + (r.attendee_id || r.session_id);
    let d: AnalyticsDetail = {};
    try {
      d = JSON.parse(r.data || "{}");
    } catch {}
    if (r.data && (!detailedSince || r.at < detailedSince))
      detailedSince = r.at;
    if (!people.has(key))
      people.set(key, {
        key: createHash("sha256").update(key).digest("hex").slice(0, 16),
        eventId: r.event_id,
        name: r.name || "Зритель",
        firstAt: r.at,
        lastAt: r.at,
        watchSeconds: 0,
        roomSeconds: 0,
        messages: 0,
        clicks: 0,
        device: "unknown",
        timezone: "",
        source: "",
        lastPosition: null,
      });
    const p = people.get(key)!;
    p.firstAt = p.firstAt < r.at ? p.firstAt : r.at;
    p.lastAt = p.lastAt > r.at ? p.lastAt : r.at;
    if (d.device && d.device !== "unknown") p.device = d.device;
    if (d.timezone) p.timezone = d.timezone;
    if (d.source && !p.source) p.source = d.source;
    if (Number.isFinite(d.position)) p.lastPosition = d.position!;
    if (r.kind === "play" || r.kind === "watch_heartbeat") played.add(key);
    if (r.kind === "chat_sent") {
      p.messages++;
      bucket(at).messages++;
    }
    if (r.kind === "cta_click") {
      p.clicks++;
      clickers.add(key);
      bucket(at).clicks++;
    }
    if (r.kind === "cta_impression") offers.add(key);
    if (r.kind === "buffering") buffering++;
    if (r.kind === "play_error") errors++;
    if (r.kind === "room_entry") bucket(at).entries++;
    if (
      r.kind === "watch_heartbeat" &&
      typeof d.seconds === "number" &&
      d.seconds > 0
    ) {
      const interval: Interval = [
        Math.max(Date.parse(since), at - Math.min(15, d.seconds) * 1000),
        at,
      ];
      for (const target of [
        watch,
        ...(d.phase === "live" ? [live] : d.phase === "replay" ? [replay] : []),
      ]) {
        if (!target.has(key)) target.set(key, []);
        target.get(key)!.push(interval);
      }
    }
    if (d.tabId && (r.kind === "room_presence" || r.kind === "room_exit")) {
      const tab = key + ":" + r.session_id + ":" + d.tabId;
      if (!tabs.has(tab)) tabs.set(tab, { person: key, points: [], exits: [] });
      tabs.get(tab)![r.kind === "room_exit" ? "exits" : "points"].push(at);
    }
  }
  for (const { person, points, exits } of tabs.values()) {
    points.sort((a, b) => a - b);
    exits.sort((a, b) => a - b);
    const pieces: Interval[] = [];
    for (const point of points)
      pieces.push([
        point,
        Math.min(point + 20000, exits.find((e) => e >= point) ?? Infinity, now),
      ]);
    const visits = mergeIntervals(pieces);
    for (const [a, b] of visits) {
      bucket(a).entries++;
      if (b < now) bucket(b).exits++;
    }
    if (!presence.has(person)) presence.set(person, []);
    presence.get(person)!.push(...visits);
  }
  // New presence samples replace legacy room_entry counts to avoid counting the first visit twice.
  const presencePeople = new Set([...tabs.values()].map((t) => t.person));
  for (const r of rows)
    if (
      r.kind === "room_entry" &&
      presencePeople.has(r.event_id + ":" + (r.attendee_id || r.session_id))
    )
      bucket(Date.parse(r.at)).entries--;
  const marks: [number, number][] = [];
  for (const [key, p] of people) {
    const roomIntervals = mergeIntervals(presence.get(key) || []),
      watchIntervals = mergeIntervals(watch.get(key) || []);
    p.watchSeconds = duration(watchIntervals);
    p.roomSeconds = duration(roomIntervals);
    for (const [intervals, kind] of [
      [roomIntervals, "audience"],
      [watchIntervals, "players"],
    ] as const) {
      for (const [a, b] of intervals) {
        if (kind === "audience") marks.push([a, 1], [b, -1]);
        // Reporting is bounded by time range and row limit; cap spans defensively.
        for (
          let i = Math.floor((a - origin) / width);
          i <= Math.floor((b - 1 - origin) / width) &&
          i <= Math.floor((a - origin) / width) + 1440;
          i++
        )
          bucket(origin + i * width)[kind].add(key);
      }
    }
  }
  let peak = 0,
    current = 0;
  for (const [, delta] of marks.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    current += delta;
    peak = Math.max(peak, current);
  }
  if (buckets.size) {
    const keys = [...buckets.keys()];
    const first = Math.min(...keys),
      last = Math.max(...keys);
    if (last - first <= 1440)
      for (let i = first; i <= last; i++) bucket(origin + i * width);
  }
  const list = [...people.values()];
  const counts = (field: "device" | "timezone" | "source") => {
    const out: Record<string, number> = {};
    for (const p of list) {
      const key = p[field] || "unknown";
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  };
  const total = list.reduce((n, p) => n + p.watchSeconds, 0);
  return {
    generatedAt: new Date(now).toISOString(),
    since,
    truncated,
    detailedSince,
    events,
    selectedId,
    summary: {
      viewers: list.length,
      played: played.size,
      peak,
      watchSeconds: total,
      averageSeconds: watch.size ? total / watch.size : 0,
      messages: list.reduce((n, p) => n + p.messages, 0),
      clicks: list.reduce((n, p) => n + p.clicks, 0),
      clickers: clickers.size,
      offerViewers: offers.size,
      buffering,
      errors,
      liveSeconds: [...live.values()].reduce(
        (n, v) => n + duration(mergeIntervals(v)),
        0,
      ),
      replaySeconds: [...replay.values()].reduce(
        (n, v) => n + duration(mergeIntervals(v)),
        0,
      ),
    },
    timeline: [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => ({
        label: b.label,
        minute: b.minute,
        present: b.audience.size,
        watching: b.players.size,
        entries: Math.max(0, b.entries),
        exits: b.exits,
        messages: b.messages,
        clicks: b.clicks,
      })),
    people: list.sort((a, b) => b.firstAt.localeCompare(a.firstAt)),
    devices: counts("device"),
    timezones: counts("timezone"),
    sources: counts("source"),
    webinars: events.map((e) => {
      const ps = list.filter((p) => p.eventId === e.id);
      return {
        id: e.id,
        title: e.title,
        viewers: ps.length,
        watchSeconds: ps.reduce((n, p) => n + p.watchSeconds, 0),
        messages: ps.reduce((n, p) => n + p.messages, 0),
        clicks: ps.reduce((n, p) => n + p.clicks, 0),
      };
    }),
  };
}
