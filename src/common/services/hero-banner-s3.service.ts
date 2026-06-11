import {
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';

import {
  S3Client,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

import { randomUUID } from 'crypto';
import { extname } from 'path';

@Injectable()
export class HeroBannerS3Service {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.AWS_BUCKET_NAME!;

    this.s3 = new S3Client({
      region: process.env.AWS_REGION!,
      // Fail fast instead of hanging the upload request when S3 is
      // slow/misconfigured (a hang surfaces to the admin as a failed upload).
      requestHandler: {
        connectionTimeout: 3000,
        requestTimeout: 8000,
      },
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey:
          process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }

  async uploadHeroBanner(
    file: Express.Multer.File,
    type: 'desktop' | 'mobile',
  ): Promise<string> {
    try {
      if (!file || !file.buffer) {
        throw new Error('Invalid file');
      }

      if (!this.bucket) {
        throw new Error('AWS_BUCKET_NAME is not set in environment variables');
      }

      const ext =
        extname(file.originalname) || '.jpg';

      const key = `hero-banner/${type}/${randomUUID()}${ext}`;

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );

      return `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    } catch (err: any) {
      console.error(
        'Hero banner upload failed:',
        err.message,
      );

      throw new InternalServerErrorException(
        `Hero banner upload failed: ${err.message}`,
      );
    }
  }
}