export interface ApplyAffiliateDto {
  userId: number;
  notes?: string;
}

export interface DecideApplicationDto {
  applicationId: number;
  adminId:        number;
  action:         'APPROVE' | 'REJECT';
  rejectionReason?: string;
  commissionPct?:   number;
  /** Optional RevShare % override applied on approval (else auto-tiered monthly). */
  revshareRate?:    number;
  /** Optional affiliate group assigned on approval ("Assign group & approve"). */
  groupId?:         number;
}

export interface UpdateCommissionDto {
  affiliateUserId: number;
  adminId:         number;
  commissionPct:   number;
}

export interface ToggleAffiliateDto {
  affiliateUserId: number;
  adminId:         number;
  isActive:        boolean;
}