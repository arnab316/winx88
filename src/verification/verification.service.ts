// src/verification/verification.service.ts
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { extname } from 'path';

@Injectable()
export class VerificationService {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(private dataSource: DataSource) {
    this.bucket = process.env.AWS_BUCKET_NAME!;
    this.region = process.env.AWS_REGION!;

    this.s3 = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }

  // ══════════════════════════════════════════════════════════════
  // PRIVATE: S3 helpers
  // ══════════════════════════════════════════════════════════════

  private async uploadToS3(
    file: Express.Multer.File,
    userId: number,
    slot: 'front' | 'back' | 'selfie',
  ): Promise<string> {
    if (!file?.buffer) {
      throw new InternalServerErrorException(`${slot} file buffer is empty`);
    }

    const ext = extname(file.originalname) || '.jpg';
    const key = `kyc/${userId}/${slot}/${randomUUID()}${ext}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );

    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }

  private async deleteFromS3(url: string): Promise<void> {
    try {
      const key = new URL(url).pathname.slice(1);
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch {
      // non-fatal — old image cleanup, log and move on
    }
  }

  // ══════════════════════════════════════════════════════════════
  // USER: Submit / Re-submit KYC
  // POST /verification/submit
  // ══════════════════════════════════════════════════════════════

  async submitVerification(
    userId: number,
    body: {
      documentType: string;
      documentNumber: string;
      expiryDate: string;
    },
    frontFile: Express.Multer.File,
    backFile: Express.Multer.File,
    selfieFile: Express.Multer.File,
  ) {
    // ── Validate document type ─────────────────────────────────
    const validDocTypes = ['IDENTITY_CARD', 'PASSPORT', 'DRIVERS_LICENSE'];
    if (!validDocTypes.includes(body.documentType)) {
      throw new BadRequestException(
        'documentType must be one of: IDENTITY_CARD, PASSPORT, DRIVERS_LICENSE',
      );
    }

    // ── Validate expiry date (optional) ────────────────────────
    // Blank / whitespace / missing → stored as NULL (no expiry). Only when a
    // value is supplied do we enforce the format and the not-expired rule.
    const expiryDate = body.expiryDate?.trim() || null;
    if (expiryDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
        throw new BadRequestException('expiryDate must be in YYYY-MM-DD format');
      }
      if (new Date(expiryDate) < new Date()) {
        throw new BadRequestException('Document has already expired');
      }
    }

    // ── Check existing record ──────────────────────────────────
    const existing = await this.dataSource.query(
      `SELECT id, status, front_image_url, back_image_url, selfie_image_url, submission_count
       FROM user_verifications
       WHERE user_id = $1
       LIMIT 1`,
      [userId],
    );

    const record = existing[0] ?? null;

    if (record?.status === 'APPROVED') {
      throw new ConflictException(
        'Your verification is already approved.',
      );
    }
    if (record?.status === 'PENDING') {
      throw new ConflictException(
        'Your verification is pending review. Please wait.',
      );
    }
    if (record?.status === 'UNDER_REVIEW') {
      throw new ConflictException(
        'Your verification is currently under review. Please wait.',
      );
    }

    // ── Upload all 3 images to S3 concurrently ─────────────────
    const [frontUrl, backUrl, selfieUrl] = await Promise.all([
      this.uploadToS3(frontFile, userId, 'front'),
      this.uploadToS3(backFile, userId, 'back'),
      this.uploadToS3(selfieFile, userId, 'selfie'),
    ]);

    // ── INSERT or UPDATE ───────────────────────────────────────
    if (!record) {
      // First submission
      const result = await this.dataSource.query(
        `INSERT INTO user_verifications
           (user_id, document_type, document_number, expiry_date,
            front_image_url, back_image_url, selfie_image_url,
            status, submission_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', 1)
         RETURNING id, document_type, document_number, expiry_date,
                   status, submission_count, created_at`,
        [
          userId,
          body.documentType,
          body.documentNumber.trim(),
          expiryDate,
          frontUrl,
          backUrl,
          selfieUrl,
        ],
      );

      return {
        message:
          'Verification submitted successfully. Please complete verification before making withdrawals.',
        data: result[0],
      };
    }

    // Re-submission after REJECTED — delete old S3 images (non-blocking)
    void Promise.all([
      this.deleteFromS3(record.front_image_url),
      this.deleteFromS3(record.back_image_url),
      this.deleteFromS3(record.selfie_image_url),
    ]);

    const result = await this.dataSource.query(
      `UPDATE user_verifications
       SET document_type      = $1,
           document_number    = $2,
           expiry_date        = $3,
           front_image_url    = $4,
           back_image_url     = $5,
           selfie_image_url   = $6,
           status             = 'PENDING',
           rejection_reason   = NULL,
           reviewed_by_admin_id = NULL,
           reviewed_at        = NULL,
           submission_count   = submission_count + 1,
           updated_at         = NOW()
       WHERE user_id = $7
       RETURNING id, document_type, document_number, expiry_date,
                 status, submission_count, updated_at`,
      [
        body.documentType,
        body.documentNumber.trim(),
        expiryDate,
        frontUrl,
        backUrl,
        selfieUrl,
        userId,
      ],
    );

    // TypeORM returns [rows, affectedCount] for UPDATE…RETURNING (unlike
    // INSERT…RETURNING which returns plain rows), so result[0] is the rows
    // array. Unwrap to a single object so re-submission matches first-submit.
    const updated = Array.isArray(result[0]) ? result[0][0] : result[0];
    return {
      message: 'Verification re-submitted successfully. Awaiting review.',
      data: updated,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // USER: Get my KYC status
  // GET /verification/my-status
  // ══════════════════════════════════════════════════════════════

  async getMyVerification(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT id, document_type, document_number, expiry_date,
              status, rejection_reason, submission_count,
              created_at, updated_at
       FROM user_verifications
       WHERE user_id = $1
       LIMIT 1`,
      [userId],
    );

    if (!rows.length) {
      return {
        status: 'NOT_SUBMITTED',
        message: 'You have not submitted any verification documents yet.',
        data: null,
      };
    }

    const record = rows[0];

    const messages: Record<string, string> = {
      PENDING: 'Your documents are submitted and awaiting review.',
      UNDER_REVIEW: 'Your documents are currently being reviewed.',
      APPROVED: 'Your identity has been verified successfully.',
      REJECTED: `Verification was not approved. Reason: ${record.rejection_reason ?? 'Not specified'}. Please correct and re-submit.`,
    };

    return {
      status: record.status,
      message: messages[record.status] ?? 'Unknown status.',
      data: record,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // ADMIN: List all verifications (paginated + filter by status)
  // GET /verification/admin/list?page=1&limit=20&status=PENDING
  // ══════════════════════════════════════════════════════════════

  async listVerifications(page: number, limit: number, status?: string) {
    const offset = (page - 1) * limit;
    const params: any[] = [limit, offset];

    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE uv.status = $${params.length}`;
    }

    const rows = await this.dataSource.query(
      `SELECT uv.id,
              uv.user_id,
              u.username,
              u.full_name,
              uv.document_type,
              uv.document_number,
              uv.expiry_date,
              uv.front_image_url,
              uv.back_image_url,
              uv.selfie_image_url,
              uv.status,
              uv.rejection_reason,
              uv.submission_count,
              uv.reviewed_at,
              -- Reviewing admin (same convention as deposit/withdrawal lists)
              adm.name  AS decided_by_name,
              adm.email AS decided_by_email,
              uv.created_at,
              uv.updated_at
       FROM user_verifications uv
       JOIN users u ON u.id = uv.user_id
       LEFT JOIN admin_users adm ON adm.id = uv.reviewed_by_admin_id
       ${where}
       ORDER BY uv.created_at DESC
       LIMIT $1 OFFSET $2`,
      params,
    );

    const countParams: any[] = [];
    let countWhere = '';
    if (status) {
      countParams.push(status);
      countWhere = `WHERE status = $1`;
    }

    const countResult = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM user_verifications ${countWhere}`,
      countParams,
    );

    const total = countResult[0].total;

    return {
      data: rows,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ══════════════════════════════════════════════════════════════
  // ADMIN: Get single verification by ID
  // GET /verification/admin/:id
  // ══════════════════════════════════════════════════════════════

  async getVerificationById(id: number) {
    const rows = await this.dataSource.query(
      `SELECT uv.*,
              u.username,
              u.full_name,
              u.email,
              adm.name  AS decided_by_name,
              adm.email AS decided_by_email
       FROM user_verifications uv
       JOIN users u ON u.id = uv.user_id
       LEFT JOIN admin_users adm ON adm.id = uv.reviewed_by_admin_id
       WHERE uv.id = $1
       LIMIT 1`,
      [id],
    );

    if (!rows.length) {
      throw new NotFoundException(`Verification #${id} not found`);
    }

    return { data: rows[0] };
  }

  // ══════════════════════════════════════════════════════════════
  // ADMIN: Get verifications by user ID
  // GET /verification/admin/user/:userId
  // ══════════════════════════════════════════════════════════════

  async getVerificationByUserId(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT uv.id, uv.document_type, uv.document_number, uv.expiry_date,
              uv.front_image_url, uv.back_image_url, uv.selfie_image_url,
              uv.status, uv.rejection_reason, uv.submission_count,
              uv.reviewed_at,
              adm.name  AS decided_by_name,
              adm.email AS decided_by_email,
              uv.created_at, uv.updated_at
       FROM user_verifications uv
       LEFT JOIN admin_users adm ON adm.id = uv.reviewed_by_admin_id
       WHERE uv.user_id = $1
       ORDER BY uv.created_at DESC`,
      [userId],
    );

    if (!rows.length) {
      throw new NotFoundException(`No verification found for user #${userId}`);
    }

    return { data: rows };
  }

  // ══════════════════════════════════════════════════════════════
  // ADMIN: Mark as Under Review
  // PATCH /verification/admin/:id/under-review
  // ══════════════════════════════════════════════════════════════

  async markUnderReview(id: number, adminId: number) {
    const rows = await this.dataSource.query(
      `SELECT id, status FROM user_verifications WHERE id = $1 LIMIT 1`,
      [id],
    );

    if (!rows.length) {
      throw new NotFoundException(`Verification #${id} not found`);
    }

    if (rows[0].status !== 'PENDING') {
      throw new ConflictException(
        `Cannot mark as under review — current status is ${rows[0].status}`,
      );
    }

    await this.dataSource.query(
      `UPDATE user_verifications
       SET status = 'UNDER_REVIEW',
           reviewed_by_admin_id = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [adminId, id],
    );

    return { message: 'Verification marked as under review' };
  }

  // ══════════════════════════════════════════════════════════════
  // ADMIN: Approve or Reject
  // PATCH /verification/admin/:id/review
  // body: { action: 'APPROVE' | 'REJECT', rejectionReason?: string }
  // ══════════════════════════════════════════════════════════════

async reviewVerification(
  id: number,
  adminId: number,
  action: 'APPROVE' | 'REJECT',
  rejectionReason?: string,
) {
  const rows = await this.dataSource.query(
    `SELECT id, status, user_id FROM user_verifications WHERE id = $1 LIMIT 1`,
    [id],
  );
 
  if (!rows.length) {
    throw new NotFoundException(`Verification #${id} not found`);
  }
 
  if (rows[0].status === 'APPROVED') {
    throw new ConflictException('This verification is already approved');
  }
 
  if (action === 'REJECT' && !rejectionReason) {
    throw new BadRequestException('rejectionReason is required when rejecting');
  }
 
  const newStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
 
  // Update the verification record
  const result = await this.dataSource.query(
    `UPDATE user_verifications
     SET status               = $1,
         rejection_reason     = $2,
         reviewed_by_admin_id = $3,
         reviewed_at          = NOW(),
         updated_at           = NOW()
     WHERE id = $4
     RETURNING id, user_id, status, rejection_reason, reviewed_at`,
    [newStatus, rejectionReason ?? null, adminId, id],
  );
 
  // Sync is_kyc_verified on users table
  // (the DB trigger does this too — this is a safety net in case
  //  the trigger is ever dropped or the transaction is complex)
  await this.dataSource.query(
    `UPDATE users
     SET is_kyc_verified = $1,
         updated_at      = NOW()
     WHERE id = $2`,
    [action === 'APPROVE', rows[0].user_id],
  );
 
  return {
    message: `Verification ${action === 'APPROVE' ? 'approved' : 'rejected'} successfully`,
    data: result[0],
  };
}

  // ══════════════════════════════════════════════════════════════
  // ADMIN: Stats summary
  // GET /verification/admin/stats
  // ══════════════════════════════════════════════════════════════

  async getStats() {
    const rows = await this.dataSource.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'PENDING')      AS pending,
         COUNT(*) FILTER (WHERE status = 'UNDER_REVIEW') AS under_review,
         COUNT(*) FILTER (WHERE status = 'APPROVED')     AS approved,
         COUNT(*) FILTER (WHERE status = 'REJECTED')     AS rejected,
         COUNT(*)                                         AS total
       FROM user_verifications`,
    );

    return { data: rows[0] };
  }


  
}