import { combineRgb } from '@companion-module/base'
import { variableKey } from './protocol.js'

export function getPresetDefinitions(self) {
	const presets = []

	presets.push({
		category: 'Volume',
		name: '+10%',
		type: 'button',
		style: {
			text: '+10%',
			size: '18',
			bgcolor: combineRgb(0, 0, 0),
			color: combineRgb(255, 255, 255),
		},
		steps: [
			{
				down: [
					{
						actionId: 'adjust_volume',
						options: { value: '10' },
					},
				],
			},
		],
		feedbacks: [],
	})
	presets.push({
		category: 'Volume',
		name: '-10%',
		type: 'button',
		style: {
			text: '-10%',
			size: '18',
			bgcolor: combineRgb(0, 0, 0),
			color: combineRgb(255, 255, 255),
		},
		steps: [
			{
				down: [
					{
						actionId: 'adjust_volume',
						options: { value: '-10' },
					},
				],
			},
		],
		feedbacks: [],
	})
	presets.push({
		category: 'Mute',
		name: 'Toggle Mute',
		type: 'button',
		style: {
			text: 'Unmuted',
			size: '14',
			bgcolor: combineRgb(0, 255, 0),
			color: combineRgb(0, 0, 0),
		},
		steps: [
			{
				down: [
					{
						actionId: 'mute',
						options: { mute: 'toggle' },
					},
				],
			},
		],
		feedbacks: [
			{
				feedbackId: 'muted',
				options: {},
				style: {
					text: 'Muted',
					size: '18',
					bgcolor: combineRgb(255, 0, 0),
					color: combineRgb(255, 255, 255),
				},
			},
		],
	})

	for (const [key, name, text] of [
		['previous', 'Previous track', 'Prev'],
		['play_pause', 'Play / Pause', 'Play\nPause'],
		['next', 'Next track', 'Next'],
	]) {
		presets.push({
			category: 'Media',
			name,
			type: 'button',
			style: {
				text,
				size: '14',
				bgcolor: combineRgb(0, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			steps: [{ down: [{ actionId: 'media_key', options: { key } }], up: [] }],
			feedbacks: [],
		})
	}

	for (let number = 1; number <= 24; number++) {
		presets.push({
			category: 'Function keys',
			name: `F${number}`,
			type: 'button',
			style: {
				text: `F${number}`,
				size: '18',
				bgcolor: combineRgb(0, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			steps: [{ down: [{ actionId: 'function_key', options: { key: number } }], up: [] }],
			feedbacks: [],
		})
	}

	// Per-app presets for the apps playing audio right now; they follow the list as it changes.
	// Each kind has its own category and text, so the two buttons of one app are told apart.
	const label = self.label ?? 'jr-remotevolume'
	for (const app of self.apps ?? []) {
		const volume = `$(${label}:app_${variableKey(app.id)}_volume)`
		const muted = {
			feedbackId: 'app_muted',
			options: { app: app.id },
			style: { bgcolor: combineRgb(255, 0, 0), color: combineRgb(255, 255, 255) },
		}
		presets.push({
			category: 'Apps: Mute',
			name: `${app.name}: Toggle Mute`,
			type: 'button',
			style: {
				text: `${app.name}\nMute`,
				size: '14',
				bgcolor: combineRgb(0, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			steps: [{ down: [{ actionId: 'app_mute', options: { app: app.id, mute: 'toggle' } }], up: [] }],
			feedbacks: [{ ...muted, style: { ...muted.style, text: `${app.name}\nMuted` } }],
		})
		presets.push({
			category: 'Apps: Volume',
			name: `${app.name}: Volume knob`,
			type: 'button',
			options: { rotaryActions: true },
			style: {
				text: `${app.name}\n${volume}%`,
				size: '14',
				bgcolor: combineRgb(0, 0, 0),
				color: combineRgb(255, 255, 255),
			},
			steps: [
				{
					down: [{ actionId: 'app_mute', options: { app: app.id, mute: 'toggle' } }],
					up: [],
					rotate_left: [{ actionId: 'app_adjust_volume', options: { app: app.id, value: '-5' } }],
					rotate_right: [{ actionId: 'app_adjust_volume', options: { app: app.id, value: '5' } }],
				},
			],
			feedbacks: [muted],
		})
	}

	return presets
}
