import { Global, Module } from '@nestjs/common';
import { ReferralEngineService } from './referral-engine.service';

/**
 * The referral lifecycle engine, exposed globally so the two host services
 * (TurnoverService, WalletService) can inject it WITHOUT importing a module —
 * which avoids the Auth↔Promotion↔Turnover import cycle.
 *
 * Depends only on DataSource and the (global) FinancialLedgerService, so this
 * module imports nothing and creates no cycles of its own.
 */
@Global()
@Module({
  providers: [ReferralEngineService],
  exports: [ReferralEngineService],
})
export class ReferralEngineModule {}
