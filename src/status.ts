export type StatusRow = {
  id: string;
  label: string;
  value: string;
  text: string;
  alert: boolean;
  acknowledged: boolean;
  blink: boolean;
  alertForeground: string;
  alertBackground: string;
};
export type StatusTab = {
  id: number;
  alert: boolean;
  foreground: string;
  background: string;
  rows: StatusRow[];
};
export type StatusBoard = {
  seenAt: number;
  statusControl: true;
  tabs: StatusTab[];
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function color(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9A-F]{6}$/i.test(value);
}
function validRow(value: unknown): value is StatusRow {
  return (
    record(value) &&
    typeof value.id === "string" &&
    !!value.id &&
    typeof value.label === "string" &&
    typeof value.value === "string" &&
    typeof value.text === "string" &&
    typeof value.alert === "boolean" &&
    typeof value.acknowledged === "boolean" &&
    typeof value.blink === "boolean" &&
    color(value.alertForeground) &&
    color(value.alertBackground)
  );
}
export function validStatusBoard(
  value: unknown,
  now = Date.now() / 1000,
): value is StatusBoard {
  if (
    !record(value) ||
    value.statusControl !== true ||
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
      typeof tab.alert === "boolean" &&
      color(tab.foreground) &&
      color(tab.background) &&
      Array.isArray(tab.rows) &&
      tab.rows.every(validRow)
    );
  });
}
export function statusTab(
  board: StatusBoard | undefined,
  id: number,
): StatusTab {
  if (!board)
    throw new Error(
      "Open Saccani Live Studio 0.22.42 or later to use its Status.",
    );
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error("Select the Saccani Live Studio Status tab.");
  const tab = board.tabs.find((item) => item.id === id);
  if (!tab)
    throw new Error(`Choose Status as the source in tab ${id} of the app.`);
  return tab;
}

/**
 * The row at a 1-based position. Position 0 is the master warning: ALL OK, or the first alert
 * (uncleared first) in its colors, labelled with the number of alerts.
 */
export function statusRow(
  tab: StatusTab | undefined,
  position: number,
): StatusRow | undefined {
  if (!tab) return undefined;
  if (position >= 1) return tab.rows[position - 1];
  const alerts = tab.rows.filter((row) => row.alert);
  const first = alerts.find((row) => !row.acknowledged) ?? alerts[0];
  if (!first)
    return {
      id: "master",
      label: "STATUS",
      value: "ALL OK",
      text: "STATUS  ALL OK",
      alert: false,
      acknowledged: false,
      blink: false,
      alertForeground: tab.foreground,
      alertBackground: tab.background,
    };
  return {
    ...first,
    label: alerts.length > 1 ? `${alerts.length} ALERTS` : "ALERT",
    value: first.text,
  };
}
/** An uncleared blinking alert alternates with the normal colors twice a second, as on the app's panel. */
export function flashing(row: StatusRow, now = Date.now()): boolean {
  return row.alert && row.blink && !row.acknowledged && now % 500 >= 250;
}
const rgb = (hex: string) => parseInt(hex.slice(1), 16);
/** The button style of a row: its text in the panel's colors, or the row's alert colors. */
export function statusStyle(
  tab: StatusTab | undefined,
  row: StatusRow | undefined,
  now = Date.now(),
): { text: string; color: number; bgcolor: number } {
  if (!tab || !row) return { text: "", color: 0xbbbbbb, bgcolor: 0x444444 };
  const alertColors = row.alert && !flashing(row, now);
  return {
    text: row.label ? `${row.label}\n${row.value}` : row.value,
    color: rgb(alertColors ? row.alertForeground : tab.foreground),
    bgcolor: rgb(alertColors ? row.alertBackground : tab.background),
  };
}
