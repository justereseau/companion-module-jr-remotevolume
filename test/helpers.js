import { WebSocketServer } from 'ws'
import { RemoteVolumeInstance } from '../instance.js'

export const CAPABILITIES = {
	protocolVersion: 2,
	outputDevices: { list: false, select: false },
	apps: { volume: false, mute: false },
	media: { keys: false },
}

/** A Remote Volume app stand-in: sends the initial state on connect and records what it receives. */
export async function startServer({ port = 0, initial, token } = {}) {
	const received = []
	const handshakes = []
	const sockets = new Set()
	const wss = new WebSocketServer({
		port,
		host: '127.0.0.1',
		// Like the app: with a token configured, a missing or wrong Bearer token is refused with a 401.
		verifyClient: ({ req }, done) => {
			handshakes.push({ url: req.url, authorization: req.headers.authorization })
			if (token && req.headers.authorization !== `Bearer ${token}`) done(false, 401, 'Invalid or missing token')
			else done(true)
		},
	})
	await new Promise((resolve) => wss.once('listening', resolve))
	wss.on('connection', (socket) => {
		sockets.add(socket)
		socket.on('close', () => sockets.delete(socket))
		socket.on('message', (data) => received.push(JSON.parse(data.toString())))
		socket.send(
			JSON.stringify(initial ?? { volume: 65, muted: true, outputDevice: 'Speakers', capabilities: CAPABILITIES }),
		)
	})
	const text = (message) => (typeof message === 'string' ? message : JSON.stringify(message))
	return {
		port: wss.address().port,
		received,
		handshakes,
		broadcast: (message) => sockets.forEach((s) => s.send(text(message))),
		sendBinary: (message) => sockets.forEach((s) => s.send(Buffer.from(text(message)), { binary: true })),
		dropClients: (code = 1001) => sockets.forEach((s) => s.close(code)),
		close: () =>
			new Promise((resolve) => {
				sockets.forEach((s) => s.terminate())
				wss.close(resolve)
			}),
	}
}

/** An instance with the Companion-provided methods replaced by recorders (no IPC needed). */
export function createInstance() {
	const inst = Object.create(RemoteVolumeInstance.prototype)
	// The connection label, normally set up by the base class constructor (used in preset texts).
	Object.defineProperty(inst, 'label', { value: 'rv' })
	Object.assign(inst, {
		statuses: [],
		logs: [],
		vars: {},
		feedbackChecks: [],
		updateStatus: (status, message) => inst.statuses.push([status, message ?? null]),
		log: (level, message) => inst.logs.push([level, message]),
		setVariableValues: (values) => Object.assign(inst.vars, values),
		checkFeedbacks: (...ids) => inst.feedbackChecks.push(ids),
		setActionDefinitions: (defs) => (inst.actionDefs = defs),
		setFeedbackDefinitions: (defs) => (inst.feedbackDefs = defs),
		setPresetDefinitions: (defs) => (inst.presetDefs = defs),
		setVariableDefinitions: (defs) => (inst.variableDefs = defs),
	})
	return inst
}

export async function until(condition, what, timeout = 3000) {
	const start = Date.now()
	while (!condition()) {
		if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`)
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

/** Custom variables seen by {@link CONTEXT}. */
export const CUSTOM_VARIABLES = { app: 'discord', step: '-3' }

/** The context Companion passes to action and feedback callbacks: parses `$(custom:...)` only. */
export const CONTEXT = {
	parseVariablesInString: async (text) =>
		text.replace(/\$\(custom:([\w-]+)\)/g, (_, name) => CUSTOM_VARIABLES[name] ?? ''),
}
