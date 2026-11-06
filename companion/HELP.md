# Saccani Live Studio

Controls the Saccani Live Studio macOS app. Requires Companion **4.3+**. Companion can run on macOS, Windows, Linux or Raspberry Pi; the app needs Saccani Live Studio **0.21.0+** (Replay channels **0.22.1+**, the ATEM's latest clip **0.22.30+**, Status **0.22.42+**, channel enable **0.22.51+**).

## Connect

1. In the app, open **Settings… → Remote Control** and note its API URL (by default `http://127.0.0.1:8765`).
2. Enter that URL in the connection. Leave the token empty: authentication is off by default. If you turn on **Require access token** in the app, copy the token here.
3. If Companion runs on another computer, turn on LAN access in the app and use the Mac's IPv4 address. Use a trusted network or a TLS proxy.

In the Mac App Store edition, allow replay recordings with **Settings… → General → Allow Replay Recordings Folder…**.

## Play, audio and jog

Each action uses a channel's stable number; the presets come ready for each channel.

- **Play** resumes, **Stop** goes back to the start, **Pause** keeps the position, **Restart** goes back to the start and plays.
- **Video jog** keeps playing or paused as it was. On a dial, each step moves one frame; press for Play / Pause.
- **Audio volume** sets the 0–100 % level of an audio channel in the app, not a mixer's volume. On a dial, each step changes it by 5 %. Video channels play their audio on the Mac by default.

Load media and set up and open outputs in the app: these actions do not do it for you. A channel that is loading, busy or replaying refuses these commands. Failed commands are never retried: `last_error` and the Companion log explain why.

## Replay

Choose **Replay** as a channel's source in the app and set its Video Output, audio, framing and overlay there. The action plays the end of the clip (the seconds set in that channel, 15 by default) on the last selected Replay channel in the app, or on the one you choose.

The clip is the MP4 file in the action; if empty, the connection's default replay file; if that is empty too, the ATEM's latest recording. Paths are on the Mac running the app. The app opens the output if needed, and gives it back to the previous channel at Stop, at the end or if the start fails.

**Stop this connection's replay** stops only the replay this connection started; for others, use Stop Replay in the app or on the controller that started it. Stopping an ATEM recording, copying recordings and discarding takes are not available here. This module controls only the app: for the switcher, cameras and audio, use Companion's Blackmagic ATEM module.

## Live chat

Choose **Chat** as a channel's source, connect it to a YouTube broadcast and keep it in **Highlight** mode.

- **Chat: put a message on air / hide** shows the latest message, or the latest Super Chat or membership, and hides it on the next press.
- **Chat: hide message on air** always hides.
- On a dial, **Chat: browse messages** moves a preview through the latest 50 messages (left = older), and **Chat: put previewed message on air / hide** sends it on air or hides it. At the newest message the preview follows new messages.

Each Chat channel has ready-made presets. Variables `chat_<n>_…` show the status, the message on air and the preview (author, text, Super Chat amount, position). Look, position and **Hide after** are set in the app. In Feed mode only hiding works.

## Status

Choose **Status** as a channel's source: a live checklist of the ATEM, microphones, cameras, recording and streaming, with alerts.

- The feedback **Status: show a row with its colors** gives a button the text and colors of a row, blinking while its alert is not cleared. Row **0** is a master warning: ALL OK, or the first alert with the number of alerts.
- **Status: clear alerts** stops the app's chime and the blinking; the rows keep their alert colors until the problem is solved.
- **Status: alert not yet cleared** is a yes / no feedback.

Each Status channel has presets for the master warning and every row. Variables `status_<n>_row_<row>` and `status_<n>_alerts` show the rows and the number of alerts not yet cleared.

## Channel enable

**Channel: enable / disable** turns a channel of the app on or off, or always enables or disables it. A disabled channel shows nothing on its output or as an overlay, and a Status channel stays silent; its source keeps running. The **Channel enabled** feedback, the `tab_<n>_enabled` variable and a preset for each channel come with it.

## Variables

For each channel, variables `tab_<n>_…` show the position in the clip, the time left, progress, whether it is loaded, playing, busy or with its output open, the filename and the audio volume. Times are counted from the start of the clip; they are not camera or SMPTE drop-frame timecode. When the app goes offline, playback indicators are cleared. Replay busy also covers replays started elsewhere.
