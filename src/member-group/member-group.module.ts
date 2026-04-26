import { Module } from '@nestjs/common';
import { MemberGroupService } from './member-group.service';
import { MemberGroupController } from './member-group.controller';

@Module({
  providers: [MemberGroupService],
  controllers: [MemberGroupController]
})
export class MemberGroupModule {}
