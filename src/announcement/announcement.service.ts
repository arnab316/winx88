import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

/**
 * Marquee announcements — a single line of text the admin sets, shown in the
 * frontend scrolling banner. Stored in the `announcements` table.
 */
@Injectable()
export class AnnouncementService {
  constructor(private readonly dataSource: DataSource) {}

  // ─── Public: active lines for the marquee ────────────────────────────────
  async getActive() {
    return this.dataSource.query(
      `SELECT id, message
       FROM announcements
       WHERE is_active = TRUE
       ORDER BY updated_at DESC, id DESC`,
    );
  }

  // ─── Admin: list everything (active + inactive) ──────────────────────────
  async list() {
    return this.dataSource.query(
      `SELECT id, message, is_active, created_at, updated_at
       FROM announcements
       ORDER BY updated_at DESC, id DESC`,
    );
  }

  // ─── Admin: create a line ────────────────────────────────────────────────
  async create(dto: CreateAnnouncementDto) {
    const rows = await this.dataSource.query(
      `INSERT INTO announcements (message, is_active)
       VALUES ($1, $2)
       RETURNING id, message, is_active, created_at, updated_at`,
      [dto.message, dto.isActive ?? true],
    );
    return rows[0];
  }

  // ─── Admin: update text and/or active state ──────────────────────────────
  async update(id: number, dto: UpdateAnnouncementDto) {
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    if (dto.message !== undefined) {
      fields.push(`message = $${i++}`);
      values.push(dto.message);
    }
    if (dto.isActive !== undefined) {
      fields.push(`is_active = $${i++}`);
      values.push(dto.isActive);
    }
    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const rows = await this.dataSource.query(
      `UPDATE announcements SET ${fields.join(', ')}
       WHERE id = $${i}
       RETURNING id, message, is_active, created_at, updated_at`,
      values,
    );
    if (!rows.length) throw new NotFoundException('Announcement not found');
    return rows[0];
  }

  // ─── Admin: delete a line ────────────────────────────────────────────────
  async remove(id: number) {
    const rows = await this.dataSource.query(
      `DELETE FROM announcements WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Announcement not found');
    return { message: 'Announcement deleted', id: Number(rows[0].id) };
  }
}
