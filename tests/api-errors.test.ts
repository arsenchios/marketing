import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/api.ts";

test("network errors explain uncertain outcome; HTTP auth/status remain actionable", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch");
  fetchMock.mock.mockImplementation(async () => {
    throw new TypeError("Load failed");
  });
  await assert.rejects(
    api("/test"),
    (e: any) =>
      e.network === true &&
      /могло уже выполниться/.test(e.message) &&
      !/Load failed/.test(e.message),
  );
  fetchMock.mock.mockImplementation(
    async () => new Response("gateway unavailable", { status: 502 }),
  );
  await assert.rejects(
    api("/test"),
    (e: any) => e.status === 502 && /Сервер временно/.test(e.message),
  );
  fetchMock.mock.mockImplementation(async () =>
    Response.json({ error: "Нет доступа" }, { status: 403 }),
  );
  await assert.rejects(
    api("/test"),
    (e: any) => e.status === 403 && e.message === "Нет доступа",
  );
  const recoveryUrl = "/studio/383fa904-f903-4db7-996c-6e0ed926b2ed";
  fetchMock.mock.mockImplementation(async () =>
    Response.json({ error: "Сервер занят", recoveryUrl }, { status: 409 }),
  );
  await assert.rejects(api("/test"), (e: any) => e.status === 409 && e.recoveryUrl === recoveryUrl);
  for (const unsafe of ["https://example.com", "javascript:alert(1)", "//example.com/studio/test"]) {
    fetchMock.mock.mockImplementation(async () =>
      Response.json({ error: "Сервер занят", recoveryUrl: unsafe }, { status: 409 }),
    );
    await assert.rejects(api("/test"), (e: any) => e.recoveryUrl === undefined);
  }
  fetchMock.mock.mockImplementation(async () =>
    Response.json({ ok: true, state: "stopping" }, { status: 202 }),
  );
  assert.deepEqual(await api("/test"), { ok: true, state: "stopping" });
});
