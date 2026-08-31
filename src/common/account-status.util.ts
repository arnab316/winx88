// src/common/account-status.util.ts
//
// One place that answers "is this player allowed to transact / play?".
//
// `users.account_status` is ACTIVE | INACTIVE | SUSPENDED | LOCKED (+ legacy
// BLOCKED). Anything other than ACTIVE means an admin has taken the account
// out of circulation, so every money movement (deposit, withdrawal, wallet
// transfer) and every play action (game launch, bet) must refuse it.
//
// Login already rejects non-ACTIVE accounts, but access tokens live 7 days —
// a player suspended mid-session keeps a perfectly valid JWT until it expires.
// These checks are what actually stop them; the login check alone does not.

import { ForbiddenException, NotFoundException } from '@nestjs/common';

/** Anything that can run a parameterised query: DataSource or QueryRunner. */
export interface Queryable {
  query(sql: string, params?: any[]): Promise<any>;
}

/**
 * Throws unless the user exists AND is ACTIVE.
 * The message names the status ("Account is SUSPENDED") so the frontend can
 * show the player why the action was refused.
 */
export async function assertUserActive(
  runner: Queryable,
  userId: number,
): Promise<void> {
  if (!userId) throw new ForbiddenException('Account is not active');

  const rows = await runner.query(
    `SELECT account_status FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  if (!rows.length) throw new NotFoundException('User not found');

  const status = rows[0].account_status;
  if (status !== 'ACTIVE') {
    throw new ForbiddenException(`Account is ${status}`);
  }
}
