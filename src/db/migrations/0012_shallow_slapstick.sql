ALTER TABLE `budgets` ADD `rollover_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `budgets` ADD `rollover_starts_on` text;--> statement-breakpoint
ALTER TABLE `budgets` ADD `rollover_cap_cents` integer;