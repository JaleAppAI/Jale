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
 *
 * The other half of the same budget is `addPathOnlyResource()` below: use it
 * instead of `addResource()` for a node that only carries children, so its
 * unreachable OPTIONS preflight is never built and never billed.
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

/**
 * Creates a PATH-ONLY resource — an `addResource()` node that exists solely to
 * carry children and never gets a method of its own — WITHOUT the CORS
 * preflight the shared RestApi would otherwise give it.
 *
 * WHY IT EXISTS: `api-stack.ts` sets `defaultCorsPreflightOptions` on the
 * RestApi, and `Resource`'s constructor ends with
 * `this.defaultCorsPreflightOptions = props.defaultCorsPreflightOptions ||
 * props.parent.defaultCorsPreflightOptions` followed by
 * `this.defaultCorsPreflightOptions && this.addCorsPreflight(...)`. So EVERY
 * new node inherits the default and gets an OPTIONS MOCK method. For a real
 * route that is required. For an intermediate like `/employer`,
 * `/worker/documents` or `/employer/workers/{worker_id}` it is dead weight: a
 * browser preflights the URL of a request it is about to send, and no request
 * exists on a path with no method, so nothing can ever reach that OPTIONS.
 *
 * HOW: there is no "explicitly none" to pass — `||` makes an `undefined` in
 * `ResourceOptions` fall straight through to the parent's value. So the
 * parent's default is cleared for the duration of the `addResource()` call and
 * restored immediately after (synthesis is single-threaded), then set on the
 * CHILD so grandchildren still inherit it and real routes deeper down keep
 * their preflight.
 *
 * WHY NOT REMOVE IT AFTERWARDS: because that silently corrupts the template.
 * `Method`'s constructor registers itself with the RestApi's `latestDeployment`
 * (`deployment.node.addDependency(cfnMethod)` and `addToLogicalId(...)`), and
 * constructs expose no removeDependency. Deleting the OPTIONS from the tree
 * with `node.tryRemoveChild()` therefore left the Deployment holding a
 * `DependsOn` on 13 logical ids that were no longer emitted — invalid
 * CloudFormation (cfn-lint E3005, rejected at changeset creation), yet only a
 * WARNING from CDK because `@aws-cdk/core:validateAgainstDefaultRules` is
 * unset. `cdk synth` and the whole test suite passed; the deploy would not
 * have. Never constructing the method is the only correct fix, and it also
 * means the Deployment's logical-id hash never includes the OPTIONS at all
 * rather than being salted by a method that no longer exists.
 *
 * WHAT IT COSTS: nothing at runtime — no deployed URL, header, auth decision
 * or response differs. What it BUYS is one `AWS::ApiGateway::Method` of
 * JaleApiStack headroom per intermediate, against CloudFormation's hard
 * 500-resource maximum this stack has already hit once (501,
 * `TooManyResourcesInStack`, a synth failure that blocks the deploy). Thirteen
 * intermediates took it from 431 to 418.
 *
 * SAFETY: use this ONLY where the path carries no method of its own — each
 * call is a deliberate claim to that effect. It cannot verify the claim
 * itself: the node is empty at creation, and three of ApiStack's intermediates
 * (`publicResource`, `workerResource`, `employerResource`) are exported for
 * downstream stacks to attach to LATER. The guard is synth-wide, in
 * `test/unit/stacks/api-stack-resource-ceiling.test.ts`, which asserts against
 * the real 17-stack composition that every resource with a real method has an
 * OPTIONS, that no resource has ONLY an OPTIONS, and that no `DependsOn`
 * dangles. Adding a real method to one of these paths fails there; the fix is
 * to switch the call back to a plain `addResource()`, not to weaken the test.
 */
export function addPathOnlyResource(
  parent: apigateway.IResource,
  pathPart: string,
): apigateway.Resource {
  const inherited = parent.defaultCorsPreflightOptions;

  if (inherited === undefined) {
    throw new Error(
      `addPathOnlyResource(${parent.node.path}, '${pathPart}'): the parent has no `
      + 'defaultCorsPreflightOptions to suppress, so this call buys nothing and a '
      + 'plain addResource() would be clearer. Either the RestApi no longer sets '
      + '`defaultCorsPreflightOptions` (in which case every call here is decorative '
      + 'and they should all become addResource()) or this parent is not on that API.',
    );
  }

  // `defaultCorsPreflightOptions` is `readonly` on IResource; this is the one
  // place that writes it, for the duration of one constructor call.
  const mutableParent = parent as unknown as { defaultCorsPreflightOptions?: apigateway.CorsOptions };
  mutableParent.defaultCorsPreflightOptions = undefined;
  let child: apigateway.Resource;
  try {
    child = parent.addResource(pathPart);
  } finally {
    // Restored even if addResource throws: the parent is shared, and leaving it
    // cleared would silently strip the preflight off every LATER sibling.
    mutableParent.defaultCorsPreflightOptions = inherited;
  }

  // The child was built with no default, so it has no OPTIONS. Give it the
  // inherited value now so its own children — the real routes — still get one.
  (child as unknown as { defaultCorsPreflightOptions?: apigateway.CorsOptions })
    .defaultCorsPreflightOptions = inherited;

  return child;
}
