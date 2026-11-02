-- Course catalog table
CREATE TABLE IF NOT EXISTS Courses (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    subject VARCHAR(10) NOT NULL,
    course_number VARCHAR(20) NOT NULL,
    title VARCHAR(255) NOT NULL,

    UNIQUE KEY uq_subject_course (subject, course_number)
) ENGINE=InnoDB;


-- Connect existing sections to courses
ALTER TABLE Sections
    ADD COLUMN course_id INT UNSIGNED NULL,
    ADD CONSTRAINT fk_section_course
        FOREIGN KEY (course_id)
        REFERENCES Courses(id);


-- Track department and term synchronization
CREATE TABLE IF NOT EXISTS DepartmentSyncs (
    subject VARCHAR(10) NOT NULL,
    term VARCHAR(6) NOT NULL,
    last_synced_at TIMESTAMP NULL DEFAULT NULL,

    PRIMARY KEY (subject, term)
) ENGINE=InnoDB;