import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audienceScenario,
  scriptedAudience,
  audienceTrend,
  scriptedGreetings,
  defaultAudienceTest,
} from "../shared/audience.ts";
import {
  initialEvent,
  audienceTestSchema,
  type Webinar,
  type Recording,
} from "../shared/contracts.ts";

const w = {
  ...initialEvent,
  id: "test",
  state: "live",
  audienceTest: { ...defaultAudienceTest, enabled: true },
} as Webinar;
const run = {
  state: "recording",
  createdAt: "2026-10-16T10:00:00Z",
} as Recording;

test("Test audience grows, peaks and declines from a shared broadcast clock", () => {
  assert.equal(scriptedAudience(0), 0);
  assert.equal(audienceTrend(420), 200);
  assert.equal(audienceTrend(900), 400);
  assert.ok(Math.abs(scriptedAudience(900) - 400) <= 8);
  let rises = 0,
    falls = 0;
  for (let second = 900; second < 960; second += 3) {
    const delta = scriptedAudience(second + 3) - scriptedAudience(second);
    if (delta > 0) rises++;
    if (delta < 0) falls++;
    assert.ok(Math.abs(scriptedAudience(second) - audienceTrend(second)) <= 8);
  }
  assert.ok(rises > 0 && falls > 0);
  for (const bad of [NaN, Infinity, -Infinity, -100])
    assert.equal(scriptedAudience(bad), 0);
});

test("Scenario is opt-in and runs only with an actual recording lifecycle", () => {
  const now = Date.parse("2026-10-16T10:10:00Z");
  assert.deepEqual(audienceScenario(w, [run], now), {
    elapsedSeconds: 600,
    startedAt: run.createdAt,
    settings: w.audienceTest,
  });
  assert.deepEqual(
    audienceScenario({ ...w, state: "reconnecting" }, [run], now),
    { elapsedSeconds: 600, startedAt: run.createdAt, settings: w.audienceTest },
  );
  assert.equal(
    audienceScenario({ ...w, audienceTest: defaultAudienceTest }, [run], now),
    undefined,
  );
  for (const state of ["draft", "ended", "failed", "stopping"] as const)
    assert.equal(audienceScenario({ ...w, state }, [run], now), undefined);
  assert.equal(audienceScenario(w, [], now), undefined);
  assert.equal(
    audienceScenario(w, [{ ...run, state: "ready" }], now),
    undefined,
  );
  assert.equal(
    audienceScenario(w, [{ ...run, createdAt: "bad" }], now),
    undefined,
  );
});

test("Custom curve validation and independent greeting schedule", () => {
  assert.equal(
    audienceTestSchema.safeParse({ ...defaultAudienceTest, peak: 10 }).success,
    false,
  );
  assert.equal(
    audienceTestSchema.safeParse({ ...defaultAudienceTest, peakMinutes: 5 })
      .success,
    false,
  );
  assert.equal(
    audienceTestSchema.safeParse({ ...defaultAudienceTest, peak: 10001 })
      .success,
    false,
  );
  const custom = {
    ...defaultAudienceTest,
    rampTarget: 30,
    rampMinutes: 1,
    peak: 100,
    peakMinutes: 3,
  };
  assert.equal(audienceTrend(60, custom), 30);
  assert.equal(audienceTrend(180, custom), 100);
  assert.equal(scriptedGreetings("a", run.createdAt, 8).length, 0);
  assert.equal(scriptedGreetings("a", run.createdAt, 9).length, 1);
  assert.equal(scriptedGreetings("a", run.createdAt, 180).length, 20);
  const rows = scriptedGreetings("a", run.createdAt, 1000);
  assert.equal(new Set(rows.map((r) => r.id)).size, 20);
  assert.deepEqual(rows, scriptedGreetings("a", run.createdAt, 1000));
  assert.equal(
    audienceScenario(
      {
        ...w,
        audienceTest: { ...defaultAudienceTest, greetingsEnabled: true },
      },
      [run],
    )?.settings.enabled,
    false,
  );
});
