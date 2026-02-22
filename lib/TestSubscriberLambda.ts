import { Duration } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { IContext } from '../context/IContext';

export type TestSubscriberLambdaProps = {
  context: IContext;
  bucket: Bucket;
};

export const getTestFunctionName = (context: IContext): string => {
  const { STACK_ID, TAGS: { Landscape } } = context;
  return `${STACK_ID}-test-subscriber-${Landscape}`;
}

export const isTestFunctionArn = (arn: string, context: IContext): boolean => {
  return arn.endsWith(':function:' + getTestFunctionName(context));
}

/**
 * Test subscriber Lambda function for testing the event processor
 * 
 * Responsibilities:
 * - Log the event payload received from the event processor
 * - Load the S3 object and count items in rawData
 */
export class TestSubscriberLambda extends Construct {
  public readonly lambda: NodejsFunction;

  constructor(scope: Construct, id: string, props: TestSubscriberLambdaProps) {
    super(scope, id);

    const { context, bucket } = props;
    const { STACK_ID, TAGS: { Landscape }, LAMBDA } = context;

    // Create test subscriber Lambda function
    this.lambda = new NodejsFunction(this, 'lambda-function', {
      functionName: getTestFunctionName(context),
      runtime: Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: 'src/test-subscriber-lambda/index.ts',
      timeout: Duration.seconds(LAMBDA.subscriberForTesting?.timeoutSeconds || 30),
      memorySize: LAMBDA.subscriberForTesting?.memorySizeMb || 2048,
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
