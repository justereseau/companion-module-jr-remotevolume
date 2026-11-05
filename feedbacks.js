import { appOption } from './actions.js'
import { findApp } from './protocol.js'

export function getFeedbackDefinitions(self) {
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
		app_muted: {
			type: 'boolean',
			name: 'App: Muted',
			description: 'True while the app is playing audio and muted (all of its sessions)',
			options: [appOption(self)],
			callback: (feedback) => findApp(self.apps, feedback.options.app)?.muted === true,
		},
		app_running: {
			type: 'boolean',
			name: 'App: Running',
			description: 'True while the app has an audio session, e.g. to grey out a button when it is gone',
			options: [appOption(self)],
			callback: (feedback) => findApp(self.apps, feedback.options.app) !== undefined,
		},
	}
}
