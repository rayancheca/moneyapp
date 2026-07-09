CREATE TABLE `holding_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`symbol` text NOT NULL,
	`asset_type` text NOT NULL,
	`occurred_on` text NOT NULL,
	`quantity_delta_e8` integer NOT NULL,
	`cost_cents` integer,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_holding_events_account_symbol_date` ON `holding_events` (`account_id`,`symbol`,`occurred_on`);