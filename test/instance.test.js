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
	assert.deepEqual(inst.vars, {
		backend_version: '1.2.3',
		muted: true,
		volume: 65,
		output_audio_device_name: 'Speakers',
	})
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
		['info', 'backendVersion', 'targetIp', 'targetPort', 'apiKey', 'reconnect'],
	)
})

const versionOnPage = (inst) => inst.getConfigFields().find((field) => field.id === 'backendVersion').value
const UNKNOWN_VERSION = 'Unknown: this Remote Volume app is too old to report it'
const stateWithVersion = (version) => ({
	initial: { volume: 65, muted: true, outputDevice: 'Speakers', capabilities: { ...CAPABILITIES, version } },
})

test('the settings page says Not connected before init, on first setup', () => {
	assert.equal(versionOnPage(createInstance()), 'Not connected')
})

test('the settings page and the variable show the version of the connected app', async () => {
	const { inst } = await connect()
	await until(() => inst.capabilities !== null, 'the capabilities')

	assert.equal(versionOnPage(inst), '1.2.3')
	assert.equal(inst.vars.backend_version, '1.2.3')
})

test('the version field is a read-only text', async () => {
	const { inst } = await connect()
	await until(() => inst.capabilities !== null, 'the capabilities')

	const field = inst.getConfigFields().find(({ id }) => id === 'backendVersion')
	assert.deepEqual(field, {
		type: 'static-text',
		id: 'backendVersion',
		width: 12,
		label: 'Backend version',
		value: '1.2.3',
	})
})

test('losing the connection clears the version', async () => {
	const { server, inst } = await connect()
	await until(() => inst.capabilities !== null, 'the capabilities')

	server.dropClients(1001)
	await until(() => statusNames(inst).includes(InstanceStatus.Disconnected), 'the disconnect')

	assert.equal(inst.backendVersion, null)
	assert.equal(inst.vars.backend_version, '')
	assert.equal(versionOnPage(inst), 'Not connected')
})

test('after a reconnect, the page and the variable show the new version', async () => {
	const { server, inst } = await connect({ reconnect: true }, stateWithVersion('1.7.1'))
	await until(() => inst.vars.backend_version === '1.7.1', 'the first version')
	const { port } = server

	await server.close()
	await until(() => inst.reconnectTimer !== null, 'the reconnect timer')
	assert.equal(inst.vars.backend_version, '')
	assert.equal(versionOnPage(inst), 'Not connected')

	const updated = await startServer({ port, ...stateWithVersion('1.7.2') })
	cleanups.push(() => updated.close())
	await until(() => inst.vars.backend_version === '1.7.2', 'the new version')
	assert.equal(versionOnPage(inst), '1.7.2')
})

test('an app reporting no version shows Unknown', async () => {
	const { protocolVersion } = CAPABILITIES
	const { inst } = await connect({}, { initial: { volume: 20, muted: false, capabilities: { protocolVersion } } })
	await until(() => inst.capabilities !== null, 'the capabilities')

	assert.equal(versionOnPage(inst), UNKNOWN_VERSION)
	assert.ok(!('backend_version' in inst.vars), 'nothing to clear')
})

test('text that does not look like a version is not shown', async () => {
	const { inst } = await connect({}, stateWithVersion('<img src=x onerror=alert(1)>'))
	await until(() => inst.capabilities !== null, 'the capabilities')

	assert.equal(inst.backendVersion, null)
	assert.equal(versionOnPage(inst), UNKNOWN_VERSION)
})

for (const [what, capabilities] of [
	['a v1 app, without capabilities', undefined],
	['a v2 app, without a version', { protocolVersion: 2 }],
]) {
	test(`after a config change to ${what}, the previous version is gone`, async () => {
		const { inst } = await connect()
		await until(() => inst.vars.backend_version === '1.2.3', 'the first version')

		const other = await startServer({ initial: { volume: 5, muted: false, outputDevice: 'Other', capabilities } })
		cleanups.push(() => other.close())
		await inst.configUpdated({ targetIp: '127.0.0.1', targetPort: other.port, reconnect: false })
		assert.equal(inst.vars.backend_version, '', 'gone as soon as the socket is replaced')
		assert.equal(versionOnPage(inst), 'Not connected')

		await until(() => inst.vars.output_audio_device_name === 'Other', 'the new target')
		assert.equal(inst.backendVersion, null)
		assert.equal(inst.vars.backend_version, '')
		assert.equal(versionOnPage(inst), UNKNOWN_VERSION)
	})
}

