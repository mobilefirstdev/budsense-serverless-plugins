'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyCognitoTriggerPermissions } = require('../src/cognitoTriggers');

const resolved = (value) => ({ promise: () => Promise.resolve(value) });
const rejected = (code) => ({ promise: () => Promise.reject(Object.assign(new Error(code), { code })) });

function stubLambda({ removeError = 'ResourceNotFoundException', addError } = {}) {
	const CALLS = [];

	return {
		calls: CALLS,
		removePermission(params) {
			CALLS.push(['remove', params]);

			return removeError ? rejected(removeError) : resolved({});
		},
		addPermission(params) {
			CALLS.push(['add', params]);

			return addError ? rejected(addError) : resolved({});
		},
	};
}

function stubCloudFormation(detail) {
	const CALLS = [];

	return {
		calls: CALLS,
		describeStackResource(params) {
			CALLS.push(params);

			return resolved({ StackResourceDetail: detail });
		},
	};
}

function stubPlugin({ alias = 'prod', cognitoTriggers = null, lambda, cloudFormation }) {
	const LOGS = [];

	return {
		logs: LOGS,
		config: { alias, region: 'us-west-2', accountId: '123456789012', cognitoTriggers },
		provider: { naming: { getStackName: () => 'svc-prod' } },
		getSdkClient: (name) => (name === 'Lambda' ? lambda : cloudFormation),
		retryOnThrottle: (_description, call) => call(),
		debugLog: (message, options = {}) => LOGS.push({ message, ...options }),
	};
}

const FUNCTIONS = [
	{ name: 'define-auth-challenge', functionName: 'svc-prod-define-auth-challenge' },
	{ name: 'verify-auth-challenge', functionName: 'svc-prod-verify-auth-challenge' },
];
const POOL = { ResourceType: 'AWS::Cognito::UserPool', PhysicalResourceId: 'us-west-2_abc123' };
const POOL_ARN = 'arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_abc123';

test('an absent key makes no calls', async () => {
	const LAMBDA = stubLambda();
	const CLOUD_FORMATION = stubCloudFormation(POOL);
	await applyCognitoTriggerPermissions(stubPlugin({ lambda: LAMBDA, cloudFormation: CLOUD_FORMATION }), FUNCTIONS);
	assert.deepEqual(LAMBDA.calls, []);
	assert.deepEqual(CLOUD_FORMATION.calls, []);
});

test('resolves the pool from the stack and grants each alias one statement scoped to it', async () => {
	const LAMBDA = stubLambda();
	const CLOUD_FORMATION = stubCloudFormation(POOL);
	const PLUGIN = stubPlugin({
		cognitoTriggers: { userPool: 'CognitoUserPool', userPoolArn: null, functions: ['define-auth-challenge', 'verify-auth-challenge'] },
		lambda: LAMBDA,
		cloudFormation: CLOUD_FORMATION,
	});

	await applyCognitoTriggerPermissions(PLUGIN, FUNCTIONS);

	assert.deepEqual(CLOUD_FORMATION.calls, [{ StackName: 'svc-prod', LogicalResourceId: 'CognitoUserPool' }]);
	assert.deepEqual(LAMBDA.calls, [
		['remove', { FunctionName: 'svc-prod-define-auth-challenge:prod', StatementId: 'cognito-prod-us-west-2_abc123' }],
		[
			'add',
			{
				FunctionName: 'svc-prod-define-auth-challenge:prod',
				StatementId: 'cognito-prod-us-west-2_abc123',
				Action: 'lambda:InvokeFunction',
				Principal: 'cognito-idp.amazonaws.com',
				SourceArn: POOL_ARN,
			},
		],
		['remove', { FunctionName: 'svc-prod-verify-auth-challenge:prod', StatementId: 'cognito-prod-us-west-2_abc123' }],
		[
			'add',
			{
				FunctionName: 'svc-prod-verify-auth-challenge:prod',
				StatementId: 'cognito-prod-us-west-2_abc123',
				Action: 'lambda:InvokeFunction',
				Principal: 'cognito-idp.amazonaws.com',
				SourceArn: POOL_ARN,
			},
		],
	]);
});

test('a configured ARN skips the stack lookup', async () => {
	const LAMBDA = stubLambda();
	const CLOUD_FORMATION = stubCloudFormation(POOL);
	const PLUGIN = stubPlugin({
		cognitoTriggers: { userPool: null, userPoolArn: POOL_ARN, functions: ['define-auth-challenge'] },
		lambda: LAMBDA,
		cloudFormation: CLOUD_FORMATION,
	});

	await applyCognitoTriggerPermissions(PLUGIN, FUNCTIONS);

	assert.deepEqual(CLOUD_FORMATION.calls, []);
	assert.equal(LAMBDA.calls.length, 2);
	assert.equal(LAMBDA.calls[1][1].SourceArn, POOL_ARN);
});

test('a logical id that is not a user pool fails before any grant', async () => {
	const LAMBDA = stubLambda();
	const PLUGIN = stubPlugin({
		cognitoTriggers: { userPool: 'UserTable', userPoolArn: null, functions: ['define-auth-challenge'] },
		lambda: LAMBDA,
		cloudFormation: stubCloudFormation({ ResourceType: 'AWS::DynamoDB::Table', PhysicalResourceId: 'user-prod' }),
	});

	await assert.rejects(
		applyCognitoTriggerPermissions(PLUGIN, FUNCTIONS),
		/'UserTable' is a AWS::DynamoDB::Table, not an AWS::Cognito::UserPool/,
	);
	assert.deepEqual(LAMBDA.calls, []);
});

test('a remove error other than not-found is logged and the grant still proceeds', async () => {
	const LAMBDA = stubLambda({ removeError: 'ServiceException' });
	const PLUGIN = stubPlugin({
		cognitoTriggers: { userPool: 'CognitoUserPool', userPoolArn: null, functions: ['define-auth-challenge'] },
		lambda: LAMBDA,
		cloudFormation: stubCloudFormation(POOL),
	});

	await applyCognitoTriggerPermissions(PLUGIN, FUNCTIONS);

	assert.equal(LAMBDA.calls.filter(([op]) => op === 'add').length, 1);
	assert.ok(PLUGIN.logs.some((log) => log.type === 'warning' && /ServiceException/.test(log.message)));
});

test('a failed grant fails the deploy after every function was tried', async () => {
	const LAMBDA = stubLambda({ addError: 'AccessDeniedException' });
	const PLUGIN = stubPlugin({
		cognitoTriggers: { userPool: 'CognitoUserPool', userPoolArn: null, functions: ['define-auth-challenge', 'verify-auth-challenge'] },
		lambda: LAMBDA,
		cloudFormation: stubCloudFormation(POOL),
	});

	await assert.rejects(
		applyCognitoTriggerPermissions(PLUGIN, FUNCTIONS),
		/Failed to grant Cognito invoke permission on 2 function alias\(es\): svc-prod-define-auth-challenge, svc-prod-verify-auth-challenge/,
	);
	assert.equal(LAMBDA.calls.filter(([op]) => op === 'add').length, 2);
});
