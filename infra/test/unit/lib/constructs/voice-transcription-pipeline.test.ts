import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { VoiceTranscriptionPipeline } from '../../../../lib/constructs/voice-transcription-pipeline';

/**
 * Builds an isolated stack with the minimal fakes VoiceTranscriptionPipeline
 * needs (vpc, security group, media bucket, completion Lambda) so these
 * tests synth the construct on its own rather than through the full
 * WhatsAppStack.
 */
function synthPipeline(esVocabularyName?: string): { template: Template; stateMachineCount: number } {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0 });
  const lambdaSg = new ec2.SecurityGroup(stack, 'LambdaSg', { vpc });
  const mediaBucket = new s3.Bucket(stack, 'MediaBucket');
  const completionHandler = new lambda.Function(stack, 'CompletionHandler', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {};'),
  });

  new VoiceTranscriptionPipeline(stack, 'Pipeline', {
    vpc,
    lambdaSg,
    mediaBucket,
    completionHandler,
    ...(esVocabularyName !== undefined ? { esVocabularyName } : {}),
  });

  const template = Template.fromStack(stack);
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  return { template, stateMachineCount: Object.keys(machines).length };
}

/** Concatenate the DefinitionString's Fn::Join parts into a single string
 * so literal ASL parameter values (baked in at synth-time, not JsonPath
 * references) can be substring-matched. */
function definitionText(template: Template): string {
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const [machine] = Object.values(machines) as any[];
  return JSON.stringify(machine.Properties.DefinitionString);
}

describe('VoiceTranscriptionPipeline construct', () => {
  test('synths exactly one Standard state machine', () => {
    const { stateMachineCount } = synthPipeline('jale-es-us-trades');
    expect(stateMachineCount).toBe(1);
  });

  test('StartTranscribeJob uses IdentifyMultipleLanguages with es-US/en-US LanguageOptions', () => {
    const { template } = synthPipeline('jale-es-us-trades');
    const text = definitionText(template);
    // Pin the boolean literal, not just the key name — a regression that
    // stringifies it as `"true"` (string) instead of `true` would otherwise
    // still pass a bare substring-contains check.
    // definitionText() runs JSON.stringify twice-over on the ASL fragment
    // (once when Transcribe/CDK encode the state machine document as a
    // JSON string, once when this helper stringifies the whole
    // DefinitionString object) — the real string therefore contains a
    // literal backslash before each quote around the key, not a bare `"`.
    expect(text).toContain('\\"IdentifyMultipleLanguages\\":true');
    expect(text).toContain('LanguageOptions');
    expect(text).toContain('es-US');
    expect(text).toContain('en-US');
  });

  test('LanguageIdSettings carries the es-US vocabulary name when esVocabularyName is set', () => {
    const { template } = synthPipeline('jale-es-us-trades');
    const text = definitionText(template);
    expect(text).toContain('LanguageIdSettings');
    expect(text).toContain('jale-es-us-trades');
  });

  test('never emits a LanguageCode parameter (replaced by language identification)', () => {
    const { template } = synthPipeline('jale-es-us-trades');
    const text = definitionText(template);
    expect(text).not.toContain('LanguageCode');
  });

  test('omits LanguageIdSettings entirely when esVocabularyName is not set', () => {
    const { template } = synthPipeline(undefined);
    const text = definitionText(template);
    expect(text).not.toContain('LanguageIdSettings');
    // The rest of the multi-language config must still be present — an
    // unset vocabulary name must not disable language identification.
    // definitionText() runs JSON.stringify twice-over on the ASL fragment
    // (once when Transcribe/CDK encode the state machine document as a
    // JSON string, once when this helper stringifies the whole
    // DefinitionString object) — the real string therefore contains a
    // literal backslash before each quote around the key, not a bare `"`.
    expect(text).toContain('\\"IdentifyMultipleLanguages\\":true');
    expect(text).toContain('LanguageOptions');
  });
});
