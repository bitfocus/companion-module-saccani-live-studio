import type { CompanionActionDefinition } from '@companion-module/base'
import type ModuleInstance from './main.js'
import { keyCommand, type ChatPick } from './chat.js'
import { chatTabField, replayTabField, shownChannelField, statusTabField, tabField } from './fields.js'

export type TransportActions = 'play' | 'pause' | 'stop' | 'restart' | 'toggle' | 'play_pause'

export type ActionsSchema = {
	[K in TransportActions]: { options: { tab: number } }
} & {
	jog: { options: { tab: number; amount: number; unit: 'seconds' | 'frames' } }
	volume: { options: { tab: number; value: number; relative: boolean } }
	replay_start: { options: { path: string; mode: 'configured' | 'source'; tab: number } }
	replay_stop: { options: Record<string, never> }
	chat_toggle: { options: { tab: number; pick: ChatPick } }
	chat_hide: { options: { tab: number } }
	chat_browse: { options: { tab: number; steps: number } }
	chat_preview: { options: { tab: number } }
	status_acknowledge: { options: { tab: number } }
	channel_enable: { options: { tab: number; mode: 'toggle' | 'on' | 'off' } }
	channel_source: { options: { tab: number; channel: number } }
}

export const transportNames: Record<TransportActions, string> = {
	play: 'Play / Resume',
	pause: 'Pause',
	stop: 'Stop and return to beginning',
	restart: 'Restart and play',
	toggle: 'Play / Stop toggle',
	play_pause: 'Play / Pause toggle (video)',
}

