import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { AnnouncementService } from './announcement.service';
import { AdminGuard } from 'src/common/guards/admin.guard';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

@Controller('announcements')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class AnnouncementController {
  constructor(private readonly service: AnnouncementService) {}

  // ─── Public ──────────────────────────────────────────────────────────────
  // GET /announcements/active — active marquee lines for the frontend
  @Get('active')
  getActive() {
    return this.service.getActive();
  }

  // ─── Admin ───────────────────────────────────────────────────────────────
  // GET /announcements/admin — list all (active + inactive)
  @UseGuards(AdminGuard)
  @Get('admin')
  list() {
    return this.service.list();
  }

  // POST /announcements/admin — create a line
  @UseGuards(AdminGuard)
  @Post('admin')
  create(@Body() dto: CreateAnnouncementDto) {
    return this.service.create(dto);
  }

  // PATCH /announcements/admin/:id — update text and/or active state
  @UseGuards(AdminGuard)
  @Patch('admin/:id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAnnouncementDto,
  ) {
    return this.service.update(id, dto);
  }

  // DELETE /announcements/admin/:id — remove a line
  @UseGuards(AdminGuard)
  @Delete('admin/:id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
