CREATE TYPE "public"."cash_flow_category" AS ENUM('OPERATING', 'INVESTING', 'FINANCING', 'CASH');--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "cash_flow_category" "cash_flow_category";