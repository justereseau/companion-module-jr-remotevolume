import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getActionDefinitions } from '../actions.js'
import { ConfigFields } from '../config.js'
import { getFeedbackDefinitions } from '../feedbacks.js'
import { getPresetDefinitions } from '../presets.js'
import { getVariableDefinitions, variables } from '../variables.js'

const APPS = [
	{ id: 'spotify', name: 'Spotify', volume: 80, muted: false },
	{ id: 'chrome', name: 'Google Chrome', volume: 30, muted: true },
]
const withApps = { apps: APPS, label: 'rv' }
const actions = getActionDefinitions(withApps)
const feedbacks = getFeedbackDefinitions(withApps)
const presets = getPresetDefinitions(withApps)

test('presets only use actions and feedbacks that exist, with valid options', () => {
	assert.ok(presets.length > 0)
	for (const preset of presets) {
		for (const step of preset.steps) {
			for (const { actionId, options } of [...step.down, ...(step.rotate_left ?? []), ...(step.rotate_right ?? [])]) {
				assert.ok(actions[actionId], `${preset.name}: unknown action ${actionId}`)
				for (const key of Object.keys(options)) {
					assert.ok(
						actions[actionId].options.some((option) => option.id === key),
						`${preset.name}: unknown option ${key}`,
					)
				}
			}
		}
		for (const { feedbackId, options } of preset.feedbacks) {
			assert.ok(feedbacks[feedbackId], `${preset.name}: unknown feedback ${feedbackId}`)
			for (const key of Object.keys(options)) {
				assert.ok(
					feedbacks[feedbackId].options.some((option) => option.id === key),
					`${preset.name}: unknown feedback option ${key}`,
				)
			}
		}
	}
})

test('number options have defaults inside their range', () => {
	for (const [id, action] of Object.entries(actions)) {
		for (const option of action.options.filter((o) => o.type === 'number')) {
			assert.ok(option.default >= option.min && option.default <= option.max, `${id}.${option.id}`)
		}
	}
})

test('action callbacks pass the options on to the instance', async () => {
	const calls = []
	const self = new Proxy(
		{},
		{
			get:
				(_, name) =>
				(...args) =>
					calls.push([name, ...args]),
		},
	)
	const defs = getActionDefinitions(self)
	await defs.set_volume.callback({ options: { volume: 1 } })
	await defs.increaseVolume.callback({ options: { volume: 2 } })
	await defs.decreaseVolume.callback({ options: { volume: 3 } })
	await defs.mute.callback({ options: { mute: 'toggle' } })
	await defs.app_set_volume.callback({ options: { app: 'spotify', volume: 4 } })
	await defs.app_increase_volume.callback({ options: { app: 'spotify', volume: 5 } })
	await defs.app_decrease_volume.callback({ options: { app: 'spotify', volume: 6 } })
	await defs.app_mute.callback({ options: { app: 'chrome', mute: 'mute' } })
	await defs.app_mute.callback({ options: { app: 'chrome', mute: 'unmute' } })
	await defs.app_mute.callback({ options: { app: 'chrome', mute: 'toggle' } })
	assert.deepEqual(calls, [
		['setVolume', 1],
		['increaseVolume', 2],
		['decreaseVolume', 3],
		['toggleMute'],
		['setAppVolume', 'spotify', 4],
		['increaseAppVolume', 'spotify', 5],
		['decreaseAppVolume', 'spotify', 6],
		['muteApp', 'chrome'],
		['unmuteApp', 'chrome'],
		['toggleAppMute', 'chrome'],
	])
})

test('the muted feedback follows the instance, and is false while the state is unknown', () => {
	const self = { muted: null }
	const { muted } = getFeedbackDefinitions(self)
	assert.equal(muted.callback({}), false)
	self.muted = true
	assert.equal(muted.callback({}), true)
	self.muted = false
	assert.equal(muted.callback({}), false)
})

test('the app picker lists the running apps and accepts any typed id', () => {
	const option = actions.app_mute.options[0]
	assert.equal(option.allowCustom, true)
	assert.equal(option.default, 'spotify')
	assert.deepEqual(option.choices, [
		{ id: 'spotify', label: 'Spotify' },
		{ id: 'chrome', label: 'Google Chrome (chrome)' },
	])
	const empty = getActionDefinitions({}).app_mute.options[0]
	assert.equal(empty.default, '')
	assert.deepEqual(empty.choices, [])
	assert.equal(feedbacks.app_running.options[0].id, 'app')
})

test('the app feedbacks find the app by id or name, and are false while it is not running', () => {
	const self = { apps: null }
	const { app_muted, app_running } = getFeedbackDefinitions(self)
	const check = (fb, app) => fb.callback({ options: { app } })
	assert.equal(check(app_running, 'chrome'), false)
	assert.equal(check(app_muted, 'chrome'), false)
	self.apps = APPS
	assert.equal(check(app_running, 'Chrome.exe'), true)
	assert.equal(check(app_muted, 'google chrome'), true)
	assert.equal(check(app_muted, 'spotify'), false)
	assert.equal(check(app_running, 'discord'), false)
})

test('presets: a mute button and a volume knob per running app, none without apps', () => {
	const apps = presets.filter((p) => p.category === 'Apps')
	assert.deepEqual(
		apps.map((p) => p.name),
		['Spotify: Toggle Mute', 'Spotify: Volume knob', 'Google Chrome: Toggle Mute', 'Google Chrome: Volume knob'],
	)
	assert.equal(apps[0].style.text, 'Spotify\n$(rv:app_spotify_volume)%')
	assert.equal(apps[1].options.rotaryActions, true)
	assert.equal(getPresetDefinitions({}).filter((p) => p.category === 'Apps').length, 0)
})

test('variable ids and config field ids are as documented and unique', () => {
	assert.deepEqual(
		variables.map((v) => v.variableId),
		['muted', 'volume', 'output_audio_device_name', 'apps'],
	)
	assert.deepEqual(
		getVariableDefinitions([{ id: 'my app', name: 'My App' }])
			.map((v) => v.variableId)
			.slice(variables.length),
		['app_my_app_volume', 'app_my_app_muted'],
	)
	assert.equal(getVariableDefinitions(null).length, variables.length)
	const fields = ConfigFields.map((f) => f.id)
	assert.equal(new Set(fields).size, fields.length)
})
