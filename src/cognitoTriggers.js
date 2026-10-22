'use strict';

/**
 * Invoke permission for a Cognito user pool on the deployed alias.
 *
 * A pool's LambdaConfig can name a qualified function ARN (`function:alias`),
 * so its triggers run the alias's version instead of $LATEST. Lambda grants
 * invoke permissions per qualifier, so a permission on the bare function does
 * not cover the alias, and an AWS::Lambda::Permission resource cannot name the
 * alias before this plugin has created it on a stage's first deploy. This step
 * grants the permission after the alias step, on every deploy:
 *
 *   custom:
 *     alias:
 *       cognitoTriggers:
 *         userPool: CognitoUserPool     # logical id of the pool in this stack
 *         functions:
 *           - define-auth-challenge
 *
 * `userPoolArn` may be given instead of `userPool` for a pool in another stack.
 */

const USER_POOL_ARN = /^arn:aws[a-z-]*:cognito-idp:[^:]+:\d{12}:userpool\/[^/]+$/;

/**
 * Parses the raw `custom.alias.cognitoTriggers` value.
 *
 * Returns `{ config, problems }`: `config` is `{ userPool, userPoolArn, functions }`
 * (one of the pool fields null), or `null` when the key is absent or invalid, and
 * `problems` lists every invalid entry so the caller can fail validation with all of them.
 */
function parseCognitoTriggersConfig(raw, { functionKeys, excludedFunctions }) {
	const PROBLEMS = [];

	if (raw === undefined || raw === null) {
		return { config: null, problems: PROBLEMS };
	}

	if (typeof raw !== 'object' || Array.isArray(raw)) {
		PROBLEMS.push('custom.alias.cognitoTriggers must be a map with userPool (or userPoolArn) and functions');
		return { config: null, problems: PROBLEMS };
	}

	const HAS_POOL = typeof raw.userPool === 'string' && raw.userPool.length > 0;
	const HAS_ARN = typeof raw.userPoolArn === 'string' && raw.userPoolArn.length > 0;

	if (HAS_POOL === HAS_ARN) {
		PROBLEMS.push('cognitoTriggers: give exactly one of userPool (logical id in this stack) or userPoolArn');
	}

	if (HAS_ARN && !USER_POOL_ARN.test(raw.userPoolArn)) {
		PROBLEMS.push(`cognitoTriggers.userPoolArn: '${raw.userPoolArn}' is not a Cognito user pool ARN`);
	}

	if (!Array.isArray(raw.functions) || raw.functions.length === 0) {
		PROBLEMS.push('cognitoTriggers.functions must be a non-empty list of function names');
	} else {
		for (const functionKey of raw.functions) {
			if (!functionKeys.has(functionKey)) {
				PROBLEMS.push(`cognitoTriggers.functions: no such function '${functionKey}' in serverless.yml`);
			} else if (excludedFunctions.has(functionKey)) {
				PROBLEMS.push(`cognitoTriggers.functions: '${functionKey}' is in excludedFunctions, so it has no alias to grant`);
			}
		}
	}

	if (PROBLEMS.length > 0) {
		return { config: null, problems: PROBLEMS };
	}

	return {
		config: {
			userPool: HAS_POOL ? raw.userPool : null,
			userPoolArn: HAS_ARN ? raw.userPoolArn : null,
			functions: Array.from(new Set(raw.functions)),
		},
		problems: PROBLEMS,
	};
}

/**
 * One statement per alias and pool, so a re-run replaces rather than accumulates.
 */
function cognitoStatementId(alias, userPoolArn) {
	const POOL_ID = userPoolArn.slice(userPoolArn.lastIndexOf('/') + 1);

	return `cognito-${alias}-${POOL_ID}`.replace(/[^a-zA-Z0-9-_]/g, '-');
}

/**
 * The pool's ARN: as configured, or built from the stack resource's physical id.
 */
