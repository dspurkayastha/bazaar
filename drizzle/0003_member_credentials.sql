CREATE TABLE "member_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "member_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "member_credentials" ADD CONSTRAINT "member_credentials_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_credentials_member_idx" ON "member_credentials" USING btree ("member_id");