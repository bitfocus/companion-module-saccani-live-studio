import assert from "node:assert/strict";
import test from "node:test";
import {
  AtemConnectionStatus,
  AtemStateUtil,
  Commands,
  Enums,
  type Atem,
} from "atem-connection";
import {
  CameraControl,
  cameraInputs,
  cameraParameters,
  cameraGroups,
  type CameraOptions,
} from "../src/atem-camera.ts";

function fixture() {
  const state = AtemStateUtil.Create();
  state.info.capabilities = { cameraControl: true } as NonNullable<
    typeof state.info.capabilities
  >;
  state.inputs[1] = {
    inputId: 1,
    longName: "Blackmagic Camera",
    internalPortType: Enums.InternalPortType.External,
  } as NonNullable<(typeof state.inputs)[1]>;
  state.inputs[6000] = {
    inputId: 6000,
    longName: "SuperSource",
    internalPortType: Enums.InternalPortType.SuperSource,
  } as NonNullable<(typeof state.inputs)[1]>;
  const sent: Commands.CameraControlCommand[] = [];
  const atem = {
    state,
    status: AtemConnectionStatus.CONNECTED,
    async sendCommand(command: Commands.CameraControlCommand) {
      sent.push(command);
    },
  };
  const control = new CameraControl();
  const apply = (
    parameter: string,
    operation: CameraOptions["operation"] = "set",
    value = 0,
    channel = 3,
    display = 2,
  ) =>
    control.apply(atem as unknown as Atem, {
      camera: 1,
      parameter,
      operation,
      value,
      channel,
      display,
    });
  const update = (
    category: number,
    parameter: number,
    type: Commands.CameraControlDataType,
    numberData: number[],
  ) =>
    control.receive([
      new Commands.CameraControlUpdateCommand(1, category, parameter, {
        type,
        numberData,
        boolData: [],
        bigintData: [],
        stringData: "",
        periodicFlushEnabled: false,
      }),
    ]);
  return { atem, sent, control, apply, update };
}
test("camera groups cover lens, exposure, white balance, color and video information; only camera inputs are offered", () => {
  const f = fixture();
  assert.deepEqual(Object.keys(cameraGroups), [
    "lens",
    "exposure",
    "whitebalance",
    "color",
    "monitor",
  ]);
  assert.ok(cameraParameters.some((parameter) => parameter.id === "autofocus"));
  assert.ok(cameraParameters.some((parameter) => parameter.id === "info"));
  assert.deepEqual(
    cameraInputs(f.atem as unknown as Atem).map((input) => input.value),
    [1],
  );
});
test("camera command bytes encode autofocus, auto iris, auto WB and video overlay/display masks", async () => {
  const f = fixture();
  for (const [parameter, category, id] of [
    ["autofocus", 0, 1],
    ["autoiris", 0, 5],
    ["autowb", 1, 3],
  ] as const) {
    await f.apply(parameter, "trigger");
    const command = f.sent.at(-1)!;
    assert.deepEqual(
      [command.source, command.category, command.parameter],
      [1, category, id],
    );
    assert.equal(command.properties.type, Commands.CameraControlDataType.BOOL);
    assert.deepEqual(command.properties.boolData, []);
    const bytes = command.serialize();
    assert.equal(bytes.length, 16);
    assert.equal(bytes[3], 0);
    assert.equal(bytes.readUInt16BE(6), 0);
  }
  await f.apply("info", "set", 1, 3, 8);
  const command = f.sent.at(-1)!,
    bytes = command.serialize();
  assert.deepEqual(
    [command.category, command.parameter, command.properties.type],
    [3, 0, Commands.CameraControlDataType.SINT16],
  );
  assert.deepEqual(command.properties.numberData, [1, 8]);
  assert.equal(bytes.readInt16BE(16), 1);
  assert.equal(bytes.readInt16BE(18), 8);
  await f.apply("info", "set", 0, 3, 8);
  assert.deepEqual(f.sent.at(-1)!.properties.numberData, [0, 8]);
});
test("relative white balance and wheel commands preserve other components, with signed fixed point bytes", async () => {
  const f = fixture();
  await f.apply("temperature", "increase", 100);
  assert.deepEqual(f.sent.at(-1)!.properties.numberData, [100, 0]);
  assert.equal(f.sent.at(-1)!.serialize()[3], 1);
  await f.apply("tint", "decrease", 2);
  assert.deepEqual(f.sent.at(-1)!.properties.numberData, [0, -2]);
  await f.apply("gamma", "decrease", 0.1, 1);
  const command = f.sent.at(-1)!;
  assert.deepEqual(command.properties.numberData, [0, -205 / 2048, 0, 0]);
  assert.equal(command.serialize().readInt16BE(18), -205);
  await f.apply("shutterangle", "set", 180);
  assert.deepEqual(f.sent.at(-1)!.properties.numberData, [18000]);
  await f.apply("focus", "set", 33.33);
  assert.equal(f.sent.at(-1)!.serialize().readInt16BE(16), 683);
});
test("absolute compound controls require real feedback, retain untouched components, and never invent confirmation", async () => {
  const f = fixture();
  await assert.rejects(
    f.apply("temperature", "set", 3200),
    /Waiting for camera feedback/,
  );
  assert.equal(f.control.value(1, "temperature"), undefined);
  f.update(1, 2, Commands.CameraControlDataType.SINT16, [5600, 7]);
  await f.apply("temperature", "set", 3200);
  assert.deepEqual(f.sent.at(-1)!.properties.numberData, [3200, 7]);
  assert.equal(
    f.control.value(1, "temperature"),
    5600,
    "A transport ACK is not camera feedback",
  );
  f.update(1, 2, Commands.CameraControlDataType.SINT16, [3200, 7]);
  assert.equal(f.control.display(1, "temperature"), "3200 K");
  f.update(8, 4, Commands.CameraControlDataType.FLOAT, [0.4, 1.1]);
  await f.apply("contrast", "set", 1.2);
  assert.equal(f.sent.at(-1)!.properties.numberData[0], 0.4);
  f.update(3, 0, Commands.CameraControlDataType.SINT16, [1, 8]);
  assert.equal(f.control.display(1, "info", 3, 8), "Info ON");
  assert.equal(f.control.display(1, "info", 3, 2), "No feedback");
  f.control.reset();
  assert.equal(f.control.value(1, "temperature"), undefined);
});
test("camera controls reject offline/unsupported ATEM, non-camera sources and invalid values before transmitting", async () => {
  const f = fixture();
  await assert.rejects(f.apply("focus", "set", 101), /outside/);
  await assert.rejects(f.apply("focus", "increase", 100000), /too large/);
  await assert.rejects(f.apply("gamma", "set", 0, 9), /Red, Green/);
  await assert.rejects(f.apply("info", "increase", 1), /overlay/);
  await assert.rejects(f.apply("info", "set", 1, 3, 0), /display/);
  await assert.rejects(f.apply("autofocus", "increase", 1), /dial/);
  await assert.rejects(
    f.control.apply(f.atem as unknown as Atem, {
      camera: 6000,
      parameter: "focus",
      operation: "set",
      value: 50,
      channel: 3,
    }),
    /camera input/,
  );
  f.atem.status = AtemConnectionStatus.CLOSED;
  await assert.rejects(f.apply("focus", "set", 50), /unavailable/);
  f.atem.status = AtemConnectionStatus.CONNECTED;
  f.atem.state.info.capabilities!.cameraControl = false;
  await assert.rejects(f.apply("focus", "set", 50), /unavailable/);
  assert.equal(f.sent.length, 0);
});
