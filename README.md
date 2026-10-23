# Saccani Live Studio for Bitfocus Companion

Free MIT-licensed Companion connection module for **Saccani Live Studio** on macOS. Version **0.5.0**.

## Install

1. Use **Companion 4.3 or later** on macOS, Windows, Linux or Raspberry Pi. Saccani Live Studio runs on its Mac.
2. In Companion, open **Modules → Import module package** and choose the `.tgz` from `pkg/`.
3. Add the **Saccani → Live Studio** connection, enter the app API URL shown in **File → Remote Control…**. Leave the token blank by default; supply the app token only if **Require access token** is enabled. The default URL is `http://127.0.0.1:8765`; enable LAN access in the app and use its Mac IPv4 address for a remote controller.
4. Open Saccani Live Studio, load a video or audio source, and keep the app running. App **0.21.0+** provides the network API; Replay tabs need **0.22.1+** and live chat **0.23.0+**.
5. Drag buttons or dials from **Presets** onto your Companion page. Each preset targets the stable tab number; deleting a tab does not renumber other tabs.

A repository in the Bitfocus organisation has been requested. Until the module is published in Companion, import the package from `pkg/`.

## Controls

- Play / Resume, Pause, Stop and return to beginning, Restart and play, Play / Stop toggle.
- Video Play / Pause toggle and jog forward/backward in frames or seconds. Jog preserves playback or pause and follows the identity of the selected clip.
- Audio-tab volume, either an absolute 0–100% value or a relative change. The audio volume dial moves by 5 percentage points per step. Video sources play their audio on the Mac by default.
- Replay the final 15 seconds of an MP4 (or the complete clip if shorter) through a tab whose source is **Replay**: the last selected Replay tab in the app, or a chosen one. Audio, framing, overlay and Video Output come from that tab. Optional ATEM Program routing before/after replay and an optional **SRC OUT** change during replay.
- Live chat: put the latest message or the latest Super Chat/membership on air, hide it, or browse the latest 50 messages with a dial and press to put the previewed one on air.
- Stop a replay started by this connection and restore its original source. Replays started from another connection, Elgato or the app must be stopped by their owner or by **Stop Replay** in the app.
- Optional ATEM Program routing: set the connection’s **ATEM IP address**, then enable **Change ATEM input before / after playback** on Play, Restart or toggle actions. Both fields support **Do not change**; **Program input after playback** also supports **Restore Previous Input**. Program inputs are listed by their ATEM names. The previous Program input is captured before Play; the starting input is selected only after the app confirms playback has started and its output handoff is complete; Stop or natural completion selects and confirms the ending input while the app holds the last video frame, then the app resets the clip and restores the preceding output. This requires Saccani Live Studio 0.21.3 or newer.
- Dynamic variables for filename, source type, playback/loading state, output state, clip-relative position, remaining time, progress and audio volume. `last_error` reports command failures. Counters are clip-relative; they are not original camera timecode or SMPTE drop-frame counters.
- Feedback colors for playback, loading/replay, readiness, output, chat on air and app offline.

Set the connection's **Default replay MP4 file** or specify an absolute MP4 path in the action; the path belongs to the Mac running the app, and clips are never uploaded. Discovering the latest ATEM recording, stopping recording, copying recordings and discarding takes work on the app Mac's files and remain in the Stream Deck plugin. Use Companion’s Blackmagic ATEM module for other mixer commands.

Preset dials expose rotation and press actions. Actual availability depends on your surface and Companion's surface driver. The Elgato plugin's touchstrip artwork and hold-to-accelerate behavior are not reproduced.

## Replay

With app **0.22.1+**, choose **Replay** as a tab's source in the app and configure its Video Output, audio, framing and overlay there. In **Replay final 15 seconds of MP4**, keep **Last selected Replay tab in the app** or choose a Replay tab. The app opens the configured output if needed, takes it from the tab that was using it and restores that tab at Stop, completion or a failed start.

Enable **Change ATEM input before / after playback** to select Program inputs, including **Restore Previous Input**. Enable **Change SRC OUT during playback** to send a chosen source to an SRC OUT output. Both change only after the app confirms the replay is playing; at the end, the ATEM returns first and the app restores its output only after this module confirms it. A failed switch rolls the ATEM back and stops the replay.

## Live chat

With app **0.23.0+**, choose **Chat** as a tab's source, connect it to a YouTube broadcast and keep the tab in **Highlight** mode.

- **Chat: put a message on air / hide** shows the latest message, or the latest Super Chat or membership; when something is on air, the same press hides it.
- **Chat: hide message on air** always hides.
- **Chat: browse messages (dial)** moves a preview through the latest 50 messages (negative = older). At the newest message the preview follows new messages; after browsing back it stays put. **Chat: put previewed message on air / hide** puts the preview on air, or hides it when it is already there.

Each chat tab has presets for these keys and a dial whose text shows the preview position, author and message. Variables `chat_<tab>_…` expose status, mode, the message on air and the preview; feedbacks mark a message on air and messages available in Highlight mode. Deleted messages leave the preview and the screen at once. The look, position and **Hide after** time are set in the app. In Feed mode the app shows messages automatically, so only hiding is possible.

## Blackmagic cameras

