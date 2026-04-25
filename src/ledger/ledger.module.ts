import { Module, Global } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { LedgerController } from './ledger.controller';
import { FinancialLedgerService } from './financial-ledger.service';
import { CoinLedgerService } from './coin-ledger.service';
import { TurnoverLedgerService } from './turnover-ledger.service';
@Global()
@Module({
  providers: [FinancialLedgerService,
    CoinLedgerService,
    TurnoverLedgerService,],
  // controllers: [LedgerController],
  exports: [
    FinancialLedgerService,
    CoinLedgerService,
    TurnoverLedgerService,
  ],
})
export class LedgerModule {}
