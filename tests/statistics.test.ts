import { csvCell } from "../shared/statistics.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStatistics,
  mergeIntervals,
  deviceClass,
  sourceHost,
} from "../server/statistics.ts";
import { measurePlayback } from "../src/watchTelemetry.ts";
import type { StatsRow } from "../shared/statistics.ts";
const base = Date.parse("2026-10-16T10:00:00Z");
function row(
  second: number,
  kind: string,
  data: object = {},
  person = "a",
  tab = "t",
): StatsRow {
  return {
    id: `${person}-${tab}-${second}-${kind}`,
    event_id: "event",
    session_id: "private-session-" + person,
    attendee_id: person,
    name: person,
    kind,
    at: new Date(base + second * 1000).toISOString(),
    data: JSON.stringify({ tabId: tab, ...data }),
  };
}
const events = [
  { id: "event", title: "Webinar", startedAt: new Date(base).toISOString() },
];
test("Statistics merge tabs, count real actions and separate watch from room presence", () => {
  const rows = [
    row(0, "room_entry"),
    row(0, "room_presence"),
    row(0, "room_presence", {}, "a", "second"),
    row(15, "room_presence"),
    row(15, "watch_heartbeat", {
      seconds: 15,
      phase: "live",
      device: "mobile",
    }),
    row(15, "watch_heartbeat", { seconds: 15, phase: "live" }, "a", "second"),
    row(20, "room_exit"),
    row(22, "cta_click"),
    row(23, "chat_sent"),
    row(24, "cta_impression"),
    row(30, "watch_heartbeat", { seconds: 10, phase: "replay" }),
    row(60, "room_entry", {}, "b"),
    row(60, "room_presence", {}, "b"),
  ];
  const r = buildStatistics(
    rows,
    events,
    "event",
    new Date(base).toISOString(),
    base + 120000,
  );
  assert.equal(r.summary.viewers, 2);
  assert.equal(r.summary.watchSeconds, 25);
  assert.equal(r.summary.averageSeconds, 25);
  assert.equal(r.summary.liveSeconds, 15);
  assert.equal(r.summary.replaySeconds, 10);
  assert.equal(r.summary.messages, 1);
  assert.equal(r.summary.clicks, 1);
  assert.equal(r.summary.clickers, 1);
  assert.equal(r.summary.offerViewers, 1);
  assert.equal(r.summary.peak, 1);
  assert.equal(r.people.find((p) => p.name === "a")?.roomSeconds, 20);
  assert.equal(r.devices.mobile, 1);
  assert.equal(JSON.stringify(r).includes("private-session"), false);
  assert.equal(r.timeline[0].minute, 0);
  assert.equal(r.timeline[1].minute, 1);
});
test("Legacy heartbeats do not invent durations; stable intervals reject seek and stall", () => {
  const r = buildStatistics(
    [{ ...row(5, "watch_heartbeat"), data: null }],
    events,
    "event",
    new Date(base).toISOString(),
    base + 120000,
  );
  assert.equal(r.summary.watchSeconds, 0);
  assert.equal(r.detailedSince, null);
  assert.equal(measurePlayback(5, { playing: true, position: 6 }, 1, true), 1);
  assert.equal(measurePlayback(5, { playing: true, position: 50 }, 1, true), 0);
  assert.equal(measurePlayback(5, { playing: true, position: 5 }, 1, true), 0);
  assert.equal(measurePlayback(5, { playing: false, position: 6 }, 1, true), 0);
  assert.equal(measurePlayback(5, { playing: true, position: 6 }, 1, false), 0);
  assert.deepEqual(
    mergeIntervals([
      [0, 10],
      [5, 15],
      [20, 30],
      [25, 28],
    ]),
    [
      [0, 15],
      [20, 30],
    ],
  );
});
test("Devices and referral domains are coarse and strip sensitive query/path data", () => {
  assert.equal(deviceClass("Mozilla iPhone Mobile"), "mobile");
  assert.equal(deviceClass("Android Tablet"), "tablet");
  assert.equal(deviceClass("Macintosh Safari"), "desktop");
  assert.equal(
    sourceHost("https://example.org/private?token=secret"),
    "example.org",
  );
  assert.equal(sourceHost("javascript:alert(1)"), "");
});

test("CSV neutralizes spreadsheet formulas while preserving quotes and text", () => {
  for (const value of ["=1+1", " +SUM(A1)", "@cmd", "\tformula", "\n=1"])
    assert.ok(csvCell(value).startsWith(`"'`));
  assert.equal(csvCell('Имя "Анна"'), '"Имя ""Анна"""');
});
