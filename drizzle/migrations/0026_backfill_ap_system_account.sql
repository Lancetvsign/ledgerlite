-- LL-068 — backfill the Accounts Payable control account.
--
-- Accounts Payable is now a REQUIRED system account (src/server/accounts/default-coa.ts),
-- so every NEW company gets it at creation. This migration gives it to companies created
-- BEFORE that change on the 'system-only' chart, which historically seeded only A/R,
-- Retained Earnings and Opening Balance Equity — leaving A/P documents to fail closed with
-- AP_ACCOUNT_NOT_CONFIGURED. Companies on the 'standard' chart already have 2000 Accounts
-- Payable (tagged by migration 0022), so the first NOT EXISTS skips them.
--
-- Idempotent and safe to replay: the NOT EXISTS guards make a second run insert nothing, and
-- a clean-slate replay (CI's ephemeral branches) simply finds no qualifying companies. Column
-- defaults supply id (gen_random_uuid), status (ACTIVE) and the timestamps.
--
-- The second NOT EXISTS is deliberate: if a company already uses account number 2000 for
-- something else, inserting A/P there would violate the (company_id, account_number) unique
-- constraint. Rather than renumber a user's account inside a migration, we skip that company
-- and leave it to the authorized re-install (installDefaultChartFor). ON CONFLICT DO NOTHING
-- is a final belt-and-suspenders against the (company_id, system_account_type) unique index
-- under any concurrent install.
INSERT INTO accounts (company_id, account_number, name, account_type, account_subtype, system_account_type)
SELECT c.id, '2000', 'Accounts Payable', 'LIABILITY', 'accounts_payable', 'ACCOUNTS_PAYABLE'
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.system_account_type = 'ACCOUNTS_PAYABLE'
)
AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.account_number = '2000'
)
ON CONFLICT DO NOTHING;
