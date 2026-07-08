CREATE TABLE `institutions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `institutions_name_unique` ON `institutions` (`name`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`institution_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`subtype` text,
	`last4` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`kind` text NOT NULL,
	`icon` text,
	`color` text,
	`is_system` integer DEFAULT false NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_categories_parent_name` ON `categories` (`parent_id`,`name`);--> statement-breakpoint
CREATE TABLE `import_files` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`file_sha256` text NOT NULL,
	`format` text NOT NULL,
	`institution_id` text NOT NULL,
	`parser_profile` text,
	`parser_version` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`superseded_by` text,
	`error` text,
	`storage_path` text NOT NULL,
	`imported_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by`) REFERENCES `import_files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_import_files_sha_parser` ON `import_files` (`file_sha256`,`parser_version`);--> statement-breakpoint
CREATE TABLE `statement_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`import_file_id` text NOT NULL,
	`account_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`beginning_balance_cents` integer,
	`ending_balance_cents` integer,
	`market_change_cents` integer,
	`reconciliation` text NOT NULL,
	`gap_cents` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`import_file_id`) REFERENCES `import_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_statement_periods_file_account` ON `statement_periods` (`import_file_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `merchant_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`pattern` text NOT NULL,
	`match_type` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_merchant_aliases_pattern_type` ON `merchant_aliases` (`pattern`,`match_type`);--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_name` text NOT NULL,
	`default_category_id` text,
	`mapping_source` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`default_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_canonical_name_unique` ON `merchants` (`canonical_name`);--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`times_applied` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`import_file_id` text,
	`statement_period_id` text,
	`posted_on` text NOT NULL,
	`transacted_on` text,
	`amount_cents` integer NOT NULL,
	`raw_description` text NOT NULL,
	`normalized_description` text NOT NULL,
	`bank_category` text,
	`merchant_id` text,
	`category_id` text,
	`categorization_source` text,
	`categorization_confidence` real,
	`needs_review` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`transfer_group_id` text,
	`recurring_series_id` text,
	`fitid` text,
	`occurrence_index` integer DEFAULT 0 NOT NULL,
	`dedupe_hash` text NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_file_id`) REFERENCES `import_files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`statement_period_id`) REFERENCES `statement_periods`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recurring_series_id`) REFERENCES `recurring_series`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_transactions_account_dedupe` ON `transactions` (`account_id`,`dedupe_hash`) WHERE status != 'superseded';--> statement-breakpoint
CREATE INDEX `ix_transactions_account_posted` ON `transactions` (`account_id`,`posted_on`);--> statement-breakpoint
CREATE INDEX `ix_transactions_category_posted` ON `transactions` (`category_id`,`posted_on`);--> statement-breakpoint
CREATE INDEX `ix_transactions_merchant` ON `transactions` (`merchant_id`);--> statement-breakpoint
CREATE INDEX `ix_transactions_transfer_group` ON `transactions` (`transfer_group_id`);--> statement-breakpoint
CREATE TABLE `balance_anchors` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`anchored_on` text NOT NULL,
	`balance_cents` integer NOT NULL,
	`source` text NOT NULL,
	`statement_period_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`statement_period_id`) REFERENCES `statement_periods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_balance_anchors_account_date_source` ON `balance_anchors` (`account_id`,`anchored_on`,`source`);--> statement-breakpoint
CREATE TABLE `daily_balances` (
	`account_id` text NOT NULL,
	`day` text NOT NULL,
	`balance_cents` integer NOT NULL,
	`basis` text NOT NULL,
	PRIMARY KEY(`account_id`, `day`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`period` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_budgets_category_period_active` ON `budgets` (`category_id`,`period`) WHERE is_active = 1;--> statement-breakpoint
CREATE TABLE `recurring_series` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`merchant_id` text,
	`account_id` text,
	`kind` text NOT NULL,
	`cadence` text NOT NULL,
	`interval_days_avg` real,
	`amount_cents_avg` integer,
	`amount_cents_stddev` real,
	`tolerance_days` integer DEFAULT 3 NOT NULL,
	`next_expected_on` text,
	`next_expected_amount_cents` integer,
	`status` text DEFAULT 'detected' NOT NULL,
	`confidence` real,
	`last_matched_on` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`symbol` text NOT NULL,
	`asset_type` text NOT NULL,
	`quantity_e8` integer NOT NULL,
	`avg_cost_cents` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_holdings_account_symbol` ON `holdings` (`account_id`,`symbol`);--> statement-breakpoint
CREATE TABLE `price_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`asset_type` text NOT NULL,
	`quoted_on` text NOT NULL,
	`close` real NOT NULL,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_price_cache_symbol_type_date` ON `price_cache` (`symbol`,`asset_type`,`quoted_on`);--> statement-breakpoint
CREATE TABLE `ai_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`est_cost_usd` real NOT NULL,
	`batch_size` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
