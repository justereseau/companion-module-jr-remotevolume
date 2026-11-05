// End-to-end: the real module class against the real `remote-volume` app (the all-Rust one),
// talking to the OS audio stack of the machine it runs on.
//
// Opt-in: set RV_BIN to the path of the `remote-volume` binary, e.g.
//   RV_BIN=../companion-remote-volume/core/target/release/remote-volume yarn test:e2e
// It briefly changes the system volume and mute state and puts both back at the end. CI runs it on
// Linux with a PulseAudio null sink as the sound card.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { InstanceStatus } from '@companion-module/base'
import { createInstance, until } from '../helpers.js'

const RV_BIN = process.env.RV_BIN

async function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address()
			server.close(() => resolve(port))
		})
	})
}

async function canConnect(port) {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1')
		socket.once('connect', () => (socket.destroy(), resolve(true)))
		socket.once('error', () => resolve(false))
	})
}

describe('module against the real remote-volume app', { skip: !RV_BIN && 'set RV_BIN to run' }, () => {
	let dir, wsPort, settingsPort, app, inst
	const appLog = []

	async function startApp() {
		app = spawn(RV_BIN, ['--config-dir', dir, '--settings-port', String(settingsPort)], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		app.stdout.on('data', (data) => appLog.push(data.toString()))
		app.stderr.on('data', (data) => appLog.push(data.toString()))
		const start = Date.now()
		while (!(await canConnect(wsPort))) {
			if (app.exitCode !== null) throw new Error(`remote-volume exited with ${app.exitCode}:\n${appLog.join('')}`)
			if (Date.now() - start > 15000) throw new Error(`remote-volume did not listen on ${wsPort}:\n${appLog.join('')}`)
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}

	async function stopApp() {
		if (!app || app.exitCode !== null) return
		const exited = new Promise((resolve) => app.once('exit', resolve))
		app.kill()
		await exited
	}

	const withinOne = (actual, expected) => Math.abs(actual - expected) <= 1

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), 'rv-e2e-'))
		wsPort = await freePort()
		settingsPort = await freePort()
		await writeFile(
			join(dir, 'config.json'),
			JSON.stringify({ websocket: { port: wsPort, host: '127.0.0.1', token: '', allowedOrigins: [] } }),
		)
		await startApp()

		inst = createInstance()
		await inst.init({ targetIp: '127.0.0.1', targetPort: wsPort, reconnect: true })
		inst.reconnectInterval = 200
		await until(
			() => 'volume' in inst.vars && 'muted' in inst.vars && 'output_audio_device_name' in inst.vars,
			`the state from the app; log:\n${appLog.join('')}`,
			15000,
		)
		inst.initial = { volume: inst.vars.volume, muted: inst.vars.muted }
	})

	after(async () => {
		try {
			if (inst?.initial && inst.ws?.readyState === 1) {
				inst.setVolume(inst.initial.volume)
				inst.initial.muted ? inst.mute() : inst.unmute()
				await until(
					() => withinOne(inst.vars.volume, inst.initial.volume) && inst.vars.muted === inst.initial.muted,
					'restore',
				).catch(() => {})
			}
		} finally {
			await inst?.destroy()
			await stopApp()
			if (dir) await rm(dir, { recursive: true, force: true })
		}
	})

	test('connects and reads the real state, capabilities included', () => {
		assert.equal(inst.statuses.at(-1)[0], InstanceStatus.Ok)
		assert.equal(typeof inst.vars.volume, 'number')
		assert.ok(inst.vars.volume >= 0 && inst.vars.volume <= 100)
		assert.equal(typeof inst.vars.muted, 'boolean')
		assert.equal(typeof inst.vars.output_audio_device_name, 'string')
		assert.equal(inst.capabilities.protocolVersion, 2)
		assert.deepEqual(inst.logs, [])
	})

	test('set volume', async () => {
		await inst.actionDefs.set_volume.callback({ options: { volume: 33 } })
		await until(() => withinOne(inst.vars.volume, 33), 'volume 33')
	})

	test('increase and decrease volume', async () => {
		const before = inst.vars.volume
		await inst.actionDefs.increaseVolume.callback({ options: { volume: 5 } })
		await until(() => withinOne(inst.vars.volume, before + 5), 'volume +5')
		const raised = inst.vars.volume
		await inst.actionDefs.decreaseVolume.callback({ options: { volume: 10 } })
		await until(() => withinOne(inst.vars.volume, raised - 10), 'volume -10')
	})

	test('mute, unmute and toggle drive the muted variable and feedback', async () => {
		const muted = inst.feedbackDefs.muted.callback
		await inst.actionDefs.mute.callback({ options: { mute: 'mute' } })
		await until(() => inst.vars.muted === true, 'muted')
		assert.equal(muted({}), true)

		await inst.actionDefs.mute.callback({ options: { mute: 'unmute' } })
		await until(() => inst.vars.muted === false, 'unmuted')
		assert.equal(muted({}), false)

		await inst.actionDefs.mute.callback({ options: { mute: 'toggle' } })
		await until(() => inst.vars.muted === true, 'toggled on')
		await inst.actionDefs.mute.callback({ options: { mute: 'toggle' } })
		await until(() => inst.vars.muted === false, 'toggled off')
	})

	test('get latest data answers with the current state', async () => {
		const seen = inst.feedbackChecks.length
		await inst.actionDefs.getState.callback({ options: {} })
		await until(() => inst.feedbackChecks.length > seen, 'the reply')
		assert.equal(typeof inst.vars.volume, 'number')
	})

	test('an error from the app is logged and the connection stays up', async () => {
		inst.sendAction({ action: 'noSuchAction' })
		await until(
			() => inst.logs.some(([level, message]) => level === 'warn' && message.includes('error')),
			'the error log',
		)
		assert.equal(inst.ws.readyState, 1)
		inst.logs.length = 0
	})

	test('reconnects after the app restarts', async () => {
		await stopApp()
		await until(() => inst.statuses.at(-1)[0] === InstanceStatus.Disconnected, 'the disconnect', 15000)
		assert.equal(inst.capabilities, null)

		await startApp()
		await until(
			() => inst.statuses.at(-1)[0] === InstanceStatus.Ok && inst.capabilities !== null,
			'the reconnect',
			15000,
		)
		assert.equal(inst.capabilities.protocolVersion, 2)
	})
})
