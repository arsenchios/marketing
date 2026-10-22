import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { GoogleAuth, encrypt, decrypt } from "../server/auth.ts";
test("Google identities, invitations, state replay and tenant encryption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arslive-auth-")),
    store = await Store.open(dir);
  const key = randomBytes(32).toString("base64");
  const auth = new GoogleAuth(store, "https://live.example.test", {
    clientId: "test",
    clientSecret: "test",
    encryptionKey: key,
    ownerEmail: "owner@example.test",
  });
  try {
    await store.seed(false);
    await auth.initialize();
    await assert.rejects(
      auth.memberForIdentity({
        sub: "intruder",
        email: "unknown@example.test",
        email_verified: true,
      }),
    );
    await assert.rejects(
      auth.memberForIdentity({
        sub: "owner",
        email: "owner@example.test",
        email_verified: false,
      }),
    );
    assert.equal(
      await auth.memberForIdentity({
        sub: "owner",
        email: "owner@example.test",
        email_verified: true,
      }),
      "platform-owner",
    );
    await assert.rejects(
      auth.memberForIdentity({
        sub: "replacement",
        email: "owner@example.test",
        email_verified: true,
      }),
    );
    const invited = await auth.inviteClient("client@example.test", "Client");
    const member = await auth.memberForIdentity({
      sub: "client",
      email: "client@example.test",
      email_verified: true,
    });
    const sid = await store.newSession(member, null, "Client"),
      session = (await store.session(sid))!;
    assert.equal(session.companyId, invited.companyId);
    assert.notEqual(session.companyId, "arslive");
    const flow = await auth.begin("youtube", session),
      state = new URL(flow.url).searchParams.get("state")!;
    await assert.rejects(auth.consume(state, "wrong", "youtube", session));
    assert.ok(
      (await auth.consume(state, flow.browser, "youtube", session)).verifier,
    );
    await assert.rejects(auth.consume(state, flow.browser, "youtube", session));
    const cipher = encrypt("refresh-token", key, invited.companyId);
    assert.equal(decrypt(cipher, key, invited.companyId), "refresh-token");
    assert.throws(() => decrypt(cipher, key, "arslive"));
    assert.equal(await auth.channel("arslive"), undefined);
  } finally {
    await store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
