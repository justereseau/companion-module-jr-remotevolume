import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMessage, parseRawMessage } from '../protocol.js'

const CAPABILITIES = {
	protocolVersion: 2,
	outputDevices: { list: false, select: false },
	apps: { volume: false, mute: false },
}

test('full state on connect', () => {
	const parsed = parseRawMessage('{"volume":65,"muted":true,"outputDevice":"Speakers"}')
	assert.deepEqual(parsed.state, { volume: 65, muted: true, outputDevice: 'Speakers' })
	assert.equal(parsed.capabilities, undefined)
	assert.equal(parsed.error, undefined)
})

test('v2 capabilities are kept apart from the state', () => {
	const parsed = parseRawMessage(
		JSON.stringify({ volume: 40, muted: false, outputDevice: 'Speakers', capabilities: CAPABILITIES }),
	)
	assert.deepEqual(parsed.state, { volume: 40, muted: false, outputDevice: 'Speakers' })
	assert.deepEqual(parsed.capabilities, CAPABILITIES)
})

test('partial state broadcasts only carry what changed', () => {
	assert.deepEqual(parseMessage({ muted: false }).state, { muted: false })
	assert.deepEqual(parseMessage({ volume: 0 }).state, { volume: 0 })
	assert.deepEqual(parseMessage({ outputDevice: 'Headphones' }).state, { outputDevice: 'Headphones' })
})

test('unknown keys (v2 lists, future fields) are ignored', () => {
	const parsed = parseMessage({ volume: 10, apps: [{ id: 'spotify', volume: 40, muted: false }], outputDevices: [] })
	assert.deepEqual(parsed.state, { volume: 10 })
})

test('values of the wrong type are ignored', () => {
	const parsed = parseMessage({ volume: '10', muted: 1, outputDevice: null, capabilities: [] })
	assert.deepEqual(parsed.state, {})
	assert.equal(parsed.capabilities, undefined)
})

test('action replies are unwrapped', () => {
	assert.deepEqual(parseMessage({ action: 'isMuted', response: { muted: true } }).state, { muted: true })
	assert.deepEqual(parseMessage({ action: 'getCapabilities', response: { capabilities: CAPABILITIES } }).capabilities, CAPABILITIES)
})

test('errors are reported and carry no state', () => {
	assert.equal(parseMessage({ action: 'mute', response: { error: 'Failed to execute action' } }).error, 'Failed to execute action')
	assert.equal(parseMessage({ error: 'Invalid message' }).error, 'Invalid message')
	assert.deepEqual(parseMessage({ error: 'x', volume: 5 }).state, {})
})

test('non-object JSON is harmless', () => {
	for (const value of [null, 5, 'text', [1, 2], true]) {
		assert.deepEqual(parseMessage(value).state, {})
	}
})

test('binary frames are decoded', () => {
	const text = '{"muted":true}'
	assert.deepEqual(parseRawMessage(Buffer.from(text)).state, { muted: true })
	assert.deepEqual(parseRawMessage([Buffer.from('{"mut'), Buffer.from('ed":true}')]).state, { muted: true })
	assert.deepEqual(parseRawMessage(new TextEncoder().encode(text).buffer).state, { muted: true })
})

test('invalid JSON throws', () => {
	assert.throws(() => parseRawMessage(''), SyntaxError)
	assert.throws(() => parseRawMessage('{'), SyntaxError)
})
