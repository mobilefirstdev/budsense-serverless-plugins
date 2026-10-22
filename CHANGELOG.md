# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-10-22

### Changed

- **Deploy output names each step's outcome.** The provisioned concurrency and Cognito steps print their per-function results (requested, ready, removed, granted) without `--verbose`, so a deploy log shows what changed on the alias. Errors and warnings already printed; the rest stays behind `--verbose` or `custom.alias.verbose`.

## [1.0.0] - 2026-10-22

### Added

- **Cognito trigger permissions on the alias.** `custom.alias.cognitoTriggers` names a user pool (`userPool` logical id in this stack, or `userPoolArn`) and the functions it triggers; after the alias step the plugin grants `cognito-idp.amazonaws.com` permission to invoke each function's alias, scoped to that pool, on every deploy. This lets a pool's `LambdaConfig` point at `function:<stage>` instead of `$LATEST`, which an `AWS::Lambda::Permission` resource cannot do on a stage's first deploy because the alias does not exist until this plugin creates it. A failed grant fails the deploy.
- **Provisioned concurrency per alias.** `custom.alias.provisionedConcurrency` maps alias name → function → count, so chosen functions keep warm instances on the stage alias that API Gateway routes to (Serverless's own `provisionedConcurrency` property creates a separate alias that nothing routes to). Once the key is present the plugin owns provisioned concurrency on the deploying alias for every aliased function: after the alias step it puts, keeps or deletes each function's config to match the map, then waits up to 5 minutes for `READY`. Keyed by alias so an `rc` deploy never inherits prod's instances. A failed put, delete or `FAILED` status fails the deploy. Absent key: no calls at all. Opt out for one deploy with `--skip-provisioned-concurrency` or `custom.alias.skipProvisionedConcurrency: true`.
- **Async invoke settings mirrored onto the alias.** Serverless compiles `maximumRetryAttempts` / `maximumEventAge` into an `EventInvokeConfig` on `$LATEST` only, so alias-qualified async invokes ran on Lambda's defaults (2 retries, 6h event age) regardless of `serverless.yml`. After the alias step the plugin now calls `PutFunctionEventInvokeConfig` on the alias for every function declaring either setting, on every deploy. Additive: `$LATEST` is untouched, undeclared functions are untouched, `destinations` are not mirrored. Opt out with `custom.alias.skipEventInvokeConfig: true` or `--skip-event-invoke-config`. A failure fails the deploy, like alias errors.
- **Throttle-aware retries on every AWS call.** Lambda's control-plane APIs (everything except invocations, `GetFunction`, and `GetPolicy`) share one account-wide 15 req/s quota that AWS does not raise, so concurrent service deploys routinely hit `Rate exceeded`. Every Lambda, API Gateway, CloudFormation, and STS call now retries throttling errors with exponential backoff and jitter (8 retries, 400ms base, 10s cap). Non-throttling errors are rethrown immediately, preserving all `ResourceNotFoundException` control flow.
- **Multi-alias routing on a single API.** Deploying with `--param alias=<name>` (when `<name>` differs from `provider.stage`) now creates a parallel API Gateway stage named `<name>` on the same REST and/or WebSocket API. Both stages share one CloudFormation stack and one set of methods/integrations; each stage routes to its corresponding Lambda alias via stage variables. This unlocks in-stack blue/green deploys (e.g. keeping `prod` and `rc` on a single stack with shared infrastructure) without any new configuration.
- On multi-alias deploys, the framework stage is refreshed onto the same API Gateway deployment as the alias stage, so both stages stay in sync on API definition while preserving each stage's own alias routing.
- **Auto-discovery of API IDs from CloudFormation stack outputs.** When `provider.apiGateway.restApiId` and `provider.websocketApiId` are not pre-supplied, the plugin reads the `ServiceEndpoint` and `ServiceEndpointWebsocket` outputs that Serverless Framework emits by default. Pre-supplied IDs always take precedence. Services whose APIs are created in the same stack no longer need extra configuration to enable API Gateway integration management.
- Validation of the alias name against AWS Lambda alias and API Gateway stage name rules (alphanumerics, dashes, underscores; up to 128 characters; not `$LATEST`). Invalid names are rejected before any AWS calls are made.
- Documented alias lifecycle semantics: the plugin is non-destructive and does not auto-delete stale API Gateway stages or Lambda aliases; cleanup is manual.

### Changed

- **Renamed to `budsense-serverless-plugins`.** The package moved from the `mobilefirstdev/serverless-aws-alias-v4` fork into its own repository and no longer tracks upstream. Services install it as `github:mobilefirstdev/budsense-serverless-plugins#<tag>` and list `budsense-serverless-plugins` under `plugins:`; the `custom.alias` configuration is unchanged. The version restarts at `1.0.0`.
- **Alias failures now fail the deploy.** Previously, a function whose alias could not be checked/published/updated only produced a `WARNING: Failed to process aliases for N functions` log line and the deploy exited 0 — leaving aliases silently pointing at stale versions. `createOrUpdateFunctionAliases` now throws after the loop when any function failed, so CI retry wrappers can detect and rerun the deploy.
- **Redundant configuration update before publish is skipped.** `publishNewFunctionVersion` used to unconditionally call `updateFunctionConfiguration` and poll `LastUpdateStatus` before publishing. The CloudFormation deploy that runs before the alias hook already applies the same merged environment, so the update (and its polling) now only runs when the live environment actually differs. If a prior update is still `InProgress`, the publish still waits for it to settle.
- Configuration reads use `GetFunction` (dedicated 100 req/s quota) instead of `GetFunctionConfiguration` (shared 15 req/s quota), keeping change-detection reads out of the contended control-plane bucket.
- One SDK client is constructed per AWS service per deploy instead of one per call.
- `createOrUpdateAlias` accepts the already-fetched alias from the deploy loop instead of re-fetching it, saving one `GetAlias` call per function.
- A change-detection or version-listing call that is still throttled after all retries now fails that function instead of silently publishing a new version or pinning the alias to `$LATEST`.
- Standardized integration URI routing on `${stageVariables.alias}` while writing both `alias` and `SERVERLESS_ALIAS` stage variables for compatibility with legacy v3-style integrations.

### Unchanged

- Single-alias deploys (the case where the deploying alias matches `provider.stage`) behave identically to v0.5.0.
- The integration URI continues to use API Gateway stage-variable alias routing and the plugin continues to set the routing stage variable on managed stages.

## [0.5.0] - 2025-09-16

Initial baseline tagged when this fork was created. See upstream releases at
<https://github.com/Castlenine/serverless-aws-alias-v4/releases> for prior history.
