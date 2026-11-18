USE njit_course_checker;

-- Users table
CREATE TABLE IF NOT EXISTS Users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Course catalog table
CREATE TABLE IF NOT EXISTS Courses (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    subject VARCHAR(10) NOT NULL,
    course_number VARCHAR(20) NOT NULL,
    title VARCHAR(255) NOT NULL,

    UNIQUE KEY uq_subject_course (subject, course_number)
) ENGINE=InnoDB;

-- Sections table
CREATE TABLE IF NOT EXISTS Sections (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    subject VARCHAR(10) NOT NULL,
    term VARCHAR(6) NOT NULL,
    crn VARCHAR(10) NOT NULL,
    section_number VARCHAR(20) DEFAULT NULL,
    capacity INT UNSIGNED DEFAULT NULL,
    enrolled INT UNSIGNED DEFAULT NULL,
    status ENUM('OPEN', 'CLOSED', 'CANCELLED') DEFAULT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_checked_at TIMESTAMP NULL DEFAULT NULL,
    course_id INT UNSIGNED NULL,

    UNIQUE KEY uq_term_crn (term, crn),

    CONSTRAINT fk_section_course
        FOREIGN KEY (course_id)
        REFERENCES Courses(id)
) ENGINE=InnoDB;

-- Track department and term synchronization
CREATE TABLE IF NOT EXISTS DepartmentSyncs (
    subject VARCHAR(10) NOT NULL,
    term VARCHAR(6) NOT NULL,
    last_synced_at TIMESTAMP NULL DEFAULT NULL,

    PRIMARY KEY (subject, term)
) ENGINE=InnoDB;

-- Session store (lowercase name matches the authentication configuration)
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    expires INT UNSIGNED NOT NULL,
    data MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
    INDEX idx_sessions_expires (expires)
) ENGINE=InnoDB;


-- Watchlists Table
CREATE TABLE IF NOT EXISTS Watchlists (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id INT UNSIGNED NOT NULL,
    section_id INT UNSIGNED NOT NULL,
    course_number_label VARCHAR(20) DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uq_user_section (user_id, section_id),

    CONSTRAINT fk_watchlist_user
        FOREIGN KEY (user_id)
        REFERENCES Users(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_watchlist_section
        FOREIGN KEY (section_id)
        REFERENCES Sections(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;
