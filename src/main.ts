import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { DEFAULT_URL, GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { UpdateVariableDefinitions, variableValues, type VariablesSchema } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, feedbackInputs, type FeedbackId, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { StudioClient, type Snapshot } from './protocol.js'
import { ChatBrowser } from './chat.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: ModuleSecrets
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

const POLL_MS = 250
/** Status rows blink twice a second: on for 250 ms, off for 250 ms. */
const BLINK_MS = 250

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config: ModuleConfig = { url: DEFAULT_URL, replayFile: '' }
	snapshot: Snapshot = {}
	/** Bumped on every reconfiguration, so late results of an old connection are dropped. */
	generation = 0
	knownTabs = new Set([1, 2, 3])
	knownChatTabs = new Set<number>()
	/** Status channels with the most rows seen, so variables and presets survive a brief disconnection. */
	knownStatusTabs = new Map<number, number>()
	chatBrowser = new ChatBrowser()
	lastError = ''
	private secrets: ModuleSecrets = {}
	private client?: StudioClient
	private timer?: ReturnType<typeof setTimeout>
	private blinkTimer?: ReturnType<typeof setTimeout>
	private tabSignature = ''
	private status = ''
	/** Values last sent to Companion, so only changes are sent. */
	private publishedValues = new Map<string, unknown>()
	/** App state each group of feedbacks last saw, so only changed feedbacks are re-checked. */
	private feedbackState = new Map<string, string>()

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig, _isFirstInit = false, secrets: ModuleSecrets = {}): Promise<void> {
		this.secrets = secrets
		await this.configure(config)
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets = this.secrets): Promise<void> {
		this.secrets = secrets
		await this.configure(config)
	}

	async destroy(): Promise<void> {
		++this.generation
		this.stopTimers()
		const client = this.client
		this.client = undefined
		await client?.close()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	private stopTimers(): void {
		clearTimeout(this.timer)
		clearTimeout(this.blinkTimer)
		this.blinkTimer = undefined
	}

	private async configure(config: ModuleConfig): Promise<void> {
		const generation = ++this.generation
		this.stopTimers()
		const oldClient = this.client
		this.client = undefined
		await oldClient?.close()
		if (generation !== this.generation) return
		this.config = { url: config.url || DEFAULT_URL, replayFile: config.replayFile || '' }
		this.snapshot = {}
		this.lastError = ''
		this.tabSignature = ''
		this.status = ''
		this.chatBrowser.clear()
		this.definitions()
		try {
			this.client = new StudioClient({ url: this.config.url, token: this.secrets.token ?? '' })
		} catch (error) {
			this.setStatus(InstanceStatus.BadConfig, errorMessage(error))
			this.publishState()
			return
		}
		await this.poll(generation)
	}

	private setStatus(status: InstanceStatus, message?: string): void {
		const key = `${status}\n${message ?? ''}`
		if (key === this.status) return
		this.status = key
		this.updateStatus(status, message)
	}

	private async poll(generation: number): Promise<void> {
		const client = this.client
		if (!client || generation !== this.generation) return
		try {
			const snapshot = await client.snapshot()
			if (generation !== this.generation) return
			this.snapshot = snapshot
			const signature = JSON.stringify([
				snapshot.playback?.tabs.map((tab) => [tab.id, tab.sourceKind, tab.filename]) ?? [],
				this.replayTabs(snapshot).map((output) => [output.id, output.label]),
				snapshot.chat?.tabs.map((tab) => tab.id) ?? [],
				snapshot.statusBoard?.tabs.map((tab) => [tab.id, tab.rows.length]) ?? [],
			])
			for (const tab of snapshot.playback?.tabs ?? []) this.knownTabs.add(tab.id)
			for (const tab of snapshot.chat?.tabs ?? []) this.knownChatTabs.add(tab.id)
			for (const tab of snapshot.statusBoard?.tabs ?? [])
				this.knownStatusTabs.set(tab.id, Math.max(tab.rows.length, this.knownStatusTabs.get(tab.id) ?? 0))
			if (signature !== this.tabSignature) {
				this.tabSignature = signature
				this.definitions()
			}
			if (snapshot.playback) this.setStatus(InstanceStatus.Ok)
			else this.setStatus(InstanceStatus.Disconnected, 'Open Saccani Live Studio and check the connection settings.')
			this.publishState()
		} catch (error) {
			if (generation !== this.generation) return
			this.snapshot = {}
			this.setStatus(InstanceStatus.ConnectionFailure, errorMessage(error))
			this.publishState()
		}
		if (generation === this.generation) {
			this.timer = setTimeout(() => void this.poll(generation), POLL_MS)
			this.timer.unref()
		}
	}

	replayTabs(snapshot = this.snapshot): NonNullable<NonNullable<Snapshot['replay']>['outputs']> {
		return snapshot.replay?.outputs?.filter((output) => output.sourceKind === 'replay') ?? []
	}

	statusTab(id: number): NonNullable<Snapshot['statusBoard']>['tabs'][number] | undefined {
		return this.snapshot.statusBoard?.tabs.find((tab) => tab.id === id)
	}

	chatTab(id: number): NonNullable<Snapshot['chat']>['tabs'][number] | undefined {
		return this.snapshot.chat?.tabs.find((tab) => tab.id === id)
	}

	sourceID(id: number): string | undefined {
		return this.snapshot.playback?.tabs.find((tab) => tab.id === id)?.sourceID
	}

	/** Runs a command and reports its error in the log and in $(label:last_error). */
	async execute(work: (client: StudioClient) => Promise<unknown>): Promise<void> {
		const client = this.client,
			generation = this.generation
		try {
			if (!client) throw new Error('Configure the app connection first.')
			await work(client)
			if (generation === this.generation && this.lastError) {
				this.lastError = ''
				this.publishState()
			}
		} catch (error) {
			if (generation !== this.generation) return
			this.reportError(error)
		}
	}

	reportError(error: unknown): void {
		this.lastError = errorMessage(error)
		this.log('warn', this.lastError)
		this.publishState()
	}

	private definitions(): void {
		UpdateActions(this)
		UpdateFeedbacks(this)
		UpdateVariableDefinitions(this)
		UpdatePresets(this)
		// New definitions: send every value and re-check every feedback once.
		this.publishedValues.clear()
		this.feedbackState.clear()
	}

	/** Sends Companion the variables and feedbacks whose app state changed. */
	publishState(): void {
		const changed: VariablesSchema = {}
		for (const [key, value] of Object.entries(variableValues(this))) {
			if (value === undefined || this.publishedValues.get(key) === value) continue
			this.publishedValues.set(key, value)
			changed[key] = value
		}
		if (Object.keys(changed).length) this.setVariableValues(changed)

		const stale = new Set<FeedbackId>()
		for (const [group, { ids, state }] of Object.entries(feedbackInputs(this))) {
			const value = JSON.stringify(state) ?? ''
			if (this.feedbackState.get(group) === value) continue
			this.feedbackState.set(group, value)
			for (const id of ids) stale.add(id)
		}
		const [first, ...rest] = stale
		if (first) this.checkFeedbacks(first, ...rest)
		this.updateBlink()
	}

	/** Re-checks Status rows on the blink beat, only while a blinking alert is still uncleared. */
	private updateBlink(): void {
		const blinking = this.snapshot.statusBoard?.tabs.some((tab) =>
			tab.rows.some((row) => row.alert && row.blink && !row.acknowledged),
		)
		if (!blinking) {
			clearTimeout(this.blinkTimer)
			this.blinkTimer = undefined
			return
		}
		if (this.blinkTimer) return
		const generation = this.generation
		const tick = () => {
			if (generation !== this.generation) return
			this.checkFeedbacks('status_row')
			// Wake just after each 250 ms boundary, in step with the blink phase.
			this.blinkTimer = setTimeout(tick, BLINK_MS - (Date.now() % BLINK_MS) + 5)
			this.blinkTimer.unref()
		}
		this.blinkTimer = setTimeout(tick, BLINK_MS - (Date.now() % BLINK_MS) + 5)
		this.blinkTimer.unref()
	}
}
