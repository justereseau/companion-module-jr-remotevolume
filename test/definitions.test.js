import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getActionDefinitions } from '../actions.js'
import { ConfigFields } from '../config.js'
import { getFeedbackDefinitions } from '../feedbacks.js'
import { getPresetDefinitions } from '../presets.js'
import { variables } from '../variables.js'

const actions = getActionDefinitions({})
const feedbacks = getFeedbackDefinitions({})
const presets = getPresetDefinitions({})

test('presets only use actions and feedbacks that exist, with valid options', () => {
	assert.ok(presets.length > 0)
	for (const preset of presets) {
		for (const step of preset.steps) {
			for (const { actionId, options } of step.down) {
				assert.ok(actions[actionId], `${preset.name}: unknown action ${actionId}`)
				for (const key of Object.keys(options)) {
					assert.ok(
						actions[actionId].options.some((option) => option.id === key),
						`${preset.name}: unknown option ${key}`,
					)
				}
			}
		}
		for (const { feedbackId } of preset.feedbacks) {
			assert.ok(feedbacks[feedbackId], `${preset.name}: unknown feedback ${feedbackId}`)
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
	assert.deepEqual(calls, [['setVolume', 1], ['increaseVolume', 2], ['decreaseVolume', 3], ['toggleMute']])
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

test('variable ids and config field ids are as documented and unique', () => {
	assert.deepEqual(
		variables.map((v) => v.variableId),
		['muted', 'volume', 'output_audio_device_name'],
	)
	const fields = ConfigFields.map((f) => f.id)
	assert.equal(new Set(fields).size, fields.length)
})
