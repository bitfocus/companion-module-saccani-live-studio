import type ModuleInstance from './main.js'
import { pickMessage, type ChatMessage } from './chat.js'
import { formatTime } from './protocol.js'

export type VariablesSchema = Record<string, string | number | boolean>

const channelVariableNames: Record<string, string> = {
	filename: 'Filename',
	source_kind: 'Source type',
	loaded: 'Media loaded',
	playing: 'Playing',
	busy: 'Loading or replay',
	output_active: 'Output active',
	position: 'Clip-relative position',
	remaining: 'Time remaining',
	position_seconds: 'Position in seconds',
	duration_seconds: 'Duration in seconds',
	remaining_seconds: 'Remaining seconds',
	progress: 'Progress percent',
	volume: 'Audio volume percent',
	enabled: 'Channel enabled',
}

const chatVariableNames: Record<string, string> = {
	status: 'Status',
	mode: 'Mode (highlight / feed)',
	live: 'Broadcast live',
	message_count: 'Recent messages',
	on_air: 'Message on air',
	on_air_author: 'On air: author',
	on_air_text: 'On air: text',
	on_air_highlight: 'On air: Super Chat amount or membership',
	preview_author: 'Preview: author',
	preview_text: 'Preview: text',
	preview_highlight: 'Preview: Super Chat amount or membership',
	preview_position: 'Preview: position (n / total)',
	preview_on_air: 'Preview: message is on air',
	latest_highlight_author: 'Latest Super Chat or membership: author',
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	const variables: Record<string, { name: string }> = {
		online: { name: 'App online' },
		tab_count: { name: 'Number of channels' },
		last_error: { name: 'Last command error' },
		replay_busy: { name: 'Replay active or loading' },
		replay_tab: { name: 'Configured Replay channel' },
	}
	for (const id of self.knownTabs)
		for (const [key, name] of Object.entries(channelVariableNames))
			variables[`tab_${id}_${key}`] = { name: `Channel ${id}: ${name}` }
	for (const id of self.knownChatTabs)
		for (const [key, name] of Object.entries(chatVariableNames))
			variables[`chat_${id}_${key}`] = { name: `Chat channel ${id}: ${name}` }
	for (const [id, rows] of self.knownStatusTabs) {
		variables[`status_${id}_alerts`] = { name: `Status channel ${id}: alerts not yet cleared` }
		for (let row = 1; row <= rows; row++)
			variables[`status_${id}_row_${row}`] = { name: `Status channel ${id}: row ${row}` }
	}
	self.setVariableDefinitions(variables)
}

/** Seconds to one decimal, so buttons show 7.7 rather than 7.654999999. */
const tenths = (seconds: number) => Math.round(seconds * 10) / 10

function messageValues(prefix: string, message: ChatMessage | null | undefined): VariablesSchema {
	return {
		[`${prefix}_author`]: message?.author ?? '',
		[`${prefix}_text`]: message?.text ?? '',
		[`${prefix}_highlight`]: message?.highlight ?? '',
	}
}

/** The value of every variable for the current app state. */
export function variableValues(self: ModuleInstance): VariablesSchema {
	const { playback, replay } = self.snapshot
	const values: VariablesSchema = {
		online: !!playback,
		tab_count: playback?.tabs.length ?? 0,
		last_error: self.lastError,
		replay_busy: replay?.busy ?? false,
		replay_tab: replay?.replayTab ?? 0,
	}
	for (const id of self.knownTabs) {
		const tab = playback?.tabs.find((item) => item.id === id),
			position = tab?.position ?? 0,
			duration = tab?.duration ?? 0,
			remaining = Math.max(0, duration - position)
		const data: VariablesSchema = {
			filename: tab?.filename ?? '',
			source_kind: tab?.sourceKind ?? '',
			loaded: tab?.loaded ?? false,
			playing: tab?.playing ?? false,
			busy: (tab?.loading || tab?.replay) ?? false,
			output_active: tab?.outputActive ?? false,
			position: formatTime(position, tab?.frameRate),
			remaining: formatTime(remaining, tab?.frameRate),
			position_seconds: tenths(position),
			duration_seconds: tenths(duration),
			remaining_seconds: tenths(remaining),
			progress: duration > 0 ? Math.round(Math.min(100, (position / duration) * 100)) : 0,
			volume: Math.round((tab?.volume ?? 0) * 100),
			enabled: tab?.enabled ?? false,
		}
		for (const [key, value] of Object.entries(data)) values[`tab_${id}_${key}`] = value
	}
	for (const id of self.knownChatTabs) {
		const tab = self.chatTab(id),
			preview = tab ? self.chatBrowser.position(tab) : undefined
		const data: VariablesSchema = {
			status: tab?.status ?? '',
			mode: tab?.mode ?? '',
			live: tab?.live ?? false,
			message_count: tab?.messages.length ?? 0,
			on_air: !!tab?.onAir,
			...messageValues('on_air', tab?.onAir),
			...messageValues('preview', preview?.message),
			preview_position: preview?.message ? `${preview.index + 1} / ${preview.total}` : '',
			preview_on_air: !!tab?.onAir && preview?.message?.id === tab.onAir.id,
			latest_highlight_author: tab ? (pickMessage(tab, 'highlight')?.author ?? '') : '',
		}
		for (const [key, value] of Object.entries(data)) values[`chat_${id}_${key}`] = value
	}
	for (const [id, rows] of self.knownStatusTabs) {
		const tab = self.statusTab(id)
		values[`status_${id}_alerts`] = tab?.rows.filter((row) => row.alert && !row.acknowledged).length ?? 0
		for (let row = 1; row <= rows; row++) values[`status_${id}_row_${row}`] = tab?.rows[row - 1]?.text ?? ''
	}
	return values
}
