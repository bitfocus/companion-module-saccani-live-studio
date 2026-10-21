import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PlaybackRouting } from "../src/playback-routing.ts";
import {
  createProgramRoute,
  hasProgramRouting,
  RESTORE_PREVIOUS_INPUT,
} from "../src/program-routing.ts";
import type { PlaybackStatus, StudioClient } from "../src/protocol.ts";
import { FakeAtem } from "./helpers/fake-atem.ts";

const options = {
  studioRouting: true,
  studioBefore: 5,
  studioAfter: RESTORE_PREVIOUS_INPUT,
} as const;
function fixture(sourceKind = "video") {
  const fake = new FakeAtem();
  const status: PlaybackStatus = {
    seenAt: Date.now() / 1000,
    videoControl: true,
    audioControl: true,
    videoJogControl: true,
    videoCompletionControl: true,
    videoReturnRoutingControl: true,
    playbackTransportControl: true,
    tabs: [
      {
        id: 7,
        sourceKind,
        filename: "Media",
        loaded: true,
        playing: false,
        loading: false,
        replay: false,
        outputActive: false,
        sourceID: randomUUID(),
        completionID: randomUUID(),
      },
    ],
  };
  const commands: string[] = [];
  let failPlay = false,
    failStop = false;
  const client: Pick<StudioClient, "snapshot" | "transport"> = {
    snapshot: async () => {
      status.seenAt += 0.01;
      return { playback: status };
    },
    transport: async (_id, command, sourceID, returnRoutingID) => {
      const tab = status.tabs[0]!;
      assert.equal(sourceID, tab.sourceID);
      commands.push(command);
      if (command === "play" && returnRoutingID)
        tab.returnRoutingID = returnRoutingID.toUpperCase();
      if (
        (command === "play" && failPlay) ||
        (["stop", "complete-return-routing"].includes(command) && failStop)
      )
        throw new Error("App command failed");
      tab.playing = command === "play" || command === "restart";
      if (["stop", "complete-return-routing", "restart"].includes(command))
        tab.completionID = randomUUID();
      if (command === "complete-return-routing") {
        tab.returnRoutingPending = false;
        tab.returnRoutingID = null;
        tab.loading = false;
      }
      return {
        id: randomUUID(),
        state: "completed",
        completionID: tab.completionID,
      };
    },
  };
  const manager = new PlaybackRouting((settings) =>
    hasProgramRouting(settings)
      ? createProgramRoute(fake.asAtem(), settings, async (work) => work())
      : undefined,
  );
  async function observe() {
    status.seenAt += 0.01;
    await manager.observe(status, (error) => {
      throw error;
    });
  }
  return {
    manager,
    fake,
    status,
    client,
    commands,
    observe,
    failPlay: () => {
      failPlay = true;
    },
    failStop: () => {
      failStop = true;
    },
  };
}
test("video and audio restore the captured source at EOF; Pause, Resume and Restart retain the original route", async () => {
  for (const kind of ["video", "audio"]) {
    const f = fixture(kind),
      tab = f.status.tabs[0]!;
    await f.manager.transport(f.client, 7, "play", options);
    assert.deepEqual(f.fake.changes, [5]);
    await f.manager.transport(f.client, 7, "pause", {});
    await f.observe();
    assert.deepEqual(f.fake.changes, [5]);
    await f.manager.transport(f.client, 7, "play", {
      ...options,
      studioAfter: 0,
    });
    await f.manager.transport(f.client, 7, "restart", {
      ...options,
      studioAfter: 0,
    });
    await f.observe();
    assert.deepEqual(f.fake.changes, [5]);
    f.fake.state.video.mixEffects[0]!.programInput = 0;
    tab.playing = false;
    tab.completionID = randomUUID();
    await f.observe();
    await f.observe();
    assert.deepEqual(f.fake.changes, [5, 1]);
  }
});
test("Stop from a separate action uses the starting route, including Black and after-only routing", async () => {
  const f = fixture();
  f.fake.state.video.mixEffects[0]!.programInput = 0;
  await f.manager.transport(f.client, 7, "toggle", {
    ...options,
    studioBefore: "unchanged",
  });
  f.fake.state.video.mixEffects[0]!.programInput = 5;
  await f.manager.transport(f.client, 7, "stop", {});
  await f.observe();
  assert.deepEqual(f.commands, ["play", "complete-return-routing"]);
  assert.deepEqual(f.fake.changes, [0]);
});
test("failed Play leaves Program unchanged; failed Stop retains the route until the app actually finishes", async () => {
  const f = fixture();
  f.failPlay();
  await assert.rejects(
    f.manager.transport(f.client, 7, "play", options),
    /command failed/,
  );
  assert.deepEqual(f.fake.changes, []);
  const g = fixture();
  await g.manager.transport(g.client, 7, "play", options);
  g.failStop();
  await assert.rejects(
    g.manager.transport(g.client, 7, "stop", {}),
    /command failed/,
  );
  await g.observe();
  assert.deepEqual(g.fake.changes, [5, 1]);
  g.status.tabs[0]!.completionID = randomUUID();
  await g.observe();
  assert.deepEqual(g.fake.changes, [5, 1]);
});
test("loops retain the input; completion, replacement, removed tab, offline app and shutdown restore once", async () => {
  for (const event of [
    "completion",
    "replacement",
    "removed",
    "offline",
    "shutdown",
  ]) {
    const f = fixture();
    await f.manager.transport(f.client, 7, "play", options);
    await f.observe();
    assert.deepEqual(f.fake.changes, [5]);
    if (event === "completion") f.status.tabs[0]!.completionID = randomUUID();
    if (event === "replacement") f.status.tabs[0]!.sourceID = randomUUID();
    if (event === "removed") f.status.tabs = [];
    if (event === "offline")
      await f.manager.observe(undefined, (error) => {
        throw error;
      });
    else if (event === "shutdown")
      await f.manager.close((error) => {
        throw error;
      });
    else await f.observe();
    await f.observe();
    assert.deepEqual(f.fake.changes, [5, 1]);
  }
});
test("failed ending routing reports once; disabled routing and external Stop never depend on the ATEM", async () => {
  const f = fixture(),
    errors: string[] = [];
  await f.manager.transport(f.client, 7, "play", options);
  f.fake.failChanges = true;
  f.status.tabs[0]!.completionID = randomUUID();
  f.status.seenAt += 1;
  await f.manager.observe(f.status, (error) => {
    errors.push(String(error));
  });
  await f.manager.observe(f.status, (error) => {
    errors.push(String(error));
  });
  assert.equal(errors.length, 1);
  const g = fixture();
  g.fake.failChanges = true;
  await g.manager.transport(g.client, 7, "play", {});
  await g.manager.transport(g.client, 7, "stop", {});
  assert.deepEqual(g.fake.changes, []);
  assert.deepEqual(g.commands, ["play", "stop"]);
});
test("busy, changed or already-playing sources reject new routing without switching Program", async () => {
  const f = fixture();
  f.status.tabs[0]!.loading = true;
  await assert.rejects(
    f.manager.transport(f.client, 7, "play", options),
    /busy/,
  );
  f.status.tabs[0]!.loading = false;
  await assert.rejects(
    f.manager.transport(f.client, 7, "play", options, randomUUID()),
    /source changed/,
  );
  f.status.tabs[0]!.playing = true;
  await assert.rejects(
    f.manager.transport(f.client, 7, "play", options),
    /already active/,
  );
  assert.deepEqual(f.fake.changes, []);
  assert.deepEqual(f.commands, []);
});

