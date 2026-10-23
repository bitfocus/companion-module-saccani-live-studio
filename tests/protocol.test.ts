import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  StudioClient,
  formatTime,
  validPlayback,
  type PlaybackStatus,
  type ReplayStatus,
} from "../src/protocol.ts";
import {
  ChatBrowser,
  validChat,
  type ChatMessage,
  type ChatStatus,
} from "../src/chat.ts";
import type { ProgramRoute } from "../src/program-routing.ts";

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
type Request = {
  id: string;
  action: string;
  tab: number;
  sourceID?: string;
  volume?: number;
  offsetSeconds?: number;
  mode?: string;
  messageID?: string;
  returnRoutingID?: string;
};
const message = (
  id: string,
  author: string,
  text: string,
  highlight: string | null = null,
): ChatMessage => ({ id, author, text, highlight, badges: [] });

async function fixture() {
  const videoID = randomUUID(),
    audioID = randomUUID();
  const status: PlaybackStatus = {
    seenAt: Date.now() / 1000,
    videoControl: true,
    audioControl: true,
    videoJogControl: true,
    playbackTransportControl: true,
    audioVolumeControl: true,
    tabs: [
      {
        id: 4,
        sourceKind: "video",
        filename: "Clip.mp4",
        loaded: true,
        playing: false,
        loading: false,
        replay: false,
        outputActive: true,
        sourceID: videoID,
        position: 0,
        duration: 10,
        frameRate: 25,
        volume: 0,
      },
      {
        id: 7,
        sourceKind: "audio",
        filename: "Audio.wav",
        loaded: true,
        playing: false,
        loading: false,
        replay: false,
        outputActive: false,
        sourceID: audioID,
        position: 0,
        duration: 10,
        frameRate: 0,
        volume: 0.5,
      },
    ],
  };
  const replay: ReplayStatus = {
    seenAt: Date.now() / 1000,
    busy: false,
    configuredReplayControl: true,
    replayStopControl: true,
    replaySourceControl: true,
    replayPlaybackControl: true,
    replayTab: 4,
    outputs: [
      {
        id: 4,
        active: true,
        kind: "display",
        sourceKind: "replay",
        audio: "mac",
        canOpen: true,
      },
    ],
  };
  const chat: Omit<ChatStatus, "seenAt"> = {
    chatControl: true,
    tabs: [
      {
        id: 9,
        connected: true,
        live: true,
        mode: "highlight",
        status: "Live",
        onAir: null,
        messages: [
          message("m1", "Ada", "First", "€5.00"),
          message("m2", "Bob", "Second"),
          message("m3", "Cy", "Third"),
        ],
      },
    ],
  };
  const commands: Request[] = [],
    replays: Request[] = [],
    cancellations: string[] = [];
  let beforeAck: ((request: Request) => Promise<void>) | undefined;
  let badResponse = false,
    acknowledge = true,
    offline = false;
  const operations = new Map<string, Record<string, unknown>>();
  const token = "a".repeat(64);
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end("{}");
      return;
    }
    if (request.url === "/api/v1/status") {
      if (offline) {
        response.writeHead(503);
        response.end(JSON.stringify({ error: { message: "Studio offline" } }));
        return;
      }
      response.end(
        JSON.stringify({
          playback: status,
          replay,
          chat,
          operations: [...operations.values()],
        }),
      );
      return;
    }
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      let state = "completed";
      if (request.url === "/api/v1/replay/start") {
        replays.push(body);
        replay.busy = true;
        state = "running";
      } else if (request.url === "/api/v1/replay/stop") {
        cancellations.push(body.operationId);
        replay.busy = false;
        const original = operations.get(body.operationId);
        if (original) original.state = "cancelled";
      } else if (acknowledge) {
        const parts = request.url!.split("/");
        const command = {
          ...body,
          tab: Number(parts[4]),
          action: parts[5],
        } as Request;
        commands.push(command);
        await beforeAck?.(command);
        const tab = status.tabs.find((item) => item.id === command.tab);
        const chatTab = chat.tabs.find((item) => item.id === command.tab);
        if (command.action === "chat-show")
          chatTab!.onAir =
            chatTab!.messages.find((item) => item.id === command.messageID) ??
            null;
        else if (command.action === "chat-hide") chatTab!.onAir = null;
        else if (command.action === "complete-return-routing")
          tab!.returnRoutingPending = false;
        else if (command.action === "set-volume") tab!.volume = command.volume;
        else if (command.action === "seek")
          tab!.position = tab!.position! + command.offsetSeconds!;
        else tab!.playing = ["play", "restart"].includes(command.action);
      } else state = "running";
      const result = { id: body.id, state };
      operations.set(body.id, result);
      response.writeHead(202);
      response.end(
        JSON.stringify(badResponse ? { ...result, id: randomUUID() } : result),
      );
      return;
    }
    response.end(
      JSON.stringify(operations.get(request.url!.split("/").at(-1)!) ?? {}),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connection = { url: `http://127.0.0.1:${address.port}`, token };
  const client = new StudioClient(connection);
  return {
    connection,
    status,
    replay,
    commands,
    replays,
    cancellations,
    operations,
    chat,
    client,
    videoID,
    audioID,
    set beforeAck(value: typeof beforeAck) {
      beforeAck = value;
    },
    set badResponse(value: boolean) {
      badResponse = value;
    },
    set acknowledge(value: boolean) {
      acknowledge = value;
    },
    set offline(value: boolean) {
      offline = value;
    },
    publish: async () => {
      status.seenAt = replay.seenAt = Date.now() / 1000;
    },
    close: async () => {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("rejects stale/malformed state, duplicate tabs, and unsafe API URLs", async () => {
  const f = await fixture();
  try {
    assert.equal(validPlayback(f.status), true);
    assert.equal(
      validPlayback({ ...f.status, seenAt: Date.now() / 1000 - 4 }),
      false,
    );
    assert.equal(
      validPlayback({
        ...f.status,
        tabs: [f.status.tabs[0], f.status.tabs[0]],
      }),
      false,
    );
    assert.equal(
      validPlayback({
        ...f.status,
        tabs: [{ ...f.status.tabs[0], position: Infinity }],
      }),
      false,
    );
    assert.throws(
      () => new StudioClient({ ...f.connection, url: "relative/path" }),
      /Invalid URL/,
    );
    f.offline = true;
    await assert.rejects(f.client.transport(4, "play"), /offline/);
    assert.equal(f.commands.length, 0);
  } finally {
    await f.close();
  }
});

test("transport acknowledges dynamic tab IDs and blocks missing/busy/replaced sources", async () => {
  const f = await fixture();
  try {
    await f.client.transport(4, "play", f.videoID);
    assert.equal(f.status.tabs[0]!.playing, true);
    await f.client.transport(4, "pause", f.videoID);
    await f.client.transport(4, "restart", f.videoID);
    await f.client.transport(4, "stop", f.videoID);
    assert.deepEqual(
      f.commands.map((request) => request.action),
      ["play", "pause", "restart", "stop"],
    );
    await assert.rejects(f.client.transport(99, "play"), /no longer exists/);
    await assert.rejects(
      f.client.transport(4, "play", randomUUID()),
      /source changed/,
    );
    f.status.tabs[0]!.replay = true;
    await f.publish();
    await assert.rejects(f.client.transport(4, "play"), /busy/);
    assert.equal(f.commands.length, 4);
  } finally {
    await f.close();
  }
});

test("serializes rapid jogs and binds queued operations to the original clip", async () => {
  const f = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 8 }, () => f.client.seek(4, 1, "frames", f.videoID)),
    );
    assert.equal(f.commands.length, 8);
    assert.ok(
      f.commands.every(
        (request) =>
          request.sourceID === f.videoID && request.offsetSeconds === 1 / 25,
      ),
    );
    assert.ok(Math.abs(f.status.tabs[0]!.position! - 8 / 25) < 0.00001);
    await assert.rejects(f.client.seek(7, 1, "frames"), /video tab/);
    f.beforeAck = async () => {
      f.status.tabs[0]!.sourceID = randomUUID();
      await f.publish();
    };
    const first = f.client.seek(4, 1, "seconds", f.videoID),
      queued = f.client.seek(4, 1, "seconds", f.videoID);
    const outcomes = await Promise.allSettled([first, queued]);
    assert.equal(outcomes[0]!.status, "fulfilled");
    assert.equal(outcomes[1]!.status, "rejected");
    assert.equal(f.commands.length, 9);
  } finally {
    await f.close();
  }
});

