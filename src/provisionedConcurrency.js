'use strict';

/**
 * Provisioned concurrency on the deployed alias.
 *
 * `custom.alias.provisionedConcurrency` is keyed by alias name and then by the
 * serverless function key, so an `rc` deploy of the prod stack never inherits
 * prod's warm instances:
 *
 *   custom:
 *     alias:
 *       provisionedConcurrency:
 *         prod:
 *           sign-in: 1
 *
 * Once the key is present the plugin owns provisioned concurrency on the
 * deploying alias for every aliased function: a function that is missing or
 * set to 0 has its config deleted. When the key is absent the plugin makes no
 * provisioned concurrency calls at all, so services that do not opt in pay
 * nothing on the shared control-plane quota.
 *
 * Serverless's own `provisionedConcurrency` property cannot be used with this
 * plugin: it creates a separate CloudFormation-managed alias, and API Gateway
 * routes to the stage alias this plugin owns, so those warm instances would
 * never receive traffic.
 */

const WAIT_INTERVAL_MS = 5000;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Parses the raw `custom.alias.provisionedConcurrency` value.
 *
 * Returns `{ byAlias, problems }`: `byAlias` is `Map<alias, Map<functionKey, count>>`,
 * or `null` when the key is absent, and `problems` lists every invalid entry so
 * the caller can fail validation with all of them at once. Counts given as
 * digit strings (e.g. from `${env:...}`) are accepted.
 */
function parseProvisionedConcurrencyConfig(raw, { functionKeys, excludedFunctions, isValidAliasName }) {
	const PROBLEMS = [];

	if (raw === undefined || raw === null) {
		return { byAlias: null, problems: PROBLEMS };
	}

	if (typeof raw !== 'object' || Array.isArray(raw)) {
		PROBLEMS.push('custom.alias.provisionedConcurrency must be a map of alias name to { function: count }');
		return { byAlias: null, problems: PROBLEMS };
	}

	const BY_ALIAS = new Map();

	for (const [aliasName, perFunction] of Object.entries(raw)) {
		if (!isValidAliasName(aliasName)) {
			PROBLEMS.push(`provisionedConcurrency: '${aliasName}' is not a valid alias name`);
			continue;
		}

		if (perFunction === null || typeof perFunction !== 'object' || Array.isArray(perFunction)) {
			PROBLEMS.push(`provisionedConcurrency.${aliasName} must be a map of function name to count`);
			continue;
		}

		const COUNTS = new Map();

		for (const [functionKey, rawCount] of Object.entries(perFunction)) {
			const COUNT = typeof rawCount === 'string' && /^\d+$/.test(rawCount) ? Number(rawCount) : rawCount;

			if (!functionKeys.has(functionKey)) {
				PROBLEMS.push(`provisionedConcurrency.${aliasName}.${functionKey}: no such function in serverless.yml`);
			} else if (excludedFunctions.has(functionKey)) {
				PROBLEMS.push(
					`provisionedConcurrency.${aliasName}.${functionKey}: function is in excludedFunctions, so it has no alias to provision`,
				);
			} else if (!Number.isInteger(COUNT) || COUNT < 0) {
				PROBLEMS.push(
					`provisionedConcurrency.${aliasName}.${functionKey}: count must be an integer of 0 or more, got ${JSON.stringify(rawCount)}`,
				);
			} else {
				COUNTS.set(functionKey, COUNT);
			}
		}

		BY_ALIAS.set(aliasName, COUNTS);
	}

	return { byAlias: BY_ALIAS, problems: PROBLEMS };
}

/**
 * `current` is the count already requested on the alias, or null when there is no config.
 *
 *   put    - request `wanted` (new config, or the count changed)
 *   keep   - already at `wanted`; nothing to send, but the alias may have moved to a new
 *            version this deploy, so the caller still waits for it to be READY
 *   delete - `wanted` is 0 and a config exists
 *   none   - `wanted` is 0 and nothing exists
 */
function decideProvisionedConcurrencyAction(wanted, current) {
	if (wanted > 0) {
		return current === wanted ? 'keep' : 'put';
	}

	return current === null ? 'none' : 'delete';
}

/**
 * Reads the alias's provisioned concurrency config, or null when it has none.
 */
async function getProvisionedConcurrency(plugin, functionName) {
	const LAMBDA = plugin.getSdkClient('Lambda');
	const ALIAS = plugin.config.alias;

	try {
		return await plugin.retryOnThrottle(`getProvisionedConcurrencyConfig(${functionName}:${ALIAS})`, () =>
			LAMBDA.getProvisionedConcurrencyConfig({ FunctionName: functionName, Qualifier: ALIAS }).promise(),
		);
	} catch (error) {
		if (error.code === 'ProvisionedConcurrencyConfigNotFoundException') {
			return null;
		}

		throw error;
	}
}

/**
 * Brings every aliased function's provisioned concurrency on the deploying alias in line
 * with the parsed config, then waits for the requested instances to be READY.
 *
 * Runs after the alias step, so a function whose alias moved to a new version this deploy
 * is already re-provisioning by the time it is checked here.
 */