test("Program waits for completed Play, and Restore Previous captures before output handoff", async () => {
  const f = fixture();
  let acknowledge!: () => void, admitted!: () => void;
  const gate = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const transport = f.client.transport;
  f.client.transport = async (...args) => {
    if (args[1] === "play") {
      admitted();
      await gate;
    }
    return transport(...args);
  };
  const play = f.manager.transport(f.client, 7, "play", options);
  await pending;
  assert.deepEqual(f.fake.changes, []);
  f.fake.state.video.mixEffects[0]!.programInput = 0;
  acknowledge();
  await play;
  assert.deepEqual(f.fake.changes, [5]);
  await f.manager.transport(f.client, 7, "stop", {});
  assert.deepEqual(f.fake.changes, [5, 1]);
});

test("closing during pending Play never switches the video on Program", async () => {
  const f = fixture();
  let acknowledge!: () => void, admitted!: () => void;
  const gate = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const transport = f.client.transport;
  f.client.transport = async (...args) => {
    if (args[1] === "play") {
      admitted();
      await gate;
    }
    return transport(...args);
  };
  const play = f.manager.transport(f.client, 7, "play", options);
  await pending;
  const rejected = assert.rejects(play, /connection closed/);
  const close = f.manager.close(() => assert.fail("Unexpected routing error"));
  acknowledge();
  await Promise.all([rejected, close]);
  assert.deepEqual(f.fake.changes, []);
  assert.deepEqual(f.commands, ["play", "complete-return-routing"]);
});

