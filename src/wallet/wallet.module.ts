import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthModule } from 'src/auth/auth.module';
import { S3Service } from './s3.service';
import { MulterModule } from '@nestjs/platform-express';

@Module({
   imports: [  MulterModule.register({}),AuthModule],
  controllers: [WalletController],
  providers: [WalletService, S3Service, JwtAuthGuard],
  exports: [JwtAuthGuard],
})
export class WalletModule {}
