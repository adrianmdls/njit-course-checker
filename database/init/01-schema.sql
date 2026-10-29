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

-- Sections table
CREATE TABLE IF NOT EXISTS Sections (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    subject VARCHAR(10) NOT NULL,
    term VARCHAR(6) NOT NULL,
    crn VARCHAR(10) NOT NULL,
    section_number VARCHAR(20) DEFAULT NULL,
    capacity INT UNSIGNED DEFAULT NULL,
    enrolled INT UNSIGNED DEFAULT NULL,
    status ENUM('OPEN', 'CLOSED') DEFAULT NULL,
    last_checked_at TIMESTAMP NULL DEFAULT NULL,

    UNIQUE KEY uq_term_crn (term, crn)
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
        REFERENCES users(id)
        ON DELETE CASCADE,

    CONSTRAINT fk_watchlist_section
        FOREIGN KEY (section_id)
        REFERENCES sections(id)
        ON DELETE CASCADE
) ENGINE=InnoDB;