test('the variable is only written when the version changes', async () => {
	const { server, inst } = await connect()
	await until(() => inst.capabilities !== null, 'the capabilities')
	const written = []
	const { setVariableValues } = inst
	inst.setVariableValues = (values) => {
		if ('backend_version' in values) written.push(values.backend_version)
		setVariableValues(values)
	}

	server.broadcast({ action: 'getCapabilities', response: { capabilities: CAPABILITIES } })
	server.broadcast({ action: 'getCapabilities', response: { capabilities: { ...CAPABILITIES, version: '1.2.4' } } })
	await until(() => inst.backendVersion === '1.2.4', 'the changed version')

	assert.deepEqual(written, ['1.2.4'])
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
	assert.equal(inst.presetDefs.filter((p) => p.category.startsWith('Apps')).length, 4)
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

test('media keys are sent when the app supports them', async () => {
	const { server, inst } = await connect(
		{},
		{ initial: { volume: 20, muted: false, capabilities: { ...CAPABILITIES, media: { keys: true } } } },
	)
	await until(() => inst.capabilities !== null, 'the capabilities')

	await inst.actionDefs.media_key.callback({ options: { key: 'play_pause' } }, CONTEXT)
	await inst.actionDefs.media_key.callback({ options: { key: 'next' } }, CONTEXT)
	await inst.actionDefs.media_key.callback({ options: { key: 'previous' } }, CONTEXT)
	inst.pressMediaKey('stop')
	await until(() => server.received.length === 3, 'all keys')

	assert.deepEqual(server.received, [
		{ action: 'mediaPlayPause' },
		{ action: 'mediaNextTrack' },
		{ action: 'mediaPreviousTrack' },
	])
	assert.deepEqual(inst.logs, [['warn', 'Unknown media key stop']])
})

test('function keys are sent when the app supports them, and checked', async () => {
	const { server, inst } = await connect(
		{},
		{ initial: { volume: 20, muted: false, capabilities: { ...CAPABILITIES, keyboard: { functionKeys: true } } } },
	)
	await until(() => inst.capabilities !== null, 'the capabilities')

	await inst.actionDefs.function_key.callback({ options: { key: 13 } }, CONTEXT)
	inst.pressFunctionKey('24')
	inst.pressFunctionKey(25)
	inst.pressFunctionKey('F1')
	inst.pressMediaKey('next')
	await until(() => server.received.length === 2, 'both keys')

	assert.deepEqual(server.received, [
		{ action: 'pressFunctionKey', value: 13 },
		{ action: 'pressFunctionKey', value: 24 },
	])
	assert.deepEqual(inst.logs, [
		['warn', 'Unknown function key F25'],
		['warn', 'Unknown function key FF1'],
		['warn', 'The Remote Volume app does not support media keys on this computer. Ignoring mediaNextTrack'],
	])
})

test('function keys need the capability', async () => {
	const { server, inst } = await connect({}, { initial: { volume: 20, muted: false, outputDevice: 'Speakers' } })
	await until(() => inst.vars.volume === 20, 'the v1 state')
	inst.pressFunctionKey(13)
	inst.pressFunctionKey(14)
	inst.getState()
	await until(() => server.received.length === 1, 'getState')
	assert.deepEqual(server.received, [{ action: 'getState' }])
	assert.deepEqual(inst.logs, [['warn', 'Function keys need a newer Remote Volume app, ignoring pressFunctionKey']])
})

test('media keys are skipped, logged once, without the capability or a connection', async () => {
	const { server, inst } = await connect()
	await until(() => inst.capabilities !== null, 'the capabilities')
	inst.pressMediaKey('next')
	inst.pressMediaKey('next')
	inst.getState()
	await until(() => server.received.length === 1, 'getState')
	assert.deepEqual(server.received, [{ action: 'getState' }])
	assert.deepEqual(inst.logs, [
		['warn', 'The Remote Volume app does not support media keys on this computer. Ignoring mediaNextTrack'],
	])

	const v1 = await connect({}, { initial: { volume: 20, muted: false, outputDevice: 'Headphones' } })
	await until(() => v1.inst.vars.volume === 20, 'the v1 state')
	v1.inst.pressMediaKey('play_pause')
	assert.deepEqual(v1.inst.logs, [['warn', 'Media keys need a newer Remote Volume app, ignoring mediaPlayPause']])

	const offline = createInstance()
	offline.pressMediaKey('next')
	assert.deepEqual(offline.logs, [['warn', 'Not connected, ignoring action mediaNextTrack']])
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

const V1_STATE = { initial: { volume: 20, muted: false, outputDevice: 'Headphones' } }

async function changeTargetToV1(inst) {
	const v1 = await startServer(V1_STATE)
	cleanups.push(() => v1.close())
	await inst.configUpdated({ targetIp: '127.0.0.1', targetPort: v1.port, reconnect: false })
	return v1
}

test('a config change to a v1 app forgets the capabilities and apps of the previous target', async () => {
	const { inst } = await connect(
		{},
		withApps(undefined, { ...APPS_CAPABILITIES, media: { keys: true }, keyboard: { functionKeys: true } }),
	)
	await until(() => inst.apps !== null, 'the apps list')

	const v1 = await changeTargetToV1(inst)
	await until(() => inst.vars.output_audio_device_name === 'Headphones', 'the new target')

	inst.setAppVolume('spotify', 10)
	inst.muteApp('spotify')
	inst.pressMediaKey('next')
	inst.pressFunctionKey(13)
	inst.getState()
	await until(() => v1.received.at(-1)?.action === 'getState', 'getState')

	assert.deepEqual(v1.received, [{ action: 'getState' }], 'a v1 app would answer Invalid action to the others')
	assert.deepEqual(inst.logs, [
		['warn', 'Per-app volume needs a newer Remote Volume app, ignoring setAppVolume'],
		['warn', 'Per-app mute needs a newer Remote Volume app, ignoring muteApp'],
		['warn', 'Media keys need a newer Remote Volume app, ignoring mediaNextTrack'],
		['warn', 'Function keys need a newer Remote Volume app, ignoring pressFunctionKey'],
	])
	assert.equal(inst.capabilities, null)
	assert.equal(inst.apps, null)
	assert.equal(inst.vars.apps, '')
	assert.deepEqual(inst.actionDefs.app_mute.options.find((o) => o.id === 'app').choices, [])
	assert.ok(!inst.variableDefs.some((v) => v.variableId.startsWith('app_')))
	assert.equal(await inst.feedbackDefs.app_running.callback({ options: { app: 'spotify' } }, CONTEXT), false)
})

test('a config change forgets the previous target at once, before the new one answers', async () => {
	const { inst } = await connect({}, withApps())
	await until(() => inst.apps !== null, 'the apps list')

	await changeTargetToV1(inst)

	assert.equal(inst.capabilities, null)
	assert.equal(inst.apps, null)
	assert.equal(inst.vars.apps, '')
})

test('after a config change, the unsupported warnings can log again for the new target', async () => {
	const { inst } = await connect({}, withApps(undefined, { ...CAPABILITIES, apps: { volume: true, mute: false } }))
	await until(() => inst.apps !== null, 'the apps list')
	inst.muteApp('spotify')
	assert.match(inst.logs.at(-1)[1], /does not support per-app mute/)

	await changeTargetToV1(inst)
	await until(() => inst.vars.output_audio_device_name === 'Headphones', 'the new target')
	inst.muteApp('spotify')

	assert.equal(inst.logs.length, 2)
	assert.deepEqual(inst.logs[1], ['warn', 'Per-app mute needs a newer Remote Volume app, ignoring muteApp'])
})

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))

for (const [what, badConfig, badSecrets, message] of [
	['the target IP is cleared', { targetIp: '' }, undefined, 'Target IP is missing'],
	['the API key is made invalid', {}, { apiKey: 'bad key' }, 'The API key contains invalid characters'],
]) {
	const goBad = (inst) => inst.configUpdated({ ...inst.config, ...badConfig }, badSecrets)

	test(`when ${what}, the old socket closes and its target is forgotten`, async () => {
		const { inst } = await connect({}, withApps(undefined, { ...CAPABILITIES, apps: { volume: true, mute: false } }))
		await until(() => inst.apps !== null, 'the apps list')
		inst.muteApp('spotify')
		assert.equal(inst.unsupportedLogged.size, 1)
		const old = inst.ws

		await goBad(inst)

		assert.deepEqual(inst.statuses.at(-1), [InstanceStatus.BadConfig, message])
		assert.equal(inst.ws, undefined)
		await until(() => old.readyState === 3, 'the old socket to close')
		assert.equal(inst.capabilities, null)
		assert.equal(inst.apps, null)
		assert.equal(inst.unsupportedLogged.size, 0)
		assert.equal(inst.vars.apps, '')
		assert.equal(inst.vars.backend_version, '')
		assert.equal(versionOnPage(inst), 'Not connected')
		assert.deepEqual(inst.actionDefs.app_mute.options.find((o) => o.id === 'app').choices, [])
	})

	test(`when ${what}, actions no longer reach the old target`, async () => {
		const { server, inst } = await connect()
		await until(() => inst.capabilities !== null, 'the initial state')

		await goBad(inst)
		inst.setVolume(10)
		await settle()

		assert.deepEqual(server.received, [])
		assert.deepEqual(inst.logs.at(-1), ['warn', 'Not connected, ignoring action setVolume'])
	})

	test(`when ${what}, broadcasts of the old target no longer update the variables`, async () => {
		const { server, inst } = await connect()
		await until(() => inst.capabilities !== null, 'the initial state')

		await goBad(inst)
		server.broadcast({ volume: 1 })
		await settle()

		assert.equal(inst.vars.volume, 65)
	})

	test(`when ${what}, the old target going away changes nothing and does not reconnect`, async () => {
		const { server, inst } = await connect({ reconnect: true })
		await until(() => inst.capabilities !== null, 'the initial state')

		await goBad(inst)
		server.dropClients(1001)
		await settle(300) // several reconnect intervals

		assert.deepEqual(inst.statuses, [
			[InstanceStatus.Connecting, null],
			[InstanceStatus.Ok, null],
			[InstanceStatus.BadConfig, message],
		])
		assert.equal(inst.reconnectTimer, null)
		assert.equal(server.handshakes.length, 1)
	})

	test(`when ${what} while still connecting, the status stays bad`, async () => {
		const { inst } = await connect()
		const connecting = inst.ws
		assert.equal(connecting.readyState, 0, 'the socket has not opened yet')

		await goBad(inst)
		await settle()

		assert.deepEqual(inst.statuses, [
			[InstanceStatus.Connecting, null],
			[InstanceStatus.BadConfig, message],
		])
		assert.equal(connecting.readyState, 3)
		assert.deepEqual(inst.logs, [], 'closing it early is not an error to report')
	})

	test(`when ${what} and then fixed, the module connects again`, async () => {
		const { server, inst } = await connect()
		await until(() => inst.capabilities !== null, 'the initial state')

		await goBad(inst)
		assert.equal(inst.ws, undefined)
		await inst.configUpdated({ ...inst.config, targetIp: '127.0.0.1' })
		await until(() => inst.capabilities !== null, 'the state after fixing the config')

		assert.deepEqual(statusNames(inst), [
			InstanceStatus.Connecting,
			InstanceStatus.Ok,
			InstanceStatus.BadConfig,
			InstanceStatus.Connecting,
			InstanceStatus.Ok,
		])
		assert.equal(server.handshakes.length, 2)
	})
}

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

const DEVICE_CAPABILITIES = { ...CAPABILITIES, outputDevices: { list: true, select: true } }
const DEVICE_LIST = [
	{ id: 'dev-a', name: 'Speakers', default: true },
	{ id: 'dev-b', name: 'Headset', default: false },
]
const DEVICE_STATE = {
	volume: 40,
	muted: false,
	outputDevice: 'Speakers',
	outputDeviceId: 'dev-a',
	outputDevices: DEVICE_LIST,
	capabilities: DEVICE_CAPABILITIES,
}

test('the device fields reach the variables, the feedbacks and the definitions', async () => {
	const { inst, server } = await connect({}, { initial: DEVICE_STATE })
	await until(() => inst.outputDevices !== null, 'the initial state')
	assert.equal(inst.vars.output_audio_device_id, 'dev-a')
	assert.equal(inst.vars.output_audio_devices, 'Speakers, Headset')
	assert.deepEqual(
		inst.actionDefs.device_set_default.options[0].choices.map((c) => c.label),
		['Speakers', 'Headset'],
	)
	assert.ok(inst.feedbackChecks.some((ids) => ids.includes('device_is_default')))
	assert.equal(inst.feedbackDefs.device_is_default.callback({ options: { device: 'dev-a' } }), true)

	// Another default: the feedback follows, the definitions stay.
	const definitions = inst.actionDefs
	server.broadcast({ outputDeviceId: 'dev-b' })
	server.broadcast({
		outputDevices: [
			{ id: 'dev-a', name: 'Speakers', default: false },
			{ id: 'dev-b', name: 'Headset', default: true },
		],
	})
	await until(() => inst.outputDevices?.[1].default === true, 'the new default')
	assert.equal(inst.vars.output_audio_device_id, 'dev-b')
	assert.equal(inst.feedbackDefs.device_is_default.callback({ options: { device: 'dev-b' } }), true)
	assert.equal(inst.actionDefs, definitions, 'only the default changed')

	// A device plugged in: the dropdowns get it.
	server.broadcast({ outputDevices: [...DEVICE_LIST, { id: 'dev-c', name: 'HDMI', default: false }] })
	await until(() => inst.outputDevices?.length === 3, 'the longer list')
	assert.equal(inst.vars.output_audio_devices, 'Speakers, Headset, HDMI')
	assert.equal(inst.actionDefs.device_cycle.options[0].choices.length, 3)

	// The app can no longer list them.
	server.broadcast({ outputDevices: null, outputDeviceId: null })
	await until(() => inst.outputDevices === null, 'no list')
	assert.equal(inst.vars.output_audio_devices, '')
	assert.equal(inst.vars.output_audio_device_id, '')
})

test('losing the connection forgets the devices', async () => {
	const { inst, server } = await connect({}, { initial: DEVICE_STATE })
	await until(() => inst.outputDevices !== null, 'the initial state')
	server.dropClients()
	await until(() => inst.outputDevices === null, 'the close')
	assert.equal(inst.vars.output_audio_devices, '')
	assert.equal(inst.vars.output_audio_device_id, '')
	assert.deepEqual(inst.actionDefs.device_cycle.options[0].choices, [])
})

test('the device actions send their payloads', async () => {
	const { inst, server } = await connect({}, { initial: DEVICE_STATE })
	await until(() => inst.outputDevices !== null, 'the initial state')
	inst.setOutputDevice('dev-b')
	inst.setOutputDevice(' Headset ')
	inst.cycleOutputDevice([])
	inst.cycleOutputDevice(undefined)
	inst.cycleOutputDevice(['dev-a', 'Headset'])
	await until(() => server.received.length === 5, 'the actions')
	assert.deepEqual(server.received, [
		{ action: 'setOutputDevice', device: 'dev-b' },
		{ action: 'setOutputDevice', device: 'Headset' },
		{ action: 'cycleOutputDevice' },
		{ action: 'cycleOutputDevice' },
		{ action: 'cycleOutputDevice', devices: ['dev-a', 'Headset'] },
	])
	inst.setOutputDevice('  ')
	assert.equal(inst.logs.at(-1)[1], 'No device chosen, ignoring action setOutputDevice')
})

test('a device error from the app is logged', async () => {
	const { inst, server } = await connect({}, { initial: DEVICE_STATE })
	await until(() => inst.outputDevices !== null, 'the initial state')
	server.broadcast({ action: 'setOutputDevice', response: { error: 'Device not found' } })
	await until(() => inst.logs.length > 0, 'the log')
	assert.deepEqual(inst.logs.at(-1), ['warn', 'Remote Volume reported an error: Device not found'])
})

test('device actions are skipped and logged once where the app cannot select devices', async () => {
	const { inst, server } = await connect()
	await until(() => inst.capabilities !== null, 'the initial state')
	inst.setOutputDevice('dev-b')
	inst.cycleOutputDevice([])
	assert.deepEqual(
		inst.logs.filter(([, message]) => message.includes('output devices')),
		[['warn', 'The Remote Volume app cannot select output devices on this computer. Ignoring setOutputDevice']],
	)
	await new Promise((resolve) => setTimeout(resolve, 50))
	assert.deepEqual(server.received, [])
})

test('a v1 app has no devices and gets no device actions', async () => {
	const { inst, server } = await connect({}, { initial: { volume: 20, muted: false, outputDevice: 'Headphones' } })
	await until(() => 'output_audio_device_name' in inst.vars, 'the initial state')
	assert.equal(inst.outputDevices, null)
	assert.equal(inst.feedbackDefs.device_is_default.callback({ options: { device: 'Headphones' } }), false)
	inst.cycleOutputDevice([])
	inst.setOutputDevice('Headphones')
	assert.deepEqual(
		inst.logs.filter(([, message]) => message.includes('Device selection')),
		[['warn', 'Device selection needs a newer Remote Volume app, ignoring cycleOutputDevice']],
	)
	await new Promise((resolve) => setTimeout(resolve, 50))
	assert.deepEqual(server.received, [])
})

test('device actions are ignored while not connected', async () => {
	const { inst, server } = await connect({}, { initial: DEVICE_STATE })
	await until(() => inst.outputDevices !== null, 'the initial state')
	server.dropClients()
	await until(() => !inst.isConnected(), 'the close')
	inst.cycleOutputDevice([])
	assert.deepEqual(inst.logs.at(-1), ['warn', 'Not connected, ignoring action cycleOutputDevice'])
})
