import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import {
  CreateMemberGroupDto,
  UpdateMemberGroupDto,
  AddUsersToGroupDto,
  RemoveUsersFromGroupDto,
} from './dto/member-group.dto';

@Injectable()
export class MemberGroupService {
     constructor(private dataSource: DataSource) {}

     // ═════════════════════════════════════════════════════════════
  // ELIGIBILITY CHECK (used by PromotionEngine)
  //   Returns true if user belongs to the given group, or if
  //   groupId is null (= no restriction).
  // ═════════════════════════════════════════════════════════════
  async isUserInGroup(
    qrOrNull: QueryRunner | null,
    userId: number,
    groupId: number | null,
  ): Promise<boolean> {
    // Null = no segmentation requirement, everyone passes
    if (!groupId) return true;
 
    const runner = qrOrNull ?? this.dataSource;
 
    // Check if it's the ALL group — everyone qualifies
    const groupRows = await runner.query(
      `SELECT code FROM member_groups WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [groupId],
    );
    if (!groupRows.length) return false;
    if (groupRows[0].code === 'ALL') return true;
 
    // Real group → check membership
    const member = await runner.query(
      `SELECT 1 FROM member_group_users
       WHERE group_id = $1 AND user_id = $2 LIMIT 1`,
      [groupId, userId],
    );
    return member.length > 0;
  }
 
  // ═════════════════════════════════════════════════════════════
  // ADMIN: CRUD
  // ═════════════════════════════════════════════════════════════
  async create(dto: CreateMemberGroupDto, adminId: number) {
    try {
      const result = await this.dataSource.query(
        `INSERT INTO member_groups (code, name, description, is_active, created_by_admin_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [dto.code, dto.name, dto.description ?? null, dto.isActive ?? true, adminId],
      );
      return result[0];
    } catch (e: any) {
      if (e.code === '23505') {
        throw new BadRequestException(`Group with code "${dto.code}" already exists`);
      }
      throw e;
    }
  }
 
  async update(id: number, dto: UpdateMemberGroupDto) {
    const existing = await this.dataSource.query(
      `SELECT * FROM member_groups WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Group not found');
 
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
 
    const map: Record<string, any> = {
      name:        dto.name,
      description: dto.description,
      is_active:   dto.isActive,
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val);
      }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');
 
    fields.push(`updated_at = NOW()`);
    values.push(id);
 
    const result = await this.dataSource.query(
      `UPDATE member_groups SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    return result[0];
  }
 
  async deleteOrDeactivate(id: number, hard = false) {
    const existing = await this.dataSource.query(
      `SELECT * FROM member_groups WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Group not found');
    const group = existing[0];
 
    if (group.is_system) {
      throw new ForbiddenException(
        `System group "${group.code}" cannot be deleted. You can deactivate it instead.`,
      );
    }
 
    if (hard) {
      // Block hard-delete if any promotion still references it
      const promosUsing = await this.dataSource.query(
        `SELECT COUNT(*)::int AS c FROM promotions WHERE member_group_id = $1`,
        [id],
      );
      if (promosUsing[0].c > 0) {
        throw new BadRequestException(
          `Cannot delete: ${promosUsing[0].c} promotion(s) still target this group. ` +
          `Reassign or delete those first, or use soft delete (is_active=false).`,
        );
      }
      await this.dataSource.query(`DELETE FROM member_groups WHERE id = $1`, [id]);
      return { message: 'Group deleted' };
    }
 
    await this.dataSource.query(
      `UPDATE member_groups SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
      [id],
    );
    return { message: 'Group deactivated' };
  }
 
  async listGroups(includeInactive = false) {
    const where = includeInactive ? '' : 'WHERE is_active = TRUE';
    return this.dataSource.query(
      `SELECT mg.*,
              (SELECT COUNT(*)::int FROM member_group_users mgu WHERE mgu.group_id = mg.id) AS member_count
       FROM member_groups mg
       ${where}
       ORDER BY mg.is_system DESC, mg.name ASC`,
    );
  }
 
  async getGroup(id: number) {
    const rows = await this.dataSource.query(
      `SELECT mg.*,
              (SELECT COUNT(*)::int FROM member_group_users mgu WHERE mgu.group_id = mg.id) AS member_count
       FROM member_groups mg
       WHERE mg.id = $1`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('Group not found');
    return rows[0];
  }
 
  // ═════════════════════════════════════════════════════════════
  // ADMIN: MEMBERSHIP MANAGEMENT
  // ═════════════════════════════════════════════════════════════
  async addUsers(groupId: number, dto: AddUsersToGroupDto, adminId: number) {
    const group = await this.getGroup(groupId);
 
    if (group.code === 'ALL') {
      throw new BadRequestException(
        'Cannot manually add users to the ALL group; it implicitly contains everyone.',
      );
    }
 
    // Validate users exist (cheaper than letting FK fail per row)
    const valid = await this.dataSource.query(
      `SELECT id FROM users WHERE id = ANY($1::bigint[])`,
      [dto.userIds],
    );
    const validIds = valid.map((r: any) => Number(r.id));
    const invalid = dto.userIds.filter((id) => !validIds.includes(id));
 
    let added = 0;
    for (const userId of validIds) {
      try {
        await this.dataSource.query(
          `INSERT INTO member_group_users (group_id, user_id, added_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (group_id, user_id) DO NOTHING`,
          [groupId, userId, adminId],
        );
        added++;
      } catch {
        // Conflict — already a member
      }
    }
 
    return {
      message: `Added ${added} user(s) to group`,
      added,
      skipped_invalid_userIds: invalid,
    };
  }
 
  async removeUsers(groupId: number, dto: RemoveUsersFromGroupDto) {
    const group = await this.getGroup(groupId);
 
    if (group.code === 'ALL') {
      throw new BadRequestException('Cannot manage membership of the ALL group');
    }
 
    const result = await this.dataSource.query(
      `DELETE FROM member_group_users
       WHERE group_id = $1 AND user_id = ANY($2::bigint[])
       RETURNING user_id`,
      [groupId, dto.userIds],
    );
 
    return { message: 'Users removed', removed: result.length };
  }
 
  async listGroupMembers(groupId: number, page = 1, limit = 50) {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const offset = (Math.max(page, 1) - 1) * safeLimit;
 
    await this.getGroup(groupId); // throws if not found
 
    const rows = await this.dataSource.query(
      `SELECT u.id, u.username, u.full_name, u.email,
              u.vip_level, u.account_status,
              mgu.added_at, mgu.added_by
       FROM member_group_users mgu
       JOIN users u ON u.id = mgu.user_id
       WHERE mgu.group_id = $1
       ORDER BY mgu.added_at DESC
       LIMIT $2 OFFSET $3`,
      [groupId, safeLimit, offset],
    );
 
    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM member_group_users WHERE group_id = $1`,
      [groupId],
    );
 
    return { data: rows, page, limit: safeLimit, total: count[0].total };
  }
 
  // ═════════════════════════════════════════════════════════════
  // USER: WHAT GROUPS DO I BELONG TO?
  // ═════════════════════════════════════════════════════════════
  async getMyGroups(userId: number) {
    return this.dataSource.query(
      `SELECT mg.id, mg.code, mg.name, mg.description, mgu.added_at
       FROM member_group_users mgu
       JOIN member_groups mg ON mg.id = mgu.group_id
       WHERE mgu.user_id = $1 AND mg.is_active = TRUE
       ORDER BY mgu.added_at DESC`,
      [userId],
    );
  }
}
