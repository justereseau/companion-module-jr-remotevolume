import { InstanceBase, InstanceStatus } from '@companion-module/base'
import { ConfigFields } from './config.js'
import { getActionDefinitions } from './actions.js'
import { getVariableDefinitions } from './variables.js'
import { getFeedbackDefinitions } from './feedbacks.js'
import { getPresetDefinitions } from './presets.js'
import { MEDIA_ACTIONS, parseRawMessage, variableKey, volumeStep } from './protocol.js'
import WebSocket from 'ws'

export class RemoteVolumeInstance extends InstanceBase {
	async init(config, _isFirstInit, secrets) {
		this.config = config
		this.secrets = secrets ?? {}
		this.isInitialized = false
		this.reconnectInterval = 5000
		this.reconnectTimer = null
		this.muted = null
		// Capabilities announced by the app (protocol v2); null for a v1 app or while disconnected.
		this.capabilities = null
		// Apps playing audio (protocol v2); null while unknown, unsupported or turned off in the app.
		this.apps = null
		// The ids and names the current definitions were built from, to rebuild them only when those change.
		this.appsSignature = appsSignature(null)
		// Features already reported as unsupported, so a busy button does not flood the log.
		this.unsupportedLogged = new Set()

		this.updateDefinitions()

		this.initWebSocket()
		this.isInitialized = true
	}

	/** (Re)builds the definitions that depend on the list of apps (dropdown choices, variables, presets). */
	updateDefinitions() {
		this.setActionDefinitions(getActionDefinitions(this))
		this.setFeedbackDefinitions(getFeedbackDefinitions(this))
		this.setPresetDefinitions(getPresetDefinitions(this))
		this.setVariableDefinitions(getVariableDefinitions(this.apps))
	}

	async destroy() {
		this.isInitialized = false
		if (this.reconnectTimer) {
			clearInterval(this.reconnectTimer)
			this.reconnectTimer = null
		}
		if (this.ws) {
			this.ws.close(1000)
			delete this.ws
		}
	}

	async configUpdated(config, secrets) {
		this.config = config
		this.secrets = secrets ?? {}
		this.initWebSocket()
	}

	maybeReconnect() {
		if (this.isInitialized && this.config.reconnect) {
			if (this.reconnectTimer) {
				clearInterval(this.reconnectTimer)
			}

			this.reconnectTimer = setInterval(() => {
				this.initWebSocket()
			}, this.reconnectInterval)
		}
	}

	initWebSocket() {
		if (this.reconnectTimer) {
			clearInterval(this.reconnectTimer)
			this.reconnectTimer = null
		}

		const url = 'ws://' + this.config.targetIp + ':' + this.config.targetPort
		if (!url || !this.config.targetIp) {
			this.updateStatus(InstanceStatus.BadConfig, `Target IP is missing`)
			return
		}

		// The API key goes in a header, not in the URL, so it does not end up in logs or proxies.
		const apiKey = String(this.secrets?.apiKey ?? '').trim()
		if (apiKey && !/^[!-~]+$/.test(apiKey)) {
			this.updateStatus(InstanceStatus.BadConfig, 'The API key contains invalid characters')
			return
		}

		this.updateStatus(InstanceStatus.Connecting)
		this.authFailed = false

		if (this.ws) {
			this.ws.close(1000)
			delete this.ws
		}
		const ws = new WebSocket(url, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined)
		this.ws = ws
		// Events of a socket that has been replaced or destroyed must not touch the current state.
		const current = () => this.ws === ws

		ws.addEventListener('open', () => {
			if (!current()) return
			this.updateStatus(InstanceStatus.Ok)

			if (this.reconnectTimer) {
				clearInterval(this.reconnectTimer)
				this.reconnectTimer = null
			}
		})

		ws.addEventListener('close', (event) => {
			if (!current()) return
			this.capabilities = null
			this.setApps(null)
			// A refused key will not work on the next try either: wait for a config change.
			if (this.authFailed) return
			this.updateStatus(InstanceStatus.Disconnected, `Connection closed with code ${event.code}`)
			this.maybeReconnect()
		})

		ws.addEventListener('message', (event) => {
			if (current()) this.messageReceivedFromWebSocket(event)
		})

		ws.addEventListener('error', (data) => {
			if (!current()) return
			if (/Unexpected server response: 401/.test(data.message)) {
				this.authFailed = true
				this.updateStatus(
					InstanceStatus.AuthenticationFailure,
					apiKey ? 'The app refused the API key' : 'The app requires an API key',
				)
				this.log('error', apiKey ? 'The app refused the API key' : 'The app requires an API key')
				return
			}
			this.log('error', data.message)
		})
	}

