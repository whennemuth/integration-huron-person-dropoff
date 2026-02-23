import { S3Event, Context as LambdaContext, S3EventRecord } from 'aws-lambda';
import { handler } from '../src/event-processor/index';

// Mock the dependencies
jest.mock('../src/event-processor/Bucket');
jest.mock('../src/event-processor/S3EventProcessor', () => {
  return {
    S3EventProcessor: jest.fn().mockImplementation(() => {
      return {
        process: jest.fn().mockResolvedValue({
          success: true,
          action: 'renamed',
          originalKey: 'test.json',
          newKey: 'timestamp-test.json'
        })
      };
    })
  };
});
jest.mock('../src/event-processor/Subscriber');

describe('Lambda Handler - Bucket Name Validation', () => {
  let mockContext: LambdaContext;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    
    mockContext = {
      functionName: 'test-function',
      functionVersion: '1',
      invokedFunctionArn: 'arn:aws:lambda:us-east-2:123456789012:function:test',
      memoryLimitInMB: '512',
      awsRequestId: 'test-request-id',
      logGroupName: '/aws/lambda/test',
      logStreamName: 'test-stream',
      getRemainingTimeInMillis: () => 30000,
      done: jest.fn(),
      fail: jest.fn(),
      succeed: jest.fn(),
      callbackWaitsForEmptyEventLoop: true
    };

    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  const createMockS3Event = (bucketName: string, objectKey: string): S3Event => {
    return {
      Records: [
        {
          eventVersion: '2.1',
          eventSource: 'aws:s3',
          awsRegion: 'us-east-2',
          eventTime: '2026-02-23T04:51:05.885Z',
          eventName: 'ObjectCreated:Put',
          userIdentity: {
            principalId: 'AWS:AIDAI...'
          },
          requestParameters: {
            sourceIPAddress: '192.168.1.1'
          },
          responseElements: {
            'x-amz-request-id': 'ABC123',
            'x-amz-id-2': 'DEF456'
          },
          s3: {
            s3SchemaVersion: '1.0',
            configurationId: 'test-config',
            bucket: {
              name: bucketName,
              ownerIdentity: {
                principalId: 'A1B2C3D4'
              },
              arn: `arn:aws:s3:::${bucketName}`
            },
            object: {
              key: objectKey,
              size: 1024,
              eTag: 'abc123',
              sequencer: '123ABC'
            }
          }
        } as S3EventRecord
      ]
    };
  };

  describe('Bucket Name Matching', () => {
    it('should successfully process when S3 event bucket matches config bucket', async () => {
      const bucketName = 'huron-person-file-drop-dev';
      process.env.BUCKET_CONFIG = JSON.stringify({
        name: bucketName,
        subdirectories: [
          {
            path: 'person-full',
            objectLifetimeDays: 7,
            subscriberLambdaArn: 'arn:aws:lambda:us-east-2:123456789012:function:subscriber'
          }
        ]
      });

      // Force re-import to pick up new env var
      jest.resetModules();
      const { handler: freshHandler } = require('../src/event-processor/index');

      const event = createMockS3Event(bucketName, 'person-full/test.json');
      
      // Should not throw
      await expect(freshHandler(event, mockContext)).resolves.not.toThrow();
    });

    it('should throw error when S3 event bucket does NOT match config bucket', async () => {
      const configBucketName = 'huron-person-file-drop';  // Wrong - missing landscape suffix
      const eventBucketName = 'huron-person-file-drop-dev';  // Correct actual bucket
      
      process.env.BUCKET_CONFIG = JSON.stringify({
        name: configBucketName,
        subdirectories: [
          {
            path: 'person-full',
            objectLifetimeDays: 7,
            subscriberLambdaArn: 'arn:aws:lambda:us-east-2:123456789012:function:subscriber'
          }
        ]
      });

      // Force re-import to pick up new env var
      jest.resetModules();
      const { handler: freshHandler } = require('../src/event-processor/index');

      const event = createMockS3Event(eventBucketName, 'person-full/test.json');
      
      // Mock console.error to suppress error output in test
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      
      await freshHandler(event, mockContext);
      
      // Should have logged an error
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error processing record:',
        expect.any(Error)
      );
      
      // The error message should indicate bucket mismatch
      const errorArg = consoleErrorSpy.mock.calls[0][1];
      expect(errorArg.message).toContain('Bucket name mismatch');
      expect(errorArg.message).toContain(eventBucketName);
      expect(errorArg.message).toContain(configBucketName);
      
      consoleErrorSpy.mockRestore();
    });

    it('should provide helpful error message about deployment issue', async () => {
      process.env.BUCKET_CONFIG = JSON.stringify({
        name: 'wrong-bucket',
        subdirectories: []
      });

      jest.resetModules();
      const { handler: freshHandler } = require('../src/event-processor/index');

      const event = createMockS3Event('actual-bucket', 'test.json');
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      
      await freshHandler(event, mockContext);
      
      const errorArg = consoleErrorSpy.mock.calls[0][1];
      expect(errorArg.message).toContain('deployment issue');
      expect(errorArg.message).toContain('BUCKET_CONFIG environment variable');
      
      consoleErrorSpy.mockRestore();
    });

    it('should continue processing remaining records even if one has bucket mismatch', async () => {
      const correctBucket = 'correct-bucket';
      const wrongBucket = 'wrong-bucket';
      
      process.env.BUCKET_CONFIG = JSON.stringify({
        name: correctBucket,
        subdirectories: []
      });

      jest.resetModules();
      const { handler: freshHandler } = require('../src/event-processor/index');
      const { S3EventProcessor } = require('../src/event-processor/S3EventProcessor');

      const event: S3Event = {
        Records: [
          createMockS3Event(wrongBucket, 'test1.json').Records[0],
          createMockS3Event(correctBucket, 'test2.json').Records[0]
        ]
      };

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      
      await freshHandler(event, mockContext);
      
      // First record should error with mismatch
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error processing record:',
        expect.objectContaining({
          message: expect.stringContaining('Bucket name mismatch')
        })
      );
      
      // Second record should process successfully
      expect(S3EventProcessor).toHaveBeenCalledTimes(1);  // Only called for matching bucket
      
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Configuration Edge Cases', () => {
    it('should handle missing bucket name in config', async () => {
      process.env.BUCKET_CONFIG = JSON.stringify({
        subdirectories: []
      });

      jest.resetModules();
      const { handler: freshHandler } = require('../src/event-processor/index');

      const event = createMockS3Event('some-bucket', 'test.json');
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      
      await freshHandler(event, mockContext);
      
      // Should error because config.name is undefined
      expect(consoleErrorSpy).toHaveBeenCalled();
      
      consoleErrorSpy.mockRestore();
    });

    it('should handle empty bucket name in config', async () => {
      process.env.BUCKET_CONFIG = JSON.stringify({
        name: '',
        subdirectories: []
      });

      jest.resetModules();
      const { handler: freshHandler } = require('../src/event-processor/index');

      const event = createMockS3Event('some-bucket', 'test.json');
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      
      await freshHandler(event, mockContext);
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorArg = consoleErrorSpy.mock.calls[0][1];
      expect(errorArg.message).toContain('mismatch');
      
      consoleErrorSpy.mockRestore();
    });
  });
});
