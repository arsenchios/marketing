import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeakerIce } from "../server/speakerIce.ts";

const env = { CLOUDFLARE_TURN_KEY_ID: "test-key", CLOUDFLARE_TURN_API_TOKEN: "test-master-secret" };
const reply = () => Response.json({ iceServers: [
  { urls: ["stun:stun.cloudflare.com:3478"] },
  { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "temporary-user", credential: "temporary-secret" },
], ignoredMasterField: env.CLOUDFLARE_TURN_API_TOKEN }, { status: 201 });

test("Speaker ICE leaves unconfigured/local mode offline and preserves existing static TURN", async () => {
  const fetcher = (async () => { throw Error("Unexpected provider call"); }) as typeof fetch;
  assert.equal((await new SpeakerIce({}, fetcher).get("local")).relayConfigured, false);
  const servers = [{ urls: "turns:turn.example.test:443?transport=tcp", username: "user", credential: "password" }];
  const config = await new SpeakerIce({ SPEAKER_ICE_SERVERS: JSON.stringify(servers) }, fetcher).get("static");
  assert.deepEqual(config, { iceServers: servers, relayConfigured: true });
  assert.deepEqual((await new SpeakerIce({ SPEAKER_ICE_SERVERS: "[]" }, fetcher).get("loopback")).iceServers, []);
});

test("Managed TURN uses expiring per-participant credentials, bounded cache, and single-flight issuance", async () => {
  let requests = 0, now = 0;
  const fetcher = (async (url, init) => {
    requests++;
    assert.equal(url, "https://rtc.live.cloudflare.com/v1/turn/keys/test-key/credentials/generate-ice-servers");
    assert.equal((init!.headers as Record<string, string>).Authorization, `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`);
    assert.deepEqual(JSON.parse(init!.body as string), { ttl: 14400 });
    assert.ok(init!.signal);
    return reply();
  }) as typeof fetch;
  const issuer = new SpeakerIce(env, fetcher, () => now);
  const [first, same] = await Promise.all([issuer.get("event:host"), issuer.get("event:host")]);
  assert.deepEqual(first, same);
  assert.equal(requests, 1);
  assert.equal(first.relayConfigured, true);
  assert.equal(JSON.stringify(first).includes(env.CLOUDFLARE_TURN_API_TOKEN), false);
  assert.equal(JSON.stringify(first).includes("temporary-secret"), true);
  await issuer.get("event:guest");
  assert.equal(requests, 2, "Other participants receive independently issued credentials");
  await issuer.get("event:host");
  assert.equal(requests, 2);
  now = 300001;
  await issuer.get("event:host");
  assert.equal(requests, 3, "Expired cache entries are reissued");
});

test("TURN configuration/provider failures are sanitized and never return partial or forged credentials", async () => {
  for (const bad of [
    { CLOUDFLARE_TURN_KEY_ID: "test-key" },
    { CLOUDFLARE_TURN_API_TOKEN: "test-master-secret" },
    { ...env, CLOUDFLARE_TURN_KEY_ID: "../../bad" },
  ]) {
    await assert.rejects(new SpeakerIce(bad, (async () => { throw Error("must not call"); }) as typeof fetch).get("host"), /Не удалось подготовить видеосвязь/);
  }
  const failures = [
    async () => Response.json({ error: env.CLOUDFLARE_TURN_API_TOKEN }, { status: 401 }),
    async () => { throw Error(`network failure ${env.CLOUDFLARE_TURN_API_TOKEN}`); },
    async () => Response.json({ iceServers: [{ urls: "turns:attacker.test:443", username: "u", credential: "p" }] }),
    async () => Response.json({ iceServers: [{ urls: "turns:turn.cloudflare.com:443?transport=tcp", username: "u", credential: env.CLOUDFLARE_TURN_API_TOKEN }] }),
    async () => Response.json({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] }),
  ];
  for (const fetcher of failures) {
    await assert.rejects(new SpeakerIce(env, fetcher as typeof fetch).get("host"), (e: Error) => {
      assert.match(e.message, /Не удалось подготовить видеосвязь/);
      assert.equal(String(e).includes(env.CLOUDFLARE_TURN_API_TOKEN), false);
      return true;
    });
  }
});
