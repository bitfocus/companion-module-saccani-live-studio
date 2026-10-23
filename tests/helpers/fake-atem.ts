import { EventEmitter } from "node:events";
import {
  AtemConnectionStatus,
  Enums,
  Commands,
  type Atem,
} from "atem-connection";

export class FakeAtem extends EventEmitter {
  state = {
    info: { capabilities: { cameraControl: true } },
    fairlight: {
      inputs: {},
      monitor: {
        gain: -1200,
        inputMasterGain: 0,
        inputMasterMuted: false,
        inputTalkbackGain: -600,
        inputTalkbackMuted: false,
        inputSidetoneGain: -1000,
      },
    },
    inputs: {
      0: {
        inputId: 0,
        longName: "Black",
        meAvailability: Enums.MeAvailability.Me1,
      },
      1: {
        inputId: 1,
        longName: "Camera",
        internalPortType: Enums.InternalPortType.External,
        meAvailability: Enums.MeAvailability.Me1,
        sourceAvailability: Enums.SourceAvailability.Auxiliary,
      },
      5: {
        inputId: 5,
        longName: "Studio HDMI",
        internalPortType: Enums.InternalPortType.External,
        meAvailability: Enums.MeAvailability.Me1,
        sourceAvailability: Enums.SourceAvailability.Auxiliary,
      },
      9: {
        inputId: 9,
        longName: "Other M/E",
        meAvailability: Enums.MeAvailability.Me2,
      },
    },
    video: { mixEffects: [{ programInput: 1 }], auxilliaries: [10010] },
  } as unknown as NonNullable<Atem["state"]>;
  status = AtemConnectionStatus.CONNECTED;
  changes: number[] = [];
  auxChanges: [number, number][] = [];
  headphoneChanges: Record<string, number | boolean>[] = [];
  cameraCommands: Commands.CameraControlCommand[] = [];
  async sendCommand(command: Commands.CameraControlCommand) {
    if (this.status !== AtemConnectionStatus.CONNECTED)
      throw new Error("ATEM offline");
    this.cameraCommands.push(command);
  }
  failChanges = false;
  destroyed = false;
  hosts: string[] = [];
  async connect(host: string) {
    this.hosts.push(host);
    this.status = AtemConnectionStatus.CONNECTED;
    this.emit("connected");
  }
  async changeProgramInput(input: number) {
    if (this.failChanges) throw new Error("ATEM offline");
    this.changes.push(input);
    this.state.video.mixEffects[0]!.programInput = input;
    this.emit("stateChanged", this.state, []);
  }
  async setAuxSource(source: number, bus: number) {
    if (this.failChanges) throw new Error("ATEM offline");
    this.auxChanges.push([source, bus]);
    this.state.video.auxilliaries[bus] = source;
    this.emit("stateChanged", this.state, []);
  }
  async setFairlightAudioMixerMonitorProps(
    props: Record<string, number | boolean>,
  ) {
    if (this.status !== AtemConnectionStatus.CONNECTED)
      throw new Error("ATEM offline");
    this.headphoneChanges.push(props);
    Object.assign(this.state.fairlight!.monitor!, props);
    this.emit("stateChanged", this.state, ["fairlight.monitor"]);
  }
  async destroy() {
    this.destroyed = true;
    this.status = AtemConnectionStatus.CLOSED;
    this.emit("disconnected");
  }
  asAtem(): Atem {
    return this as unknown as Atem;
  }
}
