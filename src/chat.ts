export type ChatMessage = {
  id: string;
  author: string;
  text: string;
  highlight: string | null;
  badges: string[];
};
export type ChatTab = {
  id: number;
  connected: boolean;
  live: boolean;
  mode: string;
  status: string;
  onAir: ChatMessage | null;
  messages: ChatMessage[];
};
export type ChatStatus = { seenAt: number; chatControl: true; tabs: ChatTab[] };
/** Which message a key press puts on air. */
export type ChatPick = "latest" | "highlight";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validMessage(value: unknown): value is ChatMessage {
  return (
    record(value) &&
    typeof value.id === "string" &&
    !!value.id &&
    typeof value.author === "string" &&
    typeof value.text === "string" &&
    (value.highlight === null || typeof value.highlight === "string") &&
    Array.isArray(value.badges) &&
    value.badges.every((badge) => typeof badge === "string")
  );
}
export function validChat(
  value: unknown,
  now = Date.now() / 1000,
): value is ChatStatus {
  if (
    !record(value) ||
    value.chatControl !== true ||
    typeof value.seenAt !== "number" ||
    !Number.isFinite(value.seenAt) ||
    Math.abs(now - value.seenAt) > 3 ||
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
      typeof tab.connected === "boolean" &&
      typeof tab.live === "boolean" &&
      typeof tab.mode === "string" &&
      typeof tab.status === "string" &&
      (tab.onAir === null || validMessage(tab.onAir)) &&
      Array.isArray(tab.messages) &&
      tab.messages.every(validMessage)
    );
  });
}
export function chatTab(
  status: ChatStatus | undefined,
  id: number,
  showing = false,
): ChatTab {
  if (!status)
    throw new Error(
      "Open Saccani Live Studio 0.23.0 or later to control the chat.",
    );
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error("Select the Saccani Live Studio chat tab.");
  const tab = status.tabs.find((item) => item.id === id);
  if (!tab)
    throw new Error(`Choose Chat as the source in tab ${id} of the app.`);
  if (showing && tab.mode !== "highlight")
    throw new Error(
      `Tab ${id} shows the chat as a feed: switch it to Highlight in the app.`,
    );
  return tab;
}
export function pickMessage(
  tab: ChatTab,
  pick: ChatPick = "latest",
): ChatMessage | undefined {
  for (let index = tab.messages.length - 1; index >= 0; index--) {
    const message = tab.messages[index]!;
    if (pick !== "highlight" || message.highlight) return message;
  }
  return undefined;
}
/** A key shows the chosen message, or hides whatever is on air. */
export function keyCommand(
  tab: ChatTab,
  pick: ChatPick = "latest",
): { action: "chat-hide" } | { action: "chat-show"; message: ChatMessage } {
  if (tab.onAir) return { action: "chat-hide" };
  const message = pickMessage(tab, pick);
  if (!message)
    throw new Error(
      pick === "highlight"
        ? "No Super Chat or membership in the chat yet."
        : "No chat messages yet.",
    );
  return { action: "chat-show", message };
}

/**
 * Browsing position per chat tab. Without a chosen message the preview follows the newest one;
 * after browsing back it stays on that message while new ones arrive.
 */
export class ChatBrowser {
  private cursors = new Map<number, string>();
  position(tab: ChatTab): {
    message?: ChatMessage;
    index: number;
    total: number;
    following: boolean;
  } {
    const total = tab.messages.length,
      id = this.cursors.get(tab.id);
    const index =
      id === undefined
        ? -1
        : tab.messages.findIndex((message) => message.id === id);
    // A deleted or expired message returns the preview to the newest one.
    if (index < 0) {
      this.cursors.delete(tab.id);
      return {
        message: tab.messages[total - 1],
        index: total - 1,
        total,
        following: true,
      };
    }
    return { message: tab.messages[index], index, total, following: false };
  }
  move(tab: ChatTab, steps: number): void {
    if (!Number.isSafeInteger(steps) || Math.abs(steps) > 1000)
      throw new Error("Invalid chat browsing step.");
    const total = tab.messages.length;
    if (!total || !steps) return;
    const next = Math.max(
      0,
      Math.min(total - 1, this.position(tab).index + steps),
    );
    if (next === total - 1) this.cursors.delete(tab.id);
    else this.cursors.set(tab.id, tab.messages[next]!.id);
  }
  /** The previewed message goes on air, or comes off air when it is already there. */
  press(
    tab: ChatTab,
  ): { action: "chat-hide" } | { action: "chat-show"; message: ChatMessage } {
    const { message } = this.position(tab);
    if (!message) throw new Error("No chat messages yet.");
    return tab.onAir?.id === message.id
      ? { action: "chat-hide" }
      : { action: "chat-show", message };
  }
  clear(): void {
    this.cursors.clear();
  }
}
