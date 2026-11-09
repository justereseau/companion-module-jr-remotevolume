import { appOptions, chosenApp, deviceOption } from './actions.js'
import { findApp, findOutputDevice } from './protocol.js'

export function getFeedbackDefinitions(self) {
	const app = async (feedback, context) => findApp(self.apps, await chosenApp(feedback.options, context))
	return {
		muted: {
			type: 'boolean',
			name: 'Muted',
			description: 'Check if the audio is currently muted',
			options: [],
			callback: (feedback) => {
				return self.muted === true
			},
		},
		device_is_default: {
			type: 'boolean',
			name: 'Device is default',
			description: 'True while this device is the default output, e.g. to show speakers or headset on a toggle button',
			options: [deviceOption(self)],
			callback: (feedback) => findOutputDevice(self.outputDevices, feedback.options.device)?.default === true,
		},
		app_muted: {
			type: 'boolean',
			name: 'App: Muted',
			description: 'True while the app is playing audio and muted (all of its sessions)',
			options: appOptions(self),
			callback: async (feedback, context) => (await app(feedback, context))?.muted === true,
		},
		app_running: {
			type: 'boolean',
			name: 'App: Running',
			description: 'True while the app has an audio session, e.g. to grey out a button when it is gone',
			options: appOptions(self),
			callback: async (feedback, context) => (await app(feedback, context)) !== undefined,
		},
	}
}
