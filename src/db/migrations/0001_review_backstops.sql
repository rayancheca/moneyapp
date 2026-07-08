CREATE UNIQUE INDEX `ux_categories_root_name` ON `categories` (`name`) WHERE parent_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `rules_name_unique` ON `rules` (`name`);