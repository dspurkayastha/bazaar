ALTER TABLE "item_defaults" ADD COLUMN "product" text;--> statement-breakpoint
ALTER TABLE "ledger_orders" ADD COLUMN "approval_id" text;--> statement-breakpoint
ALTER TABLE "ledger_orders" ADD COLUMN "unattended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "approval_used" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD COLUMN "unattended" boolean DEFAULT false NOT NULL;