test("audio volume uses acknowledged state for relative steps and rejects invalid values", async () => {
  const f = await fixture();
  try {
    await f.client.volume(7, 10, false, f.audioID);
    await Promise.all(
      Array.from({ length: 5 }, () => f.client.volume(7, 5, true, f.audioID)),
    );
    assert.ok(Math.abs(f.status.tabs[1]!.volume! - 0.35) < 0.00001);
    await f.client.volume(7, 100, true);
    assert.equal(f.status.tabs[1]!.volume, 1);
    await assert.rejects(f.client.volume(7, -1, false), /between/);
    await assert.rejects(f.client.volume(7, NaN, true), /between/);
    await assert.rejects(f.client.volume(4, 50, false), /audio tab/);
    f.status.audioVolumeControl = false;
    await f.publish();
    await assert.rejects(f.client.volume(7, 50, false), /volume control/);
    assert.equal(f.commands.length, 7);
  } finally {
    await f.close();
  }
});

test("timeouts are not retried and malformed operation responses are rejected", async () => {
  const f = await fixture();
  try {
    f.acknowledge = false;
    await assert.rejects(f.client.transport(4, "play"), /not retried/);
    assert.equal(f.commands.length, 0);
    f.acknowledge = true;
    f.badResponse = true;
    await assert.rejects(
      f.client.transport(4, "play"),
      /Invalid.*operation response/,
    );
    assert.equal(f.commands.length, 1);
  } finally {
    await f.close();
  }
});

