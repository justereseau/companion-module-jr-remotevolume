import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { InstanceStatus } from '@companion-module/base'
import { CAPABILITIES, CONTEXT, createInstance, startServer, until } from './helpers.js'

const cleanups = []
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()()
})

async function connect(overrides = {}, serverOptions, secrets) {
	const server = await startServer(serverOptions)
	cleanups.push(() => server.close())
	const inst = createInstance()
	cleanups.push(() => inst.destroy())
	await inst.init({ targetIp: '127.0.0.1', targetPort: server.port, reconnect: false, ...overrides }, true, secrets)
	inst.reconnectInterval = 50
	return { server, inst }
}

const statusNames = (inst) => inst.statuses.map(([status]) => status)

test('connects and applies the initial state of the all-Rust app, capabilities included', async () => {
	const { inst } = await connect()
	await until(() => 'output_audio_device_name' in inst.vars, 'the initial state')

	assert.deepEqual(statusNames(inst), [InstanceStatus.Connecting, InstanceStatus.Ok])
	assert.deepEqual(inst.vars, { muted: true, volume: 65, output_audio_device_name: 'Speakers' })
	assert.equal(inst.muted, true)
	assert.deepEqual(inst.capabilities, CAPABILITIES)
	assert.deepEqual(inst.logs, [])
	assert.deepEqual(inst.feedbackChecks.at(-1), ['muted'])
})

test('a v1 app without capabilities works the same', async () => {
	const { inst } = await connect({}, { initial: { volume: 20, muted: false, outputDevice: 'Headphones' } })
	await until(() => 'output_audio_device_name' in inst.vars, 'the initial state')

	assert.deepEqual(inst.vars, { muted: false, volume: 20, output_audio_device_name: 'Headphones' })
	assert.equal(inst.capabilities, null)
})

test('state broadcasts update variables and the muted feedback', async () => {
	const { server, inst } = await connect()
	await until(() => inst.capabilities !== null, 'the initial state')
	const muted = inst.feedbackDefs.muted.callback
	assert.equal(muted({}), true)

	server.broadcast({ muted: false })
	await until(() => inst.vars.muted === false, 'unmute')
	assert.equal(muted({}), false)

	server.broadcast({ volume: 12 })
	await until(() => inst.vars.volume === 12, 'volume')
	server.sendBinary({ outputDevice: 'HDMI' })
	await until(() => inst.vars.output_audio_device_name === 'HDMI', 'binary frame')
	assert.deepEqual(inst.capabilities, CAPABILITIES, 'a partial update keeps the capabilities')
})

test('actions send the v1 messages', async () => {
	const { server, inst } = await connect()
	await until(() => inst.capabilities !== null, 'the initial state')
	const run = (id, options = {}) => inst.actionDefs[id].callback({ options }, CONTEXT)

	await run('set_volume', { volume: 30 })
	await run('adjust_volume', { value: '5' })
	await run('adjust_volume', { value: '$(custom:step)' })
	await run('mute', { mute: 'mute' })
	await run('mute', { mute: 'unmute' })
	await run('mute', { mute: 'toggle' })
	await run('getState')
	await until(() => server.received.length === 7, 'all messages')

	assert.deepEqual(server.received, [
		{ action: 'setVolume', value: 30 },
		{ action: 'increaseVolume', value: 5 },
		{ action: 'decreaseVolume', value: 3 },
		{ action: 'mute' },
		{ action: 'unmute' },
		{ action: 'toggleMute' },
		{ action: 'getState' },
	])
})

test('errors reported by the app are logged and do not change the state', async () => {
	const { server, inst } = await connect()
	await until(() => inst.capabilities !== null, 'the initial state')

	server.broadcast({ action: 'mute', response: { error: 'Failed to execute action' } })
	server.broadcast({ error: 'Invalid message' })
	await until(() => inst.logs.length === 2, 'both errors')

	assert.deepEqual(inst.logs, [
		['warn', 'Remote Volume reported an error: Failed to execute action'],
		['warn', 'Remote Volume reported an error: Invalid message'],
	])
	assert.equal(inst.vars.volume, 65)
})

test('unparsable messages are logged and the connection keeps working', async () => {
	const { server, inst } = await connect()
	await until(() => inst.capabilities !== null, 'the initial state')

	server.broadcast('not json')
	await until(() => inst.logs.length === 1, 'the log entry')
	assert.equal(inst.logs[0][0], 'error')
	assert.match(inst.logs[0][1], /Could not process message from Remote Volume/)

	server.broadcast({ volume: 1 })
	await until(() => inst.vars.volume === 1, 'the next message')
})

