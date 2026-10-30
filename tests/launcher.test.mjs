import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { checkNode, ensureRunning, probeService } from "../scripts/launch.mjs";

test("launcher checks runtime and reuses healthy service without installing or starting twice", async () => {
  assert.throws(() => checkNode("22.15.0"), /Node.js 24/);
  checkNode("24.1.0");
  const result = await ensureRunning({
    probe: async () => ({ state: "ready", version: "test" }),
    prepare: () => assert.fail(),
    start: () => assert.fail(),
  });
  assert.equal(result.started, false);
});
test("launcher rejects occupied ports and reports child failure", async () => {
  await assert.rejects(
    ensureRunning({
      probe: async () => ({ state: "occupied" }),
      prepare: () => assert.fail(),
      start: () => assert.fail(),
    }),
    /占用/,
  );
  let prepared = false;
  await assert.rejects(
    ensureRunning({
      probe: async () => ({ state: "stopped" }),
      prepare: async () => {
        prepared = true;
      },
      start: async () => ({ exitCode: 1 }),
    }),
    /service.log/,
  );
  assert.ok(prepared);
});
test("launcher waits for readiness after starting", async () => {
  let checks = 0,
    starts = 0;
  const result = await ensureRunning({
    probe: async () => ({ state: ++checks < 3 ? "stopped" : "ready" }),
    prepare: async () => {},
    start: async () => {
      starts++;
      return { exitCode: null };
    },
    wait: async () => {},
  });
  assert.equal(starts, 1);
  assert.equal(result.started, true);
});
test("health probe distinguishes Frame from an unrelated HTTP service and a closed port", async () => {
  let frame = false;
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        ...(frame ? { service: "frame-agent", version: "test" } : {}),
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    assert.equal((await probeService(port)).state, "occupied");
    frame = true;
    assert.equal((await probeService(port)).state, "ready");
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal((await probeService(port)).state, "stopped");
});
