import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'fs';

let r2Client = null;

/**
 * Initialize R2 (S3-compatible) client
 * @param {Object} config - R2 configuration
 * @param {string} config.accountId - R2 account ID
 * @param {string} config.accessKeyId - R2 access key
 * @param {string} config.secretAccessKey - R2 secret key
 * @returns {S3Client|null} - Initialized R2 client or null if credentials missing
 */
export function initializeR2Client({ accountId, accessKeyId, secretAccessKey }) {
  if (!accountId || !accessKeyId || !secretAccessKey) {
    console.warn('⚠ R2 credentials not found - files will not be uploaded to cloud storage');
    return null;
  }

  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    // Configure connection pooling to prevent connection leaks
    maxAttempts: 3,
    requestHandler: {
      connectionTimeout: 5000,
      socketTimeout: 10000,
    },
  });

  console.log('✓ R2 storage initialized with connection pooling');
  return r2Client;
}

/**
 * Upload file to R2 storage
 * @param {string} filePath - Local file path to upload
 * @param {string} key - R2 object key (path in bucket)
 * @param {string} bucketName - R2 bucket name
 * @param {string} contentType - MIME type of the file
 * @returns {Promise<string|null>} - R2 key if successful, null otherwise
 */
export async function uploadFileToR2(filePath, key, bucketName, contentType = 'application/octet-stream') {
  if (!r2Client) {
    console.log('R2 not configured, skipping upload');
    return null;
  }

  try {
    const fileStream = createReadStream(filePath);
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fileStream,
      ContentType: contentType,
    });

    await r2Client.send(command);
    console.log(`✓ Uploaded to R2: ${key}`);
    return key;
  } catch (error) {
    console.error('Error uploading to R2:', error);
    return null;
  }
}

/**
 * Get the R2 client instance
 * @returns {S3Client|null} - R2 client or null if not initialized
 */
export function getR2Client() {
  return r2Client;
}

/**
 * Download file from R2 storage
 * @param {string} key - R2 object key
 * @param {string} bucketName - R2 bucket name
 * @returns {Promise<Buffer>} - File contents as buffer
 */
export async function downloadFileFromR2(key, bucketName) {
  if (!r2Client) {
    throw new Error('R2 client not initialized');
  }

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    const response = await r2Client.send(command);
    const chunks = [];

    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  } catch (error) {
    console.error('Error downloading from R2:', error);
    throw error;
  }
}
