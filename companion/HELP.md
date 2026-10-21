# Saccani Live Studio

Controls the separate Saccani Live Studio macOS app. Requires Companion **4.3+**. HTTP/WebSocket supports Companion on macOS, Windows, Linux or Raspberry Pi, with Saccani Live Studio **0.21.0+** on the app Mac.

## Connect

Open the app and load your sources. Open **File → Remote Control…** and enter its API URL. Leave the token blank: authentication is disabled by default. If you enable **Require access token** in the app, copy that token into Companion. For another computer, enable LAN access in the app and use its Mac IPv4 address. The default URL is `http://127.0.0.1:8765`. Use a trusted network or a TLS proxy.

In the Mac App Store edition, authorize replay recordings with **File → Allow Replay Recordings Folder…**.

## Play, audio and jog

Choose the stable tab number in each action, or drag the per-tab presets. Play resumes; Stop rewinds; Pause keeps the current position; Restart rewinds and plays. Video jog preserves Play/Pause. Audio volume controls that audio tab's 0–100% level, not the ATEM mixer's volume. Video sources play their audio on the Mac by default.

The audio volume dial changes 5 percentage points per rotation. The video jog dial moves one frame per rotation; press toggles Play/Pause. Surface support may vary.

Load media and configure/open outputs in Saccani Live Studio. These commands do not do those steps for you. Busy/loading/replay tabs reject source controls. `last_error` and Companion's log explain failed commands; they are never silently retried.

## Replay

Provide a full MP4 path in the connection's default replay file or in the action. **An output must already be open.** Choose Replay as a tab's source, select that tab and open its output. Replay uses that source's selected settings by default and plays its final 15 seconds. Explicit tab mode can override audio and full-screen settings.

Stop Replay only cancels the replay started by this connection. For replay started elsewhere, use **Stop Replay** in the app or its originating controller. This version does not select the latest recording, stop an ATEM recording, copy recordings or discard takes.

## Status

Variables expose clip-relative position, remaining time, progress, loaded/playing/busy/output state, filename and audio volume for each tab. Counters are not camera/SMPTE drop-frame timecode. Offline state clears live playback indicators. Replay busy includes replays started elsewhere.

## Blackmagic cameras

Set **ATEM IP address** and use the five **Blackmagic Camera** action/preset groups: **Lens**, **Exposure**, **White Balance**, **Color** and **Monitor**. Select the camera input/Camera ID. For SDI cameras, connect the ATEM return feed and set the camera ID to the input number. Lens controls require a compatible electronic lens; zoom requires a motorized lens.

Use Set / Increase / Decrease for numeric parameters; Red/Green/Blue/Luma channels adjust color wheels independently. Presets include step buttons and dials. The dial's press sets the parameter's default value; rotation applies its preset step. **Auto focus**, **Auto iris** and **Auto white balance** trigger once. **Video information overlay** chooses camera information, information with frame guides, hidden overlays or a clean feed on the selected LCD/HDMI/EVF/SDI output. It selects the complete overlay layout for that target. Availability depends on camera model, firmware and lens.

These commands work with the app offline. Variables `camera_<input>_<parameter>` report ATEM feedback (wheel variables add `_red`, `_green`, `_blue` or `_luma`); unknown/offline values are blank. `atem_camera_available` and the available feedback indicate the switcher's camera-control support, not the presence of a camera. Relative commands preserve other components; absolute WB/color component changes require current feedback. A transport acknowledgement does not confirm that a camera or lens applied a command. Failures appear in `last_error`.

The protocol is documented in the [official Blackmagic camera control manual](https://documents.blackmagicdesign.com/DeveloperManuals/BlackmagicCameraControl.pdf). Protocol and SDK tests use simulated hardware; verify camera/lens behavior on your setup.

## ATEM headphones

Set **ATEM IP address** in the connection. Headphone commands use the switcher's Fairlight monitor directly and work even while Saccani Live Studio is offline. Select **ATEM headphones: set / change volume** for an absolute −60 to +10 dB level or a relative change; **ATEM headphones: mute Program listening** offers Toggle / Mute / Unmute. Mute preserves the headphone level, talkback and sidetone; it does not change the Program output mix. Models must report Fairlight headphone monitoring.

The **ATEM Headphones** preset group contains mute, volume −1/+1 dB and a volume dial with press-to-toggle mute. Green means available, red means muted, gray means unavailable. Variables `atem_headphones_available`, `atem_headphones_volume` (dB) and `atem_headphones_muted` follow the ATEM state; volume is blank when unavailable. Changes are serialized and wait for ATEM confirmation. Failures appear in `last_error`. Hardware headphone controls still require verification on the production switcher.

## Optional ATEM Program routing

Set **ATEM IP address** in this connection, then enable **Change ATEM input before / after playback** in a Play, Restart or toggle action. Choose named Program sources before and after playback, **Do not change**, or **Restore Previous Input** in the after field.

The module saves M/E 1’s actual Program input immediately before sending Play. It switches to the starting input only after the app confirms playback has started and its output handoff is complete. **Restore Previous Input** returns to that saved source at natural completion or Stop, including Stop sent from a different button or the app. Pause, jog, Resume and Restart keep the saved return input; a looping clip returns only on Stop. For video, Stop and natural completion hold the current/last frame until the final Program selection is confirmed, then the app resets the clip and restores the previous output. Stop in the app follows the same handshake. Requires Saccani Live Studio 0.21.3 or newer. Both video and audio tabs are supported. Use a routed action to start playback; an external start has no saved return route.

Source replacement, app connection loss, reconfiguration and shutdown also attempt the ending route. Unavailable inputs or an offline ATEM produce an error, with no guessed replacement. Return routes are in memory. Blank ATEM settings and actions without routing do not require an ATEM. Variables `atem_online`, `atem_program_input` and `atem_program_name` expose connection/Program state. Use Companion’s Blackmagic ATEM module for other mixer commands.
