CREATE TABLE `insight_selections` (
	`fact_hash` text PRIMARY KEY NOT NULL,
	`surface` text NOT NULL,
	`claim_keys` text NOT NULL,
	`model` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `insight_selections_surface_idx` ON `insight_selections` (`surface`);