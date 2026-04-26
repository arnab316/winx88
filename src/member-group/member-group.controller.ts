import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';

import { MemberGroupService } from './member-group.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AddUsersToGroupDto, CreateMemberGroupDto, RemoveUsersFromGroupDto, UpdateMemberGroupDto } from './dto/member-group.dto';
@Controller('member-group')
export class MemberGroupController {
    constructor(
        private readonly groupService: MemberGroupService
    ) {}
    // ─── USER ────────────────────────────────────────────────────
 
  // GET /member-groups/me
  @UseGuards(JwtAuthGuard)
  @Get('me')
  myGroups(@Req() req: any) {
    return this.groupService.getMyGroups(req.user.sub);
  }
 
  // ─── ADMIN ───────────────────────────────────────────────────
 
  // GET /member-groups/admin?includeInactive=true
  @UseGuards(AdminGuard)
  @Get('admin')
  list(@Query('includeInactive') includeInactive?: string) {
    return this.groupService.listGroups(includeInactive === 'true');
  }
 
  // GET /member-groups/admin/:id
  @UseGuards(AdminGuard)
  @Get('admin/:id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.groupService.getGroup(id);
  }
 
  // POST /member-groups/admin
  @UseGuards(AdminGuard)
  @Post('admin')
  create(@Req() req: any, @Body() dto: CreateMemberGroupDto) {
    return this.groupService.create(dto, req.user.sub);
  }
 
  // PATCH /member-groups/admin/:id
  @UseGuards(AdminGuard)
  @Patch('admin/:id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMemberGroupDto) {
    return this.groupService.update(id, dto);
  }
 
  // DELETE /member-groups/admin/:id            → soft delete (deactivate)
  // DELETE /member-groups/admin/:id?hard=true  → hard delete (rejected if in use)
  @UseGuards(AdminGuard)
  @Delete('admin/:id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Query('hard') hard?: string,
  ) {
    return this.groupService.deleteOrDeactivate(id, hard === 'true');
  }
 
  // GET /member-groups/admin/:id/members?page=1&limit=50
  @UseGuards(AdminGuard)
  @Get('admin/:id/members')
  listMembers(
    @Param('id', ParseIntPipe) id: number,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.groupService.listGroupMembers(id, page, limit);
  }
 
  // POST /member-groups/admin/:id/add-users
  // body: { userIds: [1, 2, 3] }
  @UseGuards(AdminGuard)
  @Post('admin/:id/add-users')
  addUsers(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddUsersToGroupDto,
  ) {
    return this.groupService.addUsers(id, dto, req.user.sub);
  }
 
  // POST /member-groups/admin/:id/remove-users
  @UseGuards(AdminGuard)
  @Post('admin/:id/remove-users')
  removeUsers(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RemoveUsersFromGroupDto,
  ) {
    return this.groupService.removeUsers(id, dto);
  }
}
