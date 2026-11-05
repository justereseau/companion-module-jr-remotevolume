/**
 * The app picker of the per-app actions and feedbacks: a dropdown of the apps playing audio right
 * now (any id can also be typed, for an app that is not running yet), or a text field that takes
 * variables. Read the chosen app with {@link chosenApp}.
 */
export function appOptions(self) {
	const apps = Array.isArray(self.apps) ? self.apps : []
	return [
		{
			type: 'checkbox',
			id: 'app_by_variable',
			label: 'Pick the app with a variable',
			default: false,
		},
		{
			type: 'dropdown',
			id: 'app',
			label: 'App',
			default: apps[0]?.id ?? '',
			allowCustom: true,
			tooltip:
				'An app playing audio, or type its id: the program file name without .exe, e.g. spotify, chrome, discord.',
			// `Spotify` for spotify, `Google Chrome (chrome)` when the id is not obvious from the name.
			choices: apps.map((app) => ({
				id: app.id,
				label: app.name.toLowerCase() === app.id ? app.name : `${app.name} (${app.id})`,
			})),
			isVisibleExpression: '!$(options:app_by_variable)',
		},
		{
			type: 'textinput',
			id: 'app_variable',
			label: 'App',
			default: '',
			useVariables: { local: true },
			tooltip:
				'An app id or name, variables allowed, e.g. $(custom:app). The id is the program file name without .exe.',
			isVisibleExpression: '$(options:app_by_variable)',
		},
	]
}

/** The app an action or feedback targets, with variables replaced when picked by variable. */
export async function chosenApp(options, context) {
	if (options.app_by_variable) return context.parseVariablesInString(String(options.app_variable ?? ''))
	return options.app
}

/** The step of the Adjust Volume actions: a signed number, variables allowed. */
const STEP_OPTION = {
	type: 'textinput',
	id: 'value',
	label: 'Change by',
	default: '10',
	useVariables: { local: true },
	tooltip: 'Percentage points: positive raises the volume, negative lowers it, e.g. 5 or -5. Variables allowed.',
}

const MUTE_OPTION = {
	type: 'dropdown',
	id: 'mute',
	label: 'Mute',
	default: 'mute',
	choices: [
		{ id: 'mute', label: 'Mute' },
		{ id: 'unmute', label: 'Unmute' },
		{ id: 'toggle', label: 'Toggle' },
	],
}

const step = (options, context) => context.parseVariablesInString(String(options.value ?? ''))

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
		adjust_volume: {
			name: 'Adjust Volume',
			description: 'Raise or lower the volume: a positive step raises it, a negative one lowers it',
			options: [STEP_OPTION],
			callback: async (action, context) => {
				self.adjustVolume(await step(action.options, context))
			},
		},
		mute: {
			name: 'Set Mute',
			description: 'Set the mute state',
			options: [MUTE_OPTION],
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
			options: [...appOptions(self), { type: 'number', id: 'volume', label: 'Volume', default: 50, min: 0, max: 100 }],
			callback: async (action, context) => {
				self.setAppVolume(await chosenApp(action.options, context), action.options.volume)
			},
		},
		app_adjust_volume: {
			name: 'App: Adjust Volume',
			description: `Raise or lower the volume of one app: a positive step raises it, a negative one lowers it. ${APP_NOTE}`,
			options: [...appOptions(self), STEP_OPTION],
			callback: async (action, context) => {
				self.adjustAppVolume(await chosenApp(action.options, context), await step(action.options, context))
			},
		},
		app_mute: {
			name: 'App: Set Mute',
			description: `Mute, unmute or toggle one app. ${APP_NOTE}`,
			options: [...appOptions(self), { ...MUTE_OPTION, default: 'toggle' }],
			callback: async (action, context) => {
				const app = await chosenApp(action.options, context)
				switch (action.options.mute) {
					case 'mute':
						self.muteApp(app)
						break
					case 'unmute':
						self.unmuteApp(app)
						break
					case 'toggle':
						self.toggleAppMute(app)
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
