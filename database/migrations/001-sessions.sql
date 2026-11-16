-- Repeatable, additive migration. Apply explicitly to njit_course_checker.
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    expires INT UNSIGNED NOT NULL,
    data MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
    INDEX idx_sessions_expires (expires)
) ENGINE=InnoDB;
