import { Duration } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { S3EventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket, EventType } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { IContext } from '../context/IContext';
import { getBucketName } from './FileDropBucket';

export type EventProcessorLambdaProps = {
  context: IContext;
  bucket: Bucket;
};

/**
 * Lambda function that processes S3 events for incoming data files.
 * 
 * Responsibilities:
 * - Validate JSON structure
 * - Rename files with date-based convention
 * - Set object expiration
 * - Move invalid files to error subdirectory
 * - Invoke subscriber Lambda function(s) for processing
 */
export class EventProcessorLambda extends Construct {
  public readonly lambda: NodejsFunction;

  constructor(scope: Construct, id: string, props: EventProcessorLambdaProps) {
    super(scope, id);

    const { context, bucket } = props;
    const { STACK_ID, TAGS: { Landscape }, LAMBDA, BUCKET } = context;

    // Collect all subscriber Lambda ARNs for IAM permissions
    const subscriberLambdaArns = BUCKET.subdirectories.map(sub => sub.subscriberLambdaArn);

    // Create runtime config for Lambda (exclude CDK-only fields like subscriberLambdaExecutionRoleArn)
    const runtimeBucketConfig = {
      name: getBucketName(context),
      subdirectories: BUCKET.subdirectories.map(sub => ({
        path: sub.path,
        objectLifetimeDays: sub.objectLifetimeDays,
        subscriberLambdaArn: sub.subscriberLambdaArn
      }))
    };

    // Create Lambda function
    this.lambda = new NodejsFunction(this, 'lambda-function', {
      functionName: `${STACK_ID}-event-processor-${Landscape}`,
      runtime: Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: 'src/event-processor/index.ts',
      timeout: Duration.seconds(LAMBDA.eventProcessor?.timeoutSeconds || 300),
      memorySize: LAMBDA.eventProcessor?.memorySizeMb || 512,
      logRetention: RetentionDays.ONE_MONTH,
      environment: {
        BUCKET_CONFIG: JSON.stringify(runtimeBucketConfig)
      },
      bundling: {
        externalModules: [
          '@aws-sdk/*',
        ]
      }
    });

    // Grant Lambda permissions to read/write/delete objects in bucket
    bucket.grantReadWrite(this.lambda);
    bucket.grantDelete(this.lambda);
    bucket.grantPutAcl(this.lambda);

    // Grant Lambda permission to invoke subscriber Lambda(s)
    subscriberLambdaArns.forEach(arn => {
      this.lambda.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [arn]
        })
      );
    });

    // Add S3 event source
    // OBJECT_CREATED is a wildcard covering all s3:ObjectCreated:* events
    this.lambda.addEventSource(
      new S3EventSource(bucket, {
        events: [EventType.OBJECT_CREATED]
      })
    );
  }
}