test("a partially applied starting switch restores Program before stopping the video", async () => {
  const f = fixture(),
    order: string[] = [];
  const change = f.fake.changeProgramInput.bind(f.fake);
  f.fake.changeProgramInput = async (input) => {
    order.push(`program-${input}`);
    await change(input);
    if (input === 5) throw new Error("Switch acknowledgement lost");
  };
  const transport = f.client.transport;
  f.client.transport = async (...args) => {
    order.push(args[1]);
    return transport(...args);
  };
  await assert.rejects(
    f.manager.transport(f.client, 7, "play", options),
    /acknowledgement lost/,
  );
  assert.deepEqual(order, [
    "play",
    "program-5",
    "program-1",
    "complete-return-routing",
  ]);
});

test("Stop, EOF and app Stop wait for final Program confirmation before releasing the video output", async () => {
  for (const ending of ["stop", "eof", "app-stop"]) {
    const f = fixture(),
      tab = f.status.tabs[0]!;
    await f.manager.transport(f.client, 7, "play", options);
    tab.outputActive = true;
    if (ending !== "stop") {
      tab.playing = false;
      tab.loading = true;
      tab.returnRoutingPending = true;
    }
    const originalCompletion = tab.completionID;
    let confirm!: () => void, changing!: () => void;
    const gate = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      changing = resolve;
    });
    const change = f.fake.changeProgramInput.bind(f.fake);
    f.fake.changeProgramInput = async (input) => {
      if (input === 1) {
        changing();
        await gate;
      }
      await change(input);
    };
    const transport = f.client.transport;
    f.client.transport = async (...args) => {
      if (args[1] === "complete-return-routing") {
        assert.equal(f.fake.state.video.mixEffects[0]!.programInput, 1);
        assert.equal(tab.outputActive, true);
        tab.outputActive = false;
      }
      return transport(...args);
    };
    const finishing =
      ending === "stop"
        ? f.manager.transport(f.client, 7, "stop", {})
        : f.observe();
    await pending;
    assert.deepEqual(f.commands, ["play"]);
    assert.equal(tab.outputActive, true);
    assert.equal(tab.completionID, originalCompletion);
    confirm();
    await finishing;
    assert.deepEqual(f.commands, ["play", "complete-return-routing"]);
    assert.deepEqual(f.fake.changes, [5, 1]);
    await f.observe();
    assert.deepEqual(f.fake.changes, [5, 1]);
  }
});

test("failed final Program selection leaves playback active for a retried Stop", async () => {
  const f = fixture();
  await f.manager.transport(f.client, 7, "play", options);
  f.fake.failChanges = true;
  await assert.rejects(
    f.manager.transport(f.client, 7, "stop", {}),
    /ATEM offline/,
  );
  assert.deepEqual(f.commands, ["play"]);
  assert.equal(f.status.tabs[0]!.playing, true);
  f.fake.failChanges = false;
  await f.manager.transport(f.client, 7, "stop", {});
  assert.deepEqual(f.commands, ["play", "complete-return-routing"]);
});
