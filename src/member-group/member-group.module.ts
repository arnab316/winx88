import { Module ,forwardRef} from '@nestjs/common';
import { MemberGroupService } from './member-group.service';
import { MemberGroupController } from './member-group.controller';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [ forwardRef(() => AuthModule) ],
  providers: [MemberGroupService, JwtAuthGuard],
  controllers: [MemberGroupController],
  exports: [MemberGroupService],
})
export class MemberGroupModule {}