test('actions are ignored, with a warning, while not connected', async () => {
	const inst = createInstance()
	inst.mute()
	assert.deepEqual(inst.logs, [['warn', 'Not connected, ignoring action mute']])

	const { server, inst: connected } = await connect()
	await until(() => connected.capabilities !== null, 'the initial state')
	connected.ws.close()
	await until(() => connected.ws.readyState === 3, 'the socket to close')
	connected.setVolume(10)
	assert.deepEqual(server.received, [])
	assert.equal(connected.logs.at(-1)[1], 'Not connected, ignoring action setVolume')
})

test('a missing target IP is a bad configuration', async () => {
	const inst = createInstance()
	await inst.init({ targetIp: '', targetPort: 2501, reconnect: false })
	assert.deepEqual(inst.statuses, [[InstanceStatus.BadConfig, 'Target IP is missing']])
	assert.equal(inst.ws, undefined)
})

test('losing the connection shows the close code and forgets the capabilities', async () => {
	const { server, inst } = await connect()
	await until(() => inst.capabilities !== null, 'the initial state')

	server.dropClients(1001)
	await until(() => statusNames(inst).includes(InstanceStatus.Disconnected), 'the disconnect')

	assert.deepEqual(inst.statuses.at(-1), [InstanceStatus.Disconnected, 'Connection closed with code 1001'])
	assert.equal(inst.capabilities, null)
	assert.equal(inst.reconnectTimer, null, 'no reconnect when it is disabled')
})

test('reconnects when enabled, once the app is back', async () => {
	const { server, inst } = await connect({ reconnect: true })
	await until(() => inst.capabilities !== null, 'the initial state')
	const { port } = server

	await server.close()
	await until(() => inst.reconnectTimer !== null, 'the reconnect timer')

	const again = await startServer({ port, initial: { volume: 80, muted: false, outputDevice: 'Speakers' } })
	cleanups.push(() => again.close())
	await until(() => inst.vars.volume === 80, 'the state after reconnecting')

	assert.equal(inst.statuses.at(-1)[0], InstanceStatus.Ok)
	assert.equal(inst.reconnectTimer, null)
})

test('a socket error is logged', async () => {
	const inst = createInstance()
	cleanups.push(() => inst.destroy())
	// Nothing listens on port 1.
	await inst.init({ targetIp: '127.0.0.1', targetPort: 1, reconnect: false })
	await until(() => inst.logs.some(([level]) => level === 'error'), 'the error log')
	await until(() => statusNames(inst).includes(InstanceStatus.Disconnected), 'the disconnect')
})

test('a config update connects to the new target', async () => {
	const { inst } = await connect()
	await until(() => inst.capabilities !== null, 'the initial state')

	const other = await startServer({ initial: { volume: 5, muted: false, outputDevice: 'Other' } })
	cleanups.push(() => other.close())
	await inst.configUpdated({ targetIp: '127.0.0.1', targetPort: other.port, reconnect: false })
	await until(() => inst.vars.output_audio_device_name === 'Other', 'the new target')
})

test('destroy closes the connection and stops reconnecting', async () => {
	const { inst } = await connect({ reconnect: true })
	await until(() => inst.capabilities !== null, 'the initial state')

	await inst.destroy()
	assert.equal(inst.ws, undefined)
	assert.equal(inst.isInitialized, false)
	assert.equal(inst.reconnectTimer, null)
})

test('the config fields are the ones the module reads', () => {
	const inst = createInstance()
	assert.deepEqual(
		inst.getConfigFields().map((field) => field.id),
		['info', 'targetIp', 'targetPort', 'apiKey', 'reconnect'],
	)
})

test('the API key is sent as a Bearer token, never in the URL', async () => {
	const { server, inst } = await connect({}, { token: 's3cret' }, { apiKey: ' s3cret ' })
	await until(() => inst.capabilities !== null, 'the initial state')

	assert.deepEqual(server.handshakes, [{ url: '/', authorization: 'Bearer s3cret' }])
	assert.equal(inst.statuses.at(-1)[0], InstanceStatus.Ok)
})

test('without an API key nothing is sent in the Authorization header', async () => {
	const { server, inst } = await connect()
	await until(() => inst.capabilities !== null, 'the initial state')
	assert.equal(server.handshakes[0].authorization, undefined)
})

test('a refused API key is an authentication failure and is not retried', async () => {
	const { server, inst } = await connect({ reconnect: true }, { token: 's3cret' }, { apiKey: 'wrong' })
	await until(() => inst.statuses.some(([status]) => status === InstanceStatus.AuthenticationFailure), 'the failure')
	await new Promise((resolve) => setTimeout(resolve, 300)) // several reconnect intervals

	assert.deepEqual(inst.statuses.at(-1), [InstanceStatus.AuthenticationFailure, 'The app refused the API key'])
	assert.equal(inst.reconnectTimer, null)
	assert.equal(server.handshakes.length, 1, 'no new attempt without a config change')
	assert.ok(inst.logs.some(([level, message]) => level === 'error' && message === 'The app refused the API key'))
})