	isConnected() {
		return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN
	}

	sendAction(message) {
		if (!this.isConnected()) {
			this.log('warn', `Not connected, ignoring action ${message.action}`)
			return
		}
		this.ws.send(JSON.stringify(message))
	}

	setVolume(vol) {
		this.sendAction({ action: 'setVolume', value: vol })
	}

	increaseVolume(vol) {
		this.sendAction({ action: 'increaseVolume', value: vol })
	}

	decreaseVolume(vol) {
		this.sendAction({ action: 'decreaseVolume', value: vol })
	}

	/**
	 * Raises (positive step) or lowers (negative step) the volume. The app takes steps of 1 to 99,
	 * so a step of 100 or more sets the volume to 100 or 0.
	 *
	 * @param {string} step The step as typed or read from a variable, e.g. `5` or `-5`.
	 */
	adjustVolume(step) {
		this.adjust(step, 'Adjust Volume', {
			set: (vol) => this.setVolume(vol),
			increase: (vol) => this.increaseVolume(vol),
			decrease: (vol) => this.decreaseVolume(vol),
		})
	}

	/** {@link adjustVolume} for one app. */
	adjustAppVolume(app, step) {
		this.adjust(step, 'App: Adjust Volume', {
			set: (vol) => this.setAppVolume(app, vol),
			increase: (vol) => this.increaseAppVolume(app, vol),
			decrease: (vol) => this.decreaseAppVolume(app, vol),
		})
	}

	adjust(step, name, send) {
		const value = volumeStep(step)
		if (value === null) {
			this.log('warn', `Ignoring ${name}: "${step}" is not a number (e.g. 5 or -5)`)
			return
		}
		if (value >= 100) send.set(100)
		else if (value <= -100) send.set(0)
		else if (value > 0) send.increase(value)
		else if (value < 0) send.decrease(-value)
	}

	mute() {
		this.sendAction({ action: 'mute' })
	}

	unmute() {
		this.sendAction({ action: 'unmute' })
	}

	toggleMute() {
		this.sendAction({ action: 'toggleMute' })
	}

	getState() {
		this.sendAction({ action: 'getState' })
	}

	/**
	 * Sends a per-app action (protocol v2) when the app supports `feature` (`volume` or `mute`).
	 * Otherwise logs once and sends nothing: a v1 app would answer `Invalid action`.
	 */
	sendAppAction(action, feature, app, value) {
		const target = String(app ?? '').trim()
		if (target === '') {
			this.log('warn', `No app chosen, ignoring action ${action}`)
			return
		}
		if (!this.isConnected()) {
			this.log('warn', `Not connected, ignoring action ${action}`)
			return
		}
		if (this.capabilities?.apps?.[feature] !== true) {
			if (!this.unsupportedLogged.has(feature)) {
				this.unsupportedLogged.add(feature)
				this.log(
					'warn',
					this.capabilities === null
						? `Per-app ${feature} needs a newer Remote Volume app, ignoring ${action}`
						: `The Remote Volume app does not support per-app ${feature} on this computer, or it is turned off in its settings. Ignoring ${action}`,
				)
			}
			return
		}
		this.sendAction(value === undefined ? { action, app: target } : { action, app: target, value })
	}

