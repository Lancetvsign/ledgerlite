import { z } from 'zod';

/** Account types, mirroring the account_type enum. */
export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Cash-flow sections (LL-074), mirroring the cash_flow_category enum. */
export const CASH_FLOW_CATEGORIES = ['OPERATING', 'INVESTING', 'FINANCING', 'CASH'] as const;
export type CashFlowCategory = (typeof CASH_FLOW_CATEGORIES)[number];

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

/**
 * Account creation input. `system_account_type` is deliberately ABSENT — system
 * accounts are created only by the default-COA installer (LL-041), never through
 * general creation, so there is no path to mint or claim one here.
 */
export const createAccountInput = z.object({
  name: z.string().trim().min(1, 'Account name is required.').max(200),
  accountType: z.enum(ACCOUNT_TYPES),
  accountNumber: optionalTrimmed(40),
  accountSubtype: optionalTrimmed(80),
  parentAccountId: z.uuid().optional(),
  description: optionalTrimmed(500),
  /** Cash-flow section for the Cash-Flow Statement (LL-074); optional. */
  cashFlowCategory: z.enum(CASH_FLOW_CATEGORIES).optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountInput>;

/** What may be edited on an existing account. Not type, not system flag, not company. */
export const updateAccountInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  accountNumber: optionalTrimmed(40),
  accountSubtype: optionalTrimmed(80),
  description: optionalTrimmed(500),
  cashFlowCategory: z.enum(CASH_FLOW_CATEGORIES).optional(),
});
export type UpdateAccountInput = z.infer<typeof updateAccountInput>;
