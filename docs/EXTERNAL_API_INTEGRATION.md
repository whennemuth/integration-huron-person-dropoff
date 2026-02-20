# Example: External API Async Process

This document describes how an external API process would interact with the file-drop bucket.

## Scenario

An API endpoint that serves up person data is modified to support async operation via a new parameter:

```
GET /api/v1/persons?async=true
```

### Synchronous Mode (Default)
```
GET /api/v1/persons
Response: 200 OK
Body: { "data": [ { "personid": "...", ... }, ... ] }
```

The caller receives the full JSON payload in the response.

### Asynchronous Mode (New)
```
GET /api/v1/persons?async=true
Response: 202 Accepted
Body: { "status": "processing", "message": "Data will be deposited to S3 file-drop bucket" }
```

The API immediately returns 202 and:
1. Continues gathering person data in the background
2. Uploads the JSON payload to the S3 file-drop bucket at `s3://bucket-name/person-full/`
3. S3 event triggers Lambda processing pipeline

## Authentication with S3 Bucket

The external API process retrieves access credentials from Secrets Manager:

```bash
aws secretsmanager get-secret-value \
  --secret-id <stack-id>-bucket-access-keys-<landscape> \
  --region <region>
```

Example with current configuration (`STACK_ID: huron-file-drop`, `BUCKET.name: huron-file-drop`, `Landscape: dev`):
```bash
aws secretsmanager get-secret-value \
  --secret-id huron-file-drop-bucket-access-keys-dev \
  --region us-east-2
```

Returns:
```json
{
  "accessKeyId": "AKIA...",
  "secretAccessKey": "...",
  "bucketName": "huron-file-drop-dev",
  "bucketArn": "arn:aws:s3:::huron-file-drop-dev",
  "region": "us-east-2"
}
```

Note: Bucket name uses `BUCKET.name` if configured, otherwise defaults to `STACK_ID`.

## Uploading to S3

Example using AWS SDK (Node.js):

```javascript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIA...',
    secretAccessKey: '...'
  }
});

// Person data from CDM API
const personData = [
  {
    personid: 'U12345678',
    personBasic: {
      names: [
        {
          nameType: 'PRI',
          firstName: 'John',
          lastName: 'Doe'
        }
      ]
    },
    email: [
      {
        type: 'university',
        address: 'john.doe@example.edu'
      }
    ],
    employeeInfo: {
      positions: [ /* ... */ ]
    }
  }
  // ... more person objects
];

// Upload to S3
const command = new PutObjectCommand({
  Bucket: 'huron-file-drop-dev', // From secrets manager bucketName
  Key: 'person-full/batch-upload.json', // Any filename - Lambda will rename
  Body: JSON.stringify(personData),
  ContentType: 'application/json'
});

await s3Client.send(command);
console.log('Data uploaded to S3 file-drop bucket');
```

## Processing Flow

1. **External API** uploads JSON to `s3://bucket/person-full/batch-upload.json`
2. **S3 Event** triggers Event Processor Lambda
3. **Lambda validates** JSON structure
4. **Lambda renames** to `person-full/full-2026-02-19T15:30:45.123Z.json`
5. **Lambda sets expiration** (7 days default)
6. **Lambda invokes** target Lambda(s) with payload:
   ```json
   {
     "s3Path": "s3://huron-file-drop-dev/person-full/full-2026-02-19T15:30:45.123Z.json",
     "bucket": "huron-file-drop-dev",
     "key": "person-full/full-2026-02-19T15:30:45.123Z.json",
     "processingMetadata": {
       "processedAt": "2026-02-19T15:30:45.500Z",
       "processorVersion": "1.0.0"
     }
   }
   ```
7. **Target Lambda** retrieves object from S3 and processes person data

## Target Lambda Implementation

The target Lambda (Lambda #2) should expect the S3 path parameter:

```javascript
export async function handler(event) {
  const { s3Path, bucket, key } = event;
  
  // Retrieve object from S3
  const s3Client = new S3Client({});
  const { Body } = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  
  const personData = JSON.parse(await Body.transformToString());
  
  // Process person data
  for (const person of personData) {
    // ... handle person sync, transformation, etc.
    console.log(`Processing person: ${person.personid}`);
  }
  
  return { status: 'success', processedCount: personData.length };
}
```

## Error Handling

If the JSON is invalid or doesn't match expected structure, the file is moved to:
```
s3://bucket/person-full/errors/batch-upload.json
```

With error reason in object tags. External API process should monitor error subdirectory or set up CloudWatch alarms.
