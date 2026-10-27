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
  const instance = new StudioInstance(context);
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
            videoJogControl: true,
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

    // The module controls only the app: no ATEM settings, actions or routing options.
    assert.deepEqual(
      instance.getConfigFields().map((field: { id: string }) => field.id),
      ["help", "url", "token", "replayFile"],
    );
    assert.ok(
      Object.keys(actions).every((id) => !/^(camera_|headphones_)/.test(id)),
    );
    assert.deepEqual(
      actions.play!.options.map((option) => option.id),
      ["tab"],
    );
    assert.deepEqual(
      actions.replay_start!.options.map((option) => option.id),
      ["path", "mode", "tab"],
    );
    assert.ok(Object.keys(values).every((id) => !id.startsWith("atem_")));
    const invoke = async (
      actionId: "play" | "pause" | "restart" | "stop" | "toggle" | "play_pause",
    ) => {
      await actions[actionId]!.callback(
        { id: actionId, controlId: "1/1/1", actionId, options: { tab: 7 } },
        { type: "action" },
      );
      assert.equal(values.last_error, "");
    };
    holdPlay = true;
    const admitted = new Promise<void>((resolve) => {
      playAdmitted = resolve;
    });
    const starting = invoke("play");
    void starting.catch(() => undefined);
    await admitted;
    // HTTP admission is not playback readiness: the command deadline covers output handoff plus preroll.
    await wait(5200);
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
    await wait(350);
    for (const action of ["restart", "stop", "toggle"] as const) {
      await invoke(action);
      await wait(350);
    }
    status.tabs[0]!.sourceKind = "video";
    status.tabs[0]!.sourceID = randomUUID();
    await wait(350);
    await invoke("play_pause");
    assert.deepEqual(
      commands.slice(1).map((command) => command.route),
      [
        "/api/v1/tabs/7/play",
        "/api/v1/tabs/7/restart",
        "/api/v1/tabs/7/stop",
        "/api/v1/tabs/7/toggle",
        "/api/v1/tabs/7/play-pause",
      ],
    );
    assert.ok(commands.every((command) => !("returnRoutingID" in command)));
  } finally {
    await instance.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Companion chat actions, dial preview, feedbacks and presets follow the app's chat tab", async () => {
  const values: ModuleSchema["variables"] = {};
  let actions: CompanionActionDefinitions<ModuleSchema["actions"]> = {};
  let feedbacks: CompanionFeedbackDefinitions<ModuleSchema["feedbacks"]> = {};
  let presets: CompanionPresetDefinitions<ModuleSchema> = {};
  const context: InstanceContext<ModuleSchema> = {
    _isInstanceContext: true,
    id: "chat-test",
    label: "studio",
    upgradeScripts: [],
    sharedUdpSocketHandlers: new Map(),
    saveConfig: () => undefined,
    updateStatus: () => undefined,
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
  const message = (
    id: string,
    author: string,
    highlight: string | null = null,
  ) => ({
    id,
    author,
    text: `Hello from ${author}`,
    highlight,
    badges: [],
  });
  const chat = {
    chatControl: true,
    tabs: [
      {
        id: 3,
        connected: true,
        live: true,
        mode: "highlight",
        status: "Live chat",
        onAir: null as ReturnType<typeof message> | null,
        messages: [message("a", "Ada", "€2.00"), message("b", "Bob")],
      },
    ],
  };
  const commands: Record<string, unknown>[] = [];
  const results = new Map<string, Record<string, unknown>>();
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/v1/status") {
      response.end(
        JSON.stringify({
          playback: { seenAt: 1, videoControl: true, tabs: [] },
          replay: { busy: false, seenAt: 1 },
          chat: { ...chat, seenAt: 1 },
          operations: [],
        }),
      );
      return;
    }
    if (request.method !== "POST") {
      const id = request.url!.split("/").at(-1);
      response.writeHead(id && results.has(id) ? 200 : 404);
      response.end(JSON.stringify(results.get(id!) ?? {}));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const action = request.url!.split("/").at(-1);
    commands.push({ ...body, action });
    results.set(body.id, { id: body.id, state: "completed" });
    const tab = chat.tabs[0]!;
    tab.onAir =
      action === "chat-show"
        ? (tab.messages.find((item) => item.id === body.messageID) ?? null)
        : null;
    response.writeHead(202);
    response.end(JSON.stringify({ id: body.id, state: "completed" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const instance = new StudioInstance(context);
  const run = async (
    actionId: "chat_toggle" | "chat_hide" | "chat_browse" | "chat_preview",
    options: Record<string, unknown>,
  ) => {
    await (actions[actionId]!.callback as (...args: unknown[]) => unknown)(
      { id: actionId, controlId: "1/1/1", actionId, options },
      { type: "action" },
    );
    await wait(300);
  };
  const feedback = (
    feedbackId: "chat_on_air" | "chat_preview_on_air" | "chat_ready",
  ) =>
    (feedbacks[feedbackId]!.callback as (...args: unknown[]) => unknown)(
      { id: "f", controlId: "1/1/1", feedbackId, options: { tab: 3 } },
      { type: "feedback" },
    );
  try {
    await instance.init({
      url: `http://127.0.0.1:${address.port}`,
      replayFile: "",
    });
    await wait(300);
    assert.equal(values.chat_3_preview_author, "Bob");
    assert.equal(values.chat_3_preview_position, "2 / 2");
    assert.equal(values.chat_3_latest_highlight_author, "Ada");
    assert.equal(await feedback("chat_ready"), true);
    assert.ok(presets.chat_3_dial);
    assert.ok(presets.chat_3_latest);
    await run("chat_browse", { tab: 3, steps: -1 });
    assert.equal(values.chat_3_preview_author, "Ada");
    await run("chat_preview", { tab: 3 });
    assert.deepEqual(commands.at(-1), {
      ...commands.at(-1),
      action: "chat-show",
      messageID: "a",
    });
    assert.equal(values.chat_3_on_air_author, "Ada");
    assert.equal(await feedback("chat_preview_on_air"), true);
    await run("chat_preview", { tab: 3 });
    assert.equal(commands.at(-1)?.action, "chat-hide");
    assert.equal(await feedback("chat_on_air"), false);
    await run("chat_toggle", { tab: 3, pick: "latest" });
    assert.equal(commands.at(-1)?.messageID, "b");
    await run("chat_hide", { tab: 3 });
    assert.equal(commands.at(-1)?.action, "chat-hide");
    assert.equal(values.last_error, "");
    await run("chat_toggle", { tab: 8, pick: "latest" });
    assert.match(String(values.last_error), /tab 8/);
  } finally {
    await instance.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Companion Status rows show the app's colors, blink on alert and clear the alerts", async () => {
  const values: ModuleSchema["variables"] = {};
  let actions: CompanionActionDefinitions<ModuleSchema["actions"]> = {};
  let feedbacks: CompanionFeedbackDefinitions<ModuleSchema["feedbacks"]> = {};
  let presets: CompanionPresetDefinitions<ModuleSchema> = {};
  const context: InstanceContext<ModuleSchema> = {
    _isInstanceContext: true,
    id: "status-test",
    label: "studio",
    upgradeScripts: [],
    sharedUdpSocketHandlers: new Map(),
    saveConfig: () => undefined,
    updateStatus: () => undefined,
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
  const row = (id: string, label: string, value: string, alert = false) => ({
    id,
    label,
    value,
    text: `${label}  ${value}`,
    alert,
    acknowledged: false,
    blink: true,
    alertForeground: "#FFFFFF",
    alertBackground: "#D70015",
  });
  const statusBoard = {
    statusControl: true,
    tabs: [
      {
        id: 5,
        alert: true,
        foreground: "#3CF06E",
        background: "#000000",
        rows: [
          row("a", "ATEM", "CONNECTED"),
          row("m", "MIC 1", "NO AUDIO 6s", true),
        ],
      },
    ],
  };
  const commands: Record<string, unknown>[] = [];
  const results = new Map<string, Record<string, unknown>>();
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/v1/status") {
      response.end(
        JSON.stringify({
          playback: { seenAt: 1, videoControl: true, tabs: [] },
          replay: { busy: false, seenAt: 1 },
          statusBoard: { ...statusBoard, seenAt: 1 },
          operations: [],
        }),
      );
      return;
    }
    if (request.method !== "POST") {
      const id = request.url!.split("/").at(-1);
      response.writeHead(id && results.has(id) ? 200 : 404);
      response.end(JSON.stringify(results.get(id!) ?? {}));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    commands.push({ ...body, url: request.url });
    results.set(body.id, { id: body.id, state: "completed" });
    for (const item of statusBoard.tabs[0]!.rows)
      if (item.alert) item.acknowledged = true;
    response.writeHead(202);
    response.end(JSON.stringify({ id: body.id, state: "completed" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const instance = new StudioInstance(context);
  const feedback = (
    feedbackId: "status_row" | "status_alert",
    options: Record<string, unknown>,
  ) =>
    (feedbacks[feedbackId]!.callback as (...args: unknown[]) => unknown)(
      { id: "f", controlId: "1/1/1", feedbackId, options },
      { type: "feedback" },
    );
  try {
    await instance.init({
      url: `http://127.0.0.1:${address.port}`,
      replayFile: "",
    });
    await wait(300);
    assert.equal(values.status_5_row_2, "MIC 1  NO AUDIO 6s");
    assert.equal(values.status_5_alerts, 1);
    assert.ok(presets.status_5_row_0);
    assert.ok(presets.status_5_row_2);
    assert.deepEqual(await feedback("status_row", { tab: 5, row: 1 }), {
      text: "ATEM\nCONNECTED",
      color: 0x3cf06e,
      bgcolor: 0x000000,
    });
    const colors = new Set<number>();
    for (let i = 0; i < 4; i++) {
      colors.add(
        (
          (await feedback("status_row", { tab: 5, row: 2 })) as {
            bgcolor: number;
          }
        ).bgcolor,
      );
      await wait(130);
    }
    assert.deepEqual(
      [...colors].sort(),
      [0x000000, 0xd70015],
      "an uncleared alert blinks",
    );
    assert.equal(
      ((await feedback("status_row", { tab: 5, row: 0 })) as { text: string })
        .text,
      "ALERT\nMIC 1  NO AUDIO 6s",
    );
    assert.equal(await feedback("status_alert", { tab: 5, row: 0 }), true);
    await (
      actions.status_acknowledge!.callback as (...args: unknown[]) => unknown
    )(
      {
        id: "a",
        controlId: "1/1/1",
        actionId: "status_acknowledge",
        options: { tab: 5 },
      },
      { type: "action" },
    );
    await wait(300);
    assert.equal(commands.at(-1)?.url, "/api/v1/status-board/acknowledge");
    assert.equal(commands.at(-1)?.tab, 5);
    assert.equal(await feedback("status_alert", { tab: 5, row: 2 }), false);
    assert.deepEqual(await feedback("status_row", { tab: 5, row: 2 }), {
      text: "MIC 1\nNO AUDIO 6s",
      color: 0xffffff,
      bgcolor: 0xd70015,
    });
    assert.equal(values.status_5_alerts, 0);
    await (
      actions.status_acknowledge!.callback as (...args: unknown[]) => unknown
    )(
      {
        id: "b",
        controlId: "1/1/1",
        actionId: "status_acknowledge",
        options: { tab: 8 },
      },
      { type: "action" },
    );
    assert.match(String(values.last_error), /tab 8/);
  } finally {
    await instance.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("upgrade moves saved output-tab replays to Replay tabs and leaves other actions alone", async () => {
  const { UpgradeScripts } = await import(
    process.env.SACCANI_MODULE_ENTRY || "../dist/main.js"
  );
  const action = (
    options: Record<string, unknown>,
    actionId = "replay_start",
  ) => ({
    id: randomUUID(),
    controlId: "1/1/1",
    actionId,
    options: Object.fromEntries(
      Object.entries(options).map(([key, value]) => [
        key,
        { value, isExpression: false },
      ]),
    ),
  });
  const actions = [
    action({ mode: "tab", tab: 4, audio: "blackmagic", fullFrame: true }),
    action({ mode: "configured", tab: 1 }),
    action({ mode: "tab" }, "play"),
  ];
  const result = UpgradeScripts[0](
    { currentConfig: {} },
    { config: null, secrets: null, actions, feedbacks: [] },
  );
  assert.equal(result.updatedActions.length, 1);
  assert.deepEqual(result.updatedActions[0].options, {
    mode: { value: "source", isExpression: false },
    tab: { value: 4, isExpression: false },
  });
});
