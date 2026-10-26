import {
  NetworkControl,
  type APIConnection,
  type APIOperation,
} from "./network-control.ts";
import { randomUUID } from "node:crypto";
import {
  chatTab,
  validChat,
  type ChatMessage,
  type ChatStatus,
  type ChatTab,
} from "./chat.ts";
export type Tab = {
  id: number;
  sourceKind: string;
  filename: string;
  loaded: boolean;
  playing: boolean;
  loading: boolean;
  replay: boolean;
  outputActive: boolean;
  sourceID?: string;
  completionID?: string;
  position?: number;
  duration?: number;
  frameRate?: number;
  volume?: number;
};
export type PlaybackStatus = {
  seenAt: number;
  videoControl: true;
  audioControl?: boolean;
  videoJogControl?: boolean;
  videoCompletionControl?: boolean;
  videoReturnRoutingControl?: boolean;
  playbackTransportControl?: boolean;
  audioVolumeControl?: boolean;
  tabs: Tab[];
};
export type ReplayOutput = {
  id: number;
  active: boolean;
  kind: string;
  sourceKind?: string;
  label?: string;
  canOpen?: boolean;
  audio?: string;
  fullFrame?: boolean;
};
export type ReplayStatus = {
  seenAt: number;
  busy: boolean;
  configuredReplayControl?: boolean;
  latestAtemClipControl?: boolean;
  replayStopControl?: boolean;
  replaySourceControl?: boolean;
  replayPlaybackControl?: boolean;
  replayTab?: number;
  outputs?: ReplayOutput[];
  [key: string]: unknown;
};
export type Snapshot = {
  playback?: PlaybackStatus;
  replay?: ReplayStatus;
  chat?: ChatStatus;
};
export type Transport =
  | "play"
  | "pause"
  | "stop"
  | "restart"
  | "toggle"
  | "play-pause";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function fresh(value: Record<string, unknown>, now: number): boolean {
  return (
    typeof value.seenAt === "number" &&
    Number.isFinite(value.seenAt) &&
    Math.abs(now - value.seenAt) <= 3
  );
}
export function validPlayback(
  value: unknown,
  now = Date.now() / 1000,
): value is PlaybackStatus {
  if (
    !record(value) ||
    value.videoControl !== true ||
    !fresh(value, now) ||
    !Array.isArray(value.tabs)
  )
    return false;
  const ids = new Set<number>();
  return value.tabs.every((tab: unknown) => {
    if (
      !record(tab) ||
      typeof tab.id !== "number" ||
      !Number.isSafeInteger(tab.id) ||
      tab.id < 1 ||
      ids.has(tab.id)
    )
      return false;
    ids.add(tab.id);
    return (
      typeof tab.sourceKind === "string" &&
      typeof tab.filename === "string" &&
      ["loaded", "playing", "loading", "replay", "outputActive"].every(
        (key) => typeof tab[key] === "boolean",
      ) &&
      ["position", "duration", "frameRate", "volume"].every(
        (key) =>
          tab[key] === undefined ||
          (typeof tab[key] === "number" &&
            Number.isFinite(tab[key]) &&
            tab[key] >= 0),
      ) &&
      (tab.sourceID === undefined ||
        (typeof tab.sourceID === "string" && uuidPattern.test(tab.sourceID))) &&
      (tab.completionID === undefined ||
        (typeof tab.completionID === "string" &&
          uuidPattern.test(tab.completionID)))
    );
  });
}
export function validReplay(
  value: unknown,
  now = Date.now() / 1000,
): value is ReplayStatus {
  return record(value) && fresh(value, now) && typeof value.busy === "boolean";
}
export function formatTime(seconds: number, frameRate = 0): string {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const whole = Math.floor(value);
  const time = [
    Math.floor(whole / 3600),
    Math.floor(whole / 60) % 60,
    whole % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  if (!(frameRate > 0 && Number.isFinite(frameRate))) return time;
  return (
    time +
    ":" +
    String(
      Math.min(
        Math.ceil(frameRate) - 1,
        Math.floor((value - whole) * frameRate),
      ),
    ).padStart(2, "0")
  );
}

export class StudioClient {
  private readonly network: NetworkControl;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Set<AbortController>();
  private closed = false;
  private replayOperation?: {
    controller: AbortController;
    completion: Promise<void>;
    cancel: () => Promise<void>;
  };
  constructor(connection: APIConnection) {
    this.network = new NetworkControl(connection);
  }
  async snapshot(): Promise<Snapshot> {
    const value = await this.network.snapshot();
    const playback = validPlayback(value.playback) ? value.playback : undefined;
    // Chat freshness follows the playback snapshot, stamped with local receipt time.
    const raw = (value as { chat?: unknown }).chat;
    const chat =
      playback && raw && typeof raw === "object"
        ? { ...raw, seenAt: playback.seenAt }
        : undefined;
    return {
      playback,
      replay: validReplay(value.replay) ? value.replay : undefined,
      chat: validChat(chat) ? chat : undefined,
    };
  }
  private async tab(
    id: number,
    sourceID?: string,
    allowBusy = false,
  ): Promise<{ status: PlaybackStatus; tab: Tab }> {
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error("Select a valid tab number.");
    const { playback: status } = await this.snapshot();
    if (!status)
      throw new Error(
        "Saccani Live Studio is offline. Open the app and check the API URL and token.",
      );
    const tab = status.tabs.find((item) => item.id === id);
    if (!tab) throw new Error(`Tab ${id} no longer exists.`);
    if (
      !["video", "audio"].includes(tab.sourceKind) ||
      (tab.sourceKind === "audio" && status.audioControl !== true)
    )
      throw new Error("Select a loaded video or audio tab.");
    if (!tab.loaded || (!allowBusy && (tab.loading || tab.replay)))
      throw new Error(`Tab ${id} has no loaded media or is busy.`);
    if (sourceID !== undefined && sourceID !== tab.sourceID)
      throw new Error(
        "The source changed while the command was queued. Try again.",
      );
    return { status, tab };
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new Error("Connection closed.");
      return work();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async command(
    tab: Tab,
    action: string,
    extra: Record<string, unknown> = {},
  ): Promise<APIOperation> {
    const controller = new AbortController();
    this.pending.add(controller);
    try {
      return await this.network.command(
        tab.id,
        action,
        { sourceID: tab.sourceID, ...extra },
        controller.signal,
      );
    } finally {
      this.pending.delete(controller);
    }
  }
  transport(
    id: number,
    action: Transport,
    sourceID?: string,
  ): Promise<APIOperation> {
    return this.serial(async () => {
      const { status, tab } = await this.tab(id, sourceID);
      if (
        ["pause", "restart"].includes(action) &&
        status.playbackTransportControl !== true
      )
        throw new Error("Pause and Restart are unavailable in this app.");
      if (
        action === "play-pause" &&
        (tab.sourceKind !== "video" || status.videoJogControl !== true)
      )
        throw new Error(
          "Play/Pause toggle requires a video tab with jog support.",
        );
      if (
        !["play", "pause", "stop", "restart", "toggle", "play-pause"].includes(
          action,
        )
      )
        throw new Error("Invalid transport command.");
      return this.command(tab, action);
    });
  }
  seek(
    id: number,
    amount: number,
    unit: "seconds" | "frames",
    sourceID?: string,
  ): Promise<void> {
    return this.serial(async () => {
      const { status, tab } = await this.tab(id, sourceID);
      if (
        tab.sourceKind !== "video" ||
        status.videoJogControl !== true ||
        !tab.sourceID
      )
        throw new Error(
          "Jog requires a video tab with a current clip identity.",
        );
      if (unit === "frames" && !(tab.frameRate && tab.frameRate > 0))
        throw new Error("The video frame rate is unavailable.");
      if (!["seconds", "frames"].includes(unit))
        throw new Error("Invalid jog unit.");
      const offsetSeconds =
        unit === "frames" ? amount / tab.frameRate! : amount;
      if (!Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds) > 86400)
        throw new Error("Invalid jog distance.");
      await this.command(tab, "seek", { offsetSeconds });
    });
  }
  volume(
    id: number,
    value: number,
    relative: boolean,
    sourceID?: string,
  ): Promise<void> {
    return this.serial(async () => {
      const { status, tab } = await this.tab(id, sourceID);
      if (
        tab.sourceKind !== "audio" ||
        status.audioVolumeControl !== true ||
        tab.volume === undefined
      )
        throw new Error(
          "Audio volume requires an audio tab with volume control.",
        );
      if (
        !Number.isFinite(value) ||
        (relative ? Math.abs(value) > 100 : value < 0 || value > 100)
      )
        throw new Error(
          "Volume must be between 0 and 100 percent; relative steps must be between -100 and 100.",
        );
      const volume = Math.max(
        0,
        Math.min(1, relative ? tab.volume + value / 100 : value / 100),
      );
      await this.command(tab, "set-volume", { volume });
    });
  }
  /** Chooses the chat command from fresh app state, so a press never acts on a deleted message. */
  chat(
    id: number,
    choose: (
      tab: ChatTab,
    ) =>
      | { action: "chat-hide" }
      | { action: "chat-show"; message: ChatMessage },
  ): Promise<void> {
    return this.serial(async () => {
      const { chat } = await this.snapshot();
      const tab = chatTab(chat, id);
      const command = choose(tab);
      if (command.action === "chat-show") chatTab(chat, id, true);
      const controller = new AbortController();
      this.pending.add(controller);
      try {
        await this.network.command(
          id,
          command.action,
          command.action === "chat-show"
            ? { messageID: command.message.id }
            : {},
          controller.signal,
        );
      } finally {
        this.pending.delete(controller);
      }
    });
  }
  async startReplay(
    path: string,
    mode: "configured" | "source",
    tabID: number,
    onError: (error: Error) => void,
  ): Promise<void> {
    if (this.closed) throw new Error("Connection closed.");
    if (this.replayOperation)
      throw new Error("This connection already has a replay pending.");
    const controller = new AbortController();
    this.pending.add(controller);
    // Reserve before asynchronous validation so repeated button presses cannot submit two starts.
    let cancel: (() => Promise<void>) | undefined;
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.replayOperation = {
      controller,
      completion,
      cancel: async () => {
        controller.abort();
        await cancel?.();
      },
    };
    try {
      if (!["configured", "source"].includes(mode))
        throw new Error("Invalid replay settings.");
      // No path: the app replays the ATEM's latest clip, as Controller for Live Studio does.
      if (path && (!path.startsWith("/") || !path.toLowerCase().endsWith(".mp4")))
        throw new Error(
          "Choose an absolute MP4 path on the Mac running the app, or leave it blank for the ATEM's latest clip.",
        );
      const { replay } = await this.snapshot();
      if (!replay || replay.busy)
        throw new Error(
          "Replay is offline or busy. Open Saccani Live Studio and check the tab with a Replay source.",
        );
      if (
        replay.replaySourceControl !== true ||
        replay.replayStopControl !== true ||
        replay.replayPlaybackControl !== true ||
        (mode === "configured" && replay.configuredReplayControl !== true)
      )
        throw new Error(
          "Update Saccani Live Studio to 0.22.1 or later for Replay through a Replay tab.",
        );
      if (!path && replay.latestAtemClipControl !== true)
        throw new Error(
          "Update Saccani Live Studio to 0.22.30 or later to replay the ATEM's latest clip, or choose an MP4 path.",
        );
      const destination = mode === "configured" ? replay.replayTab : tabID;
      const output = replay.outputs?.find(
        (output) => output.id === destination && output.sourceKind === "replay",
      );
      if (!Number.isSafeInteger(destination) || !output)
        throw new Error(
          mode === "configured"
            ? "Choose Replay as the source of a tab in the app."
            : "Choose a tab with Replay as its source.",
        );
      const tab = destination!;
      if (!output.active && output.canOpen !== true)
        throw new Error(
          `Configure an available Video Output in Replay tab ${tab} of the app.`,
        );
      if (!["mac", "blackmagic"].includes(output.audio ?? ""))
        throw new Error(`Check the audio destination in Replay tab ${tab}.`);
      if (output.audio === "blackmagic" && output.kind !== "blackmagic")
        throw new Error(
          `Replay tab ${tab} needs a Blackmagic output for Blackmagic audio.`,
        );
      const network = this.network,
        id = randomUUID().toUpperCase();
      let submission: Promise<APIOperation> | undefined;
      let cancelPromise: Promise<void> | undefined;
      cancel = () =>
        (cancelPromise ??= (async () => {
          await submission?.catch(() => undefined);
          await network.stopReplay(id);
        })());
      controller.signal.throwIfAborted();
      submission = network.submit(
        "/api/v1/replay/start",
        {
          ...(path ? { path } : {}),
          mode: mode === "configured" ? "configured" : `source${tab}`,
          audio: "mac",
        },
        id,
      );
      try {
        await submission;
      } catch (error) {
        await cancel().catch(() => undefined);
        throw error;
      }
      void (async () => {
        try {
          await network.wait(id, 45000, controller.signal);
        } catch (error) {
          await cancel!().catch(() => undefined);
          if (!controller.signal.aborted)
            onError(error instanceof Error ? error : new Error(String(error)));
        } finally {
          if (controller.signal.aborted) await cancel!().catch(() => undefined);
          this.pending.delete(controller);
          if (this.replayOperation?.controller === controller)
            this.replayOperation = undefined;
          resolveCompletion();
        }
      })();
      return;
    } catch (error) {
      this.pending.delete(controller);
      if (this.replayOperation?.controller === controller)
        this.replayOperation = undefined;
      resolveCompletion();
      throw error;
    }
  }
  async stopReplay(): Promise<void> {
    if (!this.replayOperation)
      throw new Error(
        "This connection has no replay to stop. Use Stop and Restore in the app for replays started elsewhere.",
      );
    await this.replayOperation.cancel();
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.pending) controller.abort();
    await this.replayOperation?.cancel().catch(() => undefined);
    await this.queue.catch(() => undefined);
    this.network.close();
  }
}
