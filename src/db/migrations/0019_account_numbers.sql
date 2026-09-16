CREATE TABLE `account_numbers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`last4` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_account_numbers_account_last4` ON `account_numbers` (`account_id`,`last4`);