test("replay returns after submission, prevents duplicate starts, and cancels only its own ID", async () => {
  const f = await fixture(),
    errors: Error[] = [];
  try {
    const clip = "/remote-only/clip.mp4";
    const first = f.client.startReplay(clip, "configured", 4, (error) =>
      errors.push(error),
    );
    await assert.rejects(
      f.client.startReplay(clip, "configured", 4, () => undefined),
      /pending/,
    );
    await first;
    await wait(100);
    assert.equal(f.replays.length, 1);
    assert.equal(f.replays[0]!.mode, "configured");
    assert.equal(f.replays[0]!.returnRoutingID, undefined);
    assert.equal(f.replay.busy, true);
    await f.client.stopReplay();
    await wait(100);
    assert.equal(f.replay.busy, false);
    assert.deepEqual(f.cancellations, [f.replays[0]!.id]);
    assert.deepEqual(errors, []);
    await assert.rejects(f.client.stopReplay(), /no replay to stop/);
    f.replay.busy = true;
    await f.publish();
    await assert.rejects(
      f.client.startReplay(clip, "configured", 4, () => undefined),
      /busy/,
    );
    assert.equal(f.replays.length, 1);
  } finally {
    await f.close();
  }
});

test("replay targets an exact Replay tab, validates its output and closing cancels only its own playback", async () => {
  const f = await fixture();
  try {
    const clip = "/remote-only/clip.mp4";
    const output = f.replay.outputs![0]!;
    output.audio = "blackmagic";
    await assert.rejects(
      f.client.startReplay(clip, "source", 4, () => undefined),
      /Blackmagic/,
    );
    output.audio = "mac";
    output.active = false;
    output.canOpen = false;
    await assert.rejects(
      f.client.startReplay(clip, "source", 4, () => undefined),
      /Video Output in Replay tab 4/,
    );
    output.canOpen = true;
    output.sourceKind = "video";
    await assert.rejects(
      f.client.startReplay(clip, "source", 4, () => undefined),
      /Replay as its source/,
    );
    output.sourceKind = "replay";
    f.replay.replaySourceControl = false;
    await assert.rejects(
      f.client.startReplay(clip, "source", 4, () => undefined),
      /0\.22\.1/,
    );
    f.replay.replaySourceControl = true;
    await assert.rejects(
      f.client.startReplay(clip, "tab" as "source", 4, () => undefined),
      /Invalid replay settings/,
    );
    assert.equal(f.replays.length, 0);
    await f.client.startReplay(clip, "source", 4, () => undefined);
    assert.equal(f.replays[0]!.mode, "source4");
    await wait(75);
    await f.client.close();
    await wait(100);
    assert.equal(f.replay.busy, false);
    assert.equal(f.cancellations.length, 1);
    await assert.rejects(f.client.transport(4, "play"), /closed/);
  } finally {
    await f.close();
  }
});

