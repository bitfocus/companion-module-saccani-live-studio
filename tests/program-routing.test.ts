import assert from "node:assert/strict";
import test from "node:test";
import { Atem } from "atem-connection";
import {
  ATEMProgramConnection,
  RESTORE_PREVIOUS_INPUT,
  changeProgram,
  createProgramRoute,
  hasProgramRouting,
  programInputs,
  validateProgramRouting,
} from "../src/program-routing.ts";
import { FakeAtem } from "./helpers/fake-atem.ts";

test("Program fields list only M/E 1 sources; routing is optional and Restore Previous is after-only", () => {
  const fake = new FakeAtem();
  assert.deepEqual(
    programInputs(fake.asAtem()).map((input) => input.id),
    [0, 1, 5],
  );
  assert.equal(hasProgramRouting({}), false);
  assert.equal(
    hasProgramRouting({
      studioRouting: false,
      studioAfter: RESTORE_PREVIOUS_INPUT,
    }),
    false,
  );
  assert.equal(
    hasProgramRouting({
      studioRouting: true,
      studioBefore: "unchanged",
      studioAfter: "unchanged",
    }),
    false,
  );
  assert.equal(
    hasProgramRouting({
      studioRouting: true,
      studioAfter: RESTORE_PREVIOUS_INPUT,
    }),
    true,
  );
  assert.doesNotThrow(() =>
    validateProgramRouting(fake.asAtem(), {
      studioAfter: RESTORE_PREVIOUS_INPUT,
    }),
  );
  for (const options of [
    { studioBefore: 9 },
    { studioAfter: 99 },
    { studioBefore: RESTORE_PREVIOUS_INPUT },
  ])
    assert.throws(
      () => validateProgramRouting(fake.asAtem(), options as never),
      /unavailable/,
    );
});
test("restoration remembers Program before the starting switch, including Black and after-only routing", async () => {
  for (const original of [0, 1])
    for (const before of [undefined, 5]) {
      const fake = new FakeAtem();
      fake.state.video.mixEffects[0]!.programInput = original;
      const route = createProgramRoute(
        fake.asAtem(),
        { studioBefore: before, studioAfter: RESTORE_PREVIOUS_INPUT },
        async (work) => work(),
      );
      await route.prepare();
      await route.before();
      fake.state.video.mixEffects[0]!.programInput = 5;
      await route.after();
      assert.deepEqual(
        fake.changes,
        before === undefined ? [original] : [5, original],
      );
    }
});
test("queued capture uses the actual starting source; failed startup rolls back; removed sources are not guessed", async () => {
  const fake = new FakeAtem();
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const route = createProgramRoute(
    fake.asAtem(),
    { studioBefore: 5, studioAfter: RESTORE_PREVIOUS_INPUT },
    async (work) => {
      await gate;
      await work();
    },
  );
  const starting = route.prepare();
  fake.state.video.mixEffects[0]!.programInput = 0;
  ready();
  await starting;
  assert.deepEqual(fake.changes, []);
  await route.before();
  await route.rollback();
  assert.deepEqual(fake.changes, [5, 0]);
  delete fake.state.inputs[0];
  await assert.rejects(route.after(), /unavailable/);
  assert.deepEqual(fake.changes, [5, 0]);
  const unknown = createProgramRoute(
    fake.asAtem(),
    { studioAfter: RESTORE_PREVIOUS_INPUT },
    async (work) => work(),
  );
  await assert.rejects(unknown.after(), /No previous/);
});
test("ATEM connection remains optional, validates host, exposes named inputs and closes its transport", async () => {
  const fake = new FakeAtem(),
    errors: unknown[] = [];
  let creations = 0;
  const connection = new ATEMProgramConnection(
    () => {},
    (error) => errors.push(error),
    () => {
      creations++;
      return fake.asAtem();
    },
  );
  await connection.configure("");
  assert.equal(creations, 0);
  assert.equal(connection.route({}), undefined);
  assert.throws(
    () =>
      connection.route({
        studioRouting: true,
        studioAfter: RESTORE_PREVIOUS_INPUT,
      }),
    /offline/,
  );
  await assert.rejects(connection.configure("999.1.1.1"), /valid ATEM IPv4/);
  await connection.configure("127.0.0.1");
  assert.equal(creations, 1);
  assert.equal(connection.online, true);
  const route = connection.route({
    studioRouting: true,
    studioBefore: 5,
    studioAfter: RESTORE_PREVIOUS_INPUT,
  })!;
  await route.prepare();
  await route.before();
  await route.after();
  assert.deepEqual(fake.changes, [5, 1]);
  await connection.close();
  assert.equal(fake.destroyed, true);
  assert.equal(connection.online, false);
  assert.deepEqual(connection.inputs, []);
  assert.deepEqual(errors, []);
});
test("unconfirmed Program changes reject and the packaged single-process UDP backend starts without hardware", async () => {
  const fake = new FakeAtem();
  fake.changeProgramInput = async () => {};
  await assert.rejects(changeProgram(fake.asAtem(), 5, 10), /did not confirm/);
  const atem = new Atem({ disableMultithreaded: true }),
    errors: unknown[] = [];
  atem.on("error", (error) => errors.push(error));
  try {
    await atem.connect("127.0.0.1", 19910);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    await atem.destroy();
  }
  assert.deepEqual(errors, []);
});

test("headphone commands share the ATEM queue, accumulate rapid relative changes and stop on reconfiguration", async () => {
  const fake = new FakeAtem();
  const connection = new ATEMProgramConnection(
    () => {},
    () => {},
    () => fake.asAtem(),
  );
  await connection.configure("127.0.0.1");
  await Promise.all(
    Array.from({ length: 10 }, () => connection.headphoneVolume(1, true)),
  );
  assert.equal(connection.headphones!.volumeDb, -2);
  await Promise.all([
    connection.headphoneMute("toggle"),
    connection.headphoneMute("toggle"),
  ]);
  assert.equal(connection.headphones!.muted, false);
  const queued = connection.headphoneVolume(1, true);
  const closing = connection.configure("");
  await assert.rejects(queued, /connection changed|offline/);
  await closing;
  assert.equal(connection.headphones, undefined);
  assert.equal(fake.headphoneChanges.length, 12);
  await assert.rejects(connection.headphoneMute("mute"), /offline/);
});
