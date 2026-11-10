import type { CompanionPresetAction, CompanionPresetDefinitions } from '@companion-module/base'
import type { ModuleSchema } from './main.js'
import type ModuleInstance from './main.js'
import { transportNames } from './actions.js'

type PresetGroup = { id: string; name: string; type: 'simple'; presets: string[] }
type PresetAction = CompanionPresetAction<ModuleSchema['actions']>

const offline = { feedbackId: 'offline' as const, options: {}, style: { bgcolor: 0x444444, color: 0xbbbbbb } }

function channelPresets(
	self: ModuleInstance,
	definitions: CompanionPresetDefinitions<ModuleSchema>,
	groups: PresetGroup[],
): void {
	// Before the app answers, offer the channels seen so far as video channels.
	const tabs: { id: number; sourceKind: string }[] =
		self.snapshot.playback?.tabs ?? [...self.knownTabs].map((id) => ({ id, sourceKind: 'video' }))
	for (const tab of tabs) {
		const ids: string[] = [],
			id = tab.id
		// Transport commands work only on video and audio channels.
		if (tab.sourceKind === 'video' || tab.sourceKind === 'audio') {
			for (const action of ['toggle', 'play', 'pause', 'stop', 'restart'] as const) {
				const key = `tab_${id}_${action}`
				ids.push(key)
				definitions[key] = {
					type: 'simple',
					name: `Channel ${id} ${transportNames[action]}`,
					style: {
						text: `${transportNames[action].split(' and ')[0]}\n$(${self.label}:tab_${id}_filename)\n$(${self.label}:tab_${id}_position)`,
						size: 'auto',
						color: 0xffffff,
						bgcolor: 0x153a59,
						show_topbar: false,
					},
					steps: [{ down: [{ actionId: action, options: { tab: id } }], up: [] }],
					feedbacks: [
						{ feedbackId: 'playing', options: { tab: id }, style: { bgcolor: 0xb02727 } },
						{ feedbackId: 'busy', options: { tab: id }, style: { bgcolor: 0xb36a00 } },
						offline,
					],
				}
			}
		}
		if (tab.sourceKind === 'audio') {
			const key = `tab_${id}_volume`
			ids.push(key)
			definitions[key] = {
				type: 'simple',
				name: `Channel ${id} Audio volume dial`,
				style: {
					text: `VOLUME\n$(${self.label}:tab_${id}_volume)%`,
					size: 'auto',
					color: 0xffffff,
					bgcolor: 0x176b34,
					show_topbar: false,
				},
				steps: [
					{
						down: [],
						up: [],
						rotate_left: [{ actionId: 'volume', options: { tab: id, value: -5, relative: true } }],
						rotate_right: [{ actionId: 'volume', options: { tab: id, value: 5, relative: true } }],
					},
				],
				feedbacks: [offline],
			}
		} else if (tab.sourceKind === 'video') {
			const key = `tab_${id}_jog`
			ids.push(key)
			const jog = (amount: number): PresetAction => ({
				actionId: 'jog',
				options: { tab: id, amount, unit: 'frames' },
			})
			definitions[key] = {
				type: 'simple',
				name: `Channel ${id} Video jog dial`,
				style: {
					text: `JOG\n$(${self.label}:tab_${id}_filename)\n$(${self.label}:tab_${id}_position)`,
					size: 'auto',
					color: 0xffffff,
					bgcolor: 0x153a59,
					show_topbar: false,
				},
				steps: [
					{
						down: [{ actionId: 'play_pause', options: { tab: id } }],
						up: [],
						rotate_left: [jog(-1)],
						rotate_right: [jog(1)],
					},
				],
				feedbacks: [{ feedbackId: 'playing', options: { tab: id }, style: { bgcolor: 0xb02727 } }, offline],
			}
		} else if (tab.sourceKind === 'channel') {
			// A Channel source can show any other channel except an audio one.
			for (const shown of tabs) {
				if (shown.id === id || shown.sourceKind === 'audio') continue
				const key = `tab_${id}_show_${shown.id}`
				ids.push(key)
				definitions[key] = {
					type: 'simple',
					name: `Channel ${id} shows channel ${shown.id}`,
					style: {
						text: `CH ${id}\nSHOW ${shown.id}`,
						size: 'auto',
						color: 0xffffff,
						bgcolor: 0x153a59,
						show_topbar: false,
					},
					steps: [{ down: [{ actionId: 'channel_source', options: { tab: id, channel: shown.id } }], up: [] }],
					feedbacks: [
						{
							feedbackId: 'channel_source_shows',
							options: { tab: id, channel: shown.id },
							style: { bgcolor: 0x176b34 },
						},
						offline,
					],
				}
			}
		}
		const channelKey = `tab_${id}_channel`
		ids.push(channelKey)
		definitions[channelKey] = {
			type: 'simple',
			name: `Channel ${id} enable / disable`,
			style: {
				text: `CH ${id}\nOFF`,
				size: 'auto',
				color: 0xffffff,
				bgcolor: 0x8a1c1c,
				show_topbar: false,
			},
			steps: [{ down: [{ actionId: 'channel_enable', options: { tab: id, mode: 'toggle' } }], up: [] }],
			feedbacks: [
				{ feedbackId: 'channel_enabled', options: { tab: id }, style: { bgcolor: 0x176b34, text: `CH ${id}\nON` } },
				offline,
			],
		}
		groups.push({ id: `tab_${id}`, name: `Channel ${id}`, type: 'simple', presets: ids })
	}
}

