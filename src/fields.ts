import type { CompanionInputFieldDropdown, CompanionInputFieldNumber } from '@companion-module/base'
import type ModuleInstance from './main.js'

/** Dropdown of the app's channels, optionally only those with one kind of source. */
export function tabField(
	self: ModuleInstance,
	kind?: 'video' | 'audio' | 'channel',
): CompanionInputFieldDropdown<'tab'> {
	const tabs = self.snapshot.playback?.tabs.filter((tab) => !kind || tab.sourceKind === kind) ?? []
	const choices = tabs.length
		? tabs.map((tab) => ({
				id: tab.id,
				label: `Channel ${tab.id} · ${tab.filename || tab.sourceKind}`,
			}))
		: [...self.knownTabs].sort((a, b) => a - b).map((id) => ({ id, label: `Channel ${id}` }))
	return {
		id: 'tab',
		type: 'dropdown',
		label: 'Channel',
		choices,
		default: choices[0].id,
	}
}

/** The channel a Channel source should show. */
export function shownChannelField(self: ModuleInstance): CompanionInputFieldDropdown<'channel'> {
	return { ...tabField(self), id: 'channel', label: 'Channel to show' }
}

export function replayTabField(self: ModuleInstance): CompanionInputFieldDropdown<'tab'> {
	const tabs = self.replayTabs()
	const choices = tabs.length
		? tabs.map((output) => ({
				id: output.id,
				label: `Channel ${output.id}${output.label ? ' · ' + output.label : ''}`,
			}))
		: [{ id: 1, label: 'Channel 1 · choose Replay as a channel’s source in the app' }]
	return {
		id: 'tab',
		type: 'dropdown',
		label: 'Replay channel',
		choices,
		default: choices[0].id,
		isVisibleExpression: '$(options:mode) == "source"',
	}
}

export function chatTabField(self: ModuleInstance): CompanionInputFieldDropdown<'tab'> {
	const ids = self.snapshot.chat?.tabs.map((tab) => tab.id) ?? [...self.knownChatTabs]
	const choices = ids.length
		? ids.sort((a, b) => a - b).map((id) => ({ id, label: `Chat channel ${id}` }))
		: [{ id: 1, label: 'Channel 1 · choose Chat as a channel’s source in the app' }]
	return {
		id: 'tab',
		type: 'dropdown',
		label: 'Chat channel',
		choices,
		default: choices[0].id,
	}
}

export function statusTabField(self: ModuleInstance): CompanionInputFieldDropdown<'tab'> {
	const ids = self.snapshot.statusBoard?.tabs.map((tab) => tab.id) ?? [...self.knownStatusTabs.keys()]
	const choices = ids.length
		? ids.sort((a, b) => a - b).map((id) => ({ id, label: `Status channel ${id}` }))
		: [{ id: 1, label: 'Channel 1 · choose Status as a channel’s source in the app' }]
	return {
		id: 'tab',
		type: 'dropdown',
		label: 'Status channel',
		choices,
		default: choices[0].id,
	}
}

export function statusRowField(): CompanionInputFieldNumber<'row'> {
	return {
		id: 'row',
		type: 'number',
		label: 'Row (1 = first; 0 = master warning)',
		default: 0,
		min: 0,
		max: 16,
	}
}
