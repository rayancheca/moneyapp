CREATE TABLE `printed_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`import_file_id` text NOT NULL,
	`account_id` text NOT NULL,
	`lines` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`import_file_id`) REFERENCES `import_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_printed_lines_file_account` ON `printed_lines` (`import_file_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `ix_printed_lines_account` ON `printed_lines` (`account_id`);