function replayPresets(
	self: ModuleInstance,
	definitions: CompanionPresetDefinitions<ModuleSchema>,
	groups: PresetGroup[],
): void {
	definitions.replay_start = {
		type: 'simple',
		name: 'Replay (app settings and default clip)',
		style: { text: 'REPLAY', size: 'auto', color: 0xffffff, bgcolor: 0x5d245e, show_topbar: false },
		steps: [
			{
				down: [
					{
						actionId: 'replay_start',
						options: { path: '', mode: 'configured', tab: self.replayTabs()[0]?.id ?? 1 },
					},
				],
				up: [],
			},
		],
		feedbacks: [
			{ feedbackId: 'replay_busy', options: {}, style: { bgcolor: 0xb02727 } },
			{ feedbackId: 'offline', options: {}, style: { bgcolor: 0x444444 } },
		],
	}
	definitions.replay_stop = {
		type: 'simple',
		name: 'Stop this connection’s replay',
		style: { text: 'STOP\nREPLAY', size: 'auto', color: 0xffffff, bgcolor: 0x5d245e, show_topbar: false },
		steps: [{ down: [{ actionId: 'replay_stop', options: {} }], up: [] }],
		feedbacks: [],
	}
	groups.push({ id: 'replay', name: 'Replay', type: 'simple', presets: ['replay_start', 'replay_stop'] })
}

function chatPresets(
	self: ModuleInstance,
	definitions: CompanionPresetDefinitions<ModuleSchema>,
	groups: PresetGroup[],
): void {
	for (const id of [...self.knownChatTabs].sort((a, b) => a - b)) {
		const v = (key: string) => `$(${self.label}:chat_${id}_${key})`
		const onAir = (feedbackId: 'chat_on_air' | 'chat_preview_on_air') => ({
			feedbackId,
			options: { tab: id },
			style: { bgcolor: 0xb02727, color: 0xffffff },
		})
		const ready = {
			feedbackId: 'chat_ready' as const,
			options: { tab: id },
			style: { bgcolor: 0x176b34, color: 0xffffff },
		}
		const style = (text: string) => ({
			text,
			size: 'auto' as const,
			color: 0xffffff,
			bgcolor: 0x2b3440,
			show_topbar: false,
		})
		for (const pick of ['latest', 'highlight'] as const)
			definitions[`chat_${id}_${pick}`] = {
				type: 'simple',
				name:
					pick === 'latest' ? `Chat channel ${id}: show latest / hide` : `Chat channel ${id}: show Super Chat / hide`,
				style: style(
					pick === 'latest' ? `CHAT\nLATEST\n${v('on_air_author')}` : `SUPER\nCHAT\n${v('latest_highlight_author')}`,
				),
				steps: [{ down: [{ actionId: 'chat_toggle', options: { tab: id, pick } }], up: [] }],
				feedbacks: [ready, onAir('chat_on_air'), offline],
			}
		definitions[`chat_${id}_hide`] = {
			type: 'simple',
			name: `Chat channel ${id}: hide`,
			style: style('HIDE\nCHAT'),
			steps: [{ down: [{ actionId: 'chat_hide', options: { tab: id } }], up: [] }],
			feedbacks: [onAir('chat_on_air'), offline],
		}
		const browse = (steps: number): PresetAction => ({
			actionId: 'chat_browse',
			options: { tab: id, steps },
		})
		definitions[`chat_${id}_dial`] = {
			type: 'simple',
			name: `Chat channel ${id}: browse dial (press = on air / hide)`,
			style: style(`${v('preview_position')}\n${v('preview_author')}\n${v('preview_text')}`),
			steps: [
				{
					down: [{ actionId: 'chat_preview', options: { tab: id } }],
					up: [],
					rotate_left: [browse(-1)],
					rotate_right: [browse(1)],
				},
			],
			feedbacks: [onAir('chat_preview_on_air'), offline],
		}
		groups.push({
			id: `chat_${id}`,
			name: `Chat channel ${id}`,
			type: 'simple',
			presets: [`chat_${id}_latest`, `chat_${id}_highlight`, `chat_${id}_hide`, `chat_${id}_dial`],
		})
	}
}

function statusPresets(
	self: ModuleInstance,
	definitions: CompanionPresetDefinitions<ModuleSchema>,
	groups: PresetGroup[],
): void {
	for (const [id, rows] of [...self.knownStatusTabs].sort((a, b) => a[0] - b[0])) {
		const ids: string[] = []
		for (let row = 0; row <= rows; row++) {
			const key = `status_${id}_row_${row}`
			ids.push(key)
			definitions[key] = {
				type: 'simple',
				name:
					row === 0
						? `Status channel ${id}: master warning (press = clear alerts)`
						: `Status channel ${id}: row ${row} (press = clear alerts)`,
				style: {
					text: row === 0 ? 'STATUS' : `$(${self.label}:status_${id}_row_${row})`,
					size: 'auto',
					color: 0x3cf06e,
					bgcolor: 0x000000,
					show_topbar: false,
				},
				steps: [{ down: [{ actionId: 'status_acknowledge', options: { tab: id } }], up: [] }],
				feedbacks: [{ feedbackId: 'status_row', options: { tab: id, row } }, offline],
			}
		}
		groups.push({ id: `status_${id}`, name: `Status channel ${id}`, type: 'simple', presets: ids })
	}
}

export function UpdatePresets(self: ModuleInstance): void {
	const definitions: CompanionPresetDefinitions<ModuleSchema> = {},
		groups: PresetGroup[] = []
	channelPresets(self, definitions, groups)
	replayPresets(self, definitions, groups)
	chatPresets(self, definitions, groups)
	statusPresets(self, definitions, groups)
	self.setPresetDefinitions([{ id: 'studio', name: 'Saccani Live Studio', definitions: groups }], definitions)
}
