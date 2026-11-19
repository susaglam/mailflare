ALTER TABLE `mailbox_aliases` ADD `label` longtext;
--> statement-breakpoint
ALTER TABLE `mailbox_aliases` ADD `enabled` boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE `mailbox_aliases` ADD `masked` boolean NOT NULL DEFAULT false;