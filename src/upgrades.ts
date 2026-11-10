import type {
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
} from '@companion-module/base'
import type { ModuleConfig, ModuleSecrets } from './config.js'

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig, ModuleSecrets>[] = [
	// 0.5.0: replay targets an exact Replay source channel, whose own settings replace audio and framing.
	(
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, ModuleSecrets>,
	): CompanionStaticUpgradeResult<ModuleConfig, ModuleSecrets> => ({
		updatedConfig: null,
		updatedActions: props.actions.flatMap((action) => {
			if (action.actionId !== 'replay_start') return []
			const mode = action.options.mode
			if (mode?.isExpression || mode?.value !== 'tab') return []
			action.options.mode = { value: 'source', isExpression: false }
			delete action.options.audio
			delete action.options.fullFrame
			return [action]
		}),
		updatedFeedbacks: [],
	}),
]
