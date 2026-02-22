import { S3Event, S3EventRecord, Context as LambdaContext } from 'aws-lambda';
import { 
  S3Client, 
  CopyObjectCommand, 
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { BucketSubdirectory } from '../../context/IContext';

const s3Client = new S3Client({});
const lambdaClient = new LambdaClient({});

const BUCKET_CONFIG = JSON.parse(process.env.BUCKET_CONFIG || '{"subdirectories": []}');

/**
 * Lambda handler for processing S3 events
 */
export async function handler(event: S3Event, context: LambdaContext): Promise<void> {
  console.log('Received S3 event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error('Error processing record:', error);
      // Continue processing other records even if one fails
    }
  }
}

/**
 * Process a single S3 event record
 */
async function processRecord(record: S3EventRecord): Promise<void> {
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

  console.log(`Processing object: s3://${bucket}/${key}`);

  // Find matching subdirectory configuration
  const subfolderConfig = findSubfolderConfig(key);
  if (!subfolderConfig) {
    console.log(`Object not in any configured subfolder. Logging and exiting.`);
    return;
  }

  console.log(`Matched subfolder: ${subfolderConfig.path}`);

  // Skip if file has already been processed (matches timestamp prefix pattern)
  // Pattern: {ISO_TIMESTAMP}-{original_filename} (e.g., 2026-02-20T16:57:35.356Z-data.json)
  const filename = key.split('/').pop() || '';
  const dateBasedPattern = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z-/;
  if (dateBasedPattern.test(filename)) {
    console.log(`File ${filename} has already been processed (matches timestamp prefix pattern). Skipping to avoid recursive loop.`);
    return;
  }

  // Rename with timestamp prefix to preserve original filename completely
  const newKey = generateDateBasedFileName(subfolderConfig.path, filename);
  console.log(`Renaming ${key} to ${newKey}`);
  const renamed = await renameObject(bucket, key, newKey);
  if (!renamed) {
    console.error(`Failed to rename object to date-based filename`);
    return;
  }

  // Note: Object expiration is handled by S3 bucket lifecycle rules (configured per subdirectory)

  // Invoke subscriber Lambda function for this subfolder
  await invokeSubscriberLambda(bucket, newKey, subfolderConfig.subscriberLambdaArn);

  console.log(`Successfully processed: ${newKey}`);
}

/**
 * Find the matching subdirectory configuration for a given key
 */
function findSubfolderConfig(key: string): BucketSubdirectory | null {
  const subdirectories = BUCKET_CONFIG.subdirectories as BucketSubdirectory[];
  
  for (const subdir of subdirectories) {
    if (key.startsWith(`${subdir.path}/`)) {
      return subdir;
    }
  }
  
  return null;
}

/**
 * Generate timestamp-prefixed filename for a specific subfolder
 * Preserves the original filename completely by prefixing with ISO timestamp
 * Example: "data.json" becomes "2026-02-20T16:57:35.356Z-data.json"
 */
function generateDateBasedFileName(subfolderPath: string, originalFilename: string): string {
  const timestamp = new Date().toISOString();
  return `${subfolderPath}/${timestamp}-${originalFilename}`;
}

/**
 * Rename S3 object by copying and deleting original
 */
async function renameObject(bucket: string, oldKey: string, newKey: string): Promise<boolean> {
  try {
    // Copy to new key
    await s3Client.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${oldKey}`,
      Key: newKey
    }));

    // Delete old key
    await s3Client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: oldKey
    }));

    console.log(`Successfully renamed ${oldKey} to ${newKey}`);
    return true;
  } catch (error) {
    console.error(`Error renaming object from ${oldKey} to ${newKey}:`, error);
    return false;
  }
}

/**
 * Invoke the subscriber Lambda function for this subfolder with S3 path
 */
async function invokeSubscriberLambda(bucket: string, key: string, subscriberArn: string): Promise<void> {
  const s3Path = `s3://${bucket}/${key}`;

  try {
    console.log(`Invoking subscriber Lambda: ${subscriberArn}`);
    
    const payload = {
      s3Path,
      bucket,
      key,
      processingMetadata: {
        processedAt: new Date().toISOString(),
        processorVersion: '1.0.0'
      }
    };

    const command = new InvokeCommand({
      FunctionName: subscriberArn,
      InvocationType: 'Event', // Async invocation
      Payload: Buffer.from(JSON.stringify(payload))
    });

    await lambdaClient.send(command);
    console.log(`Successfully invoked subscriber Lambda: ${subscriberArn}`);
  } catch (error) {
    console.error(`Error invoking subscriber Lambda (${subscriberArn}):`, error);
    throw error;
  }
}
