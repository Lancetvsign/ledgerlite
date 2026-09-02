CREATE TYPE "public"."audit_action" AS ENUM('ACCOUNT_CREATED', 'ACCOUNT_UPDATED', 'ACCOUNT_DEACTIVATED', 'ACCOUNTING_PERIOD_CLOSED', 'ACCOUNTING_PERIOD_REOPENED');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" "audit_action" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_json" jsonb,
	"after_json" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_company_id_id_unique" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_company_entity_idx" ON "audit_events" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_company_created_idx" ON "audit_events" USING btree ("company_id","created_at");
--> statement-breakpoint
-- APPEND-ONLY ENFORCEMENT. The value of an audit log is that it cannot be
-- revised, so the database refuses every UPDATE and DELETE — for EVERY role,
-- the table owner included (the app and migrations both run as neondb_owner,
-- so an owner bypass would protect nothing). INSERT is unaffected.
--
-- Erasing a record for a legitimate reason (retention, GDPR) is then a
-- deliberate, reviewed migration that DROPs this trigger, acts, and recreates
-- it — never an application write. That friction is the point.
CREATE OR REPLACE FUNCTION "audit_events_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_immutable"();
