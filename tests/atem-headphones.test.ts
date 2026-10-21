import assert from "node:assert/strict";
import test from "node:test";
import {
  AtemConnectionStatus,
  Commands,
  type AtemState,
} from "atem-connection";
import {
  headphoneState,
  setHeadphoneMute,
  setHeadphoneVolume,
  type HeadphoneSwitcher,
} from "../src/atem-headphones.ts";

function fixture() {
  const state = {
    fairlight: {
      inputs: {},
      master: { properties: { faderGain: -500 } },
      monitor: {
        gain: -1200,
        inputMasterGain: -200,
        inputMasterMuted: false,
        inputTalkbackGain: -600,
        inputTalkbackMuted: false,
        inputSidetoneGain: -1000,
      },
    },
  } as unknown as AtemState;
  const packets: Buffer[] = [];
  const atem = {
    status: AtemConnectionStatus.CONNECTED,
    state,
    async setFairlightAudioMixerMonitorProps(
      props: Parameters<
        HeadphoneSwitcher["setFairlightAudioMixerMonitorProps"]
      >[0],
    ) {
      const command = new Commands.FairlightMixerMonitorCommand();
      command.updateProps(props);
      const packet = command.serialize();
      packets.push(packet);
      const m = { ...state.fairlight!.monitor!, ...props };
      const feedback = Buffer.alloc(32);
      feedback.writeInt32BE(m.gain, 0);
      feedback.writeInt32BE(m.inputMasterGain, 4);
      feedback.writeUInt8(m.inputMasterMuted ? 0 : 1, 8);
      feedback.writeInt32BE(m.inputTalkbackGain, 12);
      feedback.writeUInt8(m.inputTalkbackMuted ? 0 : 1, 16);
      feedback.writeInt32BE(m.inputSidetoneGain, 28);
      Commands.FairlightMixerMonitorUpdateCommand.deserialize(
        feedback,
      ).applyToState(state);
    },
  };
  return { atem, packets, state };
}

test("headphone volume uses centi-dB and monitor-only protocol flags, preserving Program master and talkback", async () => {
  const { atem, packets, state } = fixture();
  const original = structuredClone(state);
  assert.deepEqual(headphoneState(state), { volumeDb: -12, muted: false });
  await setHeadphoneVolume(atem, -18.25);
  assert.equal(packets[0]!.readUInt8(0), 1);
  assert.equal(packets[0]!.readInt32BE(4), -1825);
  assert.deepEqual(state.fairlight!.monitor, {
    ...original.fairlight!.monitor,
    gain: -1825,
  });
  assert.deepEqual(state.fairlight!.master, original.fairlight!.master);
  await setHeadphoneVolume(atem, -18.25);
  assert.equal(packets.length, 1, "Already at requested volume");
});
test("mute / unmute / toggle use the native Program monitor mute and preserve volume", async () => {
  const { atem, packets, state } = fixture();
  const original = structuredClone(state.fairlight!.monitor);
  await setHeadphoneMute(atem, "mute");
  await setHeadphoneMute(atem, "mute");
  assert.equal(packets.length, 1, "Explicit mute is idempotent");
  assert.equal(packets[0]!.readUInt8(0), 4);
  assert.equal(packets[0]!.readUInt8(12), 0);
  assert.deepEqual(state.fairlight!.monitor, {
    ...original,
    inputMasterMuted: true,
  });
  await setHeadphoneVolume(atem, 1, true);
  assert.equal(headphoneState(state)!.muted, true);
  await setHeadphoneMute(atem, "unmute");
  await setHeadphoneMute(atem, "toggle");
  await setHeadphoneMute(atem, "toggle");
  assert.deepEqual(headphoneState(state), { volumeDb: -11, muted: false });
});
test("relative volume clamps to headphone limits and rounds fractional dB", async () => {
  const { atem, state } = fixture();
  await setHeadphoneVolume(atem, 500, true);
  assert.equal(headphoneState(state)!.volumeDb, 10);
  await setHeadphoneVolume(atem, -500, true);
  assert.equal(headphoneState(state)!.volumeDb, -60);
  await setHeadphoneVolume(atem, 0.125, true);
  assert.equal(headphoneState(state)!.volumeDb, -59.87);
});
test("offline, unsupported and malformed requests never send headphone commands", async () => {
  const { atem, packets, state } = fixture();
  for (const value of [NaN, Infinity, -61, 11])
    await assert.rejects(setHeadphoneVolume(atem, value), /Invalid/);
  await assert.rejects(setHeadphoneMute(atem, "off" as never), /Invalid/);
  await assert.rejects(setHeadphoneVolume(atem, 1, "true" as never), /Invalid/);
  atem.status = AtemConnectionStatus.CLOSED;
  await assert.rejects(setHeadphoneMute(atem, "toggle"), /offline/);
  atem.status = AtemConnectionStatus.CONNECTED;
  delete state.fairlight!.monitor;
  assert.equal(headphoneState(state), undefined);
  await assert.rejects(setHeadphoneVolume(atem, 1, true), /unavailable/);
  assert.equal(packets.length, 0);
});
test("commands require ATEM state confirmation and report transport failure", async () => {
  const { atem } = fixture();
  atem.setFairlightAudioMixerMonitorProps = async () => {};
  await assert.rejects(
    setHeadphoneVolume(atem, -20, false, 5),
    /did not confirm/,
  );
  await assert.rejects(setHeadphoneMute(atem, "mute", 5), /did not confirm/);
  atem.setFairlightAudioMixerMonitorProps = async () => {
    throw new Error("UDP failure");
  };
  await assert.rejects(setHeadphoneMute(atem, "mute"), /UDP failure/);
  atem.setFairlightAudioMixerMonitorProps = async () => {
    atem.status = AtemConnectionStatus.CLOSED;
  };
  await assert.rejects(setHeadphoneMute(atem, "mute"), /offline/);
});
