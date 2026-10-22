export type AnalyticsDetail = {
  tabId?: string;
  seconds?: number;
  position?: number;
  device?: "mobile" | "tablet" | "desktop" | "unknown";
  timezone?: string;
  source?: string;
  phase?: "waiting" | "live" | "replay";
};
export type StatsRow = {
  id: string;
  event_id: string;
  session_id: string;
  kind: string;
  at: string;
  attendee_id: string | null;
  name: string;
  data?: string | null;
};
export type StatsEvent = {
  id: string;
  title: string;
  startedAt: string | null;
};
export type StatsTimeline = {
  label: string;
  minute: number | null;
  present: number;
  watching: number;
  entries: number;
  exits: number;
  messages: number;
  clicks: number;
};
export type StatsPerson = {
  key: string;
  eventId: string;
  name: string;
  firstAt: string;
  lastAt: string;
  watchSeconds: number;
  roomSeconds: number;
  messages: number;
  clicks: number;
  device: string;
  timezone: string;
  source: string;
  lastPosition: number | null;
};
export type StatsReport = {
  selectedRunId?: string | null;
  runs?: { id: string; createdAt: string; stoppedAt?: string }[];
  generatedAt: string;
  since: string;
  truncated: boolean;
  detailedSince: string | null;
  events: StatsEvent[];
  selectedId: string | null;
  summary: {
    viewers: number;
    played: number;
    peak: number;
    watchSeconds: number;
    averageSeconds: number;
    messages: number;
    clicks: number;
    clickers: number;
    offerViewers: number;
    buffering: number;
    errors: number;
    liveSeconds: number;
    replaySeconds: number;
  };
  timeline: StatsTimeline[];
  people: StatsPerson[];
  devices: Record<string, number>;
  timezones: Record<string, number>;
  sources: Record<string, number>;
  webinars: {
    id: string;
    title: string;
    viewers: number;
    watchSeconds: number;
    messages: number;
    clicks: number;
  }[];
};

export function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^\s*[=+\-@]|^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
