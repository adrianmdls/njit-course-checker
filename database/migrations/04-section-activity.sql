-- Apply explicitly to njit_course_checker after checking the existing schema.
-- Existing rows stay active until their next complete nonempty synchronization.
-- Do not rerun if a compatible is_active column already exists.
ALTER TABLE Sections
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
