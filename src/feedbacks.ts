import type { CompanionBooleanFeedbackDefinition } from '@companion-module/base'
import type ModuleInstance from './main.js'
import { chatTabField, shownChannelField, statusRowField, statusTabField, tabField } from './fields.js'
import { statusRow, statusStyle } from './status.js'

type TabFeedbacks =
	'playing' | 'ready' | 'busy' | 'output' | 'chat_on_air' | 'chat_preview_on_air' | 'chat_ready' | 'channel_enabled'

export type FeedbacksSchema = {
	offline: { type: 'boolean'; options: Record<string, never> }
	replay_busy: { type: 'boolean'; options: Record<string, never> }
} & {
	[K in TabFeedbacks]: { type: 'boolean'; options: { tab: number } }
} & {
	channel_source_shows: { type: 'boolean'; options: { tab: number; channel: number } }
	status_row: { type: 'advanced'; options: { tab: number; row: number } }
	status_alert: { type: 'boolean'; options: { tab: number; row: number } }
}

export type FeedbackId = keyof FeedbacksSchema

/**
 * The app state each feedback reads. A feedback is only re-checked when its part of the state
 * changes, so an idle app costs Companion nothing.
 */
export function feedbackInputs(self: ModuleInstance): Record<string, { ids: FeedbackId[]; state: unknown }> {
	const { playback, replay, chat, statusBoard } = self.snapshot
	return {
		offline: { ids: ['offline'], state: !!playback },
		channels: {
			ids: ['playing', 'ready', 'busy', 'output', 'channel_enabled', 'channel_source_shows'],
			state: playback?.tabs.map((tab) => [
				tab.id,
				tab.sourceKind,
				tab.loaded,
				tab.playing,
				tab.loading,
				tab.replay,
				tab.outputActive,
				tab.enabled,
				tab.sourceChannel,
			]),
		},
		replay: { ids: ['replay_busy'], state: replay?.busy },
		chat: {
			ids: ['chat_on_air', 'chat_preview_on_air', 'chat_ready'],
			state: chat?.tabs.map((tab) => [
				tab.id,
				tab.mode,
				tab.messages.length,
				tab.onAir?.id,
				self.chatBrowser.position(tab).message?.id,
			]),
		},
		status: { ids: ['status_row', 'status_alert'], state: statusBoard?.tabs },
	}
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	const playbackTab = (id: number) => self.snapshot.playback?.tabs.find((tab) => tab.id === id)
	const tabFeedback = (
		id: 'playing' | 'ready' | 'busy' | 'output',
	): CompanionBooleanFeedbackDefinition<{ tab: number }> => ({
		type: 'boolean',
		name: {
			playing: 'Channel playing',
			ready: 'Channel ready with loaded media',
			busy: 'Channel loading or replaying',
			output: 'Channel output active',
		}[id],
		defaultStyle: {
			color: 0xffffff,
			bgcolor: id === 'busy' ? 0xb36a00 : 0x176b34,
		},
		options: [tabField(self)],
		callback: (event) => {
			const tab = playbackTab(event.options.tab)
			if (!tab) return false
			if (id === 'playing') return tab.playing
			if (id === 'busy') return tab.loading || tab.replay
			if (id === 'output') return tab.outputActive
			return tab.loaded && !tab.loading && !tab.replay && ['video', 'audio'].includes(tab.sourceKind)
		},
	})
	self.setFeedbackDefinitions({
		playing: tabFeedback('playing'),
		ready: tabFeedback('ready'),
		busy: tabFeedback('busy'),
		output: tabFeedback('output'),
		offline: {
			type: 'boolean',
			name: 'App offline',
			options: [],
			defaultStyle: { bgcolor: 0x444444, color: 0xbbbbbb },
			callback: () => !self.snapshot.playback,
		},
		replay_busy: {
			type: 'boolean',
			name: 'Replay active or loading',
			options: [],
			defaultStyle: { bgcolor: 0x8d258c, color: 0xffffff },
			callback: () => self.snapshot.replay?.busy === true,
		},
		chat_on_air: {
			type: 'boolean',
			name: 'Chat: a message is on air',
			options: [chatTabField(self)],
			defaultStyle: { bgcolor: 0xb02727, color: 0xffffff },
			callback: (event) => !!self.chatTab(event.options.tab)?.onAir,
		},
		chat_preview_on_air: {
			type: 'boolean',
			name: 'Chat: previewed message is on air',
			options: [chatTabField(self)],
			defaultStyle: { bgcolor: 0xb02727, color: 0xffffff },
			callback: (event) => {
				const tab = self.chatTab(event.options.tab)
				return !!tab?.onAir && self.chatBrowser.position(tab).message?.id === tab.onAir.id
			},
		},
		channel_enabled: {
			type: 'boolean',
			name: 'Channel enabled',
			options: [tabField(self)],
			defaultStyle: { bgcolor: 0x176b34, color: 0xffffff },
			callback: (event) => playbackTab(event.options.tab)?.enabled === true,
		},
		channel_source_shows: {
			type: 'boolean',
			name: 'Channel source shows this channel',
			options: [tabField(self, 'channel'), shownChannelField(self)],
			defaultStyle: { bgcolor: 0x176b34, color: 0xffffff },
			callback: (event) => playbackTab(event.options.tab)?.sourceChannel === event.options.channel,
		},
		status_row: {
			type: 'advanced',
			name: 'Status: show a row with its colors',
			description:
				"Text and colors of a row of the app's Status panel, blinking with an uncleared alert. Row 0 is the master warning: ALL OK, or the first alert with the number of alerts.",
			options: [statusTabField(self), statusRowField()],
			callback: (event) => {
				const tab = self.statusTab(event.options.tab)
				return statusStyle(tab, statusRow(tab, Math.trunc(event.options.row)))
			},
		},
		status_alert: {
			type: 'boolean',
			name: 'Status: alert not yet cleared',
			description: 'Row 0 checks every row of the channel.',
			options: [statusTabField(self), statusRowField()],
			defaultStyle: { bgcolor: 0xd70015, color: 0xffffff },
			callback: (event) => {
				const tab = self.statusTab(event.options.tab)
				const position = Math.trunc(event.options.row)
				const rows = position >= 1 ? [tab?.rows[position - 1]] : (tab?.rows ?? [])
				return rows.some((row) => !!row?.alert && !row.acknowledged)
			},
		},
		chat_ready: {
			type: 'boolean',
			name: 'Chat: messages available in Highlight mode',
			options: [chatTabField(self)],
			defaultStyle: { bgcolor: 0x176b34, color: 0xffffff },
			callback: (event) => {
				const tab = self.chatTab(event.options.tab)
				return tab?.mode === 'highlight' && tab.messages.length > 0
			},
		},
	})
}
