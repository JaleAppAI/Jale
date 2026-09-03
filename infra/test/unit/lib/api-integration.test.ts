import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { lambdaIntegration, addPathOnlyResource } from '../../../lib/api-integration';

/**
 * Unit-level behaviour of the two `lib/api-integration.ts` helpers, on a
 * throwaway RestApi shaped like ApiStack's: `defaultCorsPreflightOptions` set,
 * and `deploy: true` (the default) so the stack carries the AWS::ApiGateway::
 * Deployment whose DependsOn list is what `addPathOnlyResource()` must not
 * corrupt.
 *
 * The SYSTEM-level guarantees — that the real 17-stack composition never has a
 * real method without a preflight, nor a resource with only a preflight, nor a
 * dangling DependsOn — are asserted in
 * `test/unit/stacks/api-stack-resource-ceiling.test.ts` against the actual app.
 * This file pins the helpers' own contract, which that test cannot see.
 */
const CORS: apigateway.CorsOptions = {
  allowOrigins: ['https://example.com'],
  allowMethods: apigateway.Cors.ALL_METHODS,
  allowHeaders: ['Content-Type', 'Authorization'],
};

// `null`, not `undefined`: passing `undefined` explicitly would fall back to
// the default parameter value and silently give the harness CORS after all.
function harness(cors: apigateway.CorsOptions | null = CORS): {
  api: apigateway.RestApi;
  fn: lambda.Function;
  stack: cdk.Stack;
} {
  const stack = new cdk.Stack(new cdk.App(), 'TestStack');
  const api = new apigateway.RestApi(stack, 'Api', {
    ...(cors ? { defaultCorsPreflightOptions: cors } : {}),
  });
  const fn = new lambda.Function(stack, 'Fn', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({});'),
  });
  return { api, fn, stack };
}

/** `logicalId -> [http methods]`, plus `ROOT` for the RestApi's implicit root. */
function methodsByResource(template: Template): Map<string, string[]> {
  const byResource = new Map<string, string[]>();
  for (const method of Object.values(
    template.findResources('AWS::ApiGateway::Method'),
  ) as Array<{ Properties: Record<string, any> }>) {
    const resourceId = method.Properties?.ResourceId;
    const key: string = resourceId?.Ref ?? (resourceId?.['Fn::GetAtt'] ? 'ROOT' : '?');
    byResource.set(key, [...(byResource.get(key) ?? []), method.Properties.HttpMethod]);
  }
  return byResource;
}

function logicalIdOf(template: Template, pathPart: string): string {
  const match = Object.entries(template.findResources('AWS::ApiGateway::Resource')).find(
    ([, resource]) => (resource as any).Properties.PathPart === pathPart,
  );
  expect(match).toBeDefined();
  return match![0];
}

/** Every `DependsOn` target that is not itself emitted in the template. */
function danglingDependsOn(template: Template): string[] {
  const resources = template.toJSON().Resources as Record<string, { DependsOn?: string | string[] }>;
  const dangling: string[] = [];
  for (const [id, resource] of Object.entries(resources)) {
    for (const target of [resource.DependsOn ?? []].flat()) {
      if (!resources[target]) dangling.push(`${id} -> ${target}`);
    }
  }
  return dangling;
}

describe('lambdaIntegration', () => {
  it('never emits the console-only test-invoke-stage Lambda permission', () => {
    const { api, fn, stack } = harness();
    api.root.addResource('thing').addMethod('GET', lambdaIntegration(fn));

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::Permission', 1);
    expect(JSON.stringify(template.toJSON())).not.toContain('test-invoke-stage');
  });
});

describe('addPathOnlyResource', () => {
  it('builds the resource with no CORS preflight of its own', () => {
    const { api, stack } = harness();
    const parent = addPathOnlyResource(api.root, 'parent');

    const template = Template.fromStack(stack);
    const byResource = methodsByResource(template);
    expect(byResource.get(logicalIdOf(template, 'parent'))).toBeUndefined();
    expect(parent.node.children.filter((c) => c instanceof apigateway.Method)).toEqual([]);
  });

  it('leaves the Deployment with no DependsOn on a method that was never emitted', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. The first implementation built the
    // OPTIONS and then removed the construct with `node.tryRemoveChild()`,
    // which cannot retract the `latestDeployment.node.addDependency(cfnMethod)`
    // that `Method`'s constructor already registered. The template still
    // passed synth (CDK only warns) but CloudFormation rejects a DependsOn on
    // an absent logical id at changeset creation.
    const { api, fn, stack } = harness();
    const parent = addPathOnlyResource(api.root, 'parent');
    parent.addResource('child').addMethod('GET', lambdaIntegration(fn));

    const template = Template.fromStack(stack);
    // The Deployment must exist, or this assertion is vacuous.
    template.resourceCountIs('AWS::ApiGateway::Deployment', 1);
    expect(danglingDependsOn(template)).toEqual([]);
  });

  it('still gives the children of a path-only node their preflight', () => {
    const { api, fn, stack } = harness();
    const parent = addPathOnlyResource(api.root, 'parent');
    parent.addResource('child').addMethod('GET', lambdaIntegration(fn));

    const template = Template.fromStack(stack);
    const onChild = methodsByResource(template).get(logicalIdOf(template, 'child'))!.sort();
    expect(onChild).toEqual(['GET', 'OPTIONS']);
  });

  it('restores the parent default so later siblings keep their preflight', () => {
    const { api, fn, stack } = harness();
    addPathOnlyResource(api.root, 'parent');
    // Added AFTER the path-only call: if the temporary clear leaked, this
    // sibling would silently lose the preflight its browser calls need.
    api.root.addResource('sibling').addMethod('POST', lambdaIntegration(fn));

    const template = Template.fromStack(stack);
    const onSibling = methodsByResource(template).get(logicalIdOf(template, 'sibling'))!.sort();
    expect(onSibling).toEqual(['OPTIONS', 'POST']);
    expect(api.root.defaultCorsPreflightOptions).toEqual(CORS);
  });

  it('refuses to be decorative when the API sets no CORS default', () => {
    // Without a default there is no preflight to suppress, so every call site
    // would quietly become a slower `addResource()`.
    const { api } = harness(null);
    expect(api.root.defaultCorsPreflightOptions).toBeUndefined();
    expect(() => addPathOnlyResource(api.root, 'parent')).toThrow(
      /no defaultCorsPreflightOptions to suppress/,
    );
  });

  it('nests: a path-only child of a path-only parent, with the leaf still covered', () => {
    const { api, fn, stack } = harness();
    const outer = addPathOnlyResource(api.root, 'outer');
    const inner = addPathOnlyResource(outer, 'inner');
    inner.addResource('leaf').addMethod('DELETE', lambdaIntegration(fn));

    const template = Template.fromStack(stack);
    const byResource = methodsByResource(template);
    expect(byResource.get(logicalIdOf(template, 'outer'))).toBeUndefined();
    expect(byResource.get(logicalIdOf(template, 'inner'))).toBeUndefined();
    expect(byResource.get(logicalIdOf(template, 'leaf'))!.sort()).toEqual(['DELETE', 'OPTIONS']);
    expect(danglingDependsOn(template)).toEqual([]);
  });
});
