CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"quote_hash" text NOT NULL,
	"member_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"conditions" jsonb,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"policy" jsonb NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_defaults" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"key" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"brand" text,
	"size" text,
	"quantity_per_head" real,
	"category" text NOT NULL,
	"never_substitute" boolean DEFAULT false NOT NULL,
	"supplier_hints" jsonb,
	"origin" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"name" text NOT NULL,
	"variant_id" text,
	"quantity" integer NOT NULL,
	"unit_price" integer NOT NULL,
	"line_total" integer NOT NULL,
	"category" text,
	"added_by" text,
	"item_key" text
);
--> statement-breakpoint
CREATE TABLE "ledger_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_order_id" text NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"place_id" text,
	"supplier_address_id" text,
	"member_id" text,
	"fees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total" integer NOT NULL,
	"status" text NOT NULL,
	"quote_hash" text,
	"decision" jsonb,
	"raw" jsonb,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_place_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"nickname" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"canonical_address" text NOT NULL,
	"city" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"supplier_address_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"serviceability" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trusted" boolean DEFAULT false NOT NULL,
	"profile_overlay" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"quote_hash" text NOT NULL,
	"live_cart_hash" text NOT NULL,
	"place_id" text,
	"member_id" text,
	"verdict" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"approval_id" text,
	"evaluated_at" timestamp with time zone NOT NULL,
	"supplier_order_id" text
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"household_id" text PRIMARY KEY NOT NULL,
	"profile" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"household_id" text NOT NULL,
	"request_id" text,
	"supplier_id" text NOT NULL,
	"place_id" text NOT NULL,
	"supplier_address_id" text NOT NULL,
	"total" integer NOT NULL,
	"quote" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"member_id" text NOT NULL,
	"channel" text NOT NULL,
	"text" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"context" jsonb,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "supplier_tokens" (
	"household_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"blob" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_tokens_household_id_supplier_id_pk" PRIMARY KEY("household_id","supplier_id")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_defaults" ADD CONSTRAINT "item_defaults_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_lines" ADD CONSTRAINT "ledger_lines_order_id_ledger_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ledger_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_orders" ADD CONSTRAINT "ledger_orders_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_orders" ADD CONSTRAINT "ledger_orders_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_orders" ADD CONSTRAINT "ledger_orders_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_tokens" ADD CONSTRAINT "supplier_tokens_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_quote_hash_idx" ON "approvals" USING btree ("quote_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "item_defaults_household_key_uq" ON "item_defaults" USING btree ("household_id","key");--> statement-breakpoint
CREATE INDEX "ledger_lines_order_idx" ON "ledger_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "ledger_lines_item_key_idx" ON "ledger_lines" USING btree ("item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_orders_supplier_order_uq" ON "ledger_orders" USING btree ("supplier_id","supplier_order_id");--> statement-breakpoint
CREATE INDEX "ledger_orders_household_placed_idx" ON "ledger_orders" USING btree ("household_id","placed_at");--> statement-breakpoint
CREATE INDEX "members_household_idx" ON "members" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "places_household_nickname_uq" ON "places" USING btree ("household_id","nickname");--> statement-breakpoint
CREATE UNIQUE INDEX "places_one_default_uq" ON "places" USING btree ("household_id") WHERE "places"."is_default" = true;--> statement-breakpoint
CREATE INDEX "policy_decisions_quote_hash_idx" ON "policy_decisions" USING btree ("quote_hash");--> statement-breakpoint
CREATE INDEX "quotes_household_idx" ON "quotes" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "requests_household_received_idx" ON "requests" USING btree ("household_id","received_at");