export function UpdateActions(self: ModuleInstance): void {
	const transportAction = (id: TransportActions): CompanionActionDefinition<{ tab: number }> => ({
		name: transportNames[id],
		options: [tabField(self)],
		callback: async (event) => {
			const tab = event.options.tab,
				sourceID = self.sourceID(tab)
			return self.execute(async (client) => client.transport(tab, id === 'play_pause' ? 'play-pause' : id, sourceID))
		},
	})
	self.setActionDefinitions({
		play: transportAction('play'),
		pause: transportAction('pause'),
		stop: transportAction('stop'),
		restart: transportAction('restart'),
		toggle: transportAction('toggle'),
		play_pause: transportAction('play_pause'),
		jog: {
			name: 'Jog video forward / backward',
			options: [
				tabField(self, 'video'),
				{
					id: 'amount',
					type: 'number',
					label: 'Distance (negative = backward)',
					default: 1,
					min: -86400,
					max: 86400,
					step: 0.01,
				},
				{
					id: 'unit',
					type: 'dropdown',
					label: 'Unit',
					default: 'frames',
					choices: [
						{ id: 'frames', label: 'Frames' },
						{ id: 'seconds', label: 'Seconds' },
					],
				},
			],
			callback: async (event) => {
				const { tab, amount, unit } = event.options,
					sourceID = self.sourceID(tab)
				return self.execute(async (client) => client.seek(tab, amount, unit, sourceID))
			},
		},
		volume: {
			name: 'Set / change audio channel volume',
			options: [
				tabField(self, 'audio'),
				{
					id: 'value',
					type: 'number',
					label: 'Volume / change (%)',
					default: 100,
					min: -100,
					max: 100,
					step: 1,
				},
				{
					id: 'relative',
					type: 'checkbox',
					label: 'Relative change (negative = quieter)',
					default: false,
				},
			],
			callback: async (event) => {
				const { tab, value, relative } = event.options,
					sourceID = self.sourceID(tab)
				return self.execute(async (client) => client.volume(tab, value, relative, sourceID))
			},
		},
		replay_start: {
			name: 'Replay the latest ATEM clip or an MP4',
			description:
				'Plays the end of the clip on a Replay channel, for the seconds set in that channel (15 by default).',
			options: [
				{
					id: 'path',
					type: 'textinput',
					label: "MP4 file (empty = the default file, or the ATEM's latest clip)",
					default: '',
					useVariables: true,
				},
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Replay channel',
					tooltip: 'Audio, framing, overlay and Video Output come from the Replay channel in the app.',
					default: 'configured',
					disableAutoExpression: true,
					choices: [
						{ id: 'configured', label: 'Last selected Replay channel in the app' },
						{ id: 'source', label: 'Choose a Replay channel' },
					],
				},
				replayTabField(self),
			],
			callback: async (event) =>
				self.execute(async (client) => {
					const generation = self.generation,
						{ path, mode, tab } = event.options
					return client.startReplay(path || self.config.replayFile, mode, tab, (error) => {
						if (generation !== self.generation) return
						self.reportError(error)
					})
				}),
		},
		replay_stop: {
			name: 'Stop this connection’s replay and restore source',
			options: [],
			callback: async () => self.execute(async (client) => client.stopReplay()),
		},
		chat_toggle: {
			name: 'Chat: put a message on air / hide',
			description: 'Puts the chosen message on air; when a message is already on air, hides it.',
			options: [
				chatTabField(self),
				{
					id: 'pick',
					type: 'dropdown',
					label: 'Key press shows',
					default: 'latest',
					choices: [
						{ id: 'latest', label: 'Latest message' },
						{ id: 'highlight', label: 'Latest Super Chat or membership' },
					],
				},
			],
			callback: async (event) =>
				self.execute(async (client) => client.chat(event.options.tab, (tab) => keyCommand(tab, event.options.pick))),
		},
		chat_hide: {
			name: 'Chat: hide message on air',
			options: [chatTabField(self)],
			callback: async (event) =>
				self.execute(async (client) => client.chat(event.options.tab, () => ({ action: 'chat-hide' }))),
		},
		chat_browse: {
			name: 'Chat: browse messages (dial)',
			description: 'Moves the preview through the latest 50 messages; at the newest message it follows new ones.',
			options: [
				chatTabField(self),
				{
					id: 'steps',
					type: 'number',
					label: 'Messages (negative = older, positive = newer)',
					default: 1,
					min: -50,
					max: 50,
					step: 1,
				},
			],
			callback: (event) => {
				const tab = self.chatTab(event.options.tab)
				if (!tab) {
					self.reportError(new Error(`Choose Chat as the source of channel ${event.options.tab} in the app.`))
					return
				}
				self.chatBrowser.move(tab, Math.trunc(event.options.steps))
				self.publishState()
			},
		},
		chat_preview: {
			name: 'Chat: put previewed message on air / hide',
			options: [chatTabField(self)],
			callback: async (event) =>
				self.execute(async (client) => client.chat(event.options.tab, (tab) => self.chatBrowser.press(tab))),
		},
		channel_enable: {
			name: 'Channel: enable / disable',
			description:
				'A disabled channel shows nothing on its output or as an overlay, and a Status channel is silent; its source keeps running.',
			options: [
				tabField(self),
				{
					id: 'mode',
					type: 'dropdown',
					label: 'On press',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'on', label: 'Enable' },
						{ id: 'off', label: 'Disable' },
					],
				},
			],
			callback: async (event) =>
				self.execute(async (client) => client.channelEnable(event.options.tab, event.options.mode)),
		},
		channel_source: {
			name: 'Channel: choose what a Channel source shows',
			description:
				'The channel must use a Channel source in the app. A channel cannot show an audio channel, itself or a channel that leads back to it.',
			options: [tabField(self, 'channel'), shownChannelField(self)],
			callback: async (event) =>
				self.execute(async (client) => client.channelSource(event.options.tab, event.options.channel)),
		},
		status_acknowledge: {
			name: 'Status: clear alerts',
			description:
				"Like a Master Warning button: the app's chime stops and the rows stop blinking; they keep their alert colors until the problem is solved.",
			options: [statusTabField(self)],
			callback: async (event) => self.execute(async (client) => client.acknowledgeStatus(event.options.tab)),
		},
	})
}