	/**
	 * Presses a media key on the computer (`play_pause`, `next` or `previous`), like on its keyboard,
	 * when the app supports it (protocol v2, `media.keys`). Otherwise logs once and sends nothing.
	 */
	pressMediaKey(key) {
		const action = MEDIA_ACTIONS[key]
		if (action === undefined) {
			this.log('warn', `Unknown media key ${key}`)
			return
		}
		if (!this.isConnected()) {
			this.log('warn', `Not connected, ignoring action ${action}`)
			return
		}
		if (this.capabilities?.media?.keys !== true) {
			if (!this.unsupportedLogged.has('media')) {
				this.unsupportedLogged.add('media')
				this.log(
					'warn',
					this.capabilities === null
						? `Media keys need a newer Remote Volume app, ignoring ${action}`
						: `The Remote Volume app does not support media keys on this computer. Ignoring ${action}`,
				)
			}
			return
		}
		this.sendAction({ action })
	}

	setAppVolume(app, vol) {
		this.sendAppAction('setAppVolume', 'volume', app, vol)
	}

	increaseAppVolume(app, vol) {
		this.sendAppAction('increaseAppVolume', 'volume', app, vol)
	}

	decreaseAppVolume(app, vol) {
		this.sendAppAction('decreaseAppVolume', 'volume', app, vol)
	}

	muteApp(app) {
		this.sendAppAction('muteApp', 'mute', app)
	}

	unmuteApp(app) {
		this.sendAppAction('unmuteApp', 'mute', app)
	}

	toggleAppMute(app) {
		this.sendAppAction('toggleAppMute', 'mute', app)
	}

	/**
	 * Applies a new `apps` list: variables and feedbacks always, the definitions only when an app
	 * appeared, went away or was renamed (not on every volume change).
	 *
	 * @param {import('./protocol.js').App[] | null} apps
	 */
	setApps(apps) {
		if (this.apps === null && apps === null) return
		this.apps = apps
		const signature = appsSignature(apps)
		if (signature !== this.appsSignature) {
			this.appsSignature = signature
			this.updateDefinitions()
		}
		const values = { apps: (apps ?? []).map((app) => app.name).join(', ') }
		for (const app of apps ?? []) {
			const key = variableKey(app.id)
			values[`app_${key}_volume`] = app.volume
			values[`app_${key}_muted`] = app.muted
		}
		this.setVariableValues(values)
		this.checkFeedbacks('app_muted', 'app_running')
	}

	/**
	 * Applies a message from the app: state fields, the capabilities and app list of protocol v2, and
	 * errors. Keys this module does not know about are ignored.
	 */
	handleMessage({ state, capabilities, error }) {
		if (error !== undefined) {
			this.log('warn', `Remote Volume reported an error: ${error}`)
			return
		}

		if (capabilities !== undefined) {
			this.capabilities = capabilities
			this.unsupportedLogged.clear()
		}
		if ('apps' in state) {
			this.setApps(state.apps)
		}
		if ('muted' in state) {
			this.muted = state.muted
			this.setVariableValues({ muted: this.muted })
		}
		if ('volume' in state) {
			this.volume = state.volume
			this.setVariableValues({ volume: this.volume })
		}
		if ('outputDevice' in state) {
			this.outputDevice = state.outputDevice
			this.setVariableValues({ output_audio_device_name: this.outputDevice })
		}

		this.checkFeedbacks('muted')
	}

	messageReceivedFromWebSocket(event) {
		try {
			this.handleMessage(parseRawMessage(event.data))
		} catch (e) {
			this.log('error', `Could not process message from Remote Volume: ${e.message}`)
		}
	}

	getConfigFields() {
		return ConfigFields
	}
}

/** @param {import('./protocol.js').App[] | null} apps */
function appsSignature(apps) {
	return JSON.stringify((apps ?? []).map((app) => [app.id, app.name]))
}
