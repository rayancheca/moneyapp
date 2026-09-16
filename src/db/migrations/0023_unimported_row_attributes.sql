CREATE TABLE `unimported_row_attributes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`posted_on` text NOT NULL,
	`transacted_on` text,
	`amount_cents` integer NOT NULL,
	`normalized_description` text NOT NULL,
	`dedupe_hash` text NOT NULL,
	`category_id` text,
	`categorization_source` text,
	`categorization_confidence` real,
	`merchant_id` text,
	`needs_review` integer DEFAULT false NOT NULL,
	`notes` text,
	`recurring_series_id` text,
	`series_link_source` text,
	`excluded` integer DEFAULT false NOT NULL,
	`splits` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_unimported_row_attributes_account` ON `unimported_row_attributes` (`account_id`,`posted_on`);--> statement-breakpoint
ALTER TABLE `unimported_transfer_legs` ADD `merchant_id` text;