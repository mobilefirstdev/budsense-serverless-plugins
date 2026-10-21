<div align="center">

# `budsense-serverless-plugins`

BudSense's Serverless Framework plugin library for alias-based Lambda deployments
</div>

BudSense services deploy with the Serverless Framework and serve traffic from a Lambda alias per stage (`dev`, `staging`, `prod`, plus `rc` on the prod stack) rather than from `$LATEST`. This repository holds the deploy-time plugin that makes that work: one npm package, installed from GitHub at a tagged release, that every service lists under `plugins:`.

The package began as a fork of [serverless-aws-alias-v4](https://github.com/Castlenine/serverless-aws-alias-v4) by Alexandre Castlenine (MIT). BudSense now maintains it as its own library; it no longer tracks upstream.

## What the plugin does

After CloudFormation has deployed the stack, the plugin runs these steps in order. Each has its own section below.

1. **Lambda aliases.** Publishes a new version of each function that changed and points the stage alias at it.
2. **Async invoke settings.** Mirrors `maximumRetryAttempts` and `maximumEventAge` onto the alias, since Serverless only sets them on `$LATEST`.
3. **API Gateway routing.** Rewrites each REST and WebSocket integration to invoke `function:${stageVariables.alias}`, grants the invoke permissions, and deploys the stage. A non-default alias (`--param alias=rc`) gets its own stage on the same API.

Every step reads its configuration from `custom.alias` in `serverless.yml`. The alias and API Gateway steps live in `src/index.js`; each later step is its own file under `src/` and only hooks into the deploy flow there.

## Installation

Install the package from GitHub at a tagged release and list it under `plugins:`:

```bash
npm install --save-dev github:mobilefirstdev/budsense-serverless-plugins#v1.0.0
```

```yaml
plugins:
  - budsense-serverless-plugins
```

It needs Serverless Framework 4 and Node 18 or later, and has no runtime dependencies of its own.

## Configuration

Everything lives under `custom.alias`. The shortest form names the alias:

```yaml
custom:
  alias: dev
```

When `custom.alias` is not set, the alias is the stage from the provider section:

```yaml
provider:
  stage: dev
```

BudSense services take the alias from the deploy command, so `sls deploy --stage prod` uses `prod` and `sls deploy --stage prod --param alias=rc` uses `rc`:

```yaml
custom:
  alias:
    name: ${param:alias, sls:stage}
```

### Complete configuration example

Every option, with its default where it has one:

```yaml
custom:
  alias:
    name: ${opt:stage, 'dev'}       # Alias name (defaults to stage)
    excludedFunctions:              # Functions to exclude from alias management
      - warmUpPluginDefault
      - some-other-function
    skipApiGateway: false           # Skip HTTP API Gateway deployment (default: false)
    skipWebSocketGateway: false     # Skip WebSocket API Gateway deployment (default: false)
    verbose: true                   # Enable detailed logging (default: false)
```

## Lambda aliases and API Gateway routing

On every deploy the plugin publishes a new version of each function whose code or environment changed and points the stage alias at it; a function with no changes keeps its alias where it is. It then rewrites each API Gateway integration to invoke `function:${stageVariables.alias}`, so the stage variable, not the integration, decides which alias serves a request.

### API Gateway configuration

Both HTTP (REST API) and WebSocket event types are supported:

#### HTTP API Gateway

```yaml
functions:
  hello:
    handler: handler.hello
    events:
      - http:
          path: hello
          method: GET
```

For HTTP APIs, you can specify a REST API ID in your provider configuration:

```yaml
provider:
  apiGateway:
    restApiId: abcdef123456
```

#### WebSocket API Gateway

```yaml
functions:
  connect:
    handler: handler.connect
    events:
      - websocket: $connect

  disconnect:
    handler: handler.disconnect
    events:
      - websocket: $disconnect

  default:
    handler: handler.default
    events:
      - websocket: $default

  # Custom route
  message:
    handler: handler.message
    events:
      - websocket:
          route: sendMessage
```

For WebSocket APIs, you can specify a WebSocket API ID in your provider configuration:

```yaml
provider:
  websocketApiId: wxyz987654
```

You can mix both HTTP and WebSocket events in the same service, and the plugin will handle both types correctly.

### Multi-alias routing on a single API

Out of the box, deploying with the framework stage as the alias name produces a single API Gateway stage routing to the matching Lambda alias (the `${stageVariables.alias}` reference in the Lambda integration URI selects the alias at runtime).

Pass a different alias name via Serverless Framework's standard alias parameter to deploy a **parallel routing surface** for that alias on the **same** REST and WebSocket APIs as the framework stage:

```bash
# Default deploy: creates / updates the `prod` API Gateway stage and
# the `prod` Lambda alias; /prod/* routes to the :prod Lambda alias.
sls deploy --stage prod

# Multi-alias deploy: creates / updates an `rc` API Gateway stage and
# the `rc` Lambda alias on the same APIs; /rc/* routes to the :rc alias.
# The `prod` stage's API definition is refreshed to match the latest deploy
# but its alias routing (-> :prod) is preserved.
sls deploy --stage prod --param alias=rc
```

This is the canonical pattern for in-stack blue/green: a single CloudFormation stack and a single API Gateway with multiple stages, each routing to a different Lambda alias version. After both deploys above:

- `https://<api-id>.execute-api.<region>.amazonaws.com/prod/...` invokes the `:prod` Lambda alias
- `https://<api-id>.execute-api.<region>.amazonaws.com/rc/...` invokes the `:rc` Lambda alias

Each managed stage receives stage variables `alias` and `SERVERLESS_ALIAS`, both set to that stage's name. The plugin templates each Lambda integration URI with `:${stageVariables.alias}`, so AWS substitutes the variable at request time and routes the invocation to the correct Lambda alias. Writing `SERVERLESS_ALIAS` is kept for backwards compatibility with v3-style integrations.

The plugin only creates/updates the alias being deployed; on multi-alias deploys it also refreshes the framework stage's deployment so both stages stay in sync on API definition. It never deletes existing stages.

#### Cleanup behavior (important)

This plugin is intentionally **non-destructive** for alias lifecycle:

- It creates/updates API Gateway stages and Lambda aliases as needed.
- It does **not** automatically delete stale API Gateway stages.
- It does **not** automatically delete stale Lambda aliases.

If an alias is no longer needed (for example `rc` after testing), clean it up explicitly via AWS CLI or console.

Example cleanup commands:

```bash
# REST API stage
aws apigateway delete-stage --rest-api-id <rest-api-id> --stage-name <alias> --region <region>

# WebSocket API stage
aws apigatewayv2 delete-stage --api-id <websocket-api-id> --stage-name <alias> --region <region>

# Lambda alias (repeat per function)
aws lambda delete-alias --function-name <lambda-function-name> --name <alias> --region <region>
```

#### CloudFormation stack output discovery

If you do not pre-set `provider.apiGateway.restApiId` or `provider.websocketApiId`, the plugin discovers them at deploy time from the standard Serverless Framework outputs `ServiceEndpoint` and `ServiceEndpointWebsocket`. No additional configuration is required for services whose REST and WebSocket APIs are created by the same CloudFormation stack.

### Excluding functions

To exclude specific functions from alias management:

```yaml
custom:
  alias:
    name: dev
    excludedFunctions:
      - some-function
# or (will fallback to provider stage)
  alias:
    excludedFunctions:
      - some-function
```

If you're using the `serverless-plugin-warmup` plugin alongside this plugin and don't want to create an alias for the warmup function, make sure to add it to your excluded functions configuration:

```yaml
custom:
  alias:
    name: dev
    excludedFunctions:
      - warmUpPluginDefault
# or (will fallback to provider stage)
  alias:
    excludedFunctions:
      - warmUpPluginDefault
```

### Skipping API Gateway deployments

By default, the plugin automatically deploys both HTTP API Gateway and WebSocket API Gateway after updating integrations. You can control this behavior using configuration options to skip deployments when needed.

#### Skip HTTP API Gateway Deployment

To skip HTTP API Gateway deployment and only update integrations:

```yaml
custom:
  alias:
    name: dev
    skipApiGateway: true
```

#### Skip WebSocket API Gateway Deployment

To skip WebSocket API Gateway deployment and only update integrations:

```yaml
custom:
  alias:
    name: dev
    skipWebSocketGateway: true
```

#### Skip Both API Gateways

You can skip both types of deployments:

```yaml
custom:
  alias:
    name: dev
    skipApiGateway: true
    skipWebSocketGateway: true
```

#### Use Cases for Skipping Deployments

Skipping API Gateway deployments can be useful in scenarios such as:

- **Development workflows**: When you want to update function aliases without triggering API Gateway deployments
- **Blue-Green deployments**: When Blue-Green API Gateway deployments are handled separately in your CI/CD pipeline
- **Testing environments**: When you need to update function integrations without affecting live API endpoints

Additionally, you can use CLI flags to override these skip settings during deployment:

- `--skip-api-gateway`: Skip HTTP API Gateway deployment (overrides config)
- `--skip-websocket-gateway`: Skip WebSocket API Gateway deployment (overrides config)

These flags take precedence over the configuration in serverless.yml and set the corresponding skip option to true when present.

## Async invoke settings on the alias

Serverless compiles a function's `maximumRetryAttempts` and `maximumEventAge` into an `EventInvokeConfig` on `$LATEST` only. An alias carries its own `EventInvokeConfig`, so anything invoking the alias asynchronously otherwise runs on Lambda's defaults (2 retries, 6 hour event age) no matter what `serverless.yml` says.

After the aliases are created or updated, the plugin mirrors those two settings onto the alias for every function that declares either of them, on every deploy. The `$LATEST` config is left untouched, functions that declare neither setting are not modified, and `destinations` are not mirrored.

To opt out:

```yaml
custom:
  alias:
    name: dev
    skipEventInvokeConfig: true
```

or pass `--skip-event-invoke-config` on the command line.

## Plugin Compatibility and Limitations

Alongside other Serverless plugins:

- **Incompatible Plugin**: This plugin is **not compatible** with the [serverless-iam-roles-per-function](https://www.serverless.com/plugins/serverless-iam-roles-per-function) plugin.
- **Alternative Recommendation**: If you need custom IAM roles, we recommend using [serverless-iam-roles-per-function-v4](https://github.com/Castlenine/serverless-iam-roles-per-function-v4), which works seamlessly with this plugin.

## Debugging

By default, only error messages are displayed. To view detailed logs, use one of these methods:

- Set the environment variable `SLS_DEBUG=*`
- Use the `--verbose` or `-v` flag when deploying: `sls deploy --verbose`
- Enable verbose logging in your custom configuration:

```yaml
custom:
  alias:
    name: dev
    verbose: true
# or (will fallback to provider stage)
  alias:
    verbose: true
```

## License

MIT. See [LICENSE.md](./LICENSE.md); the original work is copyright Alexandre Castlenine and BudSense's changes are copyright BudSense.

## Development and releases

This is an internal BudSense library. Open a pull request against `master` and keep `CHANGELOG.md` current in the same pull request.

A release is a `vX.Y.Z` tag on `master`. Services pin that tag in `package.json` (`github:mobilefirstdev/budsense-serverless-plugins#vX.Y.Z`) and pick up a release by bumping it.
