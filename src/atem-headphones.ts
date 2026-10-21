import { AtemConnectionStatus, type Atem } from "atem-connection";
import type { AtemState } from "atem-connection/dist/state/index.js";

export type HeadphoneMuteMode = "toggle" | "mute" | "unmute";
export type HeadphoneSwitcher = Pick<
  Atem,
  "state" | "status" | "setFairlightAudioMixerMonitorProps"
>;
export const MIN_HEADPHONE_DB = -60;
export const MAX_HEADPHONE_DB = 10;

export function headphoneState(
  state: AtemState | undefined,
): { volumeDb: number; muted: boolean } | undefined {
  const monitor = state?.fairlight?.monitor;
  if (
    !monitor ||
    !Number.isFinite(monitor.gain) ||
    typeof monitor.inputMasterMuted !== "boolean"
  )
    return;
  return { volumeDb: monitor.gain / 100, muted: monitor.inputMasterMuted };
}
function current(atem: HeadphoneSwitcher) {
  if (atem.status !== AtemConnectionStatus.CONNECTED)
    throw new Error("ATEM is offline");
  const value = headphoneState(atem.state);
  if (!value) throw new Error("Headphone control unavailable on this ATEM");
  return value;
}
async function confirm(
  atem: HeadphoneSwitcher,
  matches: (value: NonNullable<ReturnType<typeof headphoneState>>) => boolean,
  timeout: number,
) {
  const deadline = Date.now() + timeout;
  while (!matches(current(atem))) {
    if (Date.now() >= deadline)
      throw new Error("ATEM did not confirm the headphone change");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
export async function setHeadphoneVolume(
  atem: HeadphoneSwitcher,
  value: number,
  relative = false,
  timeout = 3000,
): Promise<void> {
  if (
    !Number.isFinite(value) ||
    typeof relative !== "boolean" ||
    (!relative && (value < MIN_HEADPHONE_DB || value > MAX_HEADPHONE_DB))
  )
    throw new Error("Invalid headphone volume");
  const previous = current(atem);
  const gain = Math.round(
    Math.max(
      MIN_HEADPHONE_DB,
      Math.min(MAX_HEADPHONE_DB, relative ? previous.volumeDb + value : value),
    ) * 100,
  );
  if (Math.round(previous.volumeDb * 100) === gain) return;
  await atem.setFairlightAudioMixerMonitorProps({ gain });
  await confirm(
    atem,
    (state) => Math.round(state.volumeDb * 100) === gain,
    timeout,
  );
}
/** Mutes the Program feed into the headphones, preserving volume and talkback/sidetone settings. */
export async function setHeadphoneMute(
  atem: HeadphoneSwitcher,
  mode: HeadphoneMuteMode,
  timeout = 3000,
): Promise<void> {
  if (!["toggle", "mute", "unmute"].includes(mode))
    throw new Error("Invalid headphone mute mode");
  const previous = current(atem);
  const muted = mode === "toggle" ? !previous.muted : mode === "mute";
  if (previous.muted === muted) return;
  await atem.setFairlightAudioMixerMonitorProps({ inputMasterMuted: muted });
  await confirm(atem, (state) => state.muted === muted, timeout);
}
