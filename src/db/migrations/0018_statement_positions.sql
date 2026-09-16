ALTER TABLE `accounts` ADD `cash_account_id` text REFERENCES accounts(id);--> statement-breakpoint
CREATE UNIQUE INDEX `ux_accounts_cash_account` ON `accounts` (`cash_account_id`);--> statement-breakpoint
ALTER TABLE `holding_events` ADD `import_file_id` text REFERENCES import_files(id);--> statement-breakpoint
CREATE INDEX `ix_holding_events_import_file` ON `holding_events` (`import_file_id`);