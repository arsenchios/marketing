import { test } from "node:test";
import assert from "node:assert/strict";
import { AdaptiveQuality } from "../src/adaptive.ts";
test("Sustained congestion lowers bitrate; short bursts and healthy queues do not", () => {
  const q = new AdaptiveQuality();
  assert.equal(q.sample(2_000_000, 0), false);
  assert.equal(q.sample(0, 2000), false);
  assert.equal(q.sample(2_000_000, 3000), false);
  assert.equal(q.sample(2_000_000, 5999), false);
  assert.equal(q.sample(2_000_000, 6000), true);
  assert.equal(q.bitrate, 1_800_000);
  assert.equal(q.sample(2_000_000, 6500), false);
  assert.equal(q.sample(2_000_000, 9500), true);
  assert.equal(q.bitrate, 900_000);
  assert.equal(q.lower(), false);
  for (let now = 10000; now < 200000; now += 500) q.sample(0, now);
  assert.equal(
    q.bitrate,
    900_000,
    "No oscillation back to higher load during this visit",
  );
});
