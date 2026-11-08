import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getActionDefinitions } from '../actions.js'
import { ConfigFields } from '../config.js'
import { getFeedbackDefinitions } from '../feedbacks.js'
import { getPresetDefinitions } from '../presets.js'
import { getVariableDefinitions, variables } from '../variables.js'
import { UpgradeScripts } from '../upgrades.js'
import { CONTEXT } from './helpers.js'

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
	const run = (id, options) => defs[id].callback({ options }, CONTEXT)
	const byVariable = { app: 'spotify', app_by_variable: true, app_variable: '$(custom:app)' }
	await run('set_volume', { volume: 1 })
	await run('adjust_volume', { value: '2' })
	await run('adjust_volume', { value: '$(custom:step)' })
	await run('mute', { mute: 'toggle' })
	await run('app_set_volume', { app: 'spotify', volume: 4 })
	await run('app_set_volume', { ...byVariable, volume: 5 })
	await run('app_adjust_volume', { app: 'spotify', value: '-6' })
	await run('app_adjust_volume', { ...byVariable, value: '$(custom:step)' })
	await run('app_mute', { ...byVariable, mute: 'mute' })
	await run('app_mute', { app: 'chrome', mute: 'unmute' })
	await run('app_mute', { app: 'chrome', mute: 'toggle' })
	await run('media_key', { key: 'next' })
	await run('function_key', { key: 13 })
	assert.deepEqual(calls, [
		['setVolume', 1],
		['adjustVolume', '2'],
		['adjustVolume', '-3'],
		['toggleMute'],
		['setAppVolume', 'spotify', 4],
		['setAppVolume', 'discord', 5],
		['adjustAppVolume', 'spotify', '-6'],
		['adjustAppVolume', 'discord', '-3'],
		['muteApp', 'discord'],
		['unmuteApp', 'chrome'],
		['toggleAppMute', 'chrome'],
		['pressMediaKey', 'next'],
		['pressFunctionKey', 13],
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

const appPicker = (def) => def.options.find((o) => o.id === 'app')

test('the app picker lists the running apps and accepts any typed id', () => {
	const option = appPicker(actions.app_mute)
	assert.equal(option.allowCustom, true)
	assert.equal(option.default, 'spotify')
	assert.deepEqual(option.choices, [
		{ id: 'spotify', label: 'Spotify' },
		{ id: 'chrome', label: 'Google Chrome (chrome)' },
	])
	const empty = appPicker(getActionDefinitions({}).app_mute)
	assert.equal(empty.default, '')
	assert.deepEqual(empty.choices, [])
	assert.ok(appPicker(feedbacks.app_running))
})

test('every app action and feedback can pick the app with a variable, shown only when ticked', () => {
	const defs = [...Object.entries(actions), ...Object.entries(feedbacks)].filter(([id]) => id.startsWith('app_'))
	assert.equal(defs.length, 5)
	for (const [id, def] of defs) {
		assert.deepEqual(
			def.options.slice(0, 3).map((o) => o.id),
			['app_by_variable', 'app', 'app_variable'],
			id,
		)
		const [, dropdown, text] = def.options
		assert.equal(text.type, 'textinput', id)
		assert.ok(text.useVariables, id)
		assert.equal(text.isVisibleExpression, '$(options:app_by_variable)', id)
		assert.equal(dropdown.isVisibleExpression, '!$(options:app_by_variable)', id)
	}
})

test('the adjust steps take variables, and the increase / decrease actions are gone', () => {
	for (const id of ['adjust_volume', 'app_adjust_volume']) {
		const step = actions[id].options.find((o) => o.id === 'value')
		assert.equal(step.type, 'textinput')
		assert.ok(step.useVariables)
	}
	for (const id of ['increaseVolume', 'decreaseVolume', 'app_increase_volume', 'app_decrease_volume']) {
		assert.equal(actions[id], undefined, id)
	}
})

test('the upgrade script turns increase / decrease into adjust, keeping the app and the amount', () => {
	const action = (actionId, options) => ({ id: actionId, controlId: 'c', actionId, options })
	const props = {
		config: null,
		secrets: null,
		feedbacks: [],
		actions: [
			action('increaseVolume', { volume: 5 }),
			action('decreaseVolume', { volume: 10 }),
			action('app_increase_volume', { app: 'spotify', volume: 3 }),
			action('app_decrease_volume', { app: 'chrome' }),
			action('mute', { mute: 'toggle' }),
		],
	}
	const result = UpgradeScripts[0]({ currentConfig: {} }, props)
	assert.deepEqual(
		result.updatedActions.map((a) => [a.id, a.actionId, a.options]),
		[
			['increaseVolume', 'adjust_volume', { value: '5' }],
			['decreaseVolume', 'adjust_volume', { value: '-10' }],
			['app_increase_volume', 'app_adjust_volume', { app: 'spotify', value: '3' }],
			['app_decrease_volume', 'app_adjust_volume', { app: 'chrome', value: '-10' }],
		],
	)
	assert.equal(result.updatedConfig, null)
	assert.deepEqual(result.updatedFeedbacks, [])
})

test('the app feedbacks find the app by id, name or variable, and are false while it is not running', async () => {
	const self = { apps: null }
	const { app_muted, app_running } = getFeedbackDefinitions(self)
	const check = (fb, app) => fb.callback({ options: { app } }, CONTEXT)
	assert.equal(await check(app_running, 'chrome'), false)
	assert.equal(await check(app_muted, 'chrome'), false)
	self.apps = APPS
	assert.equal(await check(app_running, 'Chrome.exe'), true)
	assert.equal(await check(app_muted, 'google chrome'), true)
	assert.equal(await check(app_muted, 'spotify'), false)
	assert.equal(await check(app_running, 'discord'), false)
	self.apps = [...APPS, { id: 'discord', name: 'Discord', volume: 50, muted: true }]
	const byVariable = { options: { app: 'spotify', app_by_variable: true, app_variable: '$(custom:app)' } }
	assert.equal(await app_muted.callback(byVariable, CONTEXT), true)
})

test('the function key picker lists F1 to F24, F13 by default', () => {
	const option = actions.function_key.options[0]
	assert.equal(option.default, 13)
	assert.equal(option.choices.length, 24)
	assert.deepEqual(option.choices[0], { id: 1, label: 'F1' })
	assert.deepEqual(option.choices[23], { id: 24, label: 'F24' })
})

test('presets: previous, play / pause and next media keys', () => {
	const media = presets.filter((p) => p.category === 'Media')
	assert.deepEqual(
		media.map((p) => [p.name, p.steps[0].down[0].options.key]),
		[
			['Previous track', 'previous'],
			['Play / Pause', 'play_pause'],
			['Next track', 'next'],
		],
	)
	assert.deepEqual(
		actions.media_key.options[0].choices.map((c) => c.id),
		['play_pause', 'next', 'previous'],
	)
})

test('presets: a mute button and a volume knob per running app, none without apps', () => {
	const apps = presets.filter((p) => p.category.startsWith('Apps'))
	assert.deepEqual(
		apps.map((p) => p.name),
		['Spotify: Toggle Mute', 'Spotify: Volume knob', 'Google Chrome: Toggle Mute', 'Google Chrome: Volume knob'],
	)
	// The two buttons of one app differ in category and text, so they don't look like duplicates.
	assert.deepEqual(
		apps.map((p) => [p.category, p.style.text]),
		[
			['Apps: Mute', 'Spotify\nMute'],
			['Apps: Volume', 'Spotify\n$(rv:app_spotify_volume)%'],
			['Apps: Mute', 'Google Chrome\nMute'],
			['Apps: Volume', 'Google Chrome\n$(rv:app_chrome_volume)%'],
		],
	)
	assert.equal(apps[0].feedbacks[0].style.text, 'Spotify\nMuted')
	assert.equal(apps[1].options.rotaryActions, true)
	assert.equal(getPresetDefinitions({}).filter((p) => p.category.startsWith('Apps')).length, 0)
})

test('presets: one button per function key, F1 to F24', () => {
	const keys = presets.filter((p) => p.category === 'Function keys')
	assert.equal(keys.length, 24)
	assert.deepEqual(
		[keys[0], keys[12], keys[23]].map((p) => [p.style.text, p.steps[0].down[0].options.key]),
		[
			['F1', 1],
			['F13', 13],
			['F24', 24],
		],
	)
})

test('variable ids and config field ids are as documented and unique', () => {
	assert.deepEqual(
		variables.map((v) => v.variableId),
		['muted', 'volume', 'output_audio_device_name', 'apps', 'backend_version'],
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
