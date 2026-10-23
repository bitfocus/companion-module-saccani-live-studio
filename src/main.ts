import {
  InstanceBase,
  InstanceStatus,
  type CompanionActionDefinition,
  type CompanionBooleanFeedbackDefinition,
  type CompanionInputFieldDropdown,
  type CompanionPresetDefinitions,
  type CompanionPresetAction,
  type SomeCompanionConfigField,
  type CompanionStaticUpgradeScript,
} from "@companion-module/base";
import {
  StudioClient,
  formatTime,
  type Snapshot,
  type Transport,
} from "./protocol.js";
import type { HeadphoneMuteMode } from "./atem-headphones.js";
import { Atem } from "atem-connection";
import {
  ATEMProgramConnection,
  RESTORE_PREVIOUS_INPUT,
  type ReplayOutputOptions,
  type RoutingOptions,
} from "./program-routing.js";
import {
  ChatBrowser,
  keyCommand,
  pickMessage,
  type ChatMessage,
  type ChatPick,
} from "./chat.js";
import { PlaybackRouting } from "./playback-routing.js";
import {
  cameraGroups,
  cameraParameters,
  cameraParameter,
  cameraChannels,
  cameraDisplays,
  type CameraOptions,
  type CameraGroup,
} from "./atem-camera.js";

type CameraActionOptions = CameraOptions & {
  overlay?: number;
  infoHelp?: string;
};
type Config = { replayFile: string; url: string; atemHost?: string };
type Secrets = { token?: string };
type TransportActions =
  | "play"
  | "pause"
  | "stop"
  | "restart"
  | "toggle"
  | "play_pause";
export type ModuleSchema = {
  config: Config;
  secrets: Secrets;
  actions: {
    [K in TransportActions]: { options: { tab: number } & RoutingOptions };
  } & {
    jog: {
      options: { tab: number; amount: number; unit: "seconds" | "frames" };
    };
    volume: { options: { tab: number; value: number; relative: boolean } };
    headphones_volume: { options: { value: number; relative: boolean } };
    headphones_mute: { options: { mode: HeadphoneMuteMode } };
    replay_start: {
      options: {
        path: string;
        mode: "configured" | "source";
        tab: number;
      } & RoutingOptions &
        ReplayOutputOptions;
    };
    replay_stop: { options: Record<string, never> };
    chat_toggle: { options: { tab: number; pick: ChatPick } };
    chat_hide: { options: { tab: number } };
    chat_browse: { options: { tab: number; steps: number } };
    chat_preview: { options: { tab: number } };
  } & { [K in `camera_${CameraGroup}`]: { options: CameraActionOptions } };
  feedbacks: {
    headphones_muted: { type: "boolean"; options: Record<string, never> };
    headphones_available: { type: "boolean"; options: Record<string, never> };
    camera_available: { type: "boolean"; options: Record<string, never> };
    offline: { type: "boolean"; options: Record<string, never> };
    replay_busy: { type: "boolean"; options: Record<string, never> };
  } & {
    [K in
      | "playing"
      | "ready"
      | "busy"
      | "output"
      | "chat_on_air"
      | "chat_preview_on_air"
      | "chat_ready"]: {
      type: "boolean";
      options: { tab: number };
    };
  };
  variables: Record<string, string | number | boolean>;
};
export const UpgradeScripts: CompanionStaticUpgradeScript<Config, Secrets>[] = [
  // 0.5.0: replay targets an exact Replay source tab, whose own settings replace audio and framing.
  (_context, props) => ({
    updatedConfig: null,
    updatedActions: props.actions.flatMap((action) => {
      if (action.actionId !== "replay_start") return [];
      const mode = action.options.mode;
      if (mode?.isExpression || mode?.value !== "tab") return [];
      action.options.mode = { value: "source", isExpression: false };
      delete action.options.audio;
      delete action.options.fullFrame;
      return [action];
    }),
    updatedFeedbacks: [],
  }),
];
const transportNames: Record<TransportActions, string> = {
  play: "Play / Resume",
  pause: "Pause",
  stop: "Stop and return to beginning",
  restart: "Restart and play",
  toggle: "Play / Stop toggle",
  play_pause: "Play / Pause toggle (video)",
};
const variableNames: Record<string, string> = {
  filename: "Filename",
  source_kind: "Source type",
  loaded: "Media loaded",
  playing: "Playing",
  busy: "Loading or replay",
  output_active: "Output active",
  position: "Clip-relative position",
  remaining: "Time remaining",
  position_seconds: "Position in seconds",
  duration_seconds: "Duration in seconds",
  remaining_seconds: "Remaining seconds",
  progress: "Progress percent",
  volume: "Audio volume percent",
};
const chatVariableNames: Record<string, string> = {
  status: "Status",
  mode: "Mode (highlight / feed)",
  live: "Broadcast live",
  message_count: "Recent messages",
  on_air: "Message on air",
  on_air_author: "On air: author",
  on_air_text: "On air: text",
  on_air_highlight: "On air: Super Chat amount or membership",
  preview_author: "Preview: author",
  preview_text: "Preview: text",
  preview_highlight: "Preview: Super Chat amount or membership",
  preview_position: "Preview: position (n / total)",
  preview_on_air: "Preview: message is on air",
  latest_highlight_author: "Latest Super Chat or membership: author",
};
function messageValues(
  prefix: string,
  message: ChatMessage | null | undefined,
) {
  return {
    [`${prefix}_author`]: message?.author ?? "",
    [`${prefix}_text`]: message?.text ?? "",
    [`${prefix}_highlight`]: message?.highlight ?? "",
  };
}

export default class SaccaniStudioInstance extends InstanceBase<ModuleSchema> {
  config: Config = { url: "http://127.0.0.1:8765", replayFile: "" };
  private secrets: Secrets = {};
  private client?: StudioClient;
  private snapshot: Snapshot = {};
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private tabSignature = "";
  private knownTabs = new Set([1, 2, 3]);
  private knownCameras = new Set([1]);
  private knownChatTabs = new Set<number>();
  private chatBrowser = new ChatBrowser();
  private lastError = "";
  private program: ATEMProgramConnection;
  private playbackRouting: PlaybackRouting;
  private atemSignature = "";