function recordingRoute(failBefore = false) {
  const calls: string[] = [];
  const route: ProgramRoute = {
    deferReturn: true,
    prepare: async () => {
      calls.push("prepare");
    },
    before: async () => {
      calls.push("before");
      if (failBefore) throw new Error("ATEM refused the input");
    },
    after: async () => {
      calls.push("after");
    },
    rollback: async () => {
      calls.push("rollback");
    },
  };
  return { calls, route };
}

test("routed replay switches after confirmed start and confirms the return before the app restores output", async () => {
  const f = await fixture(),
    errors: Error[] = [];
  const { calls, route } = recordingRoute();
  try {
    const tab = f.status.tabs[0]!;
    await f.client.startReplay(
      "/remote-only/clip.mp4",
      "source",
      4,
      (error) => errors.push(error),
      route,
    );
    const request = f.replays[0]!;
    assert.match(String(request.returnRoutingID), /^[0-9a-f-]{36}$/i);
    assert.deepEqual(calls, ["prepare"]);
    // Loading is not playback: Program must not change yet.
    Object.assign(tab, { replay: true, loading: true, playing: false });
    await f.publish();
    await wait(250);
    assert.deepEqual(calls, ["prepare"]);
    Object.assign(tab, { loading: false, playing: true });
    await f.publish();
    await wait(250);
    assert.deepEqual(calls, ["prepare", "before"]);
    Object.assign(tab, {
      playing: false,
      returnRoutingPending: true,
      returnRoutingID: request.returnRoutingID,
    });
    await f.publish();
    await wait(250);
    assert.deepEqual(calls, ["prepare", "before", "after"]);
    const ack = f.commands.find(
      (command) => command.action === "complete-return-routing",
    );
    assert.equal(ack?.tab, 4);
    assert.equal(ack?.sourceID, f.videoID);
    assert.equal(ack?.returnRoutingID, request.returnRoutingID);
    f.operations.get(request.id)!.state = "completed";
    Object.assign(tab, { replay: false });
    await f.publish();
    await wait(250);
    assert.deepEqual(calls, ["prepare", "before", "after"]);
    assert.deepEqual(errors, []);
    assert.equal(f.cancellations.length, 0);
  } finally {
    await f.close();
  }
});

test("routed replay rolls back the ATEM and stops when switching fails", async () => {
  const f = await fixture(),
    errors: Error[] = [];
  const { calls, route } = recordingRoute(true);
  try {
    await f.client.startReplay(
      "/remote-only/clip.mp4",
      "source",
      4,
      (error) => errors.push(error),
      route,
    );
    Object.assign(f.status.tabs[0]!, { replay: true, playing: true });
    await f.publish();
    await wait(300);
    assert.deepEqual(calls, ["prepare", "before", "rollback"]);
    assert.match(errors[0]?.message ?? "", /ATEM refused/);
    assert.deepEqual(f.cancellations, [f.replays[0]!.id]);
  } finally {
    await f.close();
  }
});

