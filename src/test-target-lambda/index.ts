import { Context as LambdaContext } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({});

interface EventPayload {
  s3Path: string;
  bucket: string;
  key: string;
  processingMetadata?: {
    processedAt: string;
    processorVersion: string;
  };
}

/**
 * Test target Lambda handler
 * Used for testing the event processor Lambda
 * Logs the event payload and attempts to read the S3 object
 */
export async function handler(event: EventPayload, context: LambdaContext): Promise<void> {
  console.log('Test Target Lambda - Received event:', JSON.stringify(event, null, 2));

  const { s3Path, bucket, key } = event;

  if (!bucket || !key) {
    console.error('Missing bucket or key in event payload');
    return;
  }

  try {
    console.log(`Attempting to load S3 object: ${s3Path}`);

    // Retrieve the object from S3
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3Client.send(command);

    if (!response.Body) {
      console.error('S3 object has no body');
      return;
    }

    // Convert stream to string
    const bodyContents = await response.Body.transformToString();
    
    // Parse JSON
    const jsonData = JSON.parse(bodyContents);
    
    // Attempt to determine the number of items in rawData
    let itemCount = 0;
    
    if (Array.isArray(jsonData)) {
      itemCount = jsonData.length;
      console.log(`Successfully loaded S3 object. Found ${itemCount} items in array.`);
    } else if (jsonData.rawData && Array.isArray(jsonData.rawData)) {
      itemCount = jsonData.rawData.length;
      console.log(`Successfully loaded S3 object. Found ${itemCount} items in rawData.`);
    } else if (jsonData.data && Array.isArray(jsonData.data)) {
      itemCount = jsonData.data.length;
      console.log(`Successfully loaded S3 object. Found ${itemCount} items in data property.`);
    } else {
      console.log('Successfully loaded S3 object, but could not determine item count (not an array or missing rawData/data property).');
    }
    
  } catch (error) {
    console.error('Error loading or processing S3 object:', error);
  }
}
