CREATE TABLE `price_intraday` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`asset_type` text NOT NULL,
	`quoted_at` text NOT NULL,
	`close` real NOT NULL,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_price_intraday_symbol_type_at` ON `price_intraday` (`symbol`,`asset_type`,`quoted_at`);