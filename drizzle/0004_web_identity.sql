CREATE TABLE "member_phones" (
	"household_id" text NOT NULL,
	"phone" text NOT NULL,
	"member_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "member_phones_household_id_phone_pk" PRIMARY KEY("household_id","phone")
);
--> statement-breakpoint
CREATE TABLE "member_pins" (
	"member_id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"hash" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consecutive" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"hard_locked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quote_rejections" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"quote_hash" text NOT NULL,
	"member_id" text NOT NULL,
	"rejected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"member_id" text NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "setup_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"household_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "setup_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"household_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "web_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"device_type" text,
	"backed_up" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "key" text;--> statement-breakpoint
-- Backfill: slug of the nickname (same rule as core/identity.ts slugify), "-2", "-3" for duplicates.
UPDATE "places" AS p SET "key" = s.k FROM (
  SELECT id, CASE WHEN rn = 1 THEN base ELSE base || '-' || rn END AS k FROM (
    SELECT id, base, row_number() OVER (PARTITION BY household_id, base ORDER BY created_at, id) AS rn FROM (
      SELECT id, household_id, created_at,
        coalesce(nullif(trim(both '-' from regexp_replace(regexp_replace(lower(nickname), '[''’]', '', 'g'), '[^a-z0-9]+', '-', 'g')), ''), 'place') AS base
      FROM "places"
    ) b
  ) r
) s WHERE p.id = s.id;--> statement-breakpoint
ALTER TABLE "places" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "member_phones" ADD CONSTRAINT "member_phones_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_phones" ADD CONSTRAINT "member_phones_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_pins" ADD CONSTRAINT "member_pins_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_pins" ADD CONSTRAINT "member_pins_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_rejections" ADD CONSTRAINT "quote_rejections_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_rejections" ADD CONSTRAINT "quote_rejections_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_codes" ADD CONSTRAINT "setup_codes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_codes" ADD CONSTRAINT "setup_codes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_phones_member_idx" ON "member_phones" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "quote_rejections_hash_idx" ON "quote_rejections" USING btree ("quote_hash");--> statement-breakpoint
CREATE INDEX "security_events_household_idx" ON "security_events" USING btree ("household_id","at");--> statement-breakpoint
CREATE INDEX "setup_codes_member_idx" ON "setup_codes" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "web_sessions_member_idx" ON "web_sessions" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "webauthn_credentials_member_idx" ON "webauthn_credentials" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "places_household_key_uq" ON "places" USING btree ("household_id","key");