test("chat state is validated and commands act on fresh messages", async () => {
  const f = await fixture();
  try {
    const now = Date.now() / 1000;
    assert.equal(validChat({ ...f.chat, seenAt: now }, now), true);
    assert.equal(validChat({ ...f.chat, seenAt: now - 10 }, now), false);
    assert.equal(
      validChat({ ...f.chat, seenAt: now, chatControl: false }, now),
      false,
    );
    assert.equal(
      validChat(
        { ...f.chat, seenAt: now, tabs: [f.chat.tabs[0], f.chat.tabs[0]] },
        now,
      ),
      false,
    );
    assert.equal((await f.client.snapshot()).chat?.tabs[0]?.messages.length, 3);
    const tab = f.chat.tabs[0]!;
    const { keyCommand } = await import("../src/chat.ts");
    await f.client.chat(9, (item) => keyCommand(item, "latest"));
    assert.equal(tab.onAir?.id, "m3");
    await f.publish();
    await f.client.chat(9, (item) => keyCommand(item, "latest"));
    assert.equal(tab.onAir, null);
    await f.publish();
    await f.client.chat(9, (item) => keyCommand(item, "highlight"));
    assert.equal(tab.onAir?.id, "m1");
    assert.deepEqual(
      f.commands.map((command) => [command.action, command.messageID]),
      [
        ["chat-show", "m3"],
        ["chat-hide", undefined],
        ["chat-show", "m1"],
      ],
    );
    tab.onAir = null;
    tab.mode = "feed";
    await f.publish();
    await assert.rejects(
      f.client.chat(9, (item) => keyCommand(item)),
      /feed/,
    );
    await assert.rejects(
      f.client.chat(3, (item) => keyCommand(item)),
      /Choose Chat as the source in tab 3/,
    );
    tab.messages = [];
    tab.mode = "highlight";
    await f.publish();
    await assert.rejects(
      f.client.chat(9, (item) => keyCommand(item)),
      /No chat messages yet/,
    );
  } finally {
    await f.close();
  }
});

test("chat browsing follows the newest message until moved and survives deletions", () => {
  const browser = new ChatBrowser();
  const tab = {
    id: 9,
    connected: true,
    live: true,
    mode: "highlight",
    status: "",
    onAir: null as ChatMessage | null,
    messages: [message("a", "A", "1"), message("b", "B", "2")],
  };
  assert.equal(browser.position(tab).message?.id, "b");
  assert.equal(browser.position(tab).following, true);
  browser.move(tab, -5);
  assert.equal(browser.position(tab).message?.id, "a");
  tab.messages.push(message("c", "C", "3"));
  assert.equal(browser.position(tab).message?.id, "a");
  assert.deepEqual(browser.press(tab), {
    action: "chat-show",
    message: tab.messages[0],
  });
  tab.onAir = tab.messages[0]!;
  assert.deepEqual(browser.press(tab), { action: "chat-hide" });
  tab.messages.shift();
  assert.equal(browser.position(tab).message?.id, "c");
  browser.move(tab, -1);
  browser.move(tab, 1);
  assert.equal(browser.position(tab).following, true);
  assert.throws(() => browser.move(tab, 1.5), /Invalid/);
});

test("display counters are clip-relative, clamp invalid values, and support fractional frame rates", () => {
  assert.equal(formatTime(3661.5, 25), "01:01:01:12");
  assert.equal(formatTime(0.99, 29.97), "00:00:00:29");
  assert.equal(formatTime(-20), "00:00:00");
  assert.equal(formatTime(Infinity), "00:00:00");
});