test('a missing API key is reported as such', async () => {
	const { inst } = await connect({}, { token: 's3cret' })
	await until(() => inst.statuses.some(([status]) => status === InstanceStatus.AuthenticationFailure), 'the failure')
	assert.equal(inst.statuses.at(-1)[1], 'The app requires an API key')
})

test('fixing the API key reconnects', async () => {
	const { server, inst } = await connect({ reconnect: true }, { token: 's3cret' }, { apiKey: 'wrong' })
	await until(() => inst.statuses.at(-1)[0] === InstanceStatus.AuthenticationFailure, 'the failure')

	await inst.configUpdated({ targetIp: '127.0.0.1', targetPort: server.port, reconnect: true }, { apiKey: 's3cret' })
	await until(() => inst.capabilities !== null, 'the state after fixing the key')
	assert.equal(inst.statuses.at(-1)[0], InstanceStatus.Ok)
})

test('an API key with characters a header cannot carry is a bad configuration', async () => {
	const { server, inst } = await connect({}, undefined, { apiKey: 'bad key\r\nX-Injected: 1' })
	assert.deepEqual(inst.statuses, [[InstanceStatus.BadConfig, 'The API key contains invalid characters']])
	assert.equal(server.handshakes.length, 0)
})

const APPS_CAPABILITIES = { ...CAPABILITIES, apps: { volume: true, mute: true } }
const SPOTIFY = { id: 'spotify', name: 'Spotify', volume: 80, muted: false }
const CHROME = { id: 'chrome', name: 'Google Chrome', volume: 70, muted: true }
const withApps = (apps = [SPOTIFY, CHROME], capabilities = APPS_CAPABILITIES) => ({
	initial: { volume: 65, muted: true, outputDevice: 'Speakers', apps, capabilities },
})

test('the apps list sets variables, app choices, presets and feedbacks', async () => {
	const { inst } = await connect({}, withApps())
	await until(() => inst.apps !== null, 'the apps list')

	assert.deepEqual(inst.apps, [SPOTIFY, CHROME])
	assert.equal(inst.vars.apps, 'Spotify, Google Chrome')
	assert.equal(inst.vars.app_spotify_volume, 80)
	assert.equal(inst.vars.app_chrome_muted, true)
	assert.ok(inst.variableDefs.some((v) => v.variableId === 'app_chrome_volume'))
	assert.deepEqual(
		inst.actionDefs.app_mute.options.find((o) => o.id === 'app').choices.map((c) => c.id),
		['spotify', 'chrome'],
	)
	assert.equal(inst.presetDefs.filter((p) => p.category === 'Apps').length, 4)
	assert.ok(inst.feedbackChecks.some((ids) => ids.includes('app_muted') && ids.includes('app_running')))
	assert.equal(await inst.feedbackDefs.app_muted.callback({ options: { app: 'chrome' } }, CONTEXT), true)
})

test('definitions are rebuilt when an app comes or goes, not on a volume change', async () => {
	const { server, inst } = await connect({}, withApps([SPOTIFY]))
	await until(() => inst.apps !== null, 'the apps list')
	const before = inst.actionDefs

	server.broadcast({ apps: [{ ...SPOTIFY, volume: 20, muted: true }] })
	await until(() => inst.vars.app_spotify_volume === 20, 'the volume change')
	assert.equal(inst.actionDefs, before, 'same definitions object')
	assert.equal(inst.vars.app_spotify_muted, true)

	server.broadcast({ apps: [SPOTIFY, CHROME] })
	await until(() => inst.vars.apps === 'Spotify, Google Chrome', 'the new app')
	assert.notEqual(inst.actionDefs, before)
	assert.equal(inst.actionDefs.app_mute.options.find((o) => o.id === 'app').choices.length, 2)
})

test('apps turned off in the app (null) clears the list', async () => {
	const { server, inst } = await connect({}, withApps())
	await until(() => inst.apps !== null, 'the apps list')

	server.broadcast({ apps: null })
	await until(() => inst.apps === null, 'the cleared list')
	assert.equal(inst.vars.apps, '')
	assert.deepEqual(inst.actionDefs.app_mute.options.find((o) => o.id === 'app').choices, [])
	assert.ok(!inst.variableDefs.some((v) => v.variableId.startsWith('app_')))
	assert.equal(await inst.feedbackDefs.app_running.callback({ options: { app: 'spotify' } }, CONTEXT), false)
})

