import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { AuthModule } from 'src/auth/auth.module';
import { MulterModule } from '@nestjs/platform-express';
import { S3Service } from 'src/wallet/s3.service';

@Module({
  // S3Service is provided directly rather than imported from WalletModule:
  // it has no injected dependencies (it reads AWS config from env), and
  // WalletModule does not export it.
  imports: [AuthModule, MulterModule.register({})],
  controllers: [AgentsController],
  providers: [AgentsService, AdminGuard, S3Service]
})
export class AgentsModule {}
