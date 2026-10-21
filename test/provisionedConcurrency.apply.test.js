'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyProvisionedConcurrency } = require('../src/provisionedConcurrency');

const resolved = (value) => ({ promise: () => Promise.resolve(value) });
const rejected = (code) => ({ promise: () => Promise.reject(Object.assign(new Error(code), { code })) });

// `state` maps a function name to { requested, status }; the stub mutates it like Lambda would.
function stubLambda(state, { putError } = {}) {
	const CALLS = [];

	return {
		calls: CALLS,
		getProvisionedConcurrencyConfig({ FunctionName, Qualifier }) {
			CALLS.push(['get', `${FunctionName}:${Qualifier}`]);
			const CURRENT = state.get(FunctionName);

			if (!CURRENT) return rejected('ProvisionedConcurrencyConfigNotFoundException');
			if (CURRENT.getError) return rejected(CURRENT.getError);

			return resolved({
				RequestedProvisionedConcurrentExecutions: CURRENT.requested,
				AvailableProvisionedConcurrentExecutions: CURRENT.status === 'READY' ? CURRENT.requested : 0,
				Status: CURRENT.status || 'READY',
				StatusReason: CURRENT.reason,
			});
		},
		putProvisionedConcurrencyConfig({ FunctionName, Qualifier, ProvisionedConcurrentExecutions }) {
			CALLS.push(['put', `${FunctionName}:${Qualifier}`, ProvisionedConcurrentExecutions]);
			if (putError) return rejected(putError);
			state.set(FunctionName, { requested: ProvisionedConcurrentExecutions, status: 'READY' });

			return resolved({});
		},
		deleteProvisionedConcurrencyConfig({ FunctionName, Qualifier }) {
			CALLS.push(['delete', `${FunctionName}:${Qualifier}`]);
			state.delete(FunctionName);

			return resolved({});
		},
	};
}

function stubPlugin({ alias = 'prod', byAlias = null, skip = false, lambda }) {
	const LOGS = [];

	return {
		logs: LOGS,
		config: { alias, provisionedConcurrency: byAlias, skipProvisionedConcurrency: skip },
		getSdkClient: () => lambda,
		retryOnThrottle: (_description, call) => call(),
		debugLog: (message, options = {}) => LOGS.push({ message, ...options }),
	};
}

const FUNCTIONS = ['a', 'b', 'c', 'd'].map((name) => ({ name, functionName: `svc-${name}` }));
const FAST = { intervalMs: 1, timeoutMs: 50 };

test('an absent key makes no calls', async () => {
	const LAMBDA = stubLambda(new Map([['svc-a', { requested: 3 }]]));
	await applyProvisionedConcurrency(stubPlugin({ byAlias: null, lambda: LAMBDA }), FUNCTIONS, FAST);
	assert.deepEqual(LAMBDA.calls, []);
});

test('the skip flag makes no calls', async () => {
	const LAMBDA = stubLambda(new Map());
	const BY_ALIAS = new Map([['prod', new Map([['a', 1]])]]);
	await applyProvisionedConcurrency(stubPlugin({ byAlias: BY_ALIAS, skip: true, lambda: LAMBDA }), FUNCTIONS, FAST);
	assert.deepEqual(LAMBDA.calls, []);
});

test('puts, keeps, deletes and ignores to match the map, then waits on the kept and put ones', async () => {
	const STATE = new Map([
		['svc-b', { requested: 2 }],
		['svc-c', { requested: 1 }],
	]);
	const LAMBDA = stubLambda(STATE);
	const BY_ALIAS = new Map([['prod', new Map([['a', 1], ['b', 2], ['c', 0]])]]);

	await applyProvisionedConcurrency(stubPlugin({ byAlias: BY_ALIAS, lambda: LAMBDA }), FUNCTIONS, FAST);

	assert.deepEqual(LAMBDA.calls, [
		['get', 'svc-a:prod'],
		['put', 'svc-a:prod', 1],
		['get', 'svc-b:prod'],
		['get', 'svc-c:prod'],
		['delete', 'svc-c:prod'],
		['get', 'svc-d:prod'],
		['get', 'svc-a:prod'],
		['get', 'svc-b:prod'],
	]);
	assert.deepEqual(Array.from(STATE.keys()), ['svc-b', 'svc-a']);
});

test('the deploying alias only sees its own block, so rc deletes what prod keeps', async () => {
	const STATE = new Map([['svc-a', { requested: 1 }]]);
	const LAMBDA = stubLambda(STATE);
	const BY_ALIAS = new Map([['prod', new Map([['a', 1]])]]);

	await applyProvisionedConcurrency(stubPlugin({ alias: 'rc', byAlias: BY_ALIAS, lambda: LAMBDA }), FUNCTIONS, FAST);

	assert.deepEqual(LAMBDA.calls.filter(([op]) => op !== 'get'), [['delete', 'svc-a:rc']]);
	assert.equal(STATE.size, 0);
});

test('a failed put fails the deploy after every function was tried', async () => {
	const LAMBDA = stubLambda(new Map(), { putError: 'InvalidParameterValueException' });
	const BY_ALIAS = new Map([['prod', new Map([['a', 1], ['b', 1]])]]);

	await assert.rejects(
		applyProvisionedConcurrency(stubPlugin({ byAlias: BY_ALIAS, lambda: LAMBDA }), FUNCTIONS, FAST),
		/Failed to apply provisioned concurrency to 2 function alias\(es\): svc-a, svc-b/,
	);
});

test('an unexpected read error fails that function', async () => {
	const LAMBDA = stubLambda(new Map([['svc-a', { requested: 1, getError: 'AccessDeniedException' }]]));
	const BY_ALIAS = new Map([['prod', new Map([['a', 1]])]]);

	await assert.rejects(
		applyProvisionedConcurrency(stubPlugin({ byAlias: BY_ALIAS, lambda: LAMBDA }), FUNCTIONS, FAST),
		/Failed to apply provisioned concurrency to 1 function alias\(es\): svc-a/,
	);
});

test('a FAILED allocation fails the deploy with the reason', async () => {
	const LAMBDA = stubLambda(new Map([['svc-a', { requested: 1, status: 'FAILED', reason: 'Not enough concurrency' }]]));
	const BY_ALIAS = new Map([['prod', new Map([['a', 1]])]]);

	await assert.rejects(
		applyProvisionedConcurrency(stubPlugin({ byAlias: BY_ALIAS, lambda: LAMBDA }), FUNCTIONS, FAST),
		/Provisioned concurrency on 'svc-a:prod' failed: Not enough concurrency/,
	);
});

test('an allocation still in progress at the timeout warns and lets the deploy continue', async () => {
	const LAMBDA = stubLambda(new Map([['svc-a', { requested: 1, status: 'IN_PROGRESS' }]]));
	const BY_ALIAS = new Map([['prod', new Map([['a', 1]])]]);
	const PLUGIN = stubPlugin({ byAlias: BY_ALIAS, lambda: LAMBDA });

	await applyProvisionedConcurrency(PLUGIN, FUNCTIONS, { intervalMs: 1, timeoutMs: 5 });

	const WARNING = PLUGIN.logs.find((log) => log.type === 'warning');
	assert.match(WARNING.message, /still allocating .* svc-a/);
	assert.equal(WARNING.forceShow, true);
});
