export interface CreditCoinsParams {
  userId:        number;
  coinsToCredit: number;
  referenceType: string;
  referenceId:   number;
  description:   string;
}

export interface UpdateCoinSettingsDto {
  adminId:           number;
  coinsPerUnit:      number;
  depositUnit:       number;
  minDepositAmount:  number;
  maxDepositAmount?: number;
}

export interface UpsertVipLevelDto {
  adminId:        number;
  level:          number;
  levelName:      string;
  groupName?:     string;
  coinsRequired:  number;
  badgeIconUrl?:  string;
  benefits?:      Record<string, any>;
}