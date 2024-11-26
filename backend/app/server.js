// server.js
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const mysql = require('mysql2');
const multer  = require('multer');

const app = express();

// Middleware 설정
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 파일 업로드를 위한 Multer 설정
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// MySQL 연결 풀 설정
const pool = mysql.createPool({
    connectionLimit: 10,
    host: 'db', // 도커 네트워크 상에서 db 컨테이너 이름
    port: 3306,
    user: 'myuser',
    password: 'myuser',
    database: 'docker_db'
});

// 연결 풀 테스트
pool.getConnection((err, connection) => {
    if (err) {
        console.error('MySQL 연결 실패:', err);
    } else {
        console.log('MySQL 연결 성공.');
        connection.release();
    }
});

// 기본 경로 설정
const BASE_PATH = path.join(__dirname, '..', 'tmp');

// MySQL 데이터베이스 덤프 로직
// ./data/db.sql 파일로 데이터베이스 덤프
const dumpDatabase = () => {
    const dumpFilePath = path.join(__dirname, '..', 'libc-data', 'db.sql');
    const dumpCommand = `mysqldump -u myuser -pmyuser docker_db > ${dumpFilePath}`;
    exec(dumpCommand, (error, stdout, stderr) => {
        if (error) {
            console.error('Error during database dump:', stderr);
        }
        console.log('Database dump successful:', stdout.trim());
    });
}

// Docker image build API
app.post('/build-docker', (req, res) => {
    const { ubuntuVersion, digest } = req.body;

    if (!ubuntuVersion) {
        return res.status(400).json({ error: 'Ubuntu Version is required.' });
    }

    const cleanBasePath = BASE_PATH.trim();

    try {
        if (!fs.existsSync(cleanBasePath)) {
            fs.mkdirSync(cleanBasePath, { recursive: true });
        }

        // 입력에 기반한 Dockerfile 작성
        const dockerfileContent = digest
            ? `FROM ubuntu:${ubuntuVersion}@sha256:${digest}`
            : `FROM ubuntu:${ubuntuVersion}`;

        fs.writeFileSync(path.join(cleanBasePath, 'Dockerfile'), dockerfileContent);
        console.log('Dockerfile created:\n', dockerfileContent);
    } catch (err) {
        console.error('Failed to create Dockerfile:', err.message);
        return res.status(500).json({ error: 'Failed to create Dockerfile', details: err.message });
    }

    // Docker 이미지 빌드
    const imageTag = digest ? `${ubuntuVersion}-${digest.slice(0, 12)}` : `${ubuntuVersion}-latest`;
    const buildCommand = `docker build -t ubuntu:${imageTag} ${cleanBasePath}`;
    console.log(`Executing build command: ${buildCommand}`);

    exec(buildCommand, (error, stdout, stderr) => {
        if (error) {
            console.error('Error during Docker build:', stderr);
            return res.status(500).json({ error: 'Docker build failed', details: stderr.trim() });
        }

        console.log('Docker build successful:', stdout.trim());

        // export.sh 스크립트 실행
        const exportRootfsCommand = `sh ./libc-data/export.sh ${imageTag}`;
        console.log(`Executing export script: ${exportRootfsCommand}`);

        exec(exportRootfsCommand, { cwd: path.join(__dirname) }, (error, stdout, stderr) => {
            if (error) {
                console.error('Error during export:', stderr);
                return res.status(500).json({ error: 'Export script failed', details: stderr.trim() });
            }

            console.log('Export script successful:', stdout.trim());

            // 파일 경로 가져오기
            const folderPath = path.resolve(__dirname, '..', 'libc-data', 'data', imageTag);
            const libcPath = path.join(folderPath, 'libc.so.6');
            const ldPath = path.join(folderPath, 'ld-linux-x86-64.so.2');

            // 파일 존재 여부 확인
            if (!fs.existsSync(libcPath) || !fs.existsSync(ldPath)) {
                console.error(`Required files not found. libcPath: ${libcPath}, ldPath: ${ldPath}`);
                return res.status(500).json({ error: 'Required files not found after export.' });
            }

            // 데이터베이스에 데이터 삽입
            const insertQuery = 'INSERT INTO docker_files (docker_tag, libc, ld) VALUES (?, ?, ?)';
            const queryValues = [imageTag, libcPath, ldPath];

            console.log('Inserting data into database:', queryValues);

            pool.query(insertQuery, queryValues, (err, results) => {
                if (err) {
                    console.error('Error inserting into database:', err);
                    return res.status(500).json({ error: 'Database insertion failed', details: err.message });
                }

                console.log('Data inserted into database:', results);

                // Dockerfile 삭제
                try {
                    fs.unlinkSync(path.join(cleanBasePath, 'Dockerfile'));
                    console.log('Dockerfile deleted.');
                } catch (unlinkErr) {
                    console.error('Error deleting Dockerfile:', unlinkErr.message);
                }

                return res.status(200).json({
                    message: 'Docker image created and data inserted into database successfully.',
                    imageTag
                });
                dumpDatabase();
            });
        });
    });
});

// 데이터 CRUD API
// GET 모든 docker_files 조회
app.get('/docker-files', (req, res) => {
    const query = 'SELECT * FROM docker_files';

    pool.query(query, (err, results) => {
        if (err) {
            console.error('Error fetching data:', err);
            return res.status(500).json({ error: 'Failed to fetch data', details: err.message });
        }
        return res.status(200).json(results);
    });
    dumpDatabase();
});

