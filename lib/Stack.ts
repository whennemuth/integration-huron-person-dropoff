import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { IContext } from '../context/IContext';
import { FileDropBucket } from './FileDropBucket';
import { EventProcessorLambda } from './EventProcessorLambda';
import { BucketAccessKeys } from './AccessKeys';
import { TestSubscriberLambda, isTestFunctionArn } from './TestSubscriberLambda';

export type FileDropStackProps = {
  context: IContext;
  stackProps?: cdk.StackProps;
};

/**
 * CDK Stack for Data File Drop Infrastructure
 * 
 * Creates:
 * - S3 bucket for receiving async data files
 * - Lambda function to process S3 events and invoke subscriber lambdas
 * - IAM access keys for external systems (stored in Secrets Manager)
 * - Bucket policies for Lambda read access
 * - Optional test subscriber Lambda for testing (when LAMBDA.subscriberForTesting is configured)
 */
export class FileDropStack extends cdk.Stack {
  public readonly bucket: FileDropBucket;
  public readonly eventProcessor: EventProcessorLambda;
  public readonly accessKeys: BucketAccessKeys;
  public readonly testSubscriberLambda?: TestSubscriberLambda;

  constructor(scope: Construct, id: string, props: FileDropStackProps) {
    const { context, stackProps } = props;
    super(scope, id, stackProps);

    // Create the S3 bucket
    this.bucket = new FileDropBucket(this, 'file-drop-bucket', { context });

    // Create the event processor Lambda
    this.eventProcessor = new EventProcessorLambda(this, 'event-processor-lambda', {
      context,
      bucket: this.bucket.bucket
    });

    // Grant read access to all subscriber Lambda(s) referenced in subdirectories
    // Filter out test Lambda if present - it gets permissions via bucket.grantRead() in TestSubscriberLambda construct
    const externalSubdirectories = context.BUCKET.subdirectories.filter(
      sub => !isTestFunctionArn(sub.subscriberLambdaArn, context)
    );
    const subscriberLambdaRoleArns = externalSubdirectories.map(sub => sub.subscriberLambdaExecutionRoleArn);
    const uniqueLambdaRoleArns = [...new Set(subscriberLambdaRoleArns)]; // Remove duplicates
    uniqueLambdaRoleArns.forEach((roleArn, index) => {
      this.bucket.grantReadToLambda(roleArn, index + 1);
    });

    // Create IAM access keys for external system
    this.accessKeys = new BucketAccessKeys(this.bucket, 'access-keys', {
      context,
      bucket: this.bucket.bucket
    });

    // Optionally create test subscriber Lambda for testing
    if (context.LAMBDA.subscriberForTesting) {
      this.testSubscriberLambda = new TestSubscriberLambda(this, 'test-subscriber-lambda', {
        context,
        bucket: this.bucket.bucket
      });
    }

    // Stack outputs
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucket.bucketName,
      description: 'S3 bucket name for data file-drop',
      exportName: `${context.STACK_ID}-${context.TAGS.Landscape}-bucket-name`
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: this.bucket.bucket.bucketArn,
      description: 'S3 bucket ARN',
      exportName: `${context.STACK_ID}-${context.TAGS.Landscape}-bucket-arn`
    });

    new cdk.CfnOutput(this, 'AccessKeysSecretArn', {
      value: this.accessKeys.secretArn,
      description: 'Secrets Manager ARN containing S3 access keys',
      exportName: `${context.STACK_ID}-${context.TAGS.Landscape}-access-keys-secret-arn`
    });

    new cdk.CfnOutput(this, 'EventProcessorLambdaArn', {
      value: this.eventProcessor.lambda.functionArn,
      description: 'Event processor Lambda ARN',
      exportName: `${context.STACK_ID}-${context.TAGS.Landscape}-event-processor-arn`
    });

    if (this.testSubscriberLambda) {
      new cdk.CfnOutput(this, 'TestSubscriberLambdaArn', {
        value: this.testSubscriberLambda.lambda.functionArn,
        description: 'Test subscriber Lambda ARN (for testing event processor)',
        exportName: `${context.STACK_ID}-${context.TAGS.Landscape}-test-subscriber-arn`
      });

      new cdk.CfnOutput(this, 'TestSubscriberLambdaRoleArn', {
        value: this.testSubscriberLambda.lambda.role!.roleArn,
        description: 'Test subscriber Lambda execution role ARN (use as subscriberLambdaExecutionRoleArn)',
        exportName: `${context.STACK_ID}-${context.TAGS.Landscape}-test-subscriber-role-arn`
      });
    }
  }
}
