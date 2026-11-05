import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appId, findApp, parseMessage, parseRawMessage, variableKey } from '../protocol.js'

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

test('unknown keys (future lists and fields) are ignored', () => {
	const parsed = parseMessage({ volume: 10, outputDevices: [], somethingNew: { a: 1 } })
	assert.deepEqual(parsed.state, { volume: 10 })
})

test('the v2 apps list is parsed, skipping malformed entries', () => {
	const parsed = parseMessage({
		apps: [
			{ id: 'spotify', name: 'Spotify', volume: 80, muted: false },
			{ id: 'chrome', volume: 30, muted: true },
			{ id: '', name: 'No id' },
			{ name: 'Nameless' },
			'discord',
			null,
			{ id: 'odd', name: 5, volume: '5', muted: 'yes' },
		],
	})
	assert.deepEqual(parsed.state.apps, [
		{ id: 'spotify', name: 'Spotify', volume: 80, muted: false },
		{ id: 'chrome', name: 'chrome', volume: 30, muted: true },
		{ id: 'odd', name: 'odd', volume: 0, muted: false },
	])
	assert.deepEqual(parseMessage({ apps: [] }).state, { apps: [] })
	assert.deepEqual(parseMessage({ apps: null }).state, { apps: null }, 'turned off in the app')
	assert.deepEqual(parseMessage({ apps: 'x' }).state, {})
	assert.deepEqual(parseMessage({ action: 'getApps', response: { apps: [{ id: 'vlc' }] } }).state.apps, [
		{ id: 'vlc', name: 'vlc', volume: 0, muted: false },
	])
})

test('app ids are derived and matched like the app does', () => {
	assert.equal(appId('Spotify.exe'), 'spotify')
	assert.equal(appId('C:\\Program Files\\Discord\\Discord.EXE'), 'discord')
	assert.equal(appId('/usr/bin/firefox'), 'firefox')
	assert.equal(appId(' VLC '), 'vlc')
	assert.equal(appId('.exe'), '.exe')

	const apps = [
		{ id: 'spotify', name: 'Spotify', volume: 80, muted: false },
		{ id: 'msedge', name: 'Microsoft Edge', volume: 50, muted: true },
	]
	assert.equal(findApp(apps, 'SPOTIFY.exe'), apps[0])
	assert.equal(findApp(apps, 'microsoft edge'), apps[1], 'by display name')
	assert.equal(findApp(apps, 'discord'), undefined)
	assert.equal(findApp(apps, '  '), undefined)
	assert.equal(findApp(null, 'spotify'), undefined)
	assert.equal(findApp(apps, undefined), undefined)

	assert.equal(variableKey('spotify'), 'spotify')
	assert.equal(variableKey('my app.bin'), 'my_app_bin')
	assert.equal(variableKey('obs-64'), 'obs-64')
})

test('values of the wrong type are ignored', () => {
	const parsed = parseMessage({ volume: '10', muted: 1, outputDevice: null, capabilities: [] })
	assert.deepEqual(parsed.state, {})
	assert.equal(parsed.capabilities, undefined)
})

test('action replies are unwrapped', () => {
	assert.deepEqual(parseMessage({ action: 'isMuted', response: { muted: true } }).state, { muted: true })
	assert.deepEqual(
		parseMessage({ action: 'getCapabilities', response: { capabilities: CAPABILITIES } }).capabilities,
		CAPABILITIES,
	)
})

test('errors are reported and carry no state', () => {
	assert.equal(
		parseMessage({ action: 'mute', response: { error: 'Failed to execute action' } }).error,
		'Failed to execute action',
	)
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
