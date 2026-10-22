'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	parseProvisionedConcurrencyConfig,
	decideProvisionedConcurrencyAction,
} = require('../src/provisionedConcurrency');

const OPTIONS = {
	functionKeys: new Set(['sign-in', 'pin-sign-in', 'warmer']),
	excludedFunctions: new Set(['warmer']),
	isValidAliasName: (name) => /^(?!\$LATEST$)[a-zA-Z0-9_-]{1,128}$/.test(name),
};

test('an absent key means the plugin leaves provisioned concurrency alone', () => {
	for (const raw of [undefined, null]) {
		const { byAlias, problems } = parseProvisionedConcurrencyConfig(raw, OPTIONS);
		assert.equal(byAlias, null);
		assert.deepEqual(problems, []);
	}
});

test('parses counts per alias and function, accepting digit strings', () => {
	const { byAlias, problems } = parseProvisionedConcurrencyConfig(
		{ prod: { 'sign-in': 1, 'pin-sign-in': '2' }, rc: {} },
		OPTIONS,
	);
	assert.deepEqual(problems, []);
	assert.deepEqual(Array.from(byAlias.get('prod')), [
		['sign-in', 1],
		['pin-sign-in', 2],
	]);
	assert.deepEqual(Array.from(byAlias.get('rc')), []);
	assert.equal(byAlias.has('dev'), false);
});

test('an empty map still claims ownership', () => {
	const { byAlias, problems } = parseProvisionedConcurrencyConfig({}, OPTIONS);
	assert.deepEqual(problems, []);
	assert.equal(byAlias.size, 0);
});

test('reports every unknown, excluded or badly counted entry at once', () => {
	const { problems } = parseProvisionedConcurrencyConfig(
		{
			prod: { 'no-such': 1, warmer: 1, 'sign-in': -1, 'pin-sign-in': 1.5 },
			'bad alias!': { 'sign-in': 1 },
			dev: ['sign-in'],
		},
		OPTIONS,
	);
	assert.equal(problems.length, 6);
	assert.match(problems[0], /no-such: no such function/);
	assert.match(problems[1], /warmer: function is in excludedFunctions/);
	assert.match(problems[2], /sign-in: count must be an integer of 0 or more, got -1/);
	assert.match(problems[3], /pin-sign-in: count must be an integer of 0 or more, got 1\.5/);
	assert.match(problems[4], /'bad alias!' is not a valid alias name/);
	assert.match(problems[5], /provisionedConcurrency\.dev must be a map/);
});

test('rejects a value that is not a map', () => {
	for (const raw of ['prod', 3, ['prod'], true]) {
		const { byAlias, problems } = parseProvisionedConcurrencyConfig(raw, OPTIONS);
		assert.equal(byAlias, null);
		assert.equal(problems.length, 1);
	}
});

test('decides put, keep, delete or none from the wanted and current counts', () => {
	assert.equal(decideProvisionedConcurrencyAction(1, null), 'put');
	assert.equal(decideProvisionedConcurrencyAction(2, 1), 'put');
	assert.equal(decideProvisionedConcurrencyAction(1, 1), 'keep');
	assert.equal(decideProvisionedConcurrencyAction(0, 1), 'delete');
	assert.equal(decideProvisionedConcurrencyAction(0, null), 'none');
});
