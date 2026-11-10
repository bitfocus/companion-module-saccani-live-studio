import type { SomeCompanionConfigField } from '@companion-module/base'

export type ModuleConfig = {
	replayFile: string
	url: string
}

export type ModuleSecrets = {
	token?: string
}

export const DEFAULT_URL = 'http://127.0.0.1:8765'

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'help',
			label: 'Saccani Live Studio connection',
			width: 12,
			value:
				'In Saccani Live Studio, turn on Settings… → Remote Control. Leave the token empty unless “Require access token” is on in the app. If Companion runs on another computer, also turn on LAN access in the app. Load media and open video outputs in the app. Replay file paths refer to the Mac running the app.',
		},
		{
			type: 'textinput',
			id: 'url',
			label: 'App API URL',
			width: 12,
			default: DEFAULT_URL,
		},
		{
			type: 'secret-text',
			id: 'token',
			label: 'API access token (optional)',
			width: 12,
		},
		{
			type: 'textinput',
			id: 'replayFile',
			label: "Default replay MP4 file (full path on the app Mac; empty = the ATEM's latest clip)",
			width: 12,
			default: '',
		},
	]
}