async function resolveUserPoolArn(plugin) {
	const { userPool, userPoolArn } = plugin.config.cognitoTriggers;

	if (userPoolArn) {
		return userPoolArn;
	}

	const STACK_NAME = plugin.provider.naming.getStackName();
	const CLOUD_FORMATION = plugin.getSdkClient('CloudFormation');
	const RESULT = await plugin.retryOnThrottle(`describeStackResource(${STACK_NAME}/${userPool})`, () =>
		CLOUD_FORMATION.describeStackResource({ StackName: STACK_NAME, LogicalResourceId: userPool }).promise(),
	);
	const DETAIL = RESULT.StackResourceDetail;

	if (DETAIL.ResourceType !== 'AWS::Cognito::UserPool') {
		throw new Error(`cognitoTriggers.userPool: '${userPool}' is a ${DETAIL.ResourceType}, not an AWS::Cognito::UserPool`);
	}

	return `arn:aws:cognito-idp:${plugin.config.region}:${plugin.config.accountId}:userpool/${DETAIL.PhysicalResourceId}`;
}

/**
 * Grants the pool permission to invoke each configured function's alias. The statement is
 * removed and re-added so a changed pool never leaves a stale grant behind.
 */
async function applyCognitoTriggerPermissions(plugin, functions) {
	if (plugin.config.cognitoTriggers === null) {
		return;
	}

	const ALIAS = plugin.config.alias;
	const POOL_ARN = await resolveUserPoolArn(plugin);
	const STATEMENT_ID = cognitoStatementId(ALIAS, POOL_ARN);
	const LAMBDA = plugin.getSdkClient('Lambda');
	const BY_KEY = new Map(functions.map((fn) => [fn.name, fn]));
	const FAILED_FUNCTIONS = [];

	for (const FUNCTION_KEY of plugin.config.cognitoTriggers.functions) {
		const FUNCTION = BY_KEY.get(FUNCTION_KEY);

		if (!FUNCTION) {
			throw new Error(`cognitoTriggers.functions: '${FUNCTION_KEY}' was not part of the alias deployment`);
		}

		const QUALIFIED_FUNCTION_NAME = `${FUNCTION.functionName}:${ALIAS}`;

		try {
			try {
				await plugin.retryOnThrottle(`removePermission(${QUALIFIED_FUNCTION_NAME})`, () =>
					LAMBDA.removePermission({ FunctionName: QUALIFIED_FUNCTION_NAME, StatementId: STATEMENT_ID }).promise(),
				);
			} catch (error) {
				if (error.code !== 'ResourceNotFoundException') {
					plugin.debugLog(`Warning: ${error.message}`, { type: 'warning' });
				}
			}

			await plugin.retryOnThrottle(`addPermission(${QUALIFIED_FUNCTION_NAME})`, () =>
				LAMBDA.addPermission({
					FunctionName: QUALIFIED_FUNCTION_NAME,
					StatementId: STATEMENT_ID,
					Action: 'lambda:InvokeFunction',
					Principal: 'cognito-idp.amazonaws.com',
					SourceArn: POOL_ARN,
				}).promise(),
			);

			plugin.debugLog(`Granted ${POOL_ARN} permission to invoke '${QUALIFIED_FUNCTION_NAME}'`, {
				forceShow: true,
				type: 'success',
			});
		} catch (error) {
			plugin.debugLog(`Error granting Cognito permission on '${QUALIFIED_FUNCTION_NAME}': ${error.message}`, {
				forceShow: true,
				type: 'error',
			});
			FAILED_FUNCTIONS.push(FUNCTION.functionName);
		}
	}

	if (FAILED_FUNCTIONS.length > 0) {
		throw new Error(
			`Failed to grant Cognito invoke permission on ${FAILED_FUNCTIONS.length} function alias(es): ${FAILED_FUNCTIONS.join(', ')}`,
		);
	}
}

module.exports = {
	parseCognitoTriggersConfig,
	cognitoStatementId,
	applyCognitoTriggerPermissions,
};
