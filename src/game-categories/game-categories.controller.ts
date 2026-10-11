import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AdminGuard } from 'src/common/guards/admin.guard';
import {
  CATEGORY_SOURCES,
  GameCategoriesService,
  type CategoryInput,
} from './game-categories.service';

/**
 * Category chips on the player home.
 *
 *   GET /game-categories/active   public — what the player panel renders
 *   GET /game-categories          admin  — including inactive ones
 */
@Controller('game-categories')
export class GameCategoriesController {
  constructor(private readonly categories: GameCategoriesService) {}

  @Get('active')
  active() {
    return this.categories.listActive();
  }

  /** The source values an admin may pick, so the UI never invents one. */
  @UseGuards(AdminGuard)
  @Get('sources')
  sources() {
    return CATEGORY_SOURCES;
  }

  @UseGuards(AdminGuard)
  @Get()
  list() {
    return this.categories.listAll();
  }

  @UseGuards(AdminGuard)
  @Post()
  create(@Body() body: CategoryInput) {
    return this.categories.create(body);
  }

  /**
   * Declared BEFORE :id — Nest matches in declaration order, so a later
   * `reorder` would be swallowed by `:id` and fail to parse as an integer.
   */
  @UseGuards(AdminGuard)
  @Patch('reorder')
  reorder(@Body() body: { ids: number[] }) {
    return this.categories.reorder(body?.ids);
  }

  @UseGuards(AdminGuard)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: Partial<CategoryInput>) {
    return this.categories.update(id, body);
  }

  @UseGuards(AdminGuard)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.categories.remove(id);
  }
}
