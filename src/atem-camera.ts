import {
  AtemConnectionStatus,
  Commands,
  Enums,
  type Atem,
} from "atem-connection";

// Blackmagic SDI Camera Control Protocol 1.6.2, carried by ATEM CCmd / CCdP.
// https://documents.blackmagicdesign.com/DeveloperManuals/BlackmagicCameraControl.pdf
export const cameraGroups = {
  lens: "Blackmagic Camera · Lens",
  exposure: "Blackmagic Camera · Exposure",
  whitebalance: "Blackmagic Camera · White Balance",
  color: "Blackmagic Camera · Color",
  monitor: "Blackmagic Camera · Monitor",
} as const;
export type CameraGroup = keyof typeof cameraGroups;
export type CameraOperation = "set" | "increase" | "decrease" | "trigger";
export type CameraOptions = {
  camera: number;
  parameter: string;
  operation: CameraOperation;
  value: number;
  channel: number;
  display?: number;
};
export type CameraParameter = {
  id: string;
  group: CameraGroup;
  name: string;
  short: string;
  category: number;
  parameter: number;
  type: Commands.CameraControlDataType;
  min: number;
  max: number;
  default: number;
  step: number;
  unit: string;
  scale?: number;
  index?: number;
  length?: number;
  channels?: boolean;
  trigger?: boolean;
  displays?: boolean;
  choices?: { value: number; name: string }[];
};
const { FLOAT, SINT8, SINT16, SINT32, BOOL } = Commands.CameraControlDataType;
export const cameraParameters: CameraParameter[] = [
  {
    id: "focus",
    group: "lens",
    name: "Focus (near → far)",
    short: "FOCUS",
    category: 0,
    parameter: 0,
    type: FLOAT,
    min: 0,
    max: 100,
    default: 50,
    step: 1,
    unit: "%",
    scale: 0.01,
  },
  {
    id: "autofocus",
    group: "lens",
    name: "Auto focus",
    short: "AUTO FOCUS",
    category: 0,
    parameter: 1,
    type: BOOL,
    min: 0,
    max: 0,
    default: 0,
    step: 0,
    unit: "",
    trigger: true,
  },
  {
    id: "zoom",
    group: "lens",
    name: "Zoom position (wide → tele)",
    short: "ZOOM",
    category: 0,
    parameter: 8,
    type: FLOAT,
    min: 0,
    max: 100,
    default: 0,
    step: 1,
    unit: "%",
    scale: 0.01,
  },
  {
    id: "iris",
    group: "exposure",
    name: "Iris opening (closed → open)",
    short: "IRIS",
    category: 0,
    parameter: 3,
    type: FLOAT,
    min: 0,
    max: 100,
    default: 50,
    step: 1,
    unit: "%",
    scale: 0.01,
  },
  {
    id: "autoiris",
    group: "exposure",
    name: "Auto iris",
    short: "AUTO IRIS",
    category: 0,
    parameter: 5,
    type: BOOL,
    min: 0,
    max: 0,
    default: 0,
    step: 0,
    unit: "",
    trigger: true,
  },
  {
    id: "gain",
    group: "exposure",
    name: "Sensor gain",
    short: "GAIN",
    category: 1,
    parameter: 13,
    type: SINT8,
    min: -128,
    max: 127,
    default: 0,
    step: 1,
    unit: "dB",
  },
  {
    id: "iso",
    group: "exposure",
    name: "ISO",
    short: "ISO",
    category: 1,
    parameter: 14,
    type: SINT32,
    min: 0,
    max: 2147483647,
    default: 400,
    step: 100,
    unit: "ISO",
  },
  {
    id: "exposure",
    group: "exposure",
    name: "Exposure time",
    short: "EXPOSURE",
    category: 1,
    parameter: 5,
    type: SINT32,
    min: 1,
    max: 42000,
    default: 20000,
    step: 100,
    unit: "µs",
  },
  {
    id: "shutterangle",
    group: "exposure",
    name: "Shutter angle",
    short: "SHUTTER",
    category: 1,
    parameter: 11,
    type: SINT32,
    min: 1,
    max: 360,
    default: 180,
    step: 1,
    unit: "°",
    scale: 100,
  },
  {
    id: "shutterspeed",
    group: "exposure",
    name: "Shutter speed (1/value seconds)",
    short: "SHUTTER",
    category: 1,
    parameter: 12,
    type: SINT32,
    min: 1,
    max: 5000,
    default: 50,
    step: 1,
    unit: "1/s",
  },
  {
    id: "temperature",
    group: "whitebalance",
    name: "Color temperature",
    short: "WB",
    category: 1,
    parameter: 2,
    type: SINT16,
    min: 2500,
    max: 10000,
    default: 5600,
    step: 100,
    unit: "K",
    index: 0,
    length: 2,
  },
  {
    id: "tint",
    group: "whitebalance",
    name: "Tint",
    short: "TINT",
    category: 1,
    parameter: 2,
    type: SINT16,
    min: -50,
    max: 50,
    default: 0,
    step: 1,
    unit: "",
    index: 1,
    length: 2,
  },
  {
    id: "autowb",
    group: "whitebalance",
    name: "Auto white balance",
    short: "AUTO WB",
    category: 1,
    parameter: 3,
    type: BOOL,
    min: 0,
    max: 0,
    default: 0,
    step: 0,
    unit: "",
    trigger: true,
  },
  {
    id: "restorewb",
    group: "whitebalance",
    name: "Restore last auto white balance",
    short: "RESTORE WB",
    category: 1,
    parameter: 4,
    type: BOOL,
    min: 0,
    max: 0,
    default: 0,
    step: 0,
    unit: "",
    trigger: true,
  },
  ...(
    [
      ["lift", "Lift / shadows", 0, -2, 2, 0],
      ["gamma", "Gamma / midtones", 1, -4, 4, 0],
      ["colorgain", "Gain / highlights", 2, 0, 15.9995, 1],
      ["offset", "Offset", 3, -8, 8, 0],
    ] as const
  ).map(([id, name, parameter, min, max, initial]) => ({
    id,
    group: "color" as const,
    name,
    short: id === "colorgain" ? "GAIN" : id.toUpperCase(),
    category: 8,
    parameter,
    type: FLOAT,
    min,
    max,
    default: initial,
    step: 0.01,
    unit: "",
    length: 4,
    channels: true,
  })),
  {
    id: "contrast",
    group: "color",
    name: "Contrast",
    short: "CONTRAST",
    category: 8,
    parameter: 4,
    type: FLOAT,
    min: 0,
    max: 2,
    default: 1,
    step: 0.05,
    unit: "",
    index: 1,
    length: 2,
  },
  {
    id: "pivot",
    group: "color",
    name: "Contrast pivot",
    short: "PIVOT",
    category: 8,
    parameter: 4,
    type: FLOAT,
    min: 0,
    max: 100,
    default: 50,
    step: 1,
    unit: "%",
    scale: 0.01,
    index: 0,
    length: 2,
  },
  {
    id: "saturation",
    group: "color",
    name: "Saturation",
    short: "SAT",
    category: 8,
    parameter: 6,
    type: FLOAT,
    min: 0,
    max: 200,
    default: 100,
    step: 1,
    unit: "%",
    scale: 0.01,
    index: 1,
    length: 2,
  },
  {
    id: "hue",
    group: "color",
    name: "Hue",
    short: "HUE",
    category: 8,
    parameter: 6,
    type: FLOAT,
    min: -180,
    max: 180,
    default: 0,
    step: 1,
    unit: "°",
    scale: 1 / 180,
    index: 0,
    length: 2,
  },
  {
    id: "lumamix",
    group: "color",
    name: "Luma mix",
    short: "LUMA MIX",
    category: 8,
    parameter: 5,
    type: FLOAT,
    min: 0,
    max: 100,
    default: 100,
    step: 1,
    unit: "%",
    scale: 0.01,
  },
  {
    id: "resetcolor",
    group: "color",
    name: "Reset color correction",
    short: "RESET COLOR",
    category: 8,
    parameter: 7,
    type: BOOL,
    min: 0,
    max: 0,
    default: 0,
    step: 0,
    unit: "",
    trigger: true,
  },
  {
    id: "info",
    group: "monitor",
    name: "Video information overlay",
    short: "VIDEO INFO",
    category: 3,
    parameter: 0,
    type: SINT16,
    min: 0,
    max: 4,
    default: 1,
    step: 1,
    unit: "",
    length: 2,
    displays: true,
    choices: [
      { value: 0, name: "Hide information and frame guides" },
      { value: 1, name: "Camera information" },
      { value: 3, name: "Camera information + frame guides" },
      { value: 4, name: "Clean feed" },
    ],
  },
  {
    id: "brightness",
    group: "monitor",
    name: "Display brightness",
    short: "BRIGHT",
    category: 4,
    parameter: 0,
    type: FLOAT,
    min: 0,
    max: 100,
    default: 50,
    step: 1,
    unit: "%",
    scale: 0.01,
  },
  {
    id: "colorbars",
    group: "monitor",
    name: "Color bars (0 = off; timeout in seconds)",
    short: "BARS",
    category: 4,
    parameter: 4,
    type: SINT8,
    min: 0,
    max: 30,
    default: 10,
    step: 1,
    unit: "s",
  },
];
export const cameraChannels = ["Red", "Green", "Blue", "Luma"];
export const cameraDisplays = [
  { value: 1, name: "Camera LCD" },
  { value: 2, name: "HDMI output" },
  { value: 4, name: "Viewfinder (EVF)" },
  { value: 8, name: "Main SDI output" },
  { value: 16, name: "Front SDI output" },
  { value: 31, name: "All displays / outputs" },
];
export function cameraParameter(id: string): CameraParameter {
  const parameter = cameraParameters.find((parameter) => parameter.id === id);
  if (!parameter) throw new Error("Choose a valid camera parameter");
  return parameter;
}
export function cameraInputs(atem: Pick<Atem, "state">) {
  return Object.values(atem.state?.inputs ?? {})
    .filter(
      (input) =>
        input &&
        input.inputId > 0 &&
        input.inputId < 255 &&
        input.internalPortType === Enums.InternalPortType.External,
    )
    .map((input) => ({
      value: input!.inputId,
      name: "CAM " + input!.inputId + " · " + input!.longName.trim(),
    }));
}
export function cameraAvailable(atem: Pick<Atem, "state" | "status">): boolean {
  return (
    atem.status === AtemConnectionStatus.CONNECTED &&
    atem.state?.info.capabilities?.cameraControl === true
  );
}
type Switcher = Pick<Atem, "state" | "status" | "sendCommand">;
export class CameraControl {
  private values = new Map<string, { type: number; values: number[] }>();
  reset() {
    this.values.clear();
  }
  private key(camera: number, category: number, parameter: number) {
    return camera + ":" + category + ":" + parameter;
  }
  /** CCdP is not included in atem-connection's normal state tree. Never invent camera feedback. */
  receive(commands: unknown[]): boolean {
    let changed = false;
    for (const command of commands) {
      // Hosts may supply a switcher from a separate copy of atem-connection.
      const update = command as Commands.CameraControlUpdateCommand | undefined;
      if (!update || (update.constructor as typeof Commands.CameraControlUpdateCommand)?.rawName !== "CCdP") continue;
      const { source, category, parameter, properties } = update;
      if (![source,category,parameter].every(value=>Number.isInteger(value)&&value>=0&&value<=255) ||
          !properties || !Array.isArray(properties.numberData) || !properties.numberData.every(Number.isFinite)) continue;
      this.values.set(this.key(source, category, parameter), {
        type: properties.type,
        values: [...properties.numberData],
      });
      changed = true;
    }
    return changed;
  }
  value(
    camera: number,
    id: string,
    channel = 3,
    display = 2,
  ): number | undefined {
    const parameter = cameraParameter(id);
    if (parameter.trigger) return;
    const value = this.values.get(
      this.key(camera, parameter.category, parameter.parameter),
    );
    if (!value || value.type !== parameter.type) return;
    if (parameter.displays && (value.values[1]! & display) !== display) return;
    const raw =
      value.values[parameter.channels ? channel : (parameter.index ?? 0)];
    return Number.isFinite(raw) ? raw! / (parameter.scale ?? 1) : undefined;
  }
  display(camera: number, id: string, channel = 3, display = 2): string {
    const parameter = cameraParameter(id),
      value = this.value(camera, id, channel, display);
    if (parameter.trigger) return "Trigger";
    if (value === undefined) return "No feedback";
    if (parameter.displays)
      return value & 4
        ? "Clean feed"
        : value & 1
          ? value & 2
            ? "Info + guides"
            : "Info ON"
          : "Info OFF";
    if (parameter.choices)
      return (
        parameter.choices.find((choice) => choice.value === value)?.name ??
        "Custom overlays"
      );
    const text = Number(
      value.toFixed(parameter.type === FLOAT ? 2 : 0),
    ).toString();
    return text + (parameter.unit ? " " + parameter.unit : "");
  }
  async apply(atem: Switcher, options: CameraOptions): Promise<void> {
    const parameter = cameraParameter(options.parameter);
    if (!cameraAvailable(atem))
      throw new Error(
        "Camera control unavailable: connect an ATEM with camera control",
      );
    if (
      !Number.isInteger(options.camera) ||
      options.camera < 1 ||
      options.camera > 254 ||
      !cameraInputs(atem).some((input) => input.value === options.camera)
    )
      throw new Error("Choose an available ATEM camera input");
    if (!["set", "increase", "decrease", "trigger"].includes(options.operation))
      throw new Error("Invalid camera operation");
    if (
      parameter.channels &&
      (!Number.isInteger(options.channel) ||
        options.channel < 0 ||
        options.channel > 3)
    )
      throw new Error("Choose Red, Green, Blue or Luma");
    if (
      parameter.displays &&
      !cameraDisplays.some(
        (display) => display.value === (options.display ?? 2),
      )
    )
      throw new Error("Choose a camera display or video output");
    const relative =
      options.operation === "increase" || options.operation === "decrease";
    let numberData: number[] = [];
    if (parameter.trigger) {
      if (relative)
        throw new Error("This camera command cannot be adjusted by a dial");
    } else {
      if (
        parameter.choices &&
        (relative ||
          !parameter.choices.some((choice) => choice.value === options.value))
      )
        throw new Error("Choose a valid video information overlay");
      if (options.operation === "trigger")
        throw new Error("Choose Set, Increase or Decrease");
      if (
        !Number.isFinite(options.value) ||
        (relative && options.value < 0) ||
        (!relative &&
          (options.value < parameter.min || options.value > parameter.max))
      )
        throw new Error("Camera value outside its valid range");
      const raw =
        options.value *
        (parameter.scale ?? 1) *
        (options.operation === "decrease" ? -1 : 1);
      const value =
        parameter.type === FLOAT
          ? Math.round(raw * 2048) / 2048
          : Math.round(raw);
      const limit =
        parameter.type === FLOAT
          ? [-16, 32767 / 2048]
          : parameter.type === SINT8
            ? [-128, 127]
            : parameter.type === SINT16
              ? [-32768, 32767]
              : [-2147483648, 2147483647];
      if (value < limit[0]! || value > limit[1]!)
        throw new Error("Camera change is too large for this parameter");
      const length = parameter.length ?? 1,
        index = parameter.channels ? options.channel : (parameter.index ?? 0);
      if (parameter.displays) numberData = [value, options.display ?? 2];
      else if (relative) numberData = Array<number>(length).fill(0);
      else if (length > 1) {
        const previous = this.values.get(
          this.key(options.camera, parameter.category, parameter.parameter),
        );
        if (
          !previous ||
          previous.type !== parameter.type ||
          previous.values.length < length ||
          !previous.values.every(Number.isFinite)
        )
          throw new Error(
            "Waiting for camera feedback: use Increase / Decrease or connect ATEM Software Control first",
          );
        numberData = previous.values.slice(0, length);
      } else numberData = [0];
      numberData[index] = value;
    }
    await atem.sendCommand(
      new Commands.CameraControlCommand(
        options.camera,
        parameter.category,
        parameter.parameter,
        {
          type: parameter.type,
          relative,
          numberData,
          boolData: [],
          bigintData: [],
          stringData: "",
        },
      ),
    );
    // UDP acknowledgement confirms the ATEM received the command, not that a camera or lens applied it.
  }
}
