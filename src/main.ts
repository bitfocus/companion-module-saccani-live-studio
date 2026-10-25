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
import {
  ChatBrowser,
  keyCommand,
  pickMessage,
  type ChatMessage,
  type ChatPick,
} from "./chat.js";
type Config = { replayFile: string; url: string };
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
    [K in TransportActions]: { options: { tab: number } };
  } & {
    jog: {
      options: { tab: number; amount: number; unit: "seconds" | "frames" };
    };
    volume: { options: { tab: number; value: number; relative: boolean } };
    replay_start: {
      options: {
        path: string;
        mode: "configured" | "source";
        tab: number;
      };
    };
    replay_stop: { options: Record<string, never> };
    chat_toggle: { options: { tab: number; pick: ChatPick } };
    chat_hide: { options: { tab: number } };
    chat_browse: { options: { tab: number; steps: number } };
    chat_preview: { options: { tab: number } };
  };
  feedbacks: {
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
  private knownChatTabs = new Set<number>();
  private chatBrowser = new ChatBrowser();
  private lastError = "";
  constructor(internal: unknown) {
    super(internal);
  }
  getConfigFields(): SomeCompanionConfigField[] {
    return [
      {
        type: "static-text",
        id: "help",
        label: "Saccani Live Studio connection",
        width: 12,
        value:
          "For HTTP / WebSocket, enable Settings… → Remote Control in the app. Leave the token blank unless Require access token is enabled in the app. Enable LAN access for Companion on another computer. Load media and open video outputs in the app. Replay paths always belong to the app Mac.",
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
    await oldClient?.close();
    if (generation !== this.generation) return;
    this.config = {
      url: config.url || "http://127.0.0.1:8765",
      replayFile: config.replayFile || "",
    };
    this.snapshot = {};
    this.lastError = "";
    this.tabSignature = "";
    this.chatBrowser.clear();
    this.definitions();
    try {
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
    await client?.close();
  }
  private async poll(generation: number): Promise<void> {
    const client = this.client;
    if (!client || generation !== this.generation) return;
    try {
      const snapshot = await client.snapshot();
      if (generation !== this.generation) return;
      this.snapshot = snapshot;
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
  private reportError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.log("warn", this.lastError);
    this.setVariableValues({ last_error: this.lastError });
  }
  private sourceID(id: number): string | undefined {
    return this.snapshot.playback?.tabs.find((tab) => tab.id === id)?.sourceID;
  }
  private definitions(): void {
    const transportAction = (
      id: TransportActions,
    ): CompanionActionDefinition<{ tab: number }> => ({
      name: transportNames[id],
      options: [this.tabField()],
      callback: (event) => {
        const tab = Number(event.options.tab),
          sourceID = this.sourceID(tab);
        return this.execute((client) =>
          client.transport(
            tab,
            (id === "play_pause" ? "play-pause" : id) as Transport,
            sourceID,
          ),
        );
      },
    });
    this.setActionDefinitions({
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
      playing: tabFeedback("playing"),
      ready: tabFeedback("ready"),
      busy: tabFeedback("busy"),
      output: tabFeedback("output"),
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
      replay_tab: { name: "Configured replay tab" },
    };
    for (const id of this.knownTabs)
      for (const [key, name] of Object.entries(variableNames))
        variables[`tab_${id}_${key}`] = { name: `Tab ${id}: ${name}` };
    for (const id of this.knownChatTabs)
      for (const [key, name] of Object.entries(chatVariableNames))
        variables[`chat_${id}_${key}`] = { name: `Chat tab ${id}: ${name}` };
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
