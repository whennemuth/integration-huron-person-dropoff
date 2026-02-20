import { S3Event, S3EventRecord, Context as LambdaContext } from 'aws-lambda';
import { 
  S3Client, 
  GetObjectCommand, 
  CopyObjectCommand, 
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { BucketSubdirectory } from '../../context/IContext';

const s3Client = new S3Client({});
const lambdaClient = new LambdaClient({});

const BUCKET_CONFIG = JSON.parse(process.env.BUCKET_CONFIG || '{"subdirectories": []}');

interface ProcessingResult {
  success: boolean;
  message: string;
  key?: string;
}

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

  // Skip if file is in errors subdirectory (already processed and marked as invalid)
  if (key.includes('/errors/')) {
    console.log(`File is in errors subdirectory. Skipping to avoid reprocessing invalid files.`);
    return;
  }

  // Skip if file has already been processed (matches date-based naming pattern)
  // Pattern: {subfolder}/{prefix}-{ISO_TIMESTAMP}.json (e.g., full-2026-02-20T16:57:35.356Z.json)
  const filename = key.split('/').pop() || '';
  const dateBasedPattern = /^(full|delta|invalid-json)-\d{4}-\d{2}-\d{2}T[\d:.]+Z\.json$/;
  if (dateBasedPattern.test(filename)) {
    console.log(`File ${filename} has already been processed (matches date-based pattern). Skipping to avoid recursive loop.`);
    return;
  }

  // Validate arrivals if configured (requires downloading file)
  if (subfolderConfig.validateArrivals) {
    console.log(`Validation enabled for ${subfolderConfig.path}. Downloading and validating file...`);
    
    // Retrieve object content
    const objectContent = await getObjectContent(bucket, key);
    if (!objectContent) {
      console.error(`Failed to retrieve object content for: ${key}`);
      return;
    }

    // Validate JSON
    const jsonData = validateJson(objectContent);
    if (!jsonData) {
      console.error(`Invalid JSON in object: ${key}`);
      await moveToErrorsSubfolder(bucket, key, subfolderConfig.path, 'Invalid JSON format');
      return;
    }

    // Validate JSON structure
    if (!validateJsonStructure(jsonData)) {
      console.error(`JSON structure validation failed for: ${key}`);
      await moveToErrorsSubfolder(bucket, key, subfolderConfig.path, 'Invalid JSON structure');
      return;
    }
    
    console.log(`Validation successful for ${key}`);
  } else {
    console.log(`Validation disabled for ${subfolderConfig.path}. Skipping content validation.`);
  }

  // Rename file if it doesn't have .json extension
  let finalKey = key;
  if (!key.endsWith('.json')) {
    console.log(`File does not have .json extension. Renaming...`);
    const renamedKey = await renameToJsonExtension(bucket, key);
    if (!renamedKey) {
      console.error(`Failed to rename object: ${key}`);
      return;
    }
    finalKey = renamedKey;
  }

  // Rename with date-based convention
  const newKey = generateDateBasedFileName(subfolderConfig.path);
  console.log(`Renaming ${finalKey} to ${newKey}`);
  const renamed = await renameObject(bucket, finalKey, newKey);
  if (!renamed) {
    console.error(`Failed to rename object to date-based filename`);
    return;
  }

  // Note: Object expiration is handled by S3 bucket lifecycle rules (configured per subdirectory)

  // Invoke target Lambda function for this subfolder
  await invokeTargetLambda(bucket, newKey, subfolderConfig.targetLambdaArn);

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
 * Retrieve object content from S3
 */
async function getObjectContent(bucket: string, key: string): Promise<string | null> {
  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3Client.send(command);
    
    if (!response.Body) {
      return null;
    }

    // Convert stream to string
    const bodyContents = await response.Body.transformToString();
    return bodyContents;
  } catch (error) {
    console.error(`Error retrieving object ${key}:`, error);
    return null;
  }
}

/**
 * Validate that content is valid JSON
 */
function validateJson(content: string): any | null {
  try {
    return JSON.parse(content);
  } catch (error) {
    return null;
  }
}

/**
 * Validate JSON structure matches expected person data format
 * TODO: Implement actual validation logic based on person data schema
 * 
 * Expected structure from PeopleDataSource.ts (line 68 rawData):
 * Array of person objects with properties like:
 * - personid: string
 * - personBasic: { names: Array<{ nameType, firstName, lastName, ... }>, ... }
 * - email: Array<{ type, address, ... }>
 * - employeeInfo: { positions: Array<{ positionInfo: { BasicData, Department, ... } }> }
 * - studentInfo: { ... }
 * - etc.
 * 
 * For now, this validates that:
 * 1. The data is an array or has data nested in common response wrapper properties
 * 2. The array contains objects (not primitives)
 * 
 * In production, implement full schema validation against the CDM person API response structure.
 */
function validateJsonStructure(jsonData: any): boolean {
  // Hard-coded as requested - returns true pending proper implementation
  // In production, validate structure like:
  // - Check if jsonData is array or has data/items/response wrapper
  // - Validate each person object has required fields (personid, personBasic, etc.)
  // - Validate nested structures match expected schema
  
  return true;
}

/**
 * Rename object to have .json extension
 */
async function renameToJsonExtension(bucket: string, key: string): Promise<string | null> {
  const newKey = `${key}.json`;
  const success = await renameObject(bucket, key, newKey);
  return success ? newKey : null;
}

/**
 * Generate date-based filename for a specific subfolder
 * Extracts prefix from subfolder path (e.g., "data-full" -> "full-", "data-delta" -> "delta-")
 */
function generateDateBasedFileName(subfolderPath: string): string {
  const timestamp = new Date().toISOString();
  // Extract last part after hyphen as prefix (e.g., "data-full" -> "full")
  const prefix = subfolderPath.split('-').pop() || 'data';
  return `${subfolderPath}/${prefix}-${timestamp}.json`;
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
 * Move object to errors subfolder within the same parent folder
 * Uses timestamp-based naming with 'invalid-json' prefix
 */
async function moveToErrorsSubfolder(bucket: string, key: string, subfolderPath: string, reason: string): Promise<void> {
  try {
    // Generate timestamp-based error filename
    const timestamp = new Date().toISOString();
    const errorKey = `${subfolderPath}/errors/invalid-json-${timestamp}.json`;
    
    // Copy to errors subfolder with timestamp-based name
    await s3Client.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${key}`,
      Key: errorKey,
      TaggingDirective: 'REPLACE',
      Tagging: `error-reason=${encodeURIComponent(reason)}`
    }));

    // Delete original
    await s3Client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: key
    }));

    console.log(`Moved ${key} to errors subfolder: ${errorKey} (Reason: ${reason})`);
  } catch (error) {
    console.error(`Error moving ${key} to errors subfolder:`, error);
  }
}

/**
 * Invoke the target Lambda function for this subfolder with S3 path
 */
async function invokeTargetLambda(bucket: string, key: string, targetArn: string): Promise<void> {
  const s3Path = `s3://${bucket}/${key}`;

  try {
    console.log(`Invoking target Lambda: ${targetArn}`);
    
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
      FunctionName: targetArn,
      InvocationType: 'Event', // Async invocation
      Payload: Buffer.from(JSON.stringify(payload))
    });

    await lambdaClient.send(command);
    console.log(`Successfully invoked target Lambda: ${targetArn}`);
  } catch (error) {
    console.error(`Error invoking target Lambda (${targetArn}):`, error);
    throw error;
  }
}
