import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * The ONE way to wire a Lambda behind a method on the shared RestApi.
 *
 * Every Lambda-backed method costs CloudFormation resources in
 * `JaleApiStack` — the Method itself, the OPTIONS preflight that
 * `defaultCorsPreflightOptions` adds for a new Resource, and, by CDK's
 * default, TWO `AWS::Lambda::Permission` resources instead of one:
 *
 *   - `ApiPermission.<api>.<METHOD>..<path>`      — the real invoke grant,
 *     scoped to the deployed stage. This is the one that serves traffic.
 *   - `ApiPermission.Test.<api>.<METHOD>..<path>` — a second grant scoped to
 *     `.../test-invoke-stage/...`, which exists ONLY so the "Test" button in
 *     the API Gateway console can invoke the method from the browser.
 *
 * At ~70 Lambda-backed methods the console-only half is ~70 resources —
 * against CloudFormation's hard maximum of 500 per stack, which ApiStack
 * had already crossed (501, `TooManyResourcesInStack`, a synth failure that
 * blocks the deploy outright). So `allowTestInvoke: false` is the default
 * here and there is no reason to override it.
 *
 * WHAT THIS COSTS: nothing at runtime. Deployed URLs, auth, throttles,
 * payloads and behaviour are all identical — the ONLY casualty is the API
 * Gateway console's "Test" feature for these methods (invoking a route from
 * the AWS console UI returns a permissions error). Test routes against the
 * deployed stage with curl instead.
 *
 * Use this instead of `new apigateway.LambdaIntegration(...)` everywhere a
 * method lands on ApiStack's RestApi, so the next route added cannot forget
 * the flag and quietly re-cross the ceiling. `infra/test/unit/stacks/
 * api-stack-resource-ceiling.test.ts` fails the build if one does.
 */
export function lambdaIntegration(
  handler: lambda.IFunction,
  options?: Omit<apigateway.LambdaIntegrationOptions, 'allowTestInvoke'>,
): apigateway.LambdaIntegration {
  return new apigateway.LambdaIntegration(handler, {
    ...options,
    // Deliberately last: not overridable by callers. See the note above.
    allowTestInvoke: false,
  });
}
