import { Injectable, Logger } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { extname } from 'path';

/**
 * Generic image upload to S3.
 *
 * `HeroBannerS3Service` predates this and hardcodes a `hero-banner/<type>/`
 * key prefix, so it can't be reused for anything else. This one takes the
 * folder as an argument. New features should use this; hero-banner can be
 * migrated onto it later without touching its behaviour.
 */
@Injectable()
export class MediaS3Service {
  private readonly logger = new Logger(MediaS3Service.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.AWS_BUCKET_NAME!;
    this.s3 = new S3Client({
      region: process.env.AWS_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }

  /**
   * Uploads `file` under `folder/` and returns its public URL.
   * The key is a random UUID, so re-uploading never overwrites a live asset.
   */
  async uploadImage(file: Express.Multer.File, folder: string): Promise<string> {
    if (!file?.buffer) {
      throw new Error('Invalid file');
    }
    if (!this.bucket) {
      throw new Error('AWS_BUCKET_NAME is not set in environment variables');
    }

    const ext = extname(file.originalname) || '.png';
    const key = `${folder.replace(/^\/+|\/+$/g, '')}/${randomUUID()}${ext}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );

    return `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  }
}
