import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { extname } from 'path';

@Injectable()
export class S3Service {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor() {
    // ── debug: log what env vars are loaded ──────────────────
    console.log('AWS_REGION:', process.env.AWS_REGION);
    console.log('AWS_BUCKET_NAME:', process.env.AWS_BUCKET_NAME);
    console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? 'SET' : 'MISSING');
    console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? 'SET' : 'MISSING');
    // ─────────────────────────────────────────────────────────

    this.bucket = process.env.AWS_BUCKET_NAME!;

    this.s3 = new S3Client({
      region: process.env.AWS_REGION!,
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }

async uploadDepositScreenshot(file: Express.Multer.File): Promise<string> {
  console.log('uploadDepositScreenshot called, file:', file?.originalname);

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

    console.log('S3 upload success, key:', key);

    // ✅ FIX: return full URL instead of key
    const fullUrl = `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

    return fullUrl;

  } catch (err: any) {
    console.error('S3 upload FAILED:', err.message);
    throw new InternalServerErrorException(`S3 upload failed: ${err.message}`);
  }
}
}