import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { extname } from 'path';

@Injectable()
export class S3Service {
  private readonly s3: S3Client;
  private readonly bucket: string;

  private readonly logger = new Logger(S3Service.name);

  constructor() {
    // Sanity-check env at boot (non-prod only). Never logs secret values.
    if (process.env.NODE_ENV !== 'production') {
      this.logger.debug(
        `AWS env — region=${process.env.AWS_REGION}, bucket=${process.env.AWS_BUCKET_NAME}, ` +
          `accessKeyId=${process.env.AWS_ACCESS_KEY_ID ? 'SET' : 'MISSING'}, ` +
          `secretAccessKey=${process.env.AWS_SECRET_ACCESS_KEY ? 'SET' : 'MISSING'}`,
      );
    }

    this.bucket = process.env.AWS_BUCKET_NAME!;

    this.s3 = new S3Client({
      region: process.env.AWS_REGION!,
      // Fail fast instead of hanging the HTTP request (which surfaces in the
      // browser as "Failed to fetch") when S3 is slow/misconfigured.
      requestHandler: {
        connectionTimeout: 3000, // ms to establish the TCP/TLS connection
        requestTimeout:    8000, // ms for the full PutObject to complete
      },
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }

async uploadDepositScreenshot(file: Express.Multer.File): Promise<string> {
  this.logger.debug(`uploadDepositScreenshot called, file=${file?.originalname ?? 'NONE'}`);

  if (!file || !file.buffer) {
    throw new InternalServerErrorException('File buffer is empty');
  }

  if (!this.bucket) {
    throw new InternalServerErrorException(
      'AWS_BUCKET_NAME is not set in environment variables',
    );
  }

  const ext = extname(file.originalname) || '.jpg';
  const key = `deposits/${randomUUID()}${ext}`;

  try {
    await this.s3.send(
      new PutObjectCommand({
        Bucket:      this.bucket,
        Key:         key,
        Body:        file.buffer,
        ContentType: file.mimetype,
      }),
    );

    this.logger.debug(`S3 upload success, key=${key}`);

    // Return full URL instead of the bare key.
    return `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

  } catch (err: any) {
    this.logger.error(`S3 upload FAILED: ${err.message}`);
    throw new InternalServerErrorException(`S3 upload failed: ${err.message}`);
  }
}

 async uploadPromotionBanner(
  file: Express.Multer.File,
  variant: 'banner_en' | 'banner_bn' | 'small_banner_en' | 'small_banner_bn',
): Promise<string> {
  if (!file || !file.buffer) {
    throw new InternalServerErrorException('File buffer is empty');
  }
  if (!this.bucket) {
    throw new InternalServerErrorException(
      'AWS_BUCKET_NAME is not set in environment variables',
    );
  }
 
  const ext = extname(file.originalname) || '.jpg';
  // promotions/banner_en/<uuid>.jpg
  const key = `promotions/${variant}/${randomUUID()}${ext}`;
 
  try {
    await this.s3.send(
      new PutObjectCommand({
        Bucket:       this.bucket,
        Key:          key,
        Body:         file.buffer,
        ContentType:  file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable', // 1 year — banners are immutable per UUID
      }),
    );
 
    return `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  } catch (err: any) {
    throw new InternalServerErrorException(`Banner upload failed: ${err.message}`);
  }
}

  
}