  constructor(internal: unknown, createATEM?: () => Atem) {
    super(internal);
    this.program = new ATEMProgramConnection(
      () => {
        for (const camera of this.program.cameras)
          this.knownCameras.add(camera.value);
        const signature = JSON.stringify([
          this.program.online,
          this.program.inputs,
          this.program.headphones !== undefined,
          this.program.cameras,
          this.program.cameraAvailable,
          this.program.auxOutputs,
          this.program.auxSources,
        ]);
        if (signature !== this.atemSignature) {
          this.atemSignature = signature;
          this.definitions();
        }
        this.publishState();
      },
      (error) => this.reportError(error),
      createATEM,
    );
    this.playbackRouting = new PlaybackRouting((options) =>
      this.program.route(options),
    );
  }
  getConfigFields(): SomeCompanionConfigField[] {
    return [
      {
        type: "static-text",
        id: "help",
        label: "Saccani Live Studio connection",
        width: 12,
        value:
          "For HTTP / WebSocket, enable File → Remote Control… in the app. Leave the token blank unless Require access token is enabled in the app. Enable LAN access for Companion on another computer. Load media and open video outputs in the app. Replay paths always belong to the app Mac. Camera and headphone controls connect directly to the ATEM and work independently of the app.",
      },
      {
        type: "textinput",
        id: "url",
        label: "App API URL",
        width: 12,
        default: "http://127.0.0.1:8765",
      },
      {
        type: "secret-text",
        id: "token",
        label: "API access token (optional)",
        width: 12,
      },
      {
        type: "textinput",
        id: "atemHost",
        label:
          "ATEM IP address (camera controls, headphones / optional Program routing)",
        width: 12,
        default: "",
      },
      {
        type: "textinput",
        id: "replayFile",
        label: "Default replay MP4 file (absolute Mac path)",
        width: 12,
        default: "",
      },
    ];
  }
  async init(
    config: Config,
    _isFirstInit = false,
    secrets: Secrets = {},
  ): Promise<void> {
    this.secrets = secrets;
    await this.configure(config);
  }
  async configUpdated(
    config: Config,
    secrets: Secrets = this.secrets,
  ): Promise<void> {
    this.secrets = secrets;
    await this.configure(config);
  }
  private async configure(config: Config): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    const oldClient = this.client;
    this.client = undefined;
    await this.playbackRouting.close((error) => this.reportError(error));
    await oldClient?.close();
    await this.program.close();
    if (generation !== this.generation) return;
    this.playbackRouting = new PlaybackRouting((options) =>
      this.program.route(options),
    );
    this.config = {
      url: config.url || "http://127.0.0.1:8765",
      replayFile: config.replayFile || "",
      atemHost: config.atemHost?.trim() || "",
    };
    this.snapshot = {};
    this.lastError = "";
    this.tabSignature = "";
    this.chatBrowser.clear();
    this.definitions();
    try {
      await this.program.configure(this.config.atemHost || "");
      if (generation !== this.generation) return;
      this.client = new StudioClient({
        url: this.config.url,
        token: this.secrets.token ?? "",
      });
    } catch (error) {
      this.updateStatus(InstanceStatus.BadConfig, String(error));
      this.publishState();
      return;
    }
    await this.poll(generation);
  }
  async destroy(): Promise<void> {
    ++this.generation;
    clearTimeout(this.timer);
    const client = this.client;
    this.client = undefined;
    await this.playbackRouting.close((error) => this.reportError(error));
    await client?.close();
    await this.program.close();
  }
  private async poll(generation: number): Promise<void> {
    const client = this.client;
    if (!client || generation !== this.generation) return;
    try {
      const snapshot = await client.snapshot();
      if (generation !== this.generation) return;
      this.snapshot = snapshot;
      await this.playbackRouting.observe(snapshot.playback, (error) => {
        if (generation === this.generation) this.reportError(error);
      });
      if (generation !== this.generation) return;
      const signature = JSON.stringify([
        snapshot.playback?.tabs.map((tab) => [
          tab.id,
          tab.sourceKind,
          tab.filename,
        ]) ?? [],
        this.replayTabs(snapshot).map((output) => [output.id, output.label]),
        snapshot.chat?.tabs.map((tab) => tab.id) ?? [],
      ]);
      for (const tab of snapshot.playback?.tabs ?? [])
        this.knownTabs.add(tab.id);
      for (const tab of snapshot.chat?.tabs ?? [])
        this.knownChatTabs.add(tab.id);
      if (signature !== this.tabSignature) {
        this.tabSignature = signature;
        this.definitions();
      }
      this.updateStatus(
        snapshot.playback ? InstanceStatus.Ok : InstanceStatus.Disconnected,
        snapshot.playback
          ? undefined
          : "Open Saccani Live Studio and check the connection settings.",
      );
      this.publishState();
    } catch (error) {
      if (generation !== this.generation) return;
      this.snapshot = {};
      await this.playbackRouting.observe(undefined, (error) => {
        if (generation === this.generation) this.reportError(error);
      });
      if (generation !== this.generation) return;
      this.updateStatus(InstanceStatus.ConnectionFailure, String(error));
      this.publishState();
    }
    if (generation === this.generation) {
      this.timer = setTimeout(() => {
        void this.poll(generation);
      }, 250);
      this.timer.unref();
    }
  }
  private tabField(
    kind?: "video" | "audio",
  ): CompanionInputFieldDropdown<"tab"> {
    const tabs =
      this.snapshot.playback?.tabs.filter(
        (tab) => !kind || tab.sourceKind === kind,
      ) ?? [];
    const choices = tabs.length
      ? tabs.map((tab) => ({
          id: tab.id,
          label: `Tab ${tab.id} · ${tab.filename || tab.sourceKind}`,
        }))
      : [...this.knownTabs]
          .sort((a, b) => a - b)
          .map((id) => ({ id, label: `Tab ${id}` }));
    return {
      id: "tab",
      type: "dropdown",
      label: "Tab",
      choices,
      default: choices[0]!.id,
    };
  }
  private replayTabs(snapshot = this.snapshot) {
    return (
      snapshot.replay?.outputs?.filter(
        (output) => output.sourceKind === "replay",
      ) ?? []
    );
  }
  private replayTabField(): CompanionInputFieldDropdown<"tab"> {
    const tabs = this.replayTabs();
    const choices = tabs.length
      ? tabs.map((output) => ({
          id: output.id,
          label: `Tab ${output.id}${output.label ? " · " + output.label : ""}`,
        }))
      : [{ id: 1, label: "Tab 1 · choose Replay as a tab source in the app" }];
    return {
      id: "tab",
      type: "dropdown",
      label: "Replay tab",
      choices,
      default: choices[0]!.id,
      isVisibleExpression: '$(options:mode) == "source"',
    };
  }
  private chatTabField(): CompanionInputFieldDropdown<"tab"> {
    const ids = this.snapshot.chat?.tabs.map((tab) => tab.id) ?? [
      ...this.knownChatTabs,
    ];
    const choices = ids.length
      ? ids.sort((a, b) => a - b).map((id) => ({ id, label: `Chat tab ${id}` }))
      : [{ id: 1, label: "Tab 1 · choose Chat as a tab source in the app" }];
    return {
      id: "tab",
      type: "dropdown",
      label: "Chat tab",
      choices,
      default: choices[0]!.id,
    };
  }
  private chatTab(id: number) {
    return this.snapshot.chat?.tabs.find((tab) => tab.id === id);
  }
  private async execute(
    work: (client: StudioClient) => Promise<unknown>,
  ): Promise<void> {
    const client = this.client,
      generation = this.generation;
    try {
      if (!client) throw new Error("Configure the app connection first.");
      await work(client);
      if (generation === this.generation) {
        this.lastError = "";
        this.setVariableValues({ last_error: "" });
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.reportError(error);
    }
  }
  private async executeATEM(work: () => Promise<void>): Promise<void> {
    const generation = this.generation;
    try {
      await work();
      if (generation === this.generation) {
        this.lastError = "";
        this.publishState();
      }
    } catch (error) {
      if (generation === this.generation) this.reportError(error);
    }
  }
  private reportError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.log("warn", this.lastError);
    this.setVariableValues({ last_error: this.lastError });
  }
  private sourceID(id: number): string | undefined {
    return this.snapshot.playback?.tabs.find((tab) => tab.id === id)?.sourceID;
  }
  private definitions(): void {
    const cameraActions = {} as Record<
      `camera_${CameraGroup}`,
      CompanionActionDefinition<CameraActionOptions>
    >;
    for (const group of Object.keys(cameraGroups) as CameraGroup[]) {
      const parameters = cameraParameters.filter(
        (parameter) => parameter.group === group,
      );
      const initial = parameters[0]!;
      const visible = (filter: (parameter: typeof initial) => boolean) =>
        parameters
          .filter(filter)
          .map(
            (parameter) =>
              "$(options:parameter) == " + JSON.stringify(parameter.id),
          )
          .join(" || ") || "false";
      const numericVisible = visible(
        (parameter) => !parameter.trigger && !parameter.choices,
      );
      cameraActions[`camera_${group}`] = {
        name: cameraGroups[group],
        options: [
          {
            id: "camera",
            type: "dropdown",
            label: "Blackmagic camera input / Camera ID",
            default: 1,
            choices: this.program.cameras.length
              ? this.program.cameras.map((input) => ({
                  id: input.value,
                  label: input.name,
                }))
              : [{ id: 1, label: "CAM 1 · connect ATEM to list inputs" }],
          },
          {
            id: "parameter",
            type: "dropdown",
            label: "Parameter",
            default: initial.id,
            disableAutoExpression: true,
            choices: parameters.map((parameter) => ({
              id: parameter.id,
              label:
                parameter.name +
                (parameter.unit ? " (" + parameter.unit + ")" : ""),
            })),
          },
          {
            id: "operation",
            type: "dropdown",
            label: "On press",
            default: initial.choices ? "set" : "increase",
            isVisibleExpression: numericVisible,
            choices: [
              { id: "set", label: "Set value" },
              { id: "increase", label: "Increase" },
              { id: "decrease", label: "Decrease" },
            ],
          },
          {
            id: "value",
            type: "number",
            label: "Value / change (positive step for Increase / Decrease)",
            default: initial.choices ? initial.default : initial.step,
            min: -2147483648,
            max: 2147483647,
            step: 0.01,
            isVisibleExpression: numericVisible,
          },
          ...(group === "color"
            ? [
                {
                  id: "channel" as const,
                  type: "dropdown" as const,
                  label: "Color wheel channel",
                  default: 3,
                  choices: cameraChannels.map((label, id) => ({ id, label })),
                  isVisibleExpression: visible(
                    (parameter) => !!parameter.channels,
                  ),
                },
              ]
            : []),
          ...(group === "monitor"
            ? [
                {
                  id: "display" as const,
                  type: "dropdown" as const,
                  label: "Display / output for video information",
                  default: 2,
                  choices: cameraDisplays.map((display) => ({
                    id: display.value,
                    label: display.name,
                  })),
                  isVisibleExpression: visible(
                    (parameter) => !!parameter.displays,
                  ),
                },
                {
                  id: "overlay" as const,
                  type: "dropdown" as const,
                  label: "Information on video",
                  default: 1,
                  choices: cameraParameter("info").choices!.map((choice) => ({
                    id: choice.value,
                    label: choice.name,
                  })),
                  isVisibleExpression: visible(
                    (parameter) => !!parameter.displays,
                  ),
                },
                {
                  id: "infoHelp" as const,
                  type: "static-text" as const,
                  label: "Video information",
                  value:
                    "Select the information layout on the chosen camera display or video output. Available overlays depend on the camera model.",
                  isVisibleExpression: visible(
                    (parameter) => !!parameter.displays,
                  ),
                },
              ]
            : []),
        ],
        callback: (event) =>
          this.executeATEM(() => {
            const parameter = cameraParameter(event.options.parameter);
            if (parameter.group !== group)
              throw new Error(
                "Choose a parameter in this camera function group",
              );
            return this.program.cameraCommand({
              ...event.options,
              camera: Number(event.options.camera),
              value: Number(
                parameter.displays
                  ? (event.options.overlay ?? event.options.value)
                  : event.options.value,
              ),
              channel: Number(event.options.channel ?? 3),
              display: Number(event.options.display ?? 2),
              operation: parameter.trigger
                ? "trigger"
                : parameter.choices
                  ? "set"
                  : event.options.operation,
            });
          }),
      };
    }
    const routingFields = [
      {
        id: "studioRouting" as const,
        type: "checkbox" as const,
        label: "Change ATEM input before / after playback",
        default: false,
        disableAutoExpression: true,
      },
      {
        id: "studioBefore" as const,
        type: "dropdown" as const,
        label: "Program input before playback",
        tooltip:
          "Selected only after the app confirms playback has started and its output is ready.",
        default: "unchanged" as const,
        isVisibleExpression: "$(options:studioRouting)",
        choices: [
          { id: "unchanged", label: "Do not change" },
          ...this.program.inputs,
        ],
      },
      {
        id: "studioAfter" as const,
        type: "dropdown" as const,
        label: "Program input after playback",
        default: "unchanged" as const,
        isVisibleExpression: "$(options:studioRouting)",
        choices: [
          { id: "unchanged", label: "Do not change" },
          {
            id: RESTORE_PREVIOUS_INPUT,
            label: "Restore Previous Input",
          },
          ...this.program.inputs,
        ],
      },
    ];
    const transportAction = (
      id: TransportActions,
    ): CompanionActionDefinition<{ tab: number } & RoutingOptions> => ({
      name: transportNames[id],
      options: [
        this.tabField(),
        ...(["play", "restart", "toggle", "play_pause"].includes(id)
          ? routingFields
          : []),
      ],
      callback: (event) => {
        const tab = Number(event.options.tab),
          sourceID = this.sourceID(tab);
        return this.execute((client) =>
          this.playbackRouting.transport(
            client,
            tab,
            (id === "play_pause" ? "play-pause" : id) as Transport,
            event.options,
            sourceID,
          ),
        );
      },
    });
    this.setActionDefinitions({
      ...cameraActions,
      play: transportAction("play"),
      pause: transportAction("pause"),
      stop: transportAction("stop"),
      restart: transportAction("restart"),
      toggle: transportAction("toggle"),
      play_pause: transportAction("play_pause"),
      jog: {
        name: "Jog video forward / backward",
        options: [
          this.tabField("video"),
          {
            id: "amount",
            type: "number",
            label: "Distance (negative = backward)",
            default: 1,
            min: -86400,
            max: 86400,
            step: 0.01,
          },
          {
            id: "unit",
            type: "dropdown",
            label: "Unit",
            default: "frames",
            choices: [
              { id: "frames", label: "Frames" },
              { id: "seconds", label: "Seconds" },
            ],
          },
        ],
        callback: (event) => {
          const { tab, amount, unit } = event.options,
            sourceID = this.sourceID(Number(tab));
          return this.execute((client) =>
            client.seek(Number(tab), Number(amount), unit, sourceID),
          );
        },
      },
      volume: {
        name: "Set / change audio-tab volume",
        options: [
          this.tabField("audio"),
          {
            id: "value",
            type: "number",
            label: "Volume / change (%)",
            default: 100,
            min: -100,
            max: 100,
            step: 1,
          },
          {
            id: "relative",
            type: "checkbox",
            label: "Relative change (negative = quieter)",
            default: false,
          },
        ],
        callback: (event) => {
          const { tab, value, relative } = event.options,
            sourceID = this.sourceID(Number(tab));
          return this.execute((client) =>
            client.volume(Number(tab), Number(value), relative, sourceID),
          );
        },
      },
      headphones_volume: {
        name: "ATEM headphones: set / change volume",
        options: [
          {
            id: "value",
            type: "number",
            label: "Volume / change (dB; absolute: −60 to +10)",
            default: 1,
            min: -70,
            max: 70,
            step: 0.1,
          },
          {
            id: "relative",
            type: "checkbox",
            label: "Relative change (negative = quieter)",
            default: true,
          },
        ],
        callback: (event) =>
          this.executeATEM(() =>
            this.program.headphoneVolume(
              Number(event.options.value),
              event.options.relative,
            ),
          ),
      },
      headphones_mute: {
        name: "ATEM headphones: mute Program listening",
        options: [
          {
            id: "mode",
            type: "dropdown",
            label: "Mute command",
            default: "toggle",
            choices: [
              { id: "toggle", label: "Toggle mute" },
              { id: "mute", label: "Mute" },
              { id: "unmute", label: "Unmute" },
            ],
          },
        ],
        callback: (event) =>
          this.executeATEM(() =>
            this.program.headphoneMute(event.options.mode),
          ),
      },
      replay_start: {
        name: "Replay final 15 seconds of MP4",
        options: [
          {
            id: "path",
            type: "textinput",
            label: "MP4 file (blank = configured default)",
            default: "",
            useVariables: true,
          },
          {
            id: "mode",
            type: "dropdown",
            label: "Replay tab",
            tooltip:
              "Audio, framing, overlay and Video Output come from the Replay tab in the app.",
            default: "configured",
            disableAutoExpression: true,
            choices: [
              {
                id: "configured",
                label: "Last selected Replay tab in the app",
              },
              { id: "source", label: "Choose a Replay tab" },
            ],
          },
          this.replayTabField(),
          ...routingFields,
          {
            id: "replayRouting",
            type: "checkbox",
            label: "Change SRC OUT during playback",
            default: false,
            disableAutoExpression: true,
          },
          {
            id: "replayAux",
            type: "dropdown",
            label: "SRC OUT output",
            tooltip:
              "Switched after the app confirms replay has started; its previous source returns before the app restores the video output.",
            default: this.program.auxOutputs[0]?.id ?? 1,
            isVisibleExpression: "$(options:replayRouting)",
            choices: this.program.auxOutputs.length
              ? this.program.auxOutputs
              : [{ id: 1, label: "SRC OUT 1 · connect ATEM to list outputs" }],
          },
          {
            id: "replaySource",
            type: "dropdown",
            label: "Source on SRC OUT during playback",
            default: this.program.auxSources[0]?.id ?? 0,
            isVisibleExpression: "$(options:replayRouting)",
            choices: this.program.auxSources.length
              ? this.program.auxSources
              : [{ id: 0, label: "Connect ATEM to list sources" }],
          },
        ],
        callback: (event) =>
          this.execute((client) => {
            const generation = this.generation,
              { path, mode, tab } = event.options;
            return client.startReplay(
              path || this.config.replayFile,
              mode,
              Number(tab),
              (error) => {
                if (generation !== this.generation) return;
                this.lastError = error.message;
                this.log("warn", error.message);
                this.setVariableValues({ last_error: error.message });
              },
              this.program.replayRoute(event.options),
            );
          }),
      },
      replay_stop: {
        name: "Stop this connection’s replay and restore source",
        options: [],
        callback: () => this.execute((client) => client.stopReplay()),
      },
      chat_toggle: {
        name: "Chat: put a message on air / hide",
        description:
          "Puts the chosen message on air; when a message is already on air, hides it.",
        options: [
          this.chatTabField(),
          {
            id: "pick",
            type: "dropdown",
            label: "Key press shows",
            default: "latest",
            choices: [
              { id: "latest", label: "Latest message" },
              { id: "highlight", label: "Latest Super Chat or membership" },
            ],
          },
        ],
        callback: (event) =>
          this.execute((client) =>
            client.chat(Number(event.options.tab), (tab) =>
              keyCommand(tab, event.options.pick),
            ),
          ),
      },
      chat_hide: {
        name: "Chat: hide message on air",
        options: [this.chatTabField()],
        callback: (event) =>
          this.execute((client) =>
            client.chat(Number(event.options.tab), () => ({
              action: "chat-hide",
            })),
          ),
      },
      chat_browse: {
        name: "Chat: browse messages (dial)",
        description:
          "Moves the preview through the latest 50 messages; at the newest message it follows new ones.",
        options: [
          this.chatTabField(),
          {
            id: "steps",
            type: "number",
            label: "Messages (negative = older, positive = newer)",
            default: 1,
            min: -50,
            max: 50,
            step: 1,
          },
        ],
        callback: (event) => {
          const tab = this.chatTab(Number(event.options.tab));
          if (!tab) {
            this.reportError(
              new Error(
                `Choose Chat as the source in tab ${event.options.tab} of the app.`,
              ),
            );
            return;
          }
          this.chatBrowser.move(tab, Math.trunc(Number(event.options.steps)));
          this.publishState();
        },
      },
      chat_preview: {
        name: "Chat: put previewed message on air / hide",
        options: [this.chatTabField()],
        callback: (event) =>
          this.execute((client) =>
            client.chat(Number(event.options.tab), (tab) =>
              this.chatBrowser.press(tab),
            ),
          ),
      },
    });
    const tabFeedback = (
      id: "playing" | "ready" | "busy" | "output",
    ): CompanionBooleanFeedbackDefinition<{ tab: number }> => ({
      type: "boolean" as const,
      name: {
        playing: "Tab playing",
        ready: "Tab ready with loaded media",
        busy: "Tab loading or replaying",
        output: "Tab output active",
      }[id]!,
      defaultStyle: {
        color: 0xffffff,
        bgcolor: id === "busy" ? 0xb36a00 : 0x176b34,
      },
      options: [this.tabField()],
      callback: (event) => {
        const tab = this.snapshot.playback?.tabs.find(
          (item) => item.id === Number(event.options.tab),
        );
        if (!tab) return false;
        return id === "playing"
          ? tab.playing
          : id === "busy"
            ? tab.loading || tab.replay
            : id === "output"
              ? tab.outputActive
              : tab.loaded &&
                !tab.loading &&
                !tab.replay &&
                ["video", "audio"].includes(tab.sourceKind);
      },
    });
    this.setFeedbackDefinitions({
      camera_available: {
        type: "boolean",
        name: "ATEM Blackmagic camera control available",
        options: [],
        defaultStyle: { bgcolor: 0x176b34, color: 0xffffff },
        callback: () => this.program.cameraAvailable,
      },
      playing: tabFeedback("playing"),
      ready: tabFeedback("ready"),
      busy: tabFeedback("busy"),
      output: tabFeedback("output"),
      headphones_muted: {
        type: "boolean",
        name: "ATEM headphone Program listening muted",
        options: [],
        defaultStyle: { bgcolor: 0xb02727, color: 0xffffff },
        callback: () => this.program.headphones?.muted === true,
      },
      headphones_available: {
        type: "boolean",
        name: "ATEM headphone control available",
        options: [],
        defaultStyle: { bgcolor: 0x176b34, color: 0xffffff },
        callback: () => this.program.headphones !== undefined,
      },
      offline: {
        type: "boolean",
        name: "App offline",
        options: [],
        defaultStyle: { bgcolor: 0x444444, color: 0xbbbbbb },
        callback: () => !this.snapshot.playback,
      },
      replay_busy: {
        type: "boolean",
        name: "Replay active or loading",
        options: [],
        defaultStyle: { bgcolor: 0x8d258c, color: 0xffffff },
        callback: () => this.snapshot.replay?.busy === true,
      },
      chat_on_air: {
        type: "boolean",
        name: "Chat: a message is on air",
        options: [this.chatTabField()],
        defaultStyle: { bgcolor: 0xb02727, color: 0xffffff },
        callback: (event) => !!this.chatTab(Number(event.options.tab))?.onAir,
      },
      chat_preview_on_air: {
        type: "boolean",
        name: "Chat: previewed message is on air",
        options: [this.chatTabField()],
        defaultStyle: { bgcolor: 0xb02727, color: 0xffffff },
        callback: (event) => {
          const tab = this.chatTab(Number(event.options.tab));
          return (
            !!tab?.onAir &&
            this.chatBrowser.position(tab).message?.id === tab.onAir.id
          );
        },
      },
      chat_ready: {
        type: "boolean",
        name: "Chat: messages available in Highlight mode",
        options: [this.chatTabField()],
        defaultStyle: { bgcolor: 0x176b34, color: 0xffffff },
        callback: (event) => {
          const tab = this.chatTab(Number(event.options.tab));
          return tab?.mode === "highlight" && tab.messages.length > 0;
        },
      },
    });
    const variables: Record<string, { name: string }> = {
      online: { name: "App online" },
      tab_count: { name: "Number of tabs" },
      last_error: { name: "Last command error" },
      replay_busy: { name: "Replay active or loading" },
      atem_headphones_available: { name: "ATEM headphone control available" },
      atem_headphones_volume: { name: "ATEM headphone volume (dB)" },
      atem_headphones_muted: { name: "ATEM headphone Program listening muted" },
      atem_online: { name: "ATEM connected" },
      atem_camera_available: {
        name: "ATEM Blackmagic camera control available",
      },
      atem_program_input: { name: "ATEM Program input number" },
      atem_program_name: { name: "ATEM Program input name" },
      replay_tab: { name: "Configured replay tab" },
    };
    for (const id of this.knownTabs)
      for (const [key, name] of Object.entries(variableNames))
        variables[`tab_${id}_${key}`] = { name: `Tab ${id}: ${name}` };
    for (const id of this.knownChatTabs)
      for (const [key, name] of Object.entries(chatVariableNames))
        variables[`chat_${id}_${key}`] = { name: `Chat tab ${id}: ${name}` };
    for (const camera of this.knownCameras)
      for (const parameter of cameraParameters.filter(
        (parameter) => !parameter.trigger,
      ))
        for (const channel of parameter.channels ? [0, 1, 2, 3] : [3])
          variables[
            "camera_" +
              camera +
              "_" +
              parameter.id +
              (parameter.channels
                ? "_" + cameraChannels[channel]!.toLowerCase()
                : "")
          ] = {
            name:
              "Camera " +
              camera +
              ": " +
              parameter.name +
              (parameter.channels ? " " + cameraChannels[channel] : ""),
          };
    this.setVariableDefinitions(variables);
    this.presets();
  }
  private publishState(): void {
    const values: ModuleSchema["variables"] = {
      online: !!this.snapshot.playback,
      tab_count: this.snapshot.playback?.tabs.length ?? 0,
      last_error: this.lastError,
      replay_busy: this.snapshot.replay?.busy ?? false,
      replay_tab: this.snapshot.replay?.replayTab ?? 0,
      atem_headphones_available: this.program.headphones !== undefined,
      atem_headphones_volume: this.program.headphones?.volumeDb ?? "",
      atem_headphones_muted: this.program.headphones?.muted ?? false,
      atem_online: this.program.online,
      atem_camera_available: this.program.cameraAvailable,
      atem_program_input: this.program.input ?? "",
      atem_program_name:
        this.program.inputs.find((input) => input.id === this.program.input)
          ?.label ?? "",
    };
    for (const id of this.knownTabs) {
      const tab = this.snapshot.playback?.tabs.find((item) => item.id === id),
        position = tab?.position ?? 0,
        duration = tab?.duration ?? 0,
        remaining = Math.max(0, duration - position);
      const data = {
        filename: tab?.filename ?? "",
        source_kind: tab?.sourceKind ?? "",
        loaded: tab?.loaded ?? false,
        playing: tab?.playing ?? false,
        busy: (tab?.loading || tab?.replay) ?? false,
        output_active: tab?.outputActive ?? false,
        position: formatTime(position, tab?.frameRate),
        remaining: formatTime(remaining, tab?.frameRate),
        position_seconds: position,
        duration_seconds: duration,
        remaining_seconds: remaining,
        progress: duration > 0 ? Math.min(100, (position / duration) * 100) : 0,
        volume: Math.round((tab?.volume ?? 0) * 100),
      };
      for (const [key, value] of Object.entries(data))
        values[`tab_${id}_${key}`] = value;
    }
    for (const id of this.knownChatTabs) {
      const tab = this.chatTab(id),
        preview = tab ? this.chatBrowser.position(tab) : undefined;
      const data = {
        status: tab?.status ?? "",
        mode: tab?.mode ?? "",
        live: tab?.live ?? false,
        message_count: tab?.messages.length ?? 0,
        on_air: !!tab?.onAir,
        ...messageValues("on_air", tab?.onAir),
        ...messageValues("preview", preview?.message),
        preview_position: preview?.message
          ? `${preview.index + 1} / ${preview.total}`
          : "",
        preview_on_air: !!tab?.onAir && preview?.message?.id === tab.onAir.id,
        latest_highlight_author: tab
          ? (pickMessage(tab, "highlight")?.author ?? "")
          : "",
      };
      for (const [key, value] of Object.entries(data))
        values[`chat_${id}_${key}`] = value;
    }
    for (const camera of this.knownCameras)
      for (const parameter of cameraParameters.filter(
        (parameter) => !parameter.trigger,
      ))
        for (const channel of parameter.channels ? [0, 1, 2, 3] : [3])
          values[
            "camera_" +
              camera +
              "_" +
              parameter.id +
              (parameter.channels
                ? "_" + cameraChannels[channel]!.toLowerCase()
                : "")
          ] =
            this.program.cameraAvailable &&
            this.program.cameras.some((input) => input.value === camera)
              ? (this.program.camera.value(camera, parameter.id, channel) ?? "")
              : "";
    this.setVariableValues(values);
    this.checkAllFeedbacks();
  }
  private presets(): void {
    const definitions: CompanionPresetDefinitions<ModuleSchema> = {},
      groups: {
        id: string;
        name: string;
        type: "simple";
        presets: string[];
      }[] = [];
    for (const group of Object.keys(cameraGroups) as CameraGroup[]) {
      const ids: string[] = [];
      for (const camera of this.program.cameras.length
        ? this.program.cameras.map((input) => input.value)
        : [1]) {
        for (const parameter of cameraParameters.filter(
          (parameter) => parameter.group === group,
        )) {
          const variants = parameter.trigger
            ? [
                {
                  id: "trigger",
                  label: parameter.short,
                  operation: "trigger" as const,
                  value: 0,
                },
              ]
            : parameter.choices
              ? parameter.choices.map((choice) => ({
                  id: String(choice.value),
                  label: choice.name,
                  operation: "set" as const,
                  value: choice.value,
                }))
              : [
                  {
                    id: "down",
                    label: parameter.short + " −",
                    operation: "decrease" as const,
                    value: parameter.step,
                  },
                  {
                    id: "up",
                    label: parameter.short + " +",
                    operation: "increase" as const,
                    value: parameter.step,
                  },
                  {
                    id: "dial",
                    label: parameter.short + " / Dial",
                    operation: "set" as const,
                    value: parameter.default,
                  },
                ];
          const actionId = `camera_${group}` as const;
          const options = (
            operation: CameraOptions["operation"],
            value: number,
          ): CameraActionOptions => ({
            camera,
            parameter: parameter.id,
            operation,
            value,
            channel: 3,
            display: 2,
            ...(parameter.displays ? { overlay: value } : {}),
          });
          for (const variant of variants) {
            const id =
              "camera_" + camera + "_" + parameter.id + "_" + variant.id;
            ids.push(id);
            definitions[id] = {
              type: "simple",
              name: "CAM " + camera + " · " + variant.label,
              style: {
                text: "CAM " + camera + "\n" + variant.label,
                size: "auto",
                color: 0xffffff,
                bgcolor: 0x253346,
                show_topbar: false,
              },
              steps: [
                {
                  down: [
                    {
                      actionId,
                      options: options(variant.operation, variant.value),
                    },
                  ],
                  up: [],
                  ...(variant.id === "dial"
                    ? {
                        rotate_left: [
                          {
                            actionId,
                            options: options("decrease", parameter.step),
                          },
                        ],
                        rotate_right: [
                          {
                            actionId,
                            options: options("increase", parameter.step),
                          },
                        ],
                      }
                    : {}),
                },
              ],
              feedbacks: [
                {
                  feedbackId: "camera_available",
                  options: {},
                  style: { bgcolor: 0x23513c, color: 0xffffff },
                },
              ],
            };
          }
        }
      }
      groups.push({
        id: "camera_" + group,
        name: cameraGroups[group],
        type: "simple",
        presets: ids,
      });
    }
    for (const tab of this.snapshot.playback?.tabs ??
      [...this.knownTabs].map((id) => ({ id, sourceKind: "video" }))) {
      const ids: string[] = [],
        id = tab.id;
      for (const action of [
        "toggle",
        "play",
        "pause",
        "stop",
        "restart",
      ] as const) {
        const key = `tab_${id}_${action}`;
        ids.push(key);
        definitions[key] = {
          type: "simple",
          name: `Tab ${id} ${transportNames[action]}`,
          style: {
            text: `${transportNames[action].split(" and ")[0]}\n$(${this.label}:tab_${id}_filename)\n$(${this.label}:tab_${id}_position)`,
            size: "auto",
            color: 0xffffff,
            bgcolor: 0x153a59,
            show_topbar: false,
          },
          steps: [
            { down: [{ actionId: action, options: { tab: id } }], up: [] },
          ],
          feedbacks: [
            {
              feedbackId: "playing",
              options: { tab: id },
              style: { bgcolor: 0xb02727 },
            },
            {
              feedbackId: "busy",
              options: { tab: id },
              style: { bgcolor: 0xb36a00 },
            },
            {
              feedbackId: "offline",
              options: {},
              style: { bgcolor: 0x444444, color: 0xbbbbbb },
            },
          ],
        };
      }
      if (tab.sourceKind === "audio") {
        const key = `tab_${id}_volume`;
        ids.push(key);
        definitions[key] = {
          type: "simple",
          name: `Tab ${id} Audio volume dial`,
          style: {
            text: `VOLUME\n$(${this.label}:tab_${id}_volume)%`,
            size: "auto",
            color: 0xffffff,
            bgcolor: 0x176b34,
            show_topbar: false,
          },
          steps: [
            {
              down: [],
              up: [],
              rotate_left: [
                {
                  actionId: "volume",
                  options: { tab: id, value: -5, relative: true },
                },
              ],
              rotate_right: [
                {
                  actionId: "volume",
                  options: { tab: id, value: 5, relative: true },
                },
              ],
            },
          ],
          feedbacks: [
            {
              feedbackId: "offline",
              options: {},
              style: { bgcolor: 0x444444 },
            },
          ],
        };
      } else {
        const key = `tab_${id}_jog`;
        ids.push(key);
        const jog = (
          amount: number,
        ): CompanionPresetAction<ModuleSchema["actions"]> => ({
          actionId: "jog",
          options: { tab: id, amount, unit: "frames" },
        });
        definitions[key] = {
          type: "simple",
          name: `Tab ${id} Video jog dial`,
          style: {
            text: `JOG\n$(${this.label}:tab_${id}_filename)\n$(${this.label}:tab_${id}_position)`,
            size: "auto",
            color: 0xffffff,
            bgcolor: 0x153a59,
            show_topbar: false,
          },
          steps: [
            {
              down: [{ actionId: "play_pause", options: { tab: id } }],
              up: [],
              rotate_left: [jog(-1)],
              rotate_right: [jog(1)],
            },
          ],
          feedbacks: [
            {
              feedbackId: "playing",
              options: { tab: id },
              style: { bgcolor: 0xb02727 },
            },
            {
              feedbackId: "offline",
              options: {},
              style: { bgcolor: 0x444444 },
            },
          ],
        };
      }
      groups.push({
        id: `tab_${id}`,
        name: `Tab ${id}`,
        type: "simple",
        presets: ids,
      });
    }
    const headphonePresets = [
      "headphones_mute",
      "headphones_down",
      "headphones_up",
      "headphones_dial",
    ];
    for (const id of headphonePresets) {
      const volumeAction = (
        value: number,
      ): CompanionPresetAction<ModuleSchema["actions"]> => ({
        actionId: "headphones_volume",
        options: { value, relative: true },
      });
      const muteAction: CompanionPresetAction<ModuleSchema["actions"]> = {
        actionId: "headphones_mute",
        options: { mode: "toggle" },
      };
      definitions[id] = {
        type: "simple",
        name: {
          headphones_mute: "Headphones mute toggle",
          headphones_down: "Headphones volume −1 dB",
          headphones_up: "Headphones volume +1 dB",
          headphones_dial: "Headphones volume dial / mute",
        }[id]!,
        style: {
          text: `PHONES${id === "headphones_down" ? " −" : id === "headphones_up" ? " +" : ""}\n$(${this.label}:atem_headphones_volume) dB`,
          size: "auto",
          color: 0xbbbbbb,
          bgcolor: 0x444444,
          show_topbar: false,
        },
        steps: [
          {
            down: [
              id === "headphones_down"
                ? volumeAction(-1)
                : id === "headphones_up"
                  ? volumeAction(1)
                  : muteAction,
            ],
            up: [],
            ...(id === "headphones_dial"
              ? {
                  rotate_left: [volumeAction(-1)],
                  rotate_right: [volumeAction(1)],
                }
              : {}),
          },
        ],
        feedbacks: [
          {
            feedbackId: "headphones_available",
            options: {},
            style: { bgcolor: 0x176b34, color: 0xffffff },
          },
          {
            feedbackId: "headphones_muted",
            options: {},
            style: { bgcolor: 0xb02727, color: 0xffffff },
          },
        ],
      };
    }
    groups.push({
      id: "headphones",
      name: "ATEM Headphones",
      type: "simple",
      presets: headphonePresets,
    });
    definitions.replay_start = {
      type: "simple",
      name: "Replay (app settings and default clip)",
      style: {
        text: "REPLAY\n15 SEC",
        size: "auto",
        color: 0xffffff,
        bgcolor: 0x5d245e,
        show_topbar: false,
      },
      steps: [
        {
          down: [
            {
              actionId: "replay_start",
              options: {
                path: "",
                mode: "configured",
                tab: this.replayTabs()[0]?.id ?? 1,
                studioRouting: false,
                studioBefore: "unchanged",
                studioAfter: "unchanged",
                replayRouting: false,
              },
            },
          ],
          up: [],
        },
      ],
      feedbacks: [
        {
          feedbackId: "replay_busy",
          options: {},
          style: { bgcolor: 0xb02727 },
        },
        { feedbackId: "offline", options: {}, style: { bgcolor: 0x444444 } },
      ],
    };
    definitions.replay_stop = {
      type: "simple",
      name: "Stop this connection’s replay",
      style: {
        text: "STOP\nREPLAY",
        size: "auto",
        color: 0xffffff,
        bgcolor: 0x5d245e,
        show_topbar: false,
      },
      steps: [{ down: [{ actionId: "replay_stop", options: {} }], up: [] }],
      feedbacks: [],
    };
    groups.push({
      id: "replay",
      name: "Replay",
      type: "simple",
      presets: ["replay_start", "replay_stop"],
    });
    for (const id of [...this.knownChatTabs].sort((a, b) => a - b)) {
      const v = (key: string) => `$(${this.label}:chat_${id}_${key})`;
      const onAir = (feedbackId: "chat_on_air" | "chat_preview_on_air") => ({
        feedbackId,
        options: { tab: id },
        style: { bgcolor: 0xb02727, color: 0xffffff },
      });
      const ready = {
        feedbackId: "chat_ready" as const,
        options: { tab: id },
        style: { bgcolor: 0x176b34, color: 0xffffff },
      };
      const offline = {
        feedbackId: "offline" as const,
        options: {},
        style: { bgcolor: 0x444444, color: 0xbbbbbb },
      };
      const style = (text: string) => ({
        text,
        size: "auto" as const,
        color: 0xffffff,
        bgcolor: 0x2b3440,
        show_topbar: false,
      });
      const ids = [
        `chat_${id}_latest`,
        `chat_${id}_highlight`,
        `chat_${id}_hide`,
        `chat_${id}_dial`,
      ];
      for (const pick of ["latest", "highlight"] as const)
        definitions[`chat_${id}_${pick}`] = {
          type: "simple",
          name:
            pick === "latest"
              ? `Chat tab ${id}: show latest / hide`
              : `Chat tab ${id}: show Super Chat / hide`,
          style: style(
            pick === "latest"
              ? `CHAT\nLATEST\n${v("on_air_author")}`
              : `SUPER\nCHAT\n${v("latest_highlight_author")}`,
          ),
          steps: [
            {
              down: [{ actionId: "chat_toggle", options: { tab: id, pick } }],
              up: [],
            },
          ],
          feedbacks: [ready, onAir("chat_on_air"), offline],
        };
      definitions[`chat_${id}_hide`] = {
        type: "simple",
        name: `Chat tab ${id}: hide`,
        style: style("HIDE\nCHAT"),
        steps: [
          { down: [{ actionId: "chat_hide", options: { tab: id } }], up: [] },
        ],
        feedbacks: [onAir("chat_on_air"), offline],
      };
      const browse = (
        steps: number,
      ): CompanionPresetAction<ModuleSchema["actions"]> => ({
        actionId: "chat_browse",
        options: { tab: id, steps },
      });
      definitions[`chat_${id}_dial`] = {
        type: "simple",
        name: `Chat tab ${id}: browse dial (press = on air / hide)`,
        style: style(
          `${v("preview_position")}\n${v("preview_author")}\n${v("preview_text")}`,
        ),
        steps: [
          {
            down: [{ actionId: "chat_preview", options: { tab: id } }],
            up: [],
            rotate_left: [browse(-1)],
            rotate_right: [browse(1)],
          },
        ],
        feedbacks: [onAir("chat_preview_on_air"), offline],
      };
      groups.push({
        id: `chat_${id}`,
        name: `Chat tab ${id}`,
        type: "simple",
        presets: ids,
      });
    }
    this.setPresetDefinitions(
      [{ id: "studio", name: "Saccani Live Studio", definitions: groups }],
      definitions,
    );
  }
}
