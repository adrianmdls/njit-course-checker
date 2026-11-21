-- Apply explicitly after checking the actual schema and external dependencies.
-- MariaDB DDL commits implicitly; these two statements are not one transaction.
-- IF EXISTS supports fresh schemas, partial upgrades, and safe reruns.
ALTER TABLE Sections DROP COLUMN IF EXISTS snapshot_generation;
ALTER TABLE DepartmentSyncs DROP COLUMN IF EXISTS snapshot_generation;
