/**
 * Parsing of the messages sent by the Remote Volume app (v1 protocol, with the optional v2 additions).
 *
 * Kept free of Companion and WebSocket code so it can be unit tested.
 *
 * Messages from the app are one of:
 *  - a (possibly partial) state object: `{"volume":40,"muted":false,"outputDevice":"Speakers"}`.
 *    The state sent right after connecting may end with `"capabilities":{...}` (protocol v2).
 *  - an action reply: `{"action":"mute","response":{...}}`, where `response.error` reports a failure.
 *  - an error without an action: `{"error":"..."}`.
 */

/**
 * @typedef {object} ParsedMessage
 * @property {{ volume?: number, muted?: boolean, outputDevice?: string }} state Fields to apply to the module state.
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
	if (isObject(payload.capabilities)) result.capabilities = payload.capabilities

	return result
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
