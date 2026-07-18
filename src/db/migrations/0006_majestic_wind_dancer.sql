CREATE TABLE `transaction_splits` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`category_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_transaction_splits_txn` ON `transaction_splits` (`transaction_id`);