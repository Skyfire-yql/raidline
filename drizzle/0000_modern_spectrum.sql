CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`share_slug` text NOT NULL,
	`edit_key_hash` text NOT NULL,
	`title` text NOT NULL,
	`encounter_name` text NOT NULL,
	`difficulty` text NOT NULL,
	`source_provider` text,
	`source_ref` text,
	`document_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plans_share_slug` ON `plans` (`share_slug`);--> statement-breakpoint
CREATE INDEX `idx_plans_updated_at` ON `plans` (`updated_at`);--> statement-breakpoint
CREATE TABLE `wcl_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`payload_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_wcl_cache_expires_at` ON `wcl_cache` (`expires_at`);