import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { UserModule } from 'src/user/user.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { AdminService } from './admin.service';
import { AuthModule } from 'src/auth/auth.module';

@Module({
    imports: [UserModule, AuthModule],
    providers: [AdminGuard, AdminService],
  controllers: [AdminController]
})
export class AdminModule {}
