ALTER TABLE `transactions` ADD `series_link_source` text;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `user_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `user_cadence` text;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `user_next_expected_on` text;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `merged_into_id` text REFERENCES `recurring_series`(`id`);