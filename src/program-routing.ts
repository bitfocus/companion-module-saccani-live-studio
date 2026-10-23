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
export type ReplayOutputOptions = {
  replayRouting?: boolean;
  replayAux?: number;
  replaySource?: number;
};
export type ProgramRoute = {
  deferReturn?: boolean;
  prepare(): Promise<void>;
  before(): Promise<void>;
  after(): Promise<void>;
  rollback(): Promise<void>;
};
type Switcher = Pick<Atem, "state" | "changeProgramInput">;
type AuxSwitcher = Pick<Atem, "state" | "setAuxSource">;

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

export function auxOutputs(atem: AuxSwitcher | undefined) {
  return (atem?.state?.video.auxilliaries ?? []).flatMap((source, index) =>
    source === undefined
      ? []
      : [{ id: index + 1, label: `SRC OUT ${index + 1}` }],
  );
}
export function auxSources(atem: AuxSwitcher | undefined) {
  return Object.values(atem?.state?.inputs ?? {})
    .filter(
      (input) =>
        input &&
        (input.sourceAvailability & Enums.SourceAvailability.Auxiliary) !== 0,
    )
    .map((input) => ({
      id: input!.inputId,
      label: input!.longName.trim() || `Source ${input!.inputId}`,
    }));
}
export function validateReplayOutput(
  atem: AuxSwitcher,
  options: ReplayOutputOptions,
): void {
  if (options.replayRouting !== true) return;
  if (
    !Number.isInteger(options.replayAux) ||
    !auxOutputs(atem).some((output) => output.id === options.replayAux)
  )
    throw new Error("The selected SRC OUT output is unavailable on this ATEM.");
  if (
    !Number.isInteger(options.replaySource) ||
    !auxSources(atem).some((input) => input.id === options.replaySource)
  )
    throw new Error("Select an available source for SRC OUT.");
}
async function changeAux(
  atem: AuxSwitcher,
  source: number,
  bus: number,
  timeout = 3000,
): Promise<void> {
  await atem.setAuxSource(source, bus);
  const deadline = Date.now() + timeout;
  while (atem.state?.video.auxilliaries[bus] !== source) {
    if (Date.now() >= deadline)
      throw new Error("ATEM did not confirm the SRC OUT change.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
/** Program and SRC OUT routing share confirmed replay startup and the app's output-return acknowledgement. */
export function createReplayRoute(
  atem: Switcher & AuxSwitcher,
  options: RoutingOptions & ReplayOutputOptions,
  enqueue: (work: () => Promise<void>) => Promise<void>,
): ProgramRoute | undefined {
  const program = hasProgramRouting(options)
    ? createProgramRoute(atem, options, enqueue)
    : undefined;
  if (options.replayRouting !== true) return program;
  validateReplayOutput(atem, options);
  const bus = options.replayAux! - 1;
  let previous: number | undefined;
  let attempted = false;
  const restore = () =>
    enqueue(async () => {
      if (!attempted) return;
      if (previous === undefined)
        throw new Error("Previous SRC OUT source unavailable.");
      await changeAux(atem, previous, bus);
    });
  return {
    deferReturn: true,
    prepare: async () => {
      await program?.prepare();
      await enqueue(async () => {
        validateReplayOutput(atem, options);
        previous = atem.state?.video.auxilliaries[bus];
        if (previous === undefined)
          throw new Error("Selected SRC OUT output unavailable.");
      });
    },
    before: async () => {
      await enqueue(async () => {
        attempted = true;
        await changeAux(atem, options.replaySource!, bus);
      });
      await program?.before();
    },
    after: async () => {
      try {
        await program?.after();
      } finally {
        await restore();
      }
    },
    rollback: async () => {
      try {
        await program?.rollback();
      } finally {
        await restore();
      }
    },
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
  get auxOutputs() {
    return this.online ? auxOutputs(this.atem) : [];
  }
  get auxSources() {
    return this.online ? auxSources(this.atem) : [];
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
  replayRoute(
    options: RoutingOptions & ReplayOutputOptions,
  ): ProgramRoute | undefined {
    if (!hasProgramRouting(options) && options.replayRouting !== true)
      return undefined;
    const atem = this.atem;
    if (!atem || !this.online)
      throw new Error(
        "ATEM offline: configure its IP address and connect before starting routed replay.",
      );
    return createReplayRoute(atem, options, (work) => this.enqueue(atem, work));
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