async function applyProvisionedConcurrency(plugin, functions, waitOptions = {}) {
	if (plugin.config.provisionedConcurrency === null) {
		return;
	}

	if (plugin.config.skipProvisionedConcurrency) {
		plugin.debugLog('Skipping provisioned concurrency (skipProvisionedConcurrency is set)');
		return;
	}

	const ALIAS = plugin.config.alias;
	const WANTED_BY_FUNCTION = plugin.config.provisionedConcurrency.get(ALIAS) || new Map();
	const LAMBDA = plugin.getSdkClient('Lambda');
	const FAILED_FUNCTIONS = [];
	const WAIT_FOR = [];

	for (const FUNCTION of functions) {
		const WANTED = WANTED_BY_FUNCTION.get(FUNCTION.name) || 0;
		const QUALIFIED_FUNCTION_NAME = `${FUNCTION.functionName}:${ALIAS}`;

		try {
			const CURRENT = await getProvisionedConcurrency(plugin, FUNCTION.functionName);
			const ACTION = decideProvisionedConcurrencyAction(
				WANTED,
				CURRENT ? CURRENT.RequestedProvisionedConcurrentExecutions : null,
			);

			if (ACTION === 'put') {
				await plugin.retryOnThrottle(`putProvisionedConcurrencyConfig(${QUALIFIED_FUNCTION_NAME})`, () =>
					LAMBDA.putProvisionedConcurrencyConfig({
						FunctionName: FUNCTION.functionName,
						Qualifier: ALIAS,
						ProvisionedConcurrentExecutions: WANTED,
					}).promise(),
				);
				plugin.debugLog(`Requested ${WANTED} provisioned instance(s) on '${QUALIFIED_FUNCTION_NAME}'`, {
					type: 'success',
				});
				WAIT_FOR.push(FUNCTION.functionName);
			} else if (ACTION === 'delete') {
				await plugin.retryOnThrottle(`deleteProvisionedConcurrencyConfig(${QUALIFIED_FUNCTION_NAME})`, () =>
					LAMBDA.deleteProvisionedConcurrencyConfig({ FunctionName: FUNCTION.functionName, Qualifier: ALIAS }).promise(),
				);
				plugin.debugLog(`Removed provisioned concurrency from '${QUALIFIED_FUNCTION_NAME}'`, { type: 'success' });
			} else if (ACTION === 'keep') {
				WAIT_FOR.push(FUNCTION.functionName);
			}
		} catch (error) {
			plugin.debugLog(`Error applying provisioned concurrency to '${QUALIFIED_FUNCTION_NAME}': ${error.message}`, {
				forceShow: true,
				type: 'error',
			});
			FAILED_FUNCTIONS.push(FUNCTION.functionName);
		}
	}

	if (FAILED_FUNCTIONS.length > 0) {
		throw new Error(
			`Failed to apply provisioned concurrency to ${FAILED_FUNCTIONS.length} function alias(es): ${FAILED_FUNCTIONS.join(', ')}`,
		);
	}

	await waitForProvisionedConcurrency(plugin, WAIT_FOR, waitOptions);
}

/**
 * Polls until every listed alias reports READY. FAILED fails the deploy with AWS's reason.
 * Past the timeout the deploy carries on with a warning: the config is in place and AWS
 * keeps allocating on its own.
 */
async function waitForProvisionedConcurrency(
	plugin,
	functionNames,
	{ intervalMs = WAIT_INTERVAL_MS, timeoutMs = WAIT_TIMEOUT_MS } = {},
) {
	const PENDING = new Set(functionNames);
	const DEADLINE = Date.now() + timeoutMs;

	while (PENDING.size > 0) {
		for (const FUNCTION_NAME of PENDING) {
			const QUALIFIED_FUNCTION_NAME = `${FUNCTION_NAME}:${plugin.config.alias}`;
			const CONFIG = await getProvisionedConcurrency(plugin, FUNCTION_NAME);

			if (CONFIG === null) {
				throw new Error(`Provisioned concurrency on '${QUALIFIED_FUNCTION_NAME}' disappeared while waiting for it`);
			}

			if (CONFIG.Status === 'READY') {
				plugin.debugLog(
					`'${QUALIFIED_FUNCTION_NAME}' has ${CONFIG.AvailableProvisionedConcurrentExecutions} provisioned instance(s) ready`,
					{ type: 'success' },
				);
				PENDING.delete(FUNCTION_NAME);
			} else if (CONFIG.Status === 'FAILED') {
				throw new Error(
					`Provisioned concurrency on '${QUALIFIED_FUNCTION_NAME}' failed: ${CONFIG.StatusReason || 'no reason given'}`,
				);
			}
		}

		if (PENDING.size === 0) {
			break;
		}

		if (Date.now() >= DEADLINE) {
			plugin.debugLog(
				`Provisioned concurrency still allocating after ${timeoutMs / 1000}s on: ${Array.from(PENDING).join(', ')}. AWS keeps allocating; the deploy continues.`,
				{ forceShow: true, type: 'warning' },
			);
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

module.exports = {
	parseProvisionedConcurrencyConfig,
	decideProvisionedConcurrencyAction,
	applyProvisionedConcurrency,
};
