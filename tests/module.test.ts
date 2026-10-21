import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ModuleSchema } from "../dist/main.js";
import {
  InstanceStatus,
  type CompanionActionDefinitions,
  type CompanionFeedbackDefinitions,
  type CompanionPresetDefinitions,
} from "@companion-module/base";
import type { InstanceContext } from "@companion-module/base/host-api";
import { FakeAtem } from "./helpers/fake-atem.ts";
import { Commands } from "atem-connection";

// The packaging check also runs this host-contract test against the bundled entrypoint.
const { default: StudioInstance } = await import(
  process.env.SACCANI_MODULE_ENTRY || "../dist/main.js"
);

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

test("Companion SDK lifecycle supports HTTP/WebSocket/secrets, keeps stable IDs, and clears stale state", async () => {
  const manifestURL = new URL(
    process.env.SACCANI_MODULE_ENTRY
      ? "../pkg/saccani-live-studio/companion/manifest.json"
      : "../companion/manifest.json",
    import.meta.url,
  );
  const manifest = JSON.parse(await readFile(manifestURL, "utf8"));
  assert.equal(manifest.runtime.permissions?.filesystem, undefined);
  const statuses: InstanceStatus[] = [],
    values: ModuleSchema["variables"] = {};
  let actions: CompanionActionDefinitions<ModuleSchema["actions"]> = {};
  let feedbacks: CompanionFeedbackDefinitions<ModuleSchema["feedbacks"]> = {};
  let presets: CompanionPresetDefinitions<ModuleSchema> = {};
  const context: InstanceContext<ModuleSchema> = {
    _isInstanceContext: true,
    id: "sdk-test",
    label: "studio",
    upgradeScripts: [],
    sharedUdpSocketHandlers: new Map(),
    saveConfig: () => undefined,
    updateStatus: (status) => {
      statuses.push(status);
    },
    oscSend: () => undefined,
    recordAction: () => undefined,
    subscribeActions: () => undefined,
    unsubscribeActions: () => undefined,
    unsubscribeFeedbacks: () => undefined,
    checkFeedbacks: () => undefined,
    checkAllFeedbacks: () => undefined,
    checkFeedbacksById: () => undefined,
    setActionDefinitions: (definitions) => {
      actions = definitions;
    },
    setFeedbackDefinitions: (definitions) => {
      feedbacks = definitions;
    },
    setPresetDefinitions: (_structure, definitions) => {
      presets = definitions;
    },
    setVariableDefinitions: () => undefined,
    setVariableValues: (update) => {
      Object.assign(values, update);
    },
    getVariableValue: (id) => values[id],
    sharedUdpSocketJoin: async () => {
      throw new Error("No UDP allowed in this local module");
    },
    sharedUdpSocketLeave: async () => undefined,
    sharedUdpSocketSend: async () => undefined,
  };
  const atem = new FakeAtem();
  const instance = new StudioInstance(context, () => atem.asAtem());
  const status = {
    seenAt: Date.now() / 1000,
    videoControl: true,
    audioControl: true,
    videoCompletionControl: true,
    videoReturnRoutingControl: true,
    tabs: [
      {
        id: 7,
        sourceKind: "audio",
        filename: "Music.wav",
        loaded: true,
        playing: true,
        loading: false,
        replay: false,
        outputActive: true,
        sourceID: randomUUID(),
        completionID: randomUUID(),
        returnRoutingID: null as string | null,
        returnRoutingPending: false,
        position: 3,
        duration: 10,
        frameRate: 0,
        volume: 0.4,
      },
    ],
  };
  const token = "a".repeat(64),
    commands: Record<string, unknown>[] = [];
  const results = new Map<string, Record<string, unknown>>();
  let offline = false,
    requireToken = false;
  let holdPlay = false,
    pendingPlayID: string | undefined;
  let playAdmitted: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (requireToken && request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end("{}");
      return;
    }
    if (request.url === "/api/v1/status") {
      if (offline) {
        response.writeHead(503);
        response.end("{}");
        return;
      }
      response.end(
        JSON.stringify({
          playback: {
            ...status,
            playbackTransportControl: true,
            seenAt: Date.now() / 1000,
          },
          replay: { busy: false, seenAt: Date.now() / 1000 },
          operations: [],
        }),
      );
      return;
    }
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const command = JSON.parse(Buffer.concat(chunks).toString());
      commands.push({ ...command, route: request.url });
      const action = request.url!.split("/").at(-1);
      if (action === "play" && command.returnRoutingID)
        status.tabs[0]!.returnRoutingID = command.returnRoutingID;
      if (action === "complete-return-routing") {
        assert.equal(command.returnRoutingID, status.tabs[0]!.returnRoutingID);
        assert.equal(
          atem.state.video.mixEffects[0]!.programInput,
          0,
          "Program must return before the app restores its output",
        );
        status.tabs[0]!.returnRoutingPending = false;
        status.tabs[0]!.returnRoutingID = null;
        status.tabs[0]!.loading = false;
        status.tabs[0]!.playing = false;
        status.tabs[0]!.outputActive = false;
        status.tabs[0]!.completionID = randomUUID();
      }
      const held = holdPlay && action === "play";
      if (["play", "restart"].includes(action!) && !held)
        status.tabs[0]!.playing = true;
      if (held) status.tabs[0]!.loading = true;
      if (["pause", "stop"].includes(action!)) status.tabs[0]!.playing = false;
      if (["stop", "restart"].includes(action!))
        status.tabs[0]!.completionID = randomUUID();
      const result = {
        id: command.id,
        state: held ? "running" : "completed",
        completionID: status.tabs[0]!.completionID,
      };
      results.set(command.id, result);
      response.writeHead(202);
      response.end(JSON.stringify(result));
      if (held) {
        pendingPlayID = command.id;
        playAdmitted?.();
      }
      return;
    }
    response.end(
      JSON.stringify(results.get(request.url!.split("/").at(-1)!) ?? {}),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = { url: `http://127.0.0.1:${address.port}`, replayFile: "" };
  try {
    await instance.init(config);
    assert.equal(statuses.at(-1), InstanceStatus.Ok);
    assert.equal(values.tab_7_filename, "Music.wav");
    assert.equal(values.tab_7_volume, 40);
    assert.equal(values.tab_7_progress, 30);
    assert.equal(values.tab_7_remaining, "00:00:07");
    assert.ok(actions.play);
    assert.ok(actions.volume);
    assert.ok(actions.replay_start);
    assert.ok(presets.tab_7_volume);
    assert.equal(
      presets.tab_7_volume.steps[0]!.rotate_left![0]!.actionId,
      "volume",
    );
    const playing = feedbacks.playing;
    assert.ok(playing && playing.type === "boolean");
    assert.equal(
      await playing.callback(
        {
          id: "f",
          controlId: "1/1/1",
          feedbackId: "playing",
          options: { tab: 7 },
        },
        { type: "feedback" },
      ),
      true,
    );
    offline = true;
    await wait(350);
    assert.equal(statuses.at(-1), InstanceStatus.ConnectionFailure);
    assert.equal(values.tab_7_filename, "");
    assert.equal(values.tab_7_playing, false);
    assert.equal(
      await playing.callback(
        {
          id: "f",
          controlId: "1/1/1",
          feedbackId: "playing",
          options: { tab: 7 },
        },
        { type: "feedback" },
      ),
      false,
    );
    await instance.configUpdated({ url: "relative/path", replayFile: "" });
    assert.equal(statuses.at(-1), InstanceStatus.BadConfig);
    offline = false;
    requireToken = true;
    await instance.configUpdated(config);
    assert.equal(statuses.at(-1), InstanceStatus.ConnectionFailure);
    await instance.configUpdated(config, { token });
    assert.equal(statuses.at(-1), InstanceStatus.Ok);
    assert.equal(values.tab_7_filename, "Music.wav");
    const pause = actions.pause;
    assert.ok(pause);
    await pause.callback(
      {
        id: "pause",
        controlId: "1/1/1",
        actionId: "pause",
        options: { tab: 7 },
      },
      { type: "action" },
    );
    assert.equal(commands[0]?.route, "/api/v1/tabs/7/pause");
    assert.equal(commands[0]?.sourceID, status.tabs[0]?.sourceID);
    assert.equal(values.last_error, "");

    // SDK definitions and callbacks also work in the packaged module with an injected switcher.
    assert.ok(
      instance
        .getConfigFields()
        .some((field: { id: string }) => field.id === "atemHost"),
    );
    await instance.configUpdated(
      { ...config, atemHost: "127.0.0.1" },
      { token },
    );
    atem.state.video.mixEffects[0]!.programInput = 0;
    atem.emit("stateChanged", atem.state, []);
    assert.equal(values.atem_online, true);
    assert.equal(values.atem_program_name, "Black");
    assert.equal(values.atem_headphones_available, true);
    assert.equal(values.atem_headphones_volume, -12);
    assert.ok(
      presets.headphones_mute &&
        presets.headphones_dial &&
        presets.headphones_down &&
        presets.headphones_up,
    );
    assert.equal(
      presets.headphones_dial.steps[0]!.rotate_left![0]!.actionId,
      "headphones_volume",
    );
    assert.equal(
      presets.headphones_dial.steps[0]!.down[0]!.actionId,
      "headphones_mute",
    );
    const mute = actions.headphones_mute!,
      headphoneVolume = actions.headphones_volume!;
    offline = true;
    await wait(350);
    assert.equal(values.online, false);
    await mute.callback(
      {
        id: "mute",
        controlId: "1/1/1",
        actionId: "headphones_mute",
        options: { mode: "toggle" },
      },
      { type: "action" },
    );
    await headphoneVolume.callback(
      {
        id: "volume",
        controlId: "1/1/1",
        actionId: "headphones_volume",
        options: { value: -18.5, relative: false },
      },
      { type: "action" },
    );
    assert.equal(values.atem_headphones_volume, -18.5);
    assert.equal(values.atem_headphones_muted, true);
    assert.equal(values.last_error, "");
    assert.equal(values.atem_camera_available, true);
    for (const group of [
      "lens",
      "exposure",
      "whitebalance",
      "color",
      "monitor",
    ] as const) {
      assert.ok(
        actions[`camera_${group}`],
        "Register each camera function group",
      );
    }
    assert.ok(
      presets.camera_1_autofocus_trigger &&
        presets.camera_1_info_1 &&
        presets.camera_1_temperature_dial,
    );
    assert.equal(
      presets.camera_1_temperature_dial.steps[0]!.rotate_right![0]!.actionId,
      "camera_whitebalance",
    );
    atem.emit("receivedCommands", [
      new Commands.CameraControlUpdateCommand(1, 1, 2, {
        type: Commands.CameraControlDataType.SINT16,
        numberData: [5600, 6],
        boolData: [],
        bigintData: [],
        stringData: "",
        periodicFlushEnabled: false,
      }),
    ]);
    assert.equal(values.camera_1_temperature, 5600);
    assert.equal(values.camera_1_tint, 6);
    for (const [actionId, options] of [
      [
        "camera_lens",
        {
          camera: 1,
          parameter: "autofocus",
          operation: "increase",
          value: 1,
          channel: 3,
        },
      ],
      [
        "camera_monitor",
        {
          camera: 1,
          parameter: "info",
          operation: "set",
          value: 1,
          channel: 3,
          display: 8,
        },
      ],
      [
        "camera_whitebalance",
        {
          camera: 1,
          parameter: "temperature",
          operation: "set",
          value: 3200,
          channel: 3,
        },
      ],
    ] as const) {
      await actions[actionId]!.callback(
        { id: actionId, controlId: "1/1/1", actionId, options },
        { type: "action" },
      );
    }
    assert.deepEqual(
      atem.cameraCommands.map((command) => [
        command.category,
        command.parameter,
        command.properties.numberData,
      ]),
      [
        [0, 1, []],
        [3, 0, [1, 8]],
        [1, 2, [3200, 6]],
      ],
    );
    assert.equal(
      values.last_error,
      "",
      "Camera controls also work while the app is offline",
    );
    const muted = feedbacks.headphones_muted!;
    assert.ok(muted.type === "boolean");
    assert.equal(
      await muted.callback(
        {
          id: "f",
          controlId: "1/1/1",
          feedbackId: "headphones_muted",
          options: {},
        },
        { type: "feedback" },
      ),
      true,
    );
    await headphoneVolume.callback(
      {
        id: "invalid",
        controlId: "1/1/1",
        actionId: "headphones_volume",
        options: { value: 20, relative: false },
      },
      { type: "action" },
    );
    assert.match(String(values.last_error), /Invalid headphone volume/);
    await mute.callback(
      {
        id: "unmute",
        controlId: "1/1/1",
        actionId: "headphones_mute",
        options: { mode: "unmute" },
      },
      { type: "action" },
    );
    offline = false;
    await wait(350);
    const play = actions.play!;
    const before = play.options.find((option) => option.id === "studioBefore");
    const after = play.options.find((option) => option.id === "studioAfter");
    assert.ok(before && before.type === "dropdown");
    assert.ok(after && after.type === "dropdown");
    assert.deepEqual(
      before.choices.map((choice) => choice.id),
      ["unchanged", 0, 1, 5],
    );
    assert.deepEqual(
      after.choices.map((choice) => choice.id),
      ["unchanged", "restore-previous", 0, 1, 5],
    );
    const routed = {
      tab: 7,
      studioRouting: true,
      studioBefore: 5,
      studioAfter: "restore-previous",
    } as const;
    const invoke = async (
      actionId: "play" | "pause" | "restart" | "stop",
      options = { tab: 7 } as ModuleSchema["actions"]["play"]["options"],
    ) => {
      await actions[actionId]!.callback(
        { id: actionId, controlId: "1/1/1", actionId, options },
        { type: "action" },
      );
      assert.equal(values.last_error, "");
    };
    holdPlay = true;
    const admitted = new Promise<void>((resolve) => {
      playAdmitted = resolve;
    });
    const starting = invoke("play", routed);
    void starting.catch(() => undefined);
    await admitted;
    // HTTP admission is not playback readiness: hold the native operation during output handoff.
    // The previous five-second command deadline must also cover slow handoff plus preroll.
    await wait(5200);
    assert.deepEqual(atem.changes, []);
    assert.equal(atem.state.video.mixEffects[0]!.programInput, 0);
    assert.equal(values.last_error, "");
    status.tabs[0]!.loading = false;
    status.tabs[0]!.playing = true;
    results.set(pendingPlayID!, {
      id: pendingPlayID,
      state: "completed",
      completionID: status.tabs[0]!.completionID,
    });
    holdPlay = false;
    await starting;
    assert.deepEqual(atem.changes, [5]);
    await invoke("pause");
    await wait(350);
    assert.deepEqual(atem.changes, [5]);
    await invoke("restart");
    await wait(350);
    assert.deepEqual(atem.changes, [5]);
    await invoke("stop");
    assert.deepEqual(atem.changes, [5, 0]);
    await invoke("play", routed);
    status.tabs[0]!.playing = false;
    status.tabs[0]!.completionID = randomUUID();
    await wait(500);
    assert.deepEqual(atem.changes, [5, 0, 5, 0]);
    status.tabs[0]!.sourceKind = "video";
    status.tabs[0]!.sourceID = randomUUID();
    status.tabs[0]!.completionID = randomUUID();
    await wait(350);
    await invoke("play", routed);
    status.tabs[0]!.playing = false;
    status.tabs[0]!.loading = true;
    status.tabs[0]!.returnRoutingPending = true;
    status.tabs[0]!.outputActive = true;
    await wait(500);
    assert.deepEqual(atem.changes, [5, 0, 5, 0, 5, 0]);
    assert.equal(
      commands.at(-1)?.route,
      "/api/v1/tabs/7/complete-return-routing",
    );
    await invoke("play", routed);
    await instance.configUpdated(config, { token });
    assert.deepEqual(atem.changes, [5, 0, 5, 0, 5, 0, 5, 0]);
    assert.equal(atem.destroyed, true);
    assert.equal(values.atem_online, false);
    assert.equal(values.atem_headphones_available, false);
    assert.equal(values.atem_headphones_volume, "");
    assert.equal(values.atem_headphones_muted, false);
    assert.equal(values.atem_camera_available,false);
    assert.equal(values.camera_1_temperature,"");
    assert.equal(values.camera_1_tint,"");
  } finally {
    await instance.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