test('app actions send the v2 messages', async () => {
	const { server, inst } = await connect({}, withApps())
	await until(() => inst.apps !== null, 'the apps list')
	const run = (id, options) => inst.actionDefs[id].callback({ options }, CONTEXT)

	await run('app_set_volume', { app: 'spotify', volume: 40 })
	await run('app_adjust_volume', { app: ' Spotify.exe ', value: '5' })
	await run('app_adjust_volume', { app: 'spotify', value: '-7' })
	await run('app_mute', { app: 'spotify', app_by_variable: true, app_variable: '$(custom:app)', mute: 'mute' })
	await run('app_mute', { app: 'discord', mute: 'unmute' })
	await run('app_mute', { app: 'chrome', mute: 'toggle' })
	await until(() => server.received.length === 6, 'all messages')

	assert.deepEqual(server.received, [
		{ action: 'setAppVolume', app: 'spotify', value: 40 },
		{ action: 'increaseAppVolume', app: 'Spotify.exe', value: 5 },
		{ action: 'decreaseAppVolume', app: 'spotify', value: 7 },
		{ action: 'muteApp', app: 'discord' },
		{ action: 'unmuteApp', app: 'discord' },
		{ action: 'toggleAppMute', app: 'chrome' },
	])

	server.broadcast({ action: 'muteApp', response: { error: 'App not found' } })
	await until(() => inst.logs.length === 1, 'the error')
	assert.deepEqual(inst.logs, [['warn', 'Remote Volume reported an error: App not found']])
})

test('app actions are skipped, logged once per feature, when the app does not support them', async () => {
	const { server, inst } = await connect(
		{},
		withApps(undefined, { ...CAPABILITIES, apps: { volume: true, mute: false } }),
	)
	await until(() => inst.apps !== null, 'the apps list')

	inst.muteApp('spotify')
	inst.toggleAppMute('spotify')
	inst.setAppVolume('spotify', 10)
	await until(() => server.received.length === 1, 'the supported action')

	assert.deepEqual(server.received, [{ action: 'setAppVolume', app: 'spotify', value: 10 }])
	assert.equal(inst.logs.length, 1)
	assert.match(inst.logs[0][1], /does not support per-app mute .* Ignoring muteApp/)
})

test('a v1 app gets no app actions', async () => {
	const { server, inst } = await connect({}, { initial: { volume: 20, muted: false, outputDevice: 'Headphones' } })
	await until(() => inst.vars.volume === 20, 'the initial state')

	inst.setAppVolume('spotify', 10)
	inst.increaseAppVolume('spotify', 10)
	inst.muteApp('spotify')
	inst.getState()
	await until(() => server.received.length === 1, 'getState')

	assert.deepEqual(server.received, [{ action: 'getState' }])
	assert.deepEqual(inst.logs, [
		['warn', 'Per-app volume needs a newer Remote Volume app, ignoring setAppVolume'],
		['warn', 'Per-app mute needs a newer Remote Volume app, ignoring muteApp'],
	])
	assert.equal(inst.apps, null)
})

test('app actions need an app and a connection', async () => {
	const inst = createInstance()
	inst.muteApp('  ')
	inst.muteApp(undefined)
	inst.muteApp('spotify')
	assert.deepEqual(inst.logs, [
		['warn', 'No app chosen, ignoring action muteApp'],
		['warn', 'No app chosen, ignoring action muteApp'],
		['warn', 'Not connected, ignoring action muteApp'],
	])
})

test('losing the connection forgets the apps', async () => {
	const { server, inst } = await connect({}, withApps())
	await until(() => inst.apps !== null, 'the apps list')

	server.dropClients(1001)
	await until(() => inst.apps === null, 'the forgotten list')
	assert.equal(inst.vars.apps, '')
	assert.equal(await inst.feedbackDefs.app_running.callback({ options: { app: 'spotify' } }, CONTEXT), false)
})

test('adjust volume: large steps set the volume, zero does nothing, text is refused', async () => {
	const { server, inst } = await connect({}, withApps())
	await until(() => inst.apps !== null, 'the apps list')

	inst.adjustVolume('150')
	inst.adjustVolume('-100')
	inst.adjustVolume('0')
	inst.adjustVolume('+4%')
	inst.adjustVolume('2.6')
	inst.adjustVolume('loud')
	inst.adjustVolume('')
	inst.adjustAppVolume('spotify', '-250')
	await until(() => server.received.length === 5, 'all messages')

	assert.deepEqual(server.received, [
		{ action: 'setVolume', value: 100 },
		{ action: 'setVolume', value: 0 },
		{ action: 'increaseVolume', value: 4 },
		{ action: 'increaseVolume', value: 3 },
		{ action: 'setAppVolume', app: 'spotify', value: 0 },
	])
	assert.deepEqual(inst.logs, [
		['warn', 'Ignoring Adjust Volume: "loud" is not a number (e.g. 5 or -5)'],
		['warn', 'Ignoring Adjust Volume: "" is not a number (e.g. 5 or -5)'],
	])
})
