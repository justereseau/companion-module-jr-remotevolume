/**
 * Parsing of the messages sent by the Remote Volume app (v1 protocol, with the optional v2 additions).
 *
 * Kept free of Companion and WebSocket code so it can be unit tested.
 *
 * Messages from the app are one of:
 *  - a (possibly partial) state object: `{"volume":40,"muted":false,"outputDevice":"Speakers"}`.
 *    The state sent right after connecting may end with `"capabilities":{...}` (protocol v2).
 *    Protocol v2 also sends `"apps":[{"id":"spotify","name":"Spotify","volume":80,"muted":false}]`,
 *    always the whole list.
 *  - an action reply: `{"action":"mute","response":{...}}`, where `response.error` reports a failure.
 *  - an error without an action: `{"error":"..."}`.
 */

/**
 * @typedef {object} ParsedMessage
 * @property {{ volume?: number, muted?: boolean, outputDevice?: string, apps?: App[] | null }} state Fields to apply to the module state.
 * @property {object | undefined} capabilities The `capabilities` object (protocol v2), if the message carried one.
 * @property {string | undefined} error An error text reported by the app, if any.
 */

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * @param {unknown} message A decoded JSON message.
 * @returns {ParsedMessage}
 */
export function parseMessage(message) {
	/** @type {ParsedMessage} */
	const result = { state: {}, capabilities: undefined, error: undefined }
	if (!isObject(message)) return result

	// An action reply carries its payload in `response`; the state then lives in there.
	const payload = typeof message.action === 'string' && isObject(message.response) ? message.response : message

	if (typeof message.error === 'string') result.error = message.error
	if (typeof payload.error === 'string') result.error = payload.error
	if (result.error !== undefined) return result

	if (typeof payload.muted === 'boolean') result.state.muted = payload.muted
	if (typeof payload.volume === 'number') result.state.volume = payload.volume
	if (typeof payload.outputDevice === 'string') result.state.outputDevice = payload.outputDevice
	if (Array.isArray(payload.apps)) result.state.apps = parseApps(payload.apps)
	// `null`: the app had a list and per-app audio is now off or unavailable.
	else if (payload.apps === null) result.state.apps = null
	if (isObject(payload.capabilities)) result.capabilities = payload.capabilities

	return result
}

/**
 * @typedef {object} App
 * @property {string} id Lowercased executable name without `.exe` (`spotify`).
 * @property {string} name Display name.
 * @property {number} volume 0–100.
 * @property {boolean} muted
 */

/**
 * Keeps the well-formed entries of an `apps` list (protocol v2), skipping the others.
 *
 * @param {unknown[]} list
 * @returns {App[]}
 */
export function parseApps(list) {
	const apps = []
	for (const entry of list) {
		if (!isObject(entry) || typeof entry.id !== 'string' || entry.id === '') continue
		apps.push({
			id: entry.id,
			name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
			volume: typeof entry.volume === 'number' ? entry.volume : 0,
			muted: entry.muted === true,
		})
	}
	return apps
}

/**
 * The app id the Remote Volume app would derive from a name typed by the user: the file name,
 * lowercased, without `.exe` (`C:\...\Spotify.exe` → `spotify`).
 *
 * @param {string} name
 */
export function appId(name) {
	const base = String(name).split(/[\\/]/).pop().trim().toLowerCase()
	const stripped = base.endsWith('.exe') ? base.slice(0, -4) : base
	return stripped === '' ? base : stripped
}

/**
 * Finds an app the way the Remote Volume app does: by id in any spelling, then by display name,
 * ignoring case.
 *
 * @param {App[] | null} apps
 * @param {string} target
 * @returns {App | undefined}
 */
export function findApp(apps, target) {
	if (!apps || typeof target !== 'string' || target.trim() === '') return undefined
	const id = appId(target)
	const name = target.trim().toLowerCase()
	return apps.find((app) => app.id === id) ?? apps.find((app) => app.name.toLowerCase() === name)
}

/** The protocol v2 action of each media key (capability `media.keys`). */
export const MEDIA_ACTIONS = {
	play_pause: 'mediaPlayPause',
	next: 'mediaNextTrack',
	previous: 'mediaPreviousTrack',
}

/**
 * The step of an Adjust Volume action, typed or from a variable: a whole number of percentage
 * points (`5`, `-5`, `+5`, `-5%`), or null when the text is not a number.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function volumeStep(text) {
	const trimmed = String(text ?? '')
		.trim()
		.replace(/%$/, '')
		.trim()
	if (trimmed === '') return null
	const value = Number(trimmed)
	return Number.isFinite(value) ? Math.round(value) : null
}

/**
 * A Companion variable id for an app id (`app_<id>_volume`): anything but letters, digits, `_` and
 * `-` becomes `_`.
 *
 * @param {string} id
 */
export function variableKey(id) {
	return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * Decodes the data of a WebSocket message and parses it.
 *
 * @param {string | Buffer | ArrayBuffer | Buffer[]} data
 * @returns {ParsedMessage} Throws a SyntaxError when the data is not JSON.
 */
export function parseRawMessage(data) {
	let text
	if (typeof data === 'string') text = data
	else if (Array.isArray(data)) text = Buffer.concat(data).toString('utf8')
	else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8')
	else text = data.toString('utf8')

	return parseMessage(JSON.parse(text))
}
