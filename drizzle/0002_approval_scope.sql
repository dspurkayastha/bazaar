ALTER TABLE "approvals" ADD COLUMN "place_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "supplier_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;