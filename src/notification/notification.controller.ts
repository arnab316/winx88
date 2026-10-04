// src/notification/notification.controller.ts
import {
  Controller, Get, Post, Patch, Put,
  Body, Param, Query, Req, UseGuards,
  ParseIntPipe, UsePipes, ValidationPipe,
} from '@nestjs/common';

import { NotificationService } from './notification.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import {
  ListMyNotificationsQueryDto, UpdatePreferencesDto,
  SendNotificationDto, UpsertTemplateDto, ListTemplatesQueryDto,
} from './dto/notification.dto';

@Controller('notifications')
@UsePipes(new ValidationPipe({
  whitelist: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
}))
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  // ─── PLAYER ───────────────────────────────────────────────────
  // NOTE: the static routes below are declared before `:id/read`, or Nest
  // matches "unread-count" as an :id and ParseIntPipe rejects it with a 400.

  /**
   * The inbox — and the catch-up fetch.
   *
   * Pass `sinceId` with the highest id the client already holds to get only
   * what it missed. This single call is what makes a dropped socket harmless,
   * so call it on every connect and whenever the app returns to the foreground.
   */
  @UseGuards(JwtAuthGuard)
  @Get()
  list(@Req() req: any, @Query() q: ListMyNotificationsQueryDto) {
    return this.notifications.listMine(req.user.sub, q);
  }

  /** Just the badge number. */
  @UseGuards(JwtAuthGuard)
  @Get('unread-count')
  unreadCount(@Req() req: any) {
    return this.notifications.unreadCount(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('preferences')
  getPreferences(@Req() req: any) {
    return this.notifications.getPreferences(req.user.sub);
  }

  /**
   * Opt in or out per category and channel. TRANSACTIONAL and SECURITY are
   * refused — a player cannot turn off "your withdrawal was declined".
   */
  @UseGuards(JwtAuthGuard)
  @Put('preferences')
  updatePreferences(@Req() req: any, @Body() dto: UpdatePreferencesDto) {
    return this.notifications.updatePreferences(req.user.sub, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('read-all')
  markAllRead(@Req() req: any) {
    return this.notifications.markAllRead(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/read')
  markRead(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.notifications.markRead(req.user.sub, id);
  }

  // ─── ADMIN ────────────────────────────────────────────────────

  /**
   * Send to specific players, or broadcast to every ACTIVE player.
   *
   * Goes through the same outbox as every automatic notification, so it gets
   * the same retries, preference checks and suppression rules.
   */
  @UseGuards(AdminGuard)
  @Post('admin/send')
  send(@Req() req: any, @Body() dto: SendNotificationDto) {
    return this.notifications.sendFromAdmin(dto, req.user.sub);
  }

  @UseGuards(AdminGuard)
  @Get('admin/templates')
  listTemplates(@Query() q: ListTemplatesQueryDto) {
    return this.notifications.listTemplates(q);
  }

  /**
   * Create or edit a template. This is how a new notification type is added —
   * one row here plus one emitted event, no deploy of the delivery layer.
   */
  @UseGuards(AdminGuard)
  @Put('admin/templates')
  upsertTemplate(@Body() dto: UpsertTemplateDto) {
    return this.notifications.upsertTemplate(dto);
  }

  /** Is the outbox draining? A growing PENDING count means the relay is stuck. */
  @UseGuards(AdminGuard)
  @Get('admin/health')
  health() {
    return this.notifications.outboxHealth();
  }
}
