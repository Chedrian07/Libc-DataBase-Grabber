USE docker_db;

CREATE TABLE IF NOT EXISTS docker_files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    docker_tag VARCHAR(255) NOT NULL,
    libc VARCHAR(512) NOT NULL,
    ld VARCHAR(512) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);