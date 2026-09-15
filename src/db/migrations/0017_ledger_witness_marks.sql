CREATE TABLE `ledger_witness_marks` (
	`kind` text PRIMARY KEY NOT NULL,
	`mark` integer NOT NULL,
	`witnesses` text NOT NULL,
	`updated_at` text NOT NULL
);