Set **ATEM IP address** and use the five **Blackmagic Camera** action/preset groups: **Lens**, **Exposure**, **White Balance**, **Color** and **Monitor**. Select the camera input/Camera ID. For SDI cameras, connect the ATEM return feed and set the camera ID to the input number. Lens controls require a compatible electronic lens; zoom requires a motorized lens.

Use Set / Increase / Decrease for numeric parameters; Red/Green/Blue/Luma channels adjust color wheels independently. Presets include step buttons and dials. The dial's press sets the parameter's default value; rotation applies its preset step. **Auto focus**, **Auto iris** and **Auto white balance** trigger once. **Video information overlay** chooses camera information, information with frame guides, hidden overlays or a clean feed on the selected LCD/HDMI/EVF/SDI output. It selects the complete overlay layout for that target. Availability depends on camera model, firmware and lens.

These commands work with the app offline. Variables `camera_<input>_<parameter>` report ATEM feedback (wheel variables add `_red`, `_green`, `_blue` or `_luma`); unknown/offline values are blank. `atem_camera_available` and the available feedback indicate the switcher's camera-control support, not the presence of a camera. Relative commands preserve other components; absolute WB/color component changes require current feedback. A transport acknowledgement does not confirm that a camera or lens applied a command. Failures appear in `last_error`.

The protocol is documented in the [official Blackmagic camera control manual](https://documents.blackmagicdesign.com/DeveloperManuals/BlackmagicCameraControl.pdf). Protocol and SDK tests use simulated hardware; verify camera/lens behavior on your setup.

## ATEM headphones

Set **ATEM IP address** in the connection. Headphone commands use the switcher's Fairlight monitor directly and work even while Saccani Live Studio is offline. Select **ATEM headphones: set / change volume** for an absolute −60 to +10 dB level or a relative change; **ATEM headphones: mute Program listening** offers Toggle / Mute / Unmute. Mute preserves the headphone level, talkback and sidetone; it does not change the Program output mix. Models must report Fairlight headphone monitoring.

The **ATEM Headphones** preset group contains mute, volume −1/+1 dB and a volume dial with press-to-toggle mute. Green means available, red means muted, gray means unavailable. Variables `atem_headphones_available`, `atem_headphones_volume` (dB) and `atem_headphones_muted` follow the ATEM state; volume is blank when unavailable. Changes are serialized and wait for ATEM confirmation. Failures appear in `last_error`. Hardware headphone controls still require verification on the production switcher.

## Program return routing

**Restore Previous Input** captures the real M/E 1 Program source immediately before sending Play, including Black. It works even when **Program input before playback** is **Do not change**. Changes made to Program while the clip plays do not replace this saved input. The original route belongs to the tab’s playback session, so a separate Stop button, a page change, Pause/Resume, jog or Restart keeps the same return destination. With loop playback, return routing waits for Stop.

Playback must start through a routed action to capture the previous input. An already-playing external source must first be stopped. Startup/Play failures roll Program back; completion, source replacement/removal, loss of the app connection, connection reconfiguration and module shutdown attempt the ending route once. If the ATEM or saved input is unavailable, `last_error` reports the failure without choosing another input. Return routes are held in memory and do not survive a Companion process restart. ATEM routing is optional; blank ATEM settings and actions without routing still work independently of the switcher.

Variables `atem_online`, `atem_program_input` and `atem_program_name` expose the ATEM connection and current M/E 1 Program source.

## App Store edition

In the Mac App Store edition, use **File → Allow Replay Recordings Folder…** to grant access to external replay recordings.

## Connection and lifecycle

The connection uses HTTP commands with UUIDs and live WebSocket snapshots, falling back to HTTP reads when the event stream is unavailable. It waits for operation results, serializes transport/jog/volume, rejects stale state and changed clips, and does not retry timed-out playback commands. Closing/reconfiguring the connection cancels its own pending replay. It does not launch the app, start video outputs, select audio devices or save settings automatically.

The module does not read controller-local media or control files. The ATEM library runs its UDP transport in the module process, without separate child processes or worker threads. Its native dependency requires the declared native-addons permission. The complete ATEM runtime and its licenses are included in the package.

Remote Companion is supported. Use a trusted LAN or a TLS proxy; the app itself serves HTTP. Replay paths are resolved on the app Mac, without uploading clips. Playback, output and hardware reliability still need testing in the intended production setup.

The [public API specification](https://github.com/Supergiovane/SaccaniLiveStudio/blob/main/docs/control-api-v1.md) describes commands, events, errors and authentication.

## Development

Requires Node **22.20+ within Node 22** and Yarn 4 (via Corepack). Run:

```sh
nvm use
corepack yarn install
corepack yarn check
corepack yarn test
corepack yarn package
```

The official Bitfocus packaging tool validates the manifest and bundled licenses and generates the `.tgz` in `pkg/`, with the assembled license notices inside the package. No Elgato SDK or native Blackmagic helper is bundled. The app is a separate product with its own license.

Automated checks cover command acknowledgement, unavailable/stale/busy state, clip replacement during queued jogs, relative-volume sequencing, replay ownership/cancellation, Replay-tab validation, Program and SRC OUT replay routing with its return handshake, chat commands and browsing, and SDK action/feedback/preset registration. The native app's regressions additionally exercise actual video/audio players and replay restoration. Automated checks are not a full show/hardware acceptance test.
