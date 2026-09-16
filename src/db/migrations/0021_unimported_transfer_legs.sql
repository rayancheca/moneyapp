CREATE TABLE `unimported_transfer_legs` (
	`id` text PRIMARY KEY NOT NULL,
	`transfer_group_id` text NOT NULL,
	`transaction_id` text,
	`account_id` text NOT NULL,
	`posted_on` text NOT NULL,
	`transacted_on` text,
	`amount_cents` integer NOT NULL,
	`normalized_description` text NOT NULL,
	`category_id` text,
	`categorization_source` text,
	`categorization_confidence` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_unimported_transfer_legs_group` ON `unimported_transfer_legs` (`transfer_group_id`);--> statement-breakpoint
CREATE INDEX `ix_unimported_transfer_legs_account` ON `unimported_transfer_legs` (`account_id`,`posted_on`);