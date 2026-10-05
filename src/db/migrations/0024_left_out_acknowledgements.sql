CREATE TABLE `left_out_acknowledgements` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`printed_on` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`printed_words` text NOT NULL,
	`printer_sha256` text NOT NULL,
	`description` text NOT NULL,
	`acknowledged_on` text NOT NULL,
	`created_at` text NOT NULL
);
