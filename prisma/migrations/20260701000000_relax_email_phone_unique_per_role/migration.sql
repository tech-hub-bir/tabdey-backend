-- Allow the same email/phone to be reused across different roles
-- (e.g. one person registering as both a rider and a driver), while
-- still preventing two accounts of the SAME role from sharing an
-- email/phone. Mirrors the existing `users_cid_role_unique` pattern.

ALTER TABLE `users` DROP INDEX `users_email_unique`;
ALTER TABLE `users` DROP INDEX `users_phone_unique`;

ALTER TABLE `users` ADD UNIQUE INDEX `users_email_role_unique` (`email`, `role`);
ALTER TABLE `users` ADD UNIQUE INDEX `users_phone_role_unique` (`phone`, `role`);
