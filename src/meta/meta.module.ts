import { Global, Module } from '@nestjs/common';
import { MetaCapiClient } from './meta-capi.client';
import { MetaCapiService } from './meta-capi.service';

/**
 * Meta Conversions API.
 *
 * @Global because the enqueue hooks live in modules that have no other reason
 * to know about Meta — WalletService (deposit approval) and AuthService
 * (registration). Importing MetaModule into each of those would create import
 * cycles for what is a single fire-and-forget call.
 */
@Global()
@Module({
  providers: [MetaCapiClient, MetaCapiService],
  exports: [MetaCapiClient, MetaCapiService],
})
export class MetaModule {}
