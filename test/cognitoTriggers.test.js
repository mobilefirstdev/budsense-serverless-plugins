'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCognitoTriggersConfig, cognitoStatementId } = require('../src/cognitoTriggers');

const OPTIONS = {
	functionKeys: new Set(['define-auth-challenge', 'verify-auth-challenge', 'warmer']),
	excludedFunctions: new Set(['warmer']),
};

const POOL_ARN = 'arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_abcDEF123';

test('an absent key means no Cognito permissions are managed', () => {
	for (const raw of [undefined, null]) {
		const { config, problems } = parseCognitoTriggersConfig(raw, OPTIONS);
		assert.equal(config, null);
		assert.deepEqual(problems, []);
	}
});

test('accepts a pool logical id with a list of functions, dropping duplicates', () => {
	const { config, problems } = parseCognitoTriggersConfig(
		{ userPool: 'CognitoUserPool', functions: ['define-auth-challenge', 'verify-auth-challenge', 'define-auth-challenge'] },
		OPTIONS,
	);
	assert.deepEqual(problems, []);
	assert.deepEqual(config, {
		userPool: 'CognitoUserPool',
		userPoolArn: null,
		functions: ['define-auth-challenge', 'verify-auth-challenge'],
	});
});

test('accepts a pool ARN for a pool in another stack', () => {
	const { config, problems } = parseCognitoTriggersConfig(
		{ userPoolArn: POOL_ARN, functions: ['define-auth-challenge'] },
		OPTIONS,
	);
	assert.deepEqual(problems, []);
	assert.equal(config.userPool, null);
	assert.equal(config.userPoolArn, POOL_ARN);
});

test('requires exactly one of userPool and userPoolArn', () => {
	const NEITHER = parseCognitoTriggersConfig({ functions: ['define-auth-challenge'] }, OPTIONS);
	assert.equal(NEITHER.config, null);
	assert.match(NEITHER.problems[0], /exactly one of userPool/);

	const BOTH = parseCognitoTriggersConfig(
		{ userPool: 'CognitoUserPool', userPoolArn: POOL_ARN, functions: ['define-auth-challenge'] },
		OPTIONS,
	);
	assert.equal(BOTH.config, null);
	assert.match(BOTH.problems[0], /exactly one of userPool/);
});

test('reports a malformed ARN and every bad function at once', () => {
	const { config, problems } = parseCognitoTriggersConfig(
		{ userPoolArn: 'arn:aws:lambda:us-west-2:123456789012:function:x', functions: ['no-such', 'warmer'] },
		OPTIONS,
	);
	assert.equal(config, null);
	assert.equal(problems.length, 3);
	assert.match(problems[0], /is not a Cognito user pool ARN/);
	assert.match(problems[1], /no such function 'no-such'/);
	assert.match(problems[2], /'warmer' is in excludedFunctions/);
});

test('rejects an empty or missing function list', () => {
	for (const functions of [undefined, [], 'define-auth-challenge']) {
		const { config, problems } = parseCognitoTriggersConfig({ userPool: 'CognitoUserPool', functions }, OPTIONS);
		assert.equal(config, null);
		assert.match(problems[0], /functions must be a non-empty list/);
	}
});

test('rejects a value that is not a map', () => {
	for (const raw of ['CognitoUserPool', ['define-auth-challenge'], 7]) {
		const { config, problems } = parseCognitoTriggersConfig(raw, OPTIONS);
		assert.equal(config, null);
		assert.equal(problems.length, 1);
	}
});

test('statement id is one per alias and pool, with only safe characters', () => {
	assert.equal(cognitoStatementId('prod', POOL_ARN), 'cognito-prod-us-west-2_abcDEF123');
	assert.equal(cognitoStatementId('rc', POOL_ARN), 'cognito-rc-us-west-2_abcDEF123');
	assert.equal(cognitoStatementId('a.b', 'arn:aws:cognito-idp:us-west-2:1:userpool/p+q'), 'cognito-a-b-p-q');
});
