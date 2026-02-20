import { Duration } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { IContext } from '../context/IContext';

export type TestTargetLambdaProps = {
  context: IContext;
  bucket: Bucket;
};

export const getTestFunctionName = (context: IContext): string => {
  const { STACK_ID, TAGS: { Landscape } } = context;
  return `${STACK_ID}-test-target-${Landscape}`;
}

export const isTestFunctionArn = (arn: string, context: IContext): boolean => {
  return arn.endsWith(':function:' + getTestFunctionName(context));
}

/**
 * Test target Lambda function for testing the event processor
 * 
 * Responsibilities:
 * - Log the event payload received from the event processor
 * - Load the S3 object and count items in rawData
 */
export class TestTargetLambda extends Construct {
  public readonly lambda: NodejsFunction;

  constructor(scope: Construct, id: string, props: TestTargetLambdaProps) {
    super(scope, id);

    const { context, bucket } = props;
    const { STACK_ID, TAGS: { Landscape }, LAMBDA } = context;

    // Create test target Lambda function
    this.lambda = new NodejsFunction(this, 'lambda-function', {
      functionName: getTestFunctionName(context),
      runtime: Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: 'src/test-target-lambda/index.ts',
      timeout: Duration.seconds(LAMBDA?.timeoutSeconds || 300),
      memorySize: LAMBDA?.memorySizeMb || 512,
      logRetention: RetentionDays.ONE_MONTH,
      bundling: {
        externalModules: [
          '@aws-sdk/*',
        ]
      }
    });

    // Grant Lambda permissions to read objects from bucket
    bucket.grantRead(this.lambda);
  }
}
