import { Atem, AtemConnectionStatus, Enums } from "atem-connection";
import {
  CameraControl,
  cameraAvailable,
  cameraInputs,
  type CameraOptions,
} from "./atem-camera.ts";

import {
  headphoneState,
  setHeadphoneVolume,
  setHeadphoneMute,
  type HeadphoneMuteMode,
} from "./atem-headphones.ts";

export const RESTORE_PREVIOUS_INPUT = "restore-previous";
export type RoutingOptions = {
  studioRouting?: boolean;
  studioBefore?: number | "unchanged";
  studioAfter?: number | "unchanged" | typeof RESTORE_PREVIOUS_INPUT;
};
export type ProgramRoute = {
  deferReturn?: boolean;
  prepare(): Promise<void>;
  before(): Promise<void>;
  after(): Promise<void>;
  rollback(): Promise<void>;
};
type Switcher = Pick<Atem, "state" | "changeProgramInput">;

export function hasProgramRouting(options: RoutingOptions): boolean {
  return (
    options.studioRouting === true &&
    [options.studioBefore, options.studioAfter].some(
      (value) => value !== undefined && value !== "unchanged",
    )
  );
}
export function programInputs(atem: Switcher | undefined) {
  return Object.values(atem?.state?.inputs ?? {})
    .filter(
      (input) =>
        input && (input.meAvailability & Enums.MeAvailability.Me1) !== 0,
    )
    .map((input) => ({
      id: input!.inputId,
      label: input!.longName.trim() || `Source ${input!.inputId}`,
    }));
}
export function validateProgramRouting(
  atem: Switcher,
  options: RoutingOptions,
): void {
  if (!atem.state?.video.mixEffects[0])
    throw new Error("ATEM Program unavailable.");
  const choices = programInputs(atem);
  for (const field of ["studioBefore", "studioAfter"] as const) {
    const value = options[field];
    if (
      value === undefined ||
      value === "unchanged" ||
      (field === "studioAfter" && value === RESTORE_PREVIOUS_INPUT)
    )
      continue;
    if (
      !Number.isInteger(value) ||
      !choices.some((input) => input.id === value)
    ) {
      throw new Error(
        `ATEM input ${field === "studioBefore" ? "before" : "after"} playback unavailable: choose a valid source.`,
      );
    }
  }
}
export async function changeProgram(
  atem: Switcher,
  input: number | undefined,
  timeout = 3000,
): Promise<void> {
  if (input === undefined) return;
  validateProgramRouting(atem, { studioBefore: input });
  await atem.changeProgramInput(input);
  const deadline = Date.now() + timeout;
  while (atem.state?.video.mixEffects[0]?.programInput !== input) {
    if (Date.now() >= deadline)
      throw new Error("ATEM did not confirm the Program change.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
export function createProgramRoute(
  atem: Switcher,
  options: RoutingOptions,
  enqueue: (work: () => Promise<void>) => Promise<void>,
): ProgramRoute {
  validateProgramRouting(atem, options);
  const before =
    options.studioBefore === "unchanged" ? undefined : options.studioBefore;
  const after =
    options.studioAfter === "unchanged" ? undefined : options.studioAfter;
  let previous: number | undefined;
  let attempted = false;
  return {
    deferReturn: after !== undefined,
    prepare: () =>
      enqueue(async () => {
        previous = atem.state?.video.mixEffects[0]?.programInput;
        if (after === RESTORE_PREVIOUS_INPUT) {
          if (previous === undefined)
            throw new Error("ATEM previous Program input unavailable.");
          validateProgramRouting(atem, { studioBefore: previous });
        }
      }),
    before: () =>
      enqueue(async () => {
        attempted = before !== undefined;
        await changeProgram(atem, before);
      }),
    after: () =>
      enqueue(async () => {
        if (after === RESTORE_PREVIOUS_INPUT && previous === undefined)
          throw new Error(
            "No previous Program input was captured for this playback.",
          );
        await changeProgram(
          atem,
          after === RESTORE_PREVIOUS_INPUT ? previous : after,
        );
      }),
    rollback: () =>
      !attempted || previous === undefined
        ? Promise.resolve()
        : enqueue(() => changeProgram(atem, previous)),
  };
}

/** Keep the UDP library intact; disable its separate worker/process transport. */
export class ATEMProgramConnection {
  readonly camera = new CameraControl();
  private atem?: Atem;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private readonly changed: () => void;
  private readonly error: (error: unknown) => void;
  private readonly create: () => Atem;
  constructor(
    changed: () => void,
    error: (error: unknown) => void,
    create: () => Atem = () => new Atem({ disableMultithreaded: true }),
  ) {
    this.changed = changed;
    this.error = error;
    this.create = create;
  }
  get online(): boolean {
    return this.atem?.status === AtemConnectionStatus.CONNECTED;
  }
  get input(): number | undefined {
    return this.online
      ? this.atem?.state?.video.mixEffects[0]?.programInput
      : undefined;
  }
  get inputs() {
    return this.online ? programInputs(this.atem) : [];
  }
  get headphones() {
    return this.online ? headphoneState(this.atem?.state) : undefined;
  }
  get cameras() {
    return this.online && this.atem ? cameraInputs(this.atem) : [];
  }
  get cameraAvailable() {
    return !!this.atem && cameraAvailable(this.atem);
  }
  cameraCommand(options: CameraOptions): Promise<void> {
    const atem = this.atem;
    if (!atem) return Promise.reject(new Error("ATEM offline"));
    return this.enqueue(atem, () => this.camera.apply(atem, options));
  }
  headphoneVolume(value: number, relative: boolean): Promise<void> {
    const atem = this.atem;
    if (!atem) return Promise.reject(new Error("ATEM offline"));
    return this.enqueue(atem, () => setHeadphoneVolume(atem, value, relative));
  }
  headphoneMute(mode: HeadphoneMuteMode): Promise<void> {
    const atem = this.atem;
    if (!atem) return Promise.reject(new Error("ATEM offline"));
    return this.enqueue(atem, () => setHeadphoneMute(atem, mode));
  }
  private enqueue(atem: Atem, work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(async () => {
      if (this.atem !== atem || !this.online)
        throw new Error("ATEM connection changed or is offline.");
      await work();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  async configure(host: string): Promise<void> {
    const generation = ++this.generation;
    await this.closeTransport();
    if (generation !== this.generation) return;
    if (!host) return;
    if (
      !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
      host.split(".").some((part) => Number(part) > 255)
    )
      throw new Error("Enter a valid ATEM IPv4 address or leave it blank.");
    const atem = this.create();
    this.atem = atem;
    atem.on("receivedCommands", (commands) => {
      if (this.atem === atem && this.camera.receive(commands)) this.changed();
    });
    atem.on("disconnected", () => {
      if (this.atem === atem) this.camera.reset();
    });
    for (const event of ["connected", "disconnected", "stateChanged"] as const)
      atem.on(event, () => {
        if (this.atem === atem) this.changed();
      });
    atem.on("error", (error) => {
      if (this.atem === atem) this.error(error);
    });
    void atem.connect(host).catch((error) => {
      if (this.atem === atem) this.error(error);
    });
  }
  route(options: RoutingOptions): ProgramRoute | undefined {
    if (!hasProgramRouting(options)) return undefined;
    const atem = this.atem;
    if (!atem || !this.online)
      throw new Error(
        "ATEM offline: configure its IP address and connect before starting routed playback.",
      );
    return createProgramRoute(atem, options, (work) =>
      this.enqueue(atem, work),
    );
  }
  async close(): Promise<void> {
    ++this.generation;
    await this.closeTransport();
  }
  private async closeTransport(): Promise<void> {
    const atem = this.atem;
    this.atem = undefined;
    this.camera.reset();
    await this.queue;
    await atem?.destroy();
    this.changed();
  }
}
