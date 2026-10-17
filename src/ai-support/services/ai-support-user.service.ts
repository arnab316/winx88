import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { UserService } from 'src/user/user.service';
import { VerificationService } from 'src/verification/verification.service';
import { VipService } from 'src/vip/vip.service';

/**
 * Account, status, restrictions and KYC — for a support agent answering
 * "why can't I do X?".
 *
 * Everything here is READ-ONLY and scoped to one customer, resolved from the
 * signed token by AiSupportGuard. Nothing in this file takes a customer id
 * from the request.
 *
 * Two rules shape every response:
 *   - Only customer-safe fields. An agent can repeat anything it is told
 *     back to the customer, so nothing it receives may be internal.
 *   - Never invent a reason. Where the platform records no reason, the
 *     response says so rather than guessing one that sounds plausible.
 */
@Injectable()
export class AiSupportUserService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly users: UserService,
    private readonly verification: VerificationService,
    private readonly vip: VipService,
  ) {}

  /** Profile, as the customer's own profile screen already shows it. */
  async getProfile(userId: number) {
    const profile: any = await this.users.getProfile(userId);
    const p = profile?.data ?? profile;
    if (!p) throw new NotFoundException('Customer not found');

    return {
      customerId: Number(p.id ?? userId),
      username: p.username ?? null,
      fullName: p.full_name ?? p.fullName ?? null,
      email: p.email ?? null,
      // Deliberately masked: an agent has no reason to read back a full
      // phone number, and repeating one is a account-takeover vector.
      phoneMasked: this.maskPhone(p.phone_number ?? p.phoneNumber ?? null),
      currency: p.currency ?? 'BDT',
      vipLevel: p.vip_level ?? p.vipLevel ?? 0,
      registeredAt: p.created_at ?? p.createdAt ?? null,
    };
  }

  /**
   * Account status plus the one thing support is really asked:
   * can this customer play, deposit and withdraw right now?
   */
  async getStatus(userId: number) {
    const [row] = await this.dataSource.query(
      `SELECT u.id, u.username, u.account_status, u.vip_level, u.created_at,
              uv.status AS kyc_status
         FROM users u
         LEFT JOIN user_verifications uv ON uv.user_id = u.id
        WHERE u.id = $1
        LIMIT 1`,
      [userId],
    );
    if (!row) throw new NotFoundException('Customer not found');

    const status = String(row.account_status ?? '').toUpperCase();
    const active = status === 'ACTIVE';

    return {
      customerId: Number(row.id),
      username: row.username,
      accountStatus: status,
      isActive: active,
      registeredAt: row.created_at,
      vipLevel: Number(row.vip_level ?? 0),
      kycStatus: row.kyc_status ?? 'NOT_SUBMITTED',
      canPlay: active,
      canDeposit: active,
      canWithdraw: active,
      // No free-text reason is stored against account_status, so none is
      // offered. Inventing one would have an agent telling a customer
      // something the platform never recorded.
      statusReason: null,
      guidance: active
        ? null
        : 'This account is not active. Please contact support to review it.',
    };
  }

  /**
   * What is currently blocking this customer, and why.
   *
   * Each entry is something a support agent can act on, with the real source
   * of the restriction named so the answer is checkable.
   */
  async getRestrictions(userId: number) {
    const [row] = await this.dataSource.query(
      `SELECT u.account_status, u.vip_level,
              uv.status AS kyc_status
         FROM users u
         LEFT JOIN user_verifications uv ON uv.user_id = u.id
        WHERE u.id = $1 LIMIT 1`,
      [userId],
    );
    if (!row) throw new NotFoundException('Customer not found');

    const restrictions: Array<{
      code: string;
      scope: string;
      message: string;
      source: string;
    }> = [];

    const status = String(row.account_status ?? '').toUpperCase();
    if (status !== 'ACTIVE') {
      restrictions.push({
        code: 'ACCOUNT_NOT_ACTIVE',
        scope: 'ALL',
        message: `The account status is ${status}. Deposits, withdrawals and betting are paused.`,
        source: 'users.account_status',
      });
    }

    const kyc = String(row.kyc_status ?? 'NOT_SUBMITTED').toUpperCase();
    if (kyc !== 'APPROVED') {
      restrictions.push({
        code: 'KYC_NOT_APPROVED',
        scope: 'WITHDRAWAL',
        message:
          kyc === 'NOT_SUBMITTED'
            ? 'Identity verification has not been submitted yet.'
            : `Identity verification is ${kyc}.`,
        source: 'user_verifications.status',
      });
    }

    // An ACTIVE turnover requirement blocks withdrawal. Read through the
    // turnover service's own view of it rather than re-deriving the rule.
    const active = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n FROM turnover_requirements
        WHERE user_id = $1 AND status = 'ACTIVE'`,
      [userId],
    );
    if (Number(active[0]?.n ?? 0) > 0) {
      restrictions.push({
        code: 'TURNOVER_PENDING',
        scope: 'WITHDRAWAL',
        message:
          'There is an unfinished wagering requirement on this account. ' +
          'Withdrawals unlock once it is complete.',
        source: 'turnover_requirements',
      });
    }

    // Per-tier banking switches an admin can flip.
    let banking: any = null;
    try {
      banking = await this.vip.getBankingToggles(Number(row.vip_level ?? 0));
    } catch {
      banking = null; // tier not configured — treated as no extra restriction
    }
    if (banking && banking.depositEnabled === false) {
      restrictions.push({
        code: 'DEPOSIT_DISABLED_FOR_TIER',
        scope: 'DEPOSIT',
        message: 'Deposits are currently unavailable for this account tier.',
        source: 'vip_level_config.deposit_enabled',
      });
    }
    if (banking && banking.withdrawalEnabled === false) {
      restrictions.push({
        code: 'WITHDRAWAL_DISABLED_FOR_TIER',
        scope: 'WITHDRAWAL',
        message: 'Withdrawals are currently unavailable for this account tier.',
        source: 'vip_level_config.withdrawal_enabled',
      });
    }

    return {
      customerId: userId,
      restricted: restrictions.length > 0,
      restrictions,
    };
  }

  /**
   * KYC state and the next step, if any.
   *
   * Document numbers and image URLs are never returned — an agent needs to
   * know the STATE of a verification, never its contents.
   */
  async getKycStatus(userId: number) {
    const record: any = await this.verification
      .getVerificationByUserId(userId)
      .catch(() => null);
    const v = record?.data ?? record;

    if (!v || !v.status) {
      return {
        customerId: userId,
        kycStatus: 'NOT_SUBMITTED',
        verificationLevel: 0,
        documentType: null,
        submittedAt: null,
        lastUpdatedAt: null,
        reviewedAt: null,
        rejectionReason: null,
        pendingRequirements: ['Submit an identity document and a selfie.'],
        nextSteps:
          'Open Profile → Verification and upload an identity document with a selfie.',
      };
    }

    const status = String(v.status).toUpperCase();
    const nextSteps: Record<string, string> = {
      PENDING: 'The documents are with our review team. No action is needed.',
      UNDER_REVIEW: 'The documents are being reviewed. No action is needed.',
      APPROVED: 'Verification is complete. No action is needed.',
      REJECTED: 'Please submit a new, clearly readable document.',
    };

    return {
      customerId: userId,
      kycStatus: status,
      // Binary today: the platform has no tiered verification levels, so this
      // is 1 for approved and 0 otherwise rather than a level we do not hold.
      verificationLevel: status === 'APPROVED' ? 1 : 0,
      documentType: v.document_type ?? v.documentType ?? null,
      submittedAt: v.last_submitted_at ?? v.created_at ?? null,
      firstSubmittedAt: v.created_at ?? null,
      submissionCount: Number(v.submission_count ?? 1),
      lastUpdatedAt: v.updated_at ?? null,
      reviewedAt: v.reviewed_at ?? null,
      // Written by an admin for the customer to read, so it is safe to relay.
      rejectionReason: status === 'REJECTED' ? (v.rejection_reason ?? null) : null,
      pendingRequirements:
        status === 'APPROVED' || status === 'PENDING' || status === 'UNDER_REVIEW'
          ? []
          : ['Submit a new identity document.'],
      nextSteps: nextSteps[status] ?? null,
    };
  }

  /** "01712345678" → "017****5678". Enough to confirm, not enough to reuse. */
  private maskPhone(phone: string | null): string | null {
    if (!phone) return null;
    const s = String(phone);
    if (s.length < 7) return '****';
    return `${s.slice(0, 3)}****${s.slice(-4)}`;
  }
}
