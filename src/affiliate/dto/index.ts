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