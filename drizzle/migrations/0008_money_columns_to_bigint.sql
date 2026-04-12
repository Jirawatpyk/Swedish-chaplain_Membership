ALTER TABLE "membership_plans" ALTER COLUMN "annual_fee_minor_units" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "membership_plans" ALTER COLUMN "min_turnover_minor_units" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "membership_plans" ALTER COLUMN "max_turnover_minor_units" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "tenant_fee_config" ALTER COLUMN "registration_fee_minor_units" SET DATA TYPE bigint;