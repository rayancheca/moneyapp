CREATE TABLE `transfer_ambiguities` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`ambiguity_key` text NOT NULL,
	`anchor_transaction_id` text,
	`leg_count` integer NOT NULL,
	`reason_detail` text NOT NULL,
	`resolution` text DEFAULT 'unresolved' NOT NULL,
	`resolved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`anchor_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_transfer_ambiguities_key` ON `transfer_ambiguities` (`ambiguity_key`);--> statement-breakpoint
CREATE INDEX `ix_transfer_ambiguities_resolution_account` ON `transfer_ambiguities` (`resolution`,`account_id`);--> statement-breakpoint
CREATE INDEX `ix_transfer_ambiguities_anchor` ON `transfer_ambiguities` (`anchor_transaction_id`);