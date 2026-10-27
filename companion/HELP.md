# Saccani Live Studio

Controls the separate Saccani Live Studio macOS app. Requires Companion **4.3+**. HTTP/WebSocket supports Companion on macOS, Windows, Linux or Raspberry Pi, with Saccani Live Studio **0.21.0+** on the app Mac (Replay tabs **0.22.1+**, Status **0.22.42+**, live chat **0.23.0+**).

## Connect

Open the app and load your sources. Open **Settings… → Remote Control** and enter its API URL. Leave the token blank: authentication is disabled by default. If you enable **Require access token** in the app, copy that token into Companion. For another computer, enable LAN access in the app and use its Mac IPv4 address. The default URL is `http://127.0.0.1:8765`. Use a trusted network or a TLS proxy.

In the Mac App Store edition, authorize replay recordings with **Settings… → General → Allow Replay Recordings Folder…**.

## Play, audio and jog

Choose the stable tab number in each action, or drag the per-tab presets. Play resumes; Stop rewinds; Pause keeps the current position; Restart rewinds and plays. Video jog preserves Play/Pause. Audio volume controls that audio tab's 0–100% level, not a mixer's volume. Video sources play their audio on the Mac by default.

The audio volume dial changes 5 percentage points per rotation. The video jog dial moves one frame per rotation; press toggles Play/Pause. Surface support may vary.

Load media and configure/open outputs in Saccani Live Studio. These commands do not do those steps for you. Busy/loading/replay tabs reject source controls. `last_error` and Companion's log explain failed commands; they are never silently retried.

## Replay

Provide a full MP4 path on the app Mac in the connection's default replay file or in the action. Choose **Replay** as a tab's source in the app and set its Video Output, audio, framing and overlay there. The action uses the last selected Replay tab in the app, or the Replay tab you choose, and plays the clip's final 15 seconds. The app opens the configured output if needed and restores the preceding tab at Stop, completion or a failed start.

Stop Replay only cancels the replay started by this connection. For replay started elsewhere, use **Stop Replay** in the app or its originating controller. Selecting the latest ATEM recording, stopping an ATEM recording, copying recordings and discarding takes are not available in Companion. This module controls only the app: for the switcher, cameras and audio use Companion’s Blackmagic ATEM module.

## Live chat

Choose **Chat** as a tab's source, connect it to a YouTube broadcast and keep it in **Highlight** mode. **Chat: put a message on air / hide** shows the latest message or the latest Super Chat/membership, and hides it on the next press. **Chat: hide message on air** always hides. On a dial, **Chat: browse messages** moves a preview through the latest 50 messages (left = older) and **Chat: put previewed message on air / hide** sends it on air or hides it. At the newest message the preview follows new messages.

Each chat tab has ready-made presets. Variables `chat_<tab>_…` show status, the message on air and the preview (author, text, Super Chat amount, position). Look, position and **Hide after** are set in the app; in Feed mode only hiding works.

## Channel enable

**Channel: enable / disable** toggles a channel of the app, or always enables or disables it (app **0.22.51+**). A disabled channel shows nothing on its output or as an overlay, and a Status channel is silent; its source keeps running. The **Channel enabled** feedback, the `tab_<n>_enabled` variable and a preset per tab come with it.

## Status

Choose **Status** as a tab's source: a live checklist of the ATEM, microphones, cameras, recording and streaming, with alerts. The feedback **Status: show a row with its colors** gives a button the text and colors of a row, blinking with an uncleared alert; row **0** is a master warning (ALL OK, or the first alert with the number of alerts). **Status: clear alerts** silences the app's chime and stops the blinking; the rows keep their alert colors until the problem is solved. **Status: alert not yet cleared** is a boolean feedback. Each Status tab has presets for the master warning and every row; variables `status_<tab>_row_<n>` and `status_<tab>_alerts` show the rows and the number of uncleared alerts.

## Channel enable

**Channel: enable / disable** toggles a channel of the app, or always enables or disables it (app **0.22.51+**). A disabled channel shows nothing on its output or as an overlay, and a Status channel is silent; its source keeps running. The **Channel enabled** feedback, the `tab_<n>_enabled` variable and a preset per tab come with it.

## Status

Variables expose clip-relative position, remaining time, progress, loaded/playing/busy/output state, filename and audio volume for each tab. Counters are not camera/SMPTE drop-frame timecode. Offline state clears live playback indicators. Replay busy includes replays started elsewhere.
