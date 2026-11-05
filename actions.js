/**
 * The app picker of the per-app actions and feedbacks: the apps playing audio right now, and any
 * id typed by hand, so a button can name an app that is not running yet.
 */
export function appOption(self) {
	const apps = Array.isArray(self.apps) ? self.apps : []
	return {
		type: 'dropdown',
		id: 'app',
		label: 'App',
		default: apps[0]?.id ?? '',
		allowCustom: true,
		tooltip: 'An app playing audio, or type its id: the program file name without .exe, e.g. spotify, chrome, discord.',
		// `Spotify` for spotify, `Google Chrome (chrome)` when the id is not obvious from the name.
		choices: apps.map((app) => ({
			id: app.id,
			label: app.name.toLowerCase() === app.id ? app.name : `${app.name} (${app.id})`,
		})),
	}
}

const APP_NOTE =
	'Needs per-app audio in the Remote Volume app (protocol v2, on Windows or Linux); otherwise nothing is sent.'

export function getActionDefinitions(self) {
	return {
		set_volume: {
			name: 'Set Volume [absolute]',
			description: 'Set the absolute volume level',
			options: [
				{
					type: 'number',
					id: 'volume',
					label: 'Volume',
					default: 50,
					min: 0,
					max: 100,
				},
			],
			callback: async (action) => {
				self.setVolume(action.options.volume)
			},
		},
		increaseVolume: {
			name: 'Increase Volume',
			description: 'Set the absolute volume level',
			options: [
				{
					type: 'number',
					id: 'volume',
					label: 'Increase by',
					default: 10,
					min: 1,
					max: 99,
				},
			],
			callback: async (action) => {
				self.increaseVolume(action.options.volume)
			},
		},
		decreaseVolume: {
			name: 'Decrease Volume',
			description: 'Set the absolute volume level',
			options: [
				{
					type: 'number',
					id: 'volume',
					label: 'Decrease by',
					default: 10,
					min: 1,
					max: 99,
				},
			],
			callback: async (action) => {
				self.decreaseVolume(action.options.volume)
			},
		},
		mute: {
			name: 'Set Mute',
			description: 'Set the mute state',
			options: [
				{
					type: 'dropdown',
					id: 'mute',
					label: 'Mute',
					default: 'mute',
					choices: [
						{ id: 'mute', label: 'Mute' },
						{ id: 'unmute', label: 'Unmute' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: async (action) => {
				switch (action.options.mute) {
					case 'mute':
						self.mute()
						break
					case 'unmute':
						self.unmute()
						break
					case 'toggle':
						self.toggleMute()
				}
			},
		},
		app_set_volume: {
			name: 'App: Set Volume [absolute]',
			description: `Set the volume of one app. ${APP_NOTE}`,
			options: [appOption(self), { type: 'number', id: 'volume', label: 'Volume', default: 50, min: 0, max: 100 }],
			callback: async (action) => {
				self.setAppVolume(action.options.app, action.options.volume)
			},
		},
		app_increase_volume: {
			name: 'App: Increase Volume',
			description: `Raise the volume of one app. ${APP_NOTE}`,
			options: [appOption(self), { type: 'number', id: 'volume', label: 'Increase by', default: 10, min: 1, max: 99 }],
			callback: async (action) => {
				self.increaseAppVolume(action.options.app, action.options.volume)
			},
		},
		app_decrease_volume: {
			name: 'App: Decrease Volume',
			description: `Lower the volume of one app. ${APP_NOTE}`,
			options: [appOption(self), { type: 'number', id: 'volume', label: 'Decrease by', default: 10, min: 1, max: 99 }],
			callback: async (action) => {
				self.decreaseAppVolume(action.options.app, action.options.volume)
			},
		},
		app_mute: {
			name: 'App: Set Mute',
			description: `Mute, unmute or toggle one app. ${APP_NOTE}`,
			options: [
				appOption(self),
				{
					type: 'dropdown',
					id: 'mute',
					label: 'Mute',
					default: 'toggle',
					choices: [
						{ id: 'mute', label: 'Mute' },
						{ id: 'unmute', label: 'Unmute' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: async (action) => {
				switch (action.options.mute) {
					case 'mute':
						self.muteApp(action.options.app)
						break
					case 'unmute':
						self.unmuteApp(action.options.app)
						break
					case 'toggle':
						self.toggleAppMute(action.options.app)
				}
			},
		},
		getState: {
			name: 'Get latest Data',
			description: 'Retrieve the latest information manually if polling is disabled',
			options: [],
			callback: async (action) => {
				self.getState()
			},
		},
	}
}
