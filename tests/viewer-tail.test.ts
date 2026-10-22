import { test } from "node:test";
import assert from "node:assert/strict";
import { ViewerTail, VIEWER_TAIL_MS } from "../server/viewerTail.ts";
import { initialEvent, type RoomSnapshot } from "../shared/contracts.ts";
test("Only connected live sessions can finish the same run; deadline cannot be extended", () => {
  const tails = new ViewerTail();
  const data = {
    event: { ...initialEvent, id: "event", state: "live" },
    media: {
      runId: "run",
      playlist: "/api/events/event/media/run/2/stream.m3u8",
      provider: "railway",
    },
    recordings: [],
    messages: [],
    online: 1,
  } as unknown as RoomSnapshot;
  tails.update(data, ["viewer"], 1000);
  assert.equal(tails.get("event", "viewer", 1000), undefined);
  data.event.state = "stopping";
  tails.update(data, ["viewer", "late"], 2000);
  assert.ok(tails.canRead("event", "viewer", "run", "2", 3000));
  assert.equal(tails.get("event", "late", 3000), undefined);
  assert.equal(tails.get("other", "viewer", 3000), undefined);
  assert.equal(tails.canRead("event", "viewer", "old", "2", 3000), false);
  assert.equal(tails.canRead("event", "viewer", "run", "1", 3000), false);
  assert.ok(tails.holds("run", 3000));
  data.event.state = "ended";
  tails.update(data, ["late"], 4000);
  assert.equal(
    tails.get("event", "viewer", 4000)?.until,
    2000 + VIEWER_TAIL_MS,
  );
  assert.equal(tails.get("event", "viewer", 2000 + VIEWER_TAIL_MS), undefined);
  assert.equal(tails.holds("run", 2000 + VIEWER_TAIL_MS), false);
  tails.update(data, ["viewer"], 2000 + VIEWER_TAIL_MS);
  assert.equal(tails.get("event", "viewer", 3000 + VIEWER_TAIL_MS), undefined);
});