// 파일 다운로드
app.get('/docker-files/:id/download/:fileType', (req, res) => {
    const { id, fileType } = req.params;

    const selectQuery = 'SELECT * FROM docker_files WHERE id = ?';
    pool.query(selectQuery, [id], (err, results) => {
        if (err || results.length === 0) {
            console.error('Record not found or error:', err);
            return res.status(404).json({ error: 'Record not found' });
        }

        const record = results[0];
        const filePath = fileType === 'libc' ? record.libc : record.ld;

        fs.access(filePath, fs.constants.R_OK, (err) => {
            if (err) {
                console.error('File not accessible:', err);
                return res.status(500).json({ error: 'File not found or inaccessible' });
            } else {
                res.download(filePath, path.basename(filePath), (err) => {
                    if (err) {
                        console.error('Error during file download:', err);
                        res.status(500).json({ error: 'File download failed', details: err.message });
                    }
                });
            }
        });
    });
});

// DELETE 특정 docker_file 삭제
app.delete('/docker-files/:id', (req, res) => {
    const id = req.params.id;

    const selectQuery = 'SELECT * FROM docker_files WHERE id = ?';
    pool.query(selectQuery, [id], (err, results) => {
        if (err || results.length === 0) {
            console.error('Record not found or error:', err);
            return res.status(404).json({ error: 'Record not found' });
        }

        const { docker_tag } = results[0];
        const folderPath = path.resolve(__dirname, '..', 'libc-data', 'data', docker_tag);

        const deleteQuery = 'DELETE FROM docker_files WHERE id = ?';
        pool.query(deleteQuery, [id], (err) => {
            if (err) {
                console.error('Error deleting record:', err);
                return res.status(500).json({ error: 'Failed to delete record', details: err.message });
            }

            fs.rm(folderPath, { recursive: true, force: true }, (fsErr) => {
                if (fsErr) {
                    console.error('Error deleting files:', fsErr);
                    return res.status(500).json({ error: 'Failed to delete files', details: fsErr.message });
                }
                return res.status(200).json({ message: 'Record and files deleted successfully.' });
            });
            dumpDatabase();
        });
    });
});

// 파일 업로드 및 데이터 삽입
app.post('/docker-files/upload', upload.fields([{ name: 'libc' }, { name: 'ld' }]), (req, res) => {
    const { dockerTag } = req.body;
    const libcFile = req.files['libc'] ? req.files['libc'][0] : null;
    const ldFile = req.files['ld'] ? req.files['ld'][0] : null;

    if (!dockerTag || !libcFile || !ldFile) {
        return res.status(400).json({ error: 'Docker Tag, libc file, and ld file are required.' });
    }

    // 저장할 위치 설정
    const folderPath = path.resolve(__dirname, '..', 'libc-data', 'data', dockerTag);

    try {
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }

        // 파일 이동
        const libcPath = path.join(folderPath, 'libc.so.6');
        const ldPath = path.join(folderPath, 'ld-linux-x86-64.so.2');

        fs.renameSync(libcFile.path, libcPath);
        fs.renameSync(ldFile.path, ldPath);

        // 데이터베이스에 데이터 삽입
        const insertQuery = 'INSERT INTO docker_files (docker_tag, libc, ld) VALUES (?, ?, ?)';
        const queryValues = [dockerTag, libcPath, ldPath];

        pool.query(insertQuery, queryValues, (err, results) => {
            if (err) {
                console.error('Error inserting into database:', err);
                return res.status(500).json({ error: 'Database insertion failed', details: err.message });
            }

            console.log('Data inserted into database:', results);
            dumpDatabase();
            return res.status(200).json({ message: 'Files uploaded and data inserted successfully.' });
        });
    } catch (error) {
        console.error('Error during file upload:', error);
        return res.status(500).json({ error: 'File upload failed', details: error.message });
    }
});

// 레코드 업데이트
app.put('/docker-files/:id', (req, res) => {
    const id = req.params.id;
    const { docker_tag } = req.body;

    if (!docker_tag) {
        return res.status(400).json({ error: 'Docker Tag is required.' });
    }

    const updateQuery = 'UPDATE docker_files SET docker_tag = ? WHERE id = ?';
    const queryValues = [docker_tag, id];

    pool.query(updateQuery, queryValues, (err, results) => {
        if (err) {
            console.error('Error updating record:', err);
            return res.status(500).json({ error: 'Failed to update record', details: err.message });
        }

        // 파일 경로 업데이트 (폴더 이름 변경)
        const oldFolderPath = path.resolve(__dirname, '..', 'libc-data', 'data', req.body.old_docker_tag);
        const newFolderPath = path.resolve(__dirname, '..', 'libc-data', 'data', docker_tag);

        fs.rename(oldFolderPath, newFolderPath, (fsErr) => {
            if (fsErr) {
                console.error('Error renaming folder:', fsErr);
                return res.status(500).json({ error: 'Failed to rename folder', details: fsErr.message });
            }

            console.log('Record updated successfully.');
            dumpDatabase();
            return res.status(200).json({ message: 'Record updated successfully.' });
        });
    });
});

// 서버 시작
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});