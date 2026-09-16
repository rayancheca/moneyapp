CREATE TABLE `statement_copies` (
	`id` text PRIMARY KEY NOT NULL,
	`import_file_id` text NOT NULL,
	`account_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`lines` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`import_file_id`) REFERENCES `import_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_statement_copies_file_account` ON `statement_copies` (`import_file_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `ix_statement_copies_period` ON `statement_copies` (`account_id`,`period_start`,`period_end`);