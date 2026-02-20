import { RemovalPolicy, SecretValue } from 'aws-cdk-lib';
import { User, AccessKey, PolicyStatement, Effect, IUser } from 'aws-cdk-lib/aws-iam';
import { Secret, ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { IContext } from '../context/IContext';

export type BucketAccessKeysProps = {
  context: IContext;
  bucket: Bucket;
};

/**
 * Creates or imports IAM access keys for external systems to upload files to the file-drop bucket.
 * Stores credentials securely in AWS Secrets Manager.
 * 
 * Behavior:
 * - If context.BUCKET.access is defined: Imports existing User and Secret (for stack recreation)
 * - If context.BUCKET.access is undefined: Creates new User, AccessKey, and Secret with RETAIN policy
 */
export class BucketAccessKeys extends Construct {
  public readonly secret: ISecret;
  public readonly user: IUser;
  public readonly accessKey?: AccessKey;

  constructor(scope: Construct, id: string, props: BucketAccessKeysProps) {
    super(scope, id);

    const { context, bucket } = props;
    const { STACK_ID, TAGS: { Landscape } } = context;

    if (context.BUCKET.access) {
      // Import existing resources for stack recreation
      console.log(`Importing existing IAM user: ${context.BUCKET.access.username}`);
      
      this.user = User.fromUserName(this, 'imported-user', context.BUCKET.access.username);
      this.secret = Secret.fromSecretCompleteArn(this, 'imported-secret', context.BUCKET.access.secretArn);
      
      // Note: AccessKey already exists in AWS but we don't have a CDK reference to it
      // The credentials remain in the imported Secret
      this.accessKey = undefined;
      
    } else {
      // Create new resources with retention policy
      console.log('Creating new IAM user and access keys');
      
      this.user = new User(this, 'bucket-service-user', {
        userName: `${STACK_ID}-service-user-${Landscape}`
      });
      
      // Prevent deletion of user when stack is destroyed
      this.user.applyRemovalPolicy(RemovalPolicy.RETAIN);

      // Create access key
      this.accessKey = new AccessKey(this, 'access-key', {
        user: this.user
      });
      
      // Prevent deletion of access key when stack is destroyed
      this.accessKey.applyRemovalPolicy(RemovalPolicy.RETAIN);

      // Store credentials in Secrets Manager with RETAIN policy
      this.secret = new Secret(this, 'access-key-secret', {
        secretName: `${STACK_ID}-bucket-access-keys-${Landscape}`,
        description: `S3 access keys for external systems to upload to ${bucket.bucketName}`,
        secretObjectValue: {
          accessKeyId: SecretValue.unsafePlainText(this.accessKey.accessKeyId),
          secretAccessKey: this.accessKey.secretAccessKey,
          bucketName: SecretValue.unsafePlainText(bucket.bucketName),
          bucketArn: SecretValue.unsafePlainText(bucket.bucketArn),
          region: SecretValue.unsafePlainText(context.REGION)
        }
      });
      
      // Prevent deletion of secret when stack is destroyed
      this.secret.applyRemovalPolicy(RemovalPolicy.RETAIN);
    }

    // Apply bucket policies (works for both imported and newly created users)
    this.applyBucketPolicies(bucket);
  }

  /**
   * Applies comprehensive S3 bucket permissions to the user
   * Includes all operations except bucket deletion/modification
   */
  private applyBucketPolicies(bucket: Bucket): void {
    // Bucket-level operations
    this.user.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          's3:ListBucket',
          's3:GetBucketLocation',
          's3:GetBucketVersioning',
          's3:GetBucketNotification',
          's3:GetBucketTagging',
          's3:GetBucketCors',
          's3:GetBucketAcl',
          's3:GetBucketPolicy',
          's3:GetBucketObjectLockConfiguration',
          's3:GetBucketRequestPayment',
          's3:GetLifecycleConfiguration',
          's3:GetReplicationConfiguration',
          's3:GetEncryptionConfiguration',
          's3:ListBucketMultipartUploads',
          's3:ListBucketVersions'
        ],
        resources: [bucket.bucketArn]
      })
    );

    // Object-level operations (read, write, delete objects)
    this.user.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          // Read operations
          's3:GetObject',
          's3:GetObjectAcl',
          's3:GetObjectAttributes',
          's3:GetObjectTagging',
          's3:GetObjectVersion',
          's3:GetObjectVersionAcl',
          's3:GetObjectVersionAttributes',
          's3:GetObjectVersionTagging',
          's3:GetObjectLegalHold',
          's3:GetObjectRetention',
          // Write operations
          's3:PutObject',
          's3:PutObjectAcl',
          's3:PutObjectTagging',
          's3:PutObjectVersionAcl',
          's3:PutObjectVersionTagging',
          's3:PutObjectLegalHold',
          's3:PutObjectRetention',
          // Delete operations (objects only, not bucket)
          's3:DeleteObject',
          's3:DeleteObjectTagging',
          's3:DeleteObjectVersion',
          's3:DeleteObjectVersionTagging',
          // Multipart upload operations
          's3:AbortMultipartUpload',
          's3:ListMultipartUploadParts',
          // Restore operations (for Glacier)
          's3:RestoreObject'
        ],
        resources: [`${bucket.bucketArn}/*`]
      })
    );
  }

  public get secretArn(): string {
    return this.secret.secretArn;
  }
}
