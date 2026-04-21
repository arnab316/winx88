import {
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import * as XLSX from 'xlsx';
import {
  CreateAgentDto,
  UpdateAgentDto,
  ListAgentsQueryDto,
} from './dto/agent.dto';

// How many recent agents the same user should NOT see again
// e.g. 3 means: rotate through at least 3 unique agents before repeating
const NO_REPEAT_WINDOW = 3;

@Injectable()
export class AgentsService {
  constructor(private dataSource: DataSource) {}

  // ──────────────────────────────────────────────────────────────
  // ADMIN: CREATE
  // ──────────────────────────────────────────────────────────────
  async createAgent(dto: CreateAgentDto, adminId: number) {
    // Verify the gateway exists and is active
    const gw = await this.dataSource.query(
      `SELECT id, name FROM payment_gateways WHERE id = $1 LIMIT 1`,
      [dto.gatewayId],
    );
    if (!gw.length) throw new BadRequestException('Payment gateway not found');

    try {
      const result = await this.dataSource.query(
        `INSERT INTO agents
           (gateway_id, wallet_type, agent_number, agent_code,
            start_date, stop_date, status, created_by_admin_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          dto.gatewayId,
          dto.walletType,
          dto.agentNumber,
          dto.agentCode ?? null,
          dto.startDate ?? null,
          dto.stopDate ?? null,
          dto.status ?? 'ACTIVE',
          adminId,
        ],
      );
      return result[0];
    } catch (err: any) {
      if (err.code === '23505') {
        throw new BadRequestException(
          'Agent with this gateway + number already exists',
        );
      }
      throw err;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // ADMIN: UPDATE
  // ──────────────────────────────────────────────────────────────
  async updateAgent(id: number, dto: UpdateAgentDto) {
    const existing = await this.dataSource.query(
      `SELECT * FROM agents WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Agent not found');

    // Build dynamic SET clause — only update provided fields
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    const map: Record<string, any> = {
      gateway_id:   dto.gatewayId,
      wallet_type:  dto.walletType,
      agent_number: dto.agentNumber,
      agent_code:   dto.agentCode,
      start_date:   dto.startDate,
      stop_date:    dto.stopDate,
      status:       dto.status,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        values.push(val);
      }
    }

    if (fields.length === 0)
      throw new BadRequestException('No fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const sql = `UPDATE agents SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;

    try {
      const result = await this.dataSource.query(sql, values);
      return result[0];
    } catch (err: any) {
      if (err.code === '23505') {
        throw new BadRequestException(
          'Another agent already has this gateway + number',
        );
      }
      throw err;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // ADMIN: DELETE  (soft delete → set INACTIVE by default;
  //                 hard delete only if no deposits linked)
  // ──────────────────────────────────────────────────────────────
  async deleteAgent(id: number, hard = false) {
    const existing = await this.dataSource.query(
      `SELECT id FROM agents WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Agent not found');

    if (hard) {
      const deps = await this.dataSource.query(
        `SELECT COUNT(*)::int AS c FROM deposits WHERE agent_id = $1`,
        [id],
      );
      if (deps[0].c > 0) {
        throw new BadRequestException(
          `Cannot hard-delete: ${deps[0].c} deposits reference this agent. ` +
          `Use soft delete (status=INACTIVE) instead.`,
        );
      }
      await this.dataSource.query(`DELETE FROM agents WHERE id = $1`, [id]);
      return { message: 'Agent deleted permanently' };
    }

    await this.dataSource.query(
      `UPDATE agents SET status = 'INACTIVE', updated_at = NOW() WHERE id = $1`,
      [id],
    );
    return { message: 'Agent marked INACTIVE' };
  }

  // ──────────────────────────────────────────────────────────────
  // ADMIN: LIST  (with filters + pagination)
  // ──────────────────────────────────────────────────────────────
  async listAgents(q: ListAgentsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (q.status)      { where.push(`a.status = $${i++}`);       params.push(q.status); }
    if (q.gatewayId)   { where.push(`a.gateway_id = $${i++}`);   params.push(q.gatewayId); }
    if (q.walletType)  { where.push(`a.wallet_type = $${i++}`);  params.push(q.walletType); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await this.dataSource.query(
      `SELECT a.*, g.name AS gateway_name
       FROM agents a
       JOIN payment_gateways g ON g.id = a.gateway_id
       ${whereSql}
       ORDER BY a.status ASC, a.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );

    const total = await this.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM agents a ${whereSql}`,
      params,
    );

    return { data: rows, page, limit, total: total[0].c };
  }

  // ──────────────────────────────────────────────────────────────
  // USER: GET AGENT FOR DEPOSIT (round-robin, no-repeat window)
  //
  //   Algorithm:
  //   1. SELECT all ACTIVE agents for this gateway
  //   2. EXCLUDE the last N agents this user was shown (N = NO_REPEAT_WINDOW)
  //   3. If that leaves nothing → ignore the exclusion (edge case: only
  //      1–2 agents total)
  //   4. Pick the one with LOWEST assignment_count (= least recently used globally)
  //   5. Lock it, increment counter, log the assignment
  //   All inside one transaction to prevent two users getting the same
  //   agent at the same millisecond.
  // ──────────────────────────────────────────────────────────────
  async getAgentForDeposit(userId: number, gatewayId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // Step 1+2: pick next agent, excluding recently-shown ones
      let agent = await this.pickNextAgent(qr, userId, gatewayId, true);

      // Step 3: fallback — if excluded window wiped out all agents,
      // pick from the full active pool anyway
      if (!agent) {
        agent = await this.pickNextAgent(qr, userId, gatewayId, false);
      }

      if (!agent) {
        throw new NotFoundException(
          'No active agents available for this gateway. Please try again later.',
        );
      }

      // Step 4: bump its counter
      await qr.query(
        `UPDATE agents
         SET assignment_count = assignment_count + 1,
             last_assigned_at = NOW()
         WHERE id = $1`,
        [agent.id],
      );

      // Step 5: log the assignment
      await qr.query(
        `INSERT INTO agent_assignments (agent_id, user_id, gateway_id)
         VALUES ($1, $2, $3)`,
        [agent.id, userId, gatewayId],
      );

      await qr.commitTransaction();

      return {
        agentId:     agent.id,
        walletType:  agent.wallet_type,
        agentNumber: agent.agent_number,
        agentCode:   agent.agent_code,
        gatewayName: agent.gateway_name,
        instruction: `Send the deposit amount to ${agent.wallet_type} number ${agent.agent_number}. ` +
                     `Then submit your transaction ID and screenshot.`,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // Private helper used by getAgentForDeposit
  private async pickNextAgent(
    qr: QueryRunner,
    userId: number,
    gatewayId: number,
    excludeRecent: boolean,
  ) {
    let excludeClause = '';
    const params: any[] = [gatewayId];

    if (excludeRecent) {
      // last N agent_ids shown to this user
      const recent = await qr.query(
        `SELECT DISTINCT agent_id
         FROM agent_assignments
         WHERE user_id = $1
         ORDER BY agent_id
         LIMIT $2`,
        [userId, NO_REPEAT_WINDOW],
      );
      const recentIds: number[] = recent.map((r: any) => Number(r.agent_id));

      if (recentIds.length > 0) {
        excludeClause = `AND a.id NOT IN (${recentIds.map((_, idx) => `$${idx + 2}`).join(',')})`;
        params.push(...recentIds);
      }
    }

    // FOR UPDATE SKIP LOCKED → two simultaneous calls won't lock the same row
    const rows = await qr.query(
      `SELECT a.*, g.name AS gateway_name
       FROM agents a
       JOIN payment_gateways g ON g.id = a.gateway_id
       WHERE a.gateway_id = $1
         AND a.status = 'ACTIVE'
         ${excludeClause}
       ORDER BY a.assignment_count ASC, a.last_assigned_at ASC NULLS FIRST
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      params,
    );

    return rows[0] ?? null;
  }

  // ──────────────────────────────────────────────────────────────
  // ADMIN: BULK UPLOAD (Excel)
  //
  //   Expected columns (matches your Agent_List_2026.xlsx):
  //     Wallet | Number | Agent Code | Start Date | Stop Date | Status
  //
  //   - Reads xlsx from Multer upload
  //   - Parses both "Active" and "Inactive" blocks if present
  //   - Inserts valid rows, skips/logs invalid ones
  //   - Returns { inserted, skipped, errors[] }
  // ──────────────────────────────────────────────────────────────
  async bulkUploadFromExcel(fileBuffer: Buffer, adminId: number) {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
    } catch (e) {
      throw new BadRequestException('Invalid Excel file');
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Read as 2D array so we can handle the split Active/Inactive layout
    const matrix: any[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: null,
    });

    // Fetch all gateways once (to resolve wallet_type → gateway_id)
    const gatewaysRaw = await this.dataSource.query(
      `SELECT id, name FROM payment_gateways WHERE is_active = true`,
    );
    const gatewayMap = new Map<string, number>();
    for (const g of gatewaysRaw) {
      gatewayMap.set(g.name.toLowerCase().trim(), Number(g.id));
    }

    const inserted: any[] = [];
    const errors: Array<{ row: number; reason: string }> = [];

    // Your Excel has two blocks side by side.
    // Active block: columns 1..6 (B..G)
    // Inactive block: columns 9..14 (J..O)
    // We parse both and set status appropriately.
    const parseBlock = async (
      rows: any[][],
      colOffset: number,
      defaultStatus: 'ACTIVE' | 'INACTIVE',
    ) => {
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const walletRaw = row[colOffset];
        const numberRaw = row[colOffset + 1];
        const codeRaw   = row[colOffset + 2];
        const startRaw  = row[colOffset + 3];
        const stopRaw   = row[colOffset + 4];
        const statusRaw = row[colOffset + 5];

        // Skip empty rows and header rows
        if (!walletRaw || !numberRaw) continue;
        const walletStr = String(walletRaw).trim();
        if (walletStr.toLowerCase() === 'wallet') continue; // header

        // Resolve gateway
        const gwKey = walletStr.toLowerCase();
        const gatewayId = gatewayMap.get(gwKey);
        if (!gatewayId) {
          errors.push({
            row: r + 1,
            reason: `Unknown gateway "${walletStr}". Seed it in payment_gateways first.`,
          });
          continue;
        }

        const agentNumber = String(numberRaw).replace(/\.0$/, '').trim();
        const agentCode   = codeRaw != null ? String(codeRaw).replace(/\.0$/, '').trim() : null;

        const startDate = this.normalizeDate(startRaw);
        const stopDate  = this.normalizeDate(stopRaw);

        const status =
          (statusRaw && String(statusRaw).trim().toUpperCase() === 'INACTIVE')
            ? 'INACTIVE'
            : defaultStatus;

        try {
          const ins = await this.dataSource.query(
            `INSERT INTO agents
              (gateway_id, wallet_type, agent_number, agent_code,
               start_date, stop_date, status, created_by_admin_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (gateway_id, agent_number) DO UPDATE
               SET wallet_type = EXCLUDED.wallet_type,
                   agent_code  = EXCLUDED.agent_code,
                   start_date  = EXCLUDED.start_date,
                   stop_date   = EXCLUDED.stop_date,
                   status      = EXCLUDED.status,
                   updated_at  = NOW()
             RETURNING id, wallet_type, agent_number, status`,
            [
              gatewayId,
              walletStr,
              agentNumber,
              agentCode,
              startDate,
              stopDate,
              status,
              adminId,
            ],
          );
          inserted.push(ins[0]);
        } catch (err: any) {
          errors.push({
            row: r + 1,
            reason: err.message || 'Insert failed',
          });
        }
      }
    };

    // Parse both blocks
    await parseBlock(matrix, 1, 'ACTIVE');   // columns B..G
    await parseBlock(matrix, 9, 'INACTIVE'); // columns J..O

    return {
      message: 'Bulk upload completed',
      inserted: inserted.length,
      failed: errors.length,
      insertedAgents: inserted,
      errors,
    };
  }

  // Convert whatever Excel gave us (Date object | "2026-04-11" | null) to YYYY-MM-DD
  private normalizeDate(raw: any): string | null {
    if (!raw) return null;
    if (raw instanceof Date) {
      return raw.toISOString().slice(0, 10);
    }
    // Try to parse strings
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
}