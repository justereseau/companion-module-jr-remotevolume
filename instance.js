import { InstanceBase, InstanceStatus } from '@companion-module/base'
import { ConfigFields } from './config.js'
import { getActionDefinitions } from './actions.js'
import { variables } from './variables.js'
import { getFeedbackDefinitions } from './feedbacks.js'
import { getPresetDefinitions } from './presets.js'
import { parseRawMessage } from './protocol.js'
import WebSocket from 'ws'

export class RemoteVolumeInstance extends InstanceBase {
	async init(config, _isFirstInit, secrets) {
		this.config = config
		this.secrets = secrets ?? {}
		this.isInitialized = false
		this.reconnectInterval = 5000
		this.reconnectTimer = null
		this.muted = null
		// Capabilities announced by the app (protocol v2). Kept for later, nothing uses them yet.
		this.capabilities = null

		this.setActionDefinitions(getActionDefinitions(this))
		this.setFeedbackDefinitions(getFeedbackDefinitions(this))
		this.setPresetDefinitions(getPresetDefinitions(this))
		this.setVariableDefinitions(variables)

		this.initWebSocket()
		this.isInitialized = true
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

	sendAction(message) {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
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
	 * Applies a message from the app: state fields, the capabilities of protocol v2 (stored only) and
	 * errors. Keys this module does not know about are ignored.
	 */
	handleMessage({ state, capabilities, error }) {
		if (error !== undefined) {
			this.log('warn', `Remote Volume reported an error: ${error}`)
			return
		}

		if (capabilities !== undefined) {
			this.capabilities = capabilities
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
