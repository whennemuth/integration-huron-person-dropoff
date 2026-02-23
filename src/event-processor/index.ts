import { S3Event, Context as LambdaContext } from 'aws-lambda';
import { BucketConfig } from '../../context/IContext';
import { Bucket } from './Bucket';
import { S3EventProcessor } from './S3EventProcessor';

const BUCKET_CONFIG: BucketConfig = JSON.parse(process.env.BUCKET_CONFIG || '{"subdirectories": []}');

/**
 * Lambda handler for processing S3 events
 */
export async function handler(event: S3Event, context: LambdaContext): Promise<void> {
  console.log('Received S3 event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      // Validate that the bucket name from the S3 event matches the configuration
      const eventBucketName = record.s3.bucket.name;
      const configBucketName = BUCKET_CONFIG.name;
      
      if (eventBucketName !== configBucketName) {
        throw new Error(
          `Bucket name mismatch: S3 event reports bucket "${eventBucketName}" ` +
          `but Lambda configuration expects "${configBucketName}". ` +
          `This indicates a deployment issue where the Lambda's BUCKET_CONFIG environment variable ` +
          `does not match the actual S3 bucket triggering the event.`
        );
      }
      
      const bucket = new Bucket(BUCKET_CONFIG);
      const processor = new S3EventProcessor(record, bucket);
      const result = await processor.process();
      
      console.log('Processing result:', JSON.stringify(result, null, 2));
    } catch (error) {
      console.error('Error processing record:', error);
      // Continue processing other records even if one fails
    }
  }
}
