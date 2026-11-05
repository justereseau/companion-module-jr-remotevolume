import { variableKey } from './protocol.js'

export const variables = [
	{
		name: 'Mute state',
		variableId: 'muted',
	},
	{
		name: 'Volume',
		variableId: 'volume',
	},
	{
		name: 'Name of the currently active Audio Device',
		variableId: 'output_audio_device_name',
	},
	{
		name: 'Apps playing audio (comma-separated names)',
		variableId: 'apps',
	},
]

/**
 * The fixed variables plus `app_<id>_volume` and `app_<id>_muted` for each app playing audio.
 *
 * @param {import('./protocol.js').App[] | null} apps
 */
export function getVariableDefinitions(apps) {
	const definitions = [...variables]
	for (const app of apps ?? []) {
		const key = variableKey(app.id)
		definitions.push(
			{ name: `${app.name}: volume`, variableId: `app_${key}_volume` },
			{ name: `${app.name}: mute state`, variableId: `app_${key}_muted` },
		)
	}
	return definitions
}
