import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreateReferralInfoStatDto,
  UpdateReferralInfoStatDto,
} from './dto/referral-info-stat.dto';

/**
 * CRUD service for the `referral_info_stat` table.
 *
 * Table schema (already created in PostgreSQL):
 *   id           SERIAL PRIMARY KEY
 *   no_of_people INTEGER NOT NULL
 *   amount       NUMERIC NOT NULL
 *   created_at   TIMESTAMPTZ DEFAULT NOW()
 *   updated_at   TIMESTAMPTZ DEFAULT NOW()
 */
@Injectable()
export class ReferralInfoStatService {
  constructor(private readonly dataSource: DataSource) {}

  // ── CREATE ──────────────────────────────────────────────────────────────────
  async create(dto: CreateReferralInfoStatDto) {
    const [row] = await this.dataSource.query(
      `INSERT INTO referral_info_stat (no_of_people, amount)
       VALUES ($1, $2)
       RETURNING *`,
      [dto.no_of_people, dto.amount],
    );
    return row;
  }

  // ── READ ALL ─────────────────────────────────────────────────────────────────
  async findAll() {
    const rows = await this.dataSource.query(
      `SELECT * FROM referral_info_stat ORDER BY id DESC`,
    );
    return rows;
  }

  // ── READ ONE ─────────────────────────────────────────────────────────────────
  async findOne(id: number) {
    const [row] = await this.dataSource.query(
      `SELECT * FROM referral_info_stat WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException(`referral_info_stat with id ${id} not found`);
    return row;
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────────
  async update(id: number, dto: UpdateReferralInfoStatDto) {
    // Ensure the record exists first
    await this.findOne(id);

    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (dto.no_of_people !== undefined) {
      sets.push(`no_of_people = $${i++}`);
      params.push(dto.no_of_people);
    }
    if (dto.amount !== undefined) {
      sets.push(`amount = $${i++}`);
      params.push(dto.amount);
    }

    if (!sets.length) {
      throw new BadRequestException('At least one field (no_of_people, amount) must be provided');
    }

    sets.push(`updated_at = NOW()`);
    params.push(id);

    const [updated] = await this.dataSource.query(
      `UPDATE referral_info_stat
          SET ${sets.join(', ')}
        WHERE id = $${i}
        RETURNING *`,
      params,
    );
    return updated;
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────
  async remove(id: number) {
    // Ensure the record exists first
    await this.findOne(id);

    await this.dataSource.query(
      `DELETE FROM referral_info_stat WHERE id = $1`,
      [id],
    );
    return { message: `referral_info_stat record ${id} deleted successfully` };
  }
}
