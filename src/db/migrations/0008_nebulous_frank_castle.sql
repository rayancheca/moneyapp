CREATE TABLE `duplicate_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`transaction_id_a` text,
	`transaction_id_b` text,
	`pair_key` text NOT NULL,
	`reason` text NOT NULL,
	`reason_detail` text NOT NULL,
	`resolution` text DEFAULT 'unresolved' NOT NULL,
	`resolved_at` text,
	`retired_transaction_id` text,
	`retired_from_status` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id_a`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transaction_id_b`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`retired_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_duplicate_candidates_txn_a_b` ON `duplicate_candidates` (`transaction_id_a`,`transaction_id_b`);--> statement-breakpoint
CREATE INDEX `ix_duplicate_candidates_txn_b` ON `duplicate_candidates` (`transaction_id_b`);--> statement-breakpoint
CREATE INDEX `ix_duplicate_candidates_pair_key` ON `duplicate_candidates` (`pair_key`);--> statement-breakpoint
CREATE INDEX `ix_duplicate_candidates_resolution_account` ON `duplicate_candidates` (`resolution`,`account_id`);