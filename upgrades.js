/**
 * Upgrade scripts, run once per connection in this order. Never reorder or remove one: Companion
 * remembers how many have run.
 */

const ADJUSTED = {
	increaseVolume: ['adjust_volume', 1],
	decreaseVolume: ['adjust_volume', -1],
	app_increase_volume: ['app_adjust_volume', 1],
	app_decrease_volume: ['app_adjust_volume', -1],
}

/** 1.6.0: Increase / Decrease Volume (global and per app) become one Adjust Volume with a signed step. */
export function mergeIncreaseDecrease(_context, props) {
	const updatedActions = []
	for (const action of props.actions) {
		const target = ADJUSTED[action.actionId]
		if (!target) continue
		const [actionId, sign] = target
		const { volume, ...rest } = action.options
		const amount = Number(volume ?? 10)
		action.actionId = actionId
		action.options = { ...rest, value: String(sign * (Number.isFinite(amount) ? amount : 10)) }
		updatedActions.push(action)
	}
	return { updatedConfig: null, updatedActions, updatedFeedbacks: [] }
}

export const UpgradeScripts = [mergeIncreaseDecrease]
