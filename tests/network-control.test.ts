import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NetworkControl } from "../src/network-control.ts";
import { networkFixture } from "./helpers/network-fixture.ts";

test("HTTP fallback reads fresh remote state and completes commands without retries", async (t) => {
  const fixture = await networkFixture(),
    client = new NetworkControl(fixture.connection);
  t.after(async () => {
    client.close();
    await fixture.close();
  });
  const snapshot = await client.snapshot();
  assert.ok(
    Math.abs(Number(snapshot.playback?.seenAt) - Date.now() / 1000) < 1,
  );
  const result = await client.command(7, "play", {
    sourceID: fixture.tab.sourceID,
  });
  assert.equal(result.state, "completed");
  assert.equal(result.completionID, "acknowledged");
  assert.equal(fixture.commands.length, 1);
  assert.equal(fixture.tab.playing, true);
  await assert.rejects(client.wait(randomUUID(), 100), /Unknown operation/);
});
test("invalid credentials fail explicitly and commands are never redirected or retried", async (t) => {
  const fixture = await networkFixture(false, 0, true);
  const client = new NetworkControl({
    ...fixture.connection,
    token: "b".repeat(64),
  });
  t.after(async () => {
    client.close();
    await fixture.close();
  });
  await assert.rejects(client.command(7, "toggle"), /Invalid token/);
  assert.equal(fixture.commands.length, 0);
  assert.throws(
    () =>
      new NetworkControl({
        ...fixture.connection,
        url: "http://user:pass@localhost:8765",
      }),
    /base URL/,
  );
  assert.throws(
    () => new NetworkControl({ ...fixture.connection, token: "x" }),
    /access token/,
  );
});
test("replay operation cancellation addresses the original replay and close blocks further work", async (t) => {
  const fixture = await networkFixture(),
    client = new NetworkControl(fixture.connection);
  t.after(async () => {
    client.close();
    await fixture.close();
  });
  const accepted = await client.submit("/api/v1/replay/start", {
    path: "/remote/clip.mp4",
    mode: "configured",
    audio: "mac",
  });
  assert.equal(accepted.state, "running");
  await client.stopReplay(accepted.id);
  assert.equal(fixture.operations.get(accepted.id)?.state, "cancelled");
  await assert.rejects(client.wait(accepted.id), /cancelled/);
  client.close();
  await assert.rejects(client.snapshot(), /closed/);
});

test("Companion uses the remote API for transport, jog and replay paths without local filesystem access", async (t) => {
  const { StudioClient } = await import("../src/protocol.ts");
  const fixture = await networkFixture();
  const client = new StudioClient(fixture.connection);
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  assert.equal(
    (await client.snapshot()).playback?.tabs[0]?.filename,
    "remote.mp4",
  );
  await client.transport(7, "play", fixture.tab.sourceID);
  await client.seek(7, 2, "frames", fixture.tab.sourceID);
  assert.equal(fixture.tab.position, 0.08);
  await assert.rejects(
    client.transport(7, "play", randomUUID()),
    /source changed/,
  );
  const errors: Error[] = [];
  await client.startReplay("/remote-only/clip.mp4", "configured", 7, (error) =>
    errors.push(error),
  );
  await assert.rejects(
    client.startReplay("/remote-only/clip.mp4", "configured", 7, () => {}),
    /already.*pending/,
  );
  await client.stopReplay();
  await client.close();
  assert.equal(
    fixture.commands.filter(
      (command) => command.route === "/api/v1/replay/start",
    ).length,
    1,
  );
  assert.equal(
    fixture.commands.filter(
      (command) => command.route === "/api/v1/replay/stop",
    ).length,
    1,
  );
  assert.deepEqual(errors, []);
});

test("WebSocket snapshots replace HTTP polling and reconnect after a lost event connection", async (t) => {
  const fixture = await networkFixture(true),
    client = new NetworkControl(fixture.connection);
  t.after(async () => {
    client.close();
    await fixture.close();
  });
  await client.snapshot();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const reads = fixture.reads();
  await client.snapshot();
  await client.snapshot();
  assert.equal(
    fixture.reads(),
    reads,
    "Fresh event snapshots should avoid additional HTTP reads",
  );
  fixture.disconnectEvents();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await client.snapshot();
  assert.ok(
    fixture.reads() > reads,
    "Lost events must invalidate cached state",
  );
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await client.snapshot();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const reconnectedReads = fixture.reads();
  await client.snapshot();
  assert.equal(
    fixture.reads(),
    reconnectedReads,
    "Reconnected events should replace HTTP reads again",
  );
});

test("closing Companion during replay admission waits for Start before cancelling its operation", async (t) => {
  const { StudioClient } = await import("../src/protocol.ts");
  const fixture = await networkFixture(false, 100),
    client = new StudioClient(fixture.connection);
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  const errors: Error[] = [];
  const start = client.startReplay(
    "/remote-only/clip.mp4",
    "configured",
    7,
    (error) => errors.push(error),
  );
  for (let i = 0; i < 100 && !fixture.commands.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.commands[0]?.route, "/api/v1/replay/start");
  const id = String(fixture.commands[0]?.id);
  await client.close();
  await start;
  assert.equal(fixture.operations.get(id)?.state, "cancelled");
  assert.equal(
    fixture.commands.filter(
      (command) => command.route === "/api/v1/replay/stop",
    ).length,
    1,
  );
  assert.deepEqual(errors, []);
});

test("no-token HTTP transport, volume and replay omit Authorization completely", async (t) => {
  const fixture = await networkFixture(),
    client = new NetworkControl({ url: fixture.connection.url });
  t.after(async () => {
    client.close();
    await fixture.close();
  });
  await client.snapshot();
  await client.command(7, "play");
  await client.command(7, "set-volume", { volume: 0.4 });
  const replay = await client.submit("/api/v1/replay/start", {
    path: "/remote/clip.mp4",
    mode: "configured",
    audio: "mac",
  });
  await client.stopReplay(replay.id);
  assert.equal(fixture.operations.get(replay.id)?.state, "cancelled");
  assert.ok(fixture.httpAuthorizations.length > 0);
  assert.ok(fixture.httpAuthorizations.every((value) => value === undefined));
  const blank = new NetworkControl({ url: fixture.connection.url, token: "" });
  await blank.snapshot();
  blank.close();
  assert.equal(fixture.httpAuthorizations.at(-1), undefined);
});
test("no-token WebSocket connects with only sls.v1 and receives live snapshots", async (t) => {
  const fixture = await networkFixture(true),
    client = new NetworkControl({ url: fixture.connection.url });
  t.after(async () => {
    client.close();
    await fixture.close();
  });
  await client.snapshot();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const reads = fixture.reads();
  await client.snapshot();
  assert.equal(fixture.reads(), reads);
  assert.deepEqual(fixture.websocketProtocols[0], ["sls.v1"]);
});
test("protected HTTP and WebSocket work with a token and reject anonymous commands", async (t) => {
  const fixture = await networkFixture(true, 0, true);
  const client = new NetworkControl(fixture.connection),
    anonymous = new NetworkControl({ url: fixture.connection.url });
  t.after(async () => {
    client.close();
    anonymous.close();
    await fixture.close();
  });
  await assert.rejects(anonymous.command(7, "play"), /Invalid token/);
  assert.equal(fixture.commands.length, 0);
  await client.command(7, "play");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const reads = fixture.reads();
  await client.snapshot();
  assert.equal(fixture.reads(), reads);
  assert.ok(
    fixture.websocketProtocols.some((protocols) =>
      protocols.includes(`sls.auth.${fixture.connection.token}`),
    ),
  );
});
