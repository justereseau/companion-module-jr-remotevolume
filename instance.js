import { InstanceBase, InstanceStatus } from '@companion-module/base'
import { ConfigFields } from './config.js'
import { getActionDefinitions } from './actions.js'
import { variables } from './variables.js'
import { getFeedbackDefinitions } from './feedbacks.js'
import { getPresetDefinitions } from './presets.js'
import { parseRawMessage } from './protocol.js'
import WebSocket from 'ws'

export class RemoteVolumeInstance extends InstanceBase {
	async init(config) {
		this.config = config
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

	async configUpdated(config) {
		this.config = config
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

		this.updateStatus(InstanceStatus.Connecting)

		if (this.ws) {
			this.ws.close(1000)
			delete this.ws
		}
		this.ws = new WebSocket(url)
		if (!this.ws) {
			throw new Error('WebSocket initialization failed')
		}

		this.ws.addEventListener('open', () => {
			this.updateStatus(InstanceStatus.Ok)

			if (this.reconnectTimer) {
				clearInterval(this.reconnectTimer)
				this.reconnectTimer = null
			}
		})

		this.ws.addEventListener('close', (event) => {
			this.capabilities = null
			this.updateStatus(InstanceStatus.Disconnected, `Connection closed with code ${event.code}`)
			this.maybeReconnect()
		})

		this.ws.addEventListener('message', (event) => this.messageReceivedFromWebSocket(event))

		this.ws.addEventListener('error', (data) => {
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
