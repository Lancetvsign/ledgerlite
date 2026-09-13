CREATE TYPE "public"."invitation_status" AS ENUM('PENDING', 'ACCEPTED', 'REVOKED');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'MEMBER_INVITED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'MEMBER_ADDED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'MEMBER_ROLE_CHANGED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'MEMBER_REMOVED';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'INVITATION_REVOKED';--> statement-breakpoint
CREATE TABLE "company_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"status" "invitation_status" DEFAULT 'PENDING' NOT NULL,
	"invited_by" uuid NOT NULL,
	"accepted_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "company_invitations_company_id_id_unique" UNIQUE("company_id","id"),
	CONSTRAINT "company_invitations_email_lowercase" CHECK ("company_invitations"."email" = lower(btrim("company_invitations"."email"))),
	CONSTRAINT "company_invitations_accepted_stamp" CHECK (("company_invitations"."status" = 'ACCEPTED') = ("company_invitations"."accepted_user_id" is not null)),
	CONSTRAINT "company_invitations_resolved_stamp" CHECK (("company_invitations"."status" <> 'PENDING') = ("company_invitations"."resolved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_invitations_pending_email_unique" ON "company_invitations" USING btree ("company_id","email") WHERE "company_invitations"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "company_invitations_pending_by_email_idx" ON "company_invitations" USING btree ("email") WHERE "company_invitations"."status" = 'PENDING';