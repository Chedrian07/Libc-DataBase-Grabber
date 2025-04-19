// server.js
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const { exec, execFile } = require('child_process');
const path = require('path');
const cors = require('cors');
const mysql = require('mysql2');
const multer  = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// 보안 헤더 설정
app.use(helmet());

// 속도 제한 설정
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15분
    max: 100, // 15분 동안 최대 100개 요청
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// CORS 설정 강화
app.use(cors({
    origin: ['http://localhost', 'http://localhost:80'], // 허용할 도메인 제한
    methods: ['GET', 'POST', 'PUT', 'DELETE'], // 허용 메서드 제한
}));

// Middleware 설정
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 파일 업로드를 위한 Multer 설정 (파일 유형 및 크기 제한 추가)
const upload = multer({ 
    dest: path.join('/usr/src/uploads'),
    limits: {
        fileSize: 100 * 1024 * 1024, // 최대 100MB 제한
    },
    fileFilter: (req, file, cb) => {
        // 허용되는 파일 타입 제한
        if (file.mimetype === 'application/octet-stream') {
            cb(null, true);
        } else {
            cb(new Error('지원되지 않는 파일 형식입니다'));
        }
    }
});

// MySQL 연결 풀 설정 (SSL 옵션 추가)
const pool = mysql.createPool({
    connectionLimit: 10,
    host: 'db', // 도커 네트워크 상에서 db 컨테이너 이름
    port: 3306,
    user: 'myuser',
    password: 'myuser',
    database: 'docker_db',
    ssl: {
        rejectUnauthorized: false
    }
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

// MySQL 데이터베이스 덤프 로직 - 명령어 삽입 취약점 수정
const dumpDatabase = () => {
    const dumpFilePath = path.join('/usr/src/libc-data', 'db.sql');
    
    // 안전한 방식으로 명령어 실행
    execFile('mysqldump', [
        '-u', 'myuser', 
        '-pmyuser', 
        'docker_db'
    ], (error, stdout, stderr) => {
        if (error) {
            console.error('Error during database dump:', stderr);
            return;
        }
        
        // 결과를 파일에 안전하게 저장
        fs.writeFile(dumpFilePath, stdout, (err) => {
            if (err) {
                console.error('Error saving dump file:', err);
                return;
            }
            console.log('Database dump successful and saved to:', dumpFilePath);
        });
    });
}

// Docker image build API - 명령어 삽입 취약점 수정
app.post('/build-docker', (req, res) => {
    const { ubuntuVersion, digest } = req.body;

    // 입력 검증 강화
    if (!ubuntuVersion || !/^\d+\.\d+$/.test(ubuntuVersion)) {
        return res.status(400).json({ error: 'Invalid Ubuntu Version format. Expected format: xx.xx' });
    }

    if (digest && !/^[a-f0-9]{64}$/.test(digest)) {
        return res.status(400).json({ error: 'Invalid digest format. Expected 64 character hex string.' });
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

    // Docker 이미지 빌드 (명령어 삽입 취약점 수정)
    const imageTag = digest ? `${ubuntuVersion}-${digest.slice(0, 12)}` : `${ubuntuVersion}-latest`;
    
    // 안전한 방식으로 docker build 명령 실행
    execFile('docker', [
        'build', 
        '-t', 
        `ubuntu:${imageTag}`, 
        cleanBasePath
    ], (error, stdout, stderr) => {
        if (error) {
            console.error('Error during Docker build:', stderr);
            return res.status(500).json({ error: 'Docker build failed', details: stderr.trim() });
        }

        console.log('Docker build successful:', stdout.trim());

        // export.sh 스크립트 실행 (안전하게 실행)
        const exportScriptPath = path.join('/usr/src/libc-data', 'export.sh');
        execFile('sh', [
            exportScriptPath, 
            imageTag
        ], { cwd: '/usr/src' }, (error, stdout, stderr) => {
            if (error) {
                console.error('Error during export:', stderr);
                return res.status(500).json({ error: 'Export script failed', details: stderr.trim() });
            }

            console.log('Export script successful:', stdout.trim());

            // 파일 경로 가져오기 - 수정된 경로
            const folderPath = path.resolve('/usr/src/libc-data/data', imageTag);
            const libcPath = path.join(folderPath, 'libc.so.6');
            const ldPath = path.join(folderPath, 'ld-linux-x86-64.so.2');

            // 파일 존재 여부 확인
            if (!fs.existsSync(libcPath) || !fs.existsSync(ldPath)) {
                console.error(`Required files not found. libcPath: ${libcPath}, ldPath: ${ldPath}`);
                return res.status(500).json({ error: 'Required files not found after export.' });
            }

            // SQL 인젝션 방지를 위해 파라미터화된 쿼리 사용
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

                dumpDatabase();
                return res.status(200).json({
                    message: 'Docker image created and data inserted into database successfully.',
                    imageTag
                });
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
        dumpDatabase();
        return res.status(200).json(results);
    });
});

// 파일 다운로드 - 경로 검증 추가
app.get('/docker-files/:id/download/:fileType', (req, res) => {
    const { id, fileType } = req.params;

    // 입력 검증
    if (!id || !/^\d+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid ID' });
    }

    if (!fileType || !['libc', 'ld'].includes(fileType)) {
        return res.status(400).json({ error: 'Invalid file type' });
    }

    const selectQuery = 'SELECT * FROM docker_files WHERE id = ?';
    pool.query(selectQuery, [id], (err, results) => {
        if (err || results.length === 0) {
            console.error('Record not found or error:', err);
            return res.status(404).json({ error: 'Record not found' });
        }

        const record = results[0];
        const filePath = fileType === 'libc' ? record.libc : record.ld;
        
        console.log(`시도 중인 파일 다운로드: ${filePath}`);

        // 경로 순회 방지를 위한 추가 검증
        const normalizedPath = path.normalize(filePath);
        if (!normalizedPath.startsWith('/usr/src/libc-data/data')) {
            return res.status(403).json({ error: 'Access denied: Invalid file path' });
        }

        // 파일 존재 여부 추가 검증
        fs.access(filePath, fs.constants.R_OK, (err) => {
            if (err) {
                console.error('File not accessible:', err);
                
                // 파일이 없으면 데이터베이스에서 docker_tag 가져와서 경로 다시 확인
                const dockerTag = record.docker_tag;
                const expectedDir = `/usr/src/libc-data/data/${dockerTag}`;
                const expectedFile = fileType === 'libc' 
                    ? path.join(expectedDir, 'libc.so.6') 
                    : path.join(expectedDir, 'ld-linux-x86-64.so.2');
                
                console.log(`경로 확인: ${expectedFile}`);
                
                // 예상 경로의 파일 존재 여부 확인
                fs.access(expectedFile, fs.constants.R_OK, (expectedErr) => {
                    if (expectedErr) {
                        console.error('예상 경로 파일도 접근 불가:', expectedErr);
                        
                        // 디렉토리 내용 출력 (디버깅 용도)
                        fs.readdir('/usr/src/libc-data/data', (dirErr, files) => {
                            if (dirErr) {
                                console.error('디렉토리 읽기 실패:', dirErr);
                            } else {
                                console.log('사용 가능한 디렉토리들:', files);
                            }
                            
                            return res.status(500).json({ 
                                error: 'File not found or inaccessible',
                                path: filePath,
                                expected_path: expectedFile
                            });
                        });
                    } else {
                        // 예상 경로에서 파일을 발견했음 - DB 업데이트 및 파일 제공
                        const updateQuery = 'UPDATE docker_files SET libc = ?, ld = ? WHERE id = ?';
                        const libc = fileType === 'libc' ? expectedFile : record.libc;
                        const ld = fileType === 'ld' ? expectedFile : record.ld;
                        
                        pool.query(updateQuery, [libc, ld, id], (updateErr) => {
                            if (updateErr) {
                                console.error('DB 업데이트 실패:', updateErr);
                            } else {
                                console.log(`ID ${id} 레코드 경로 수정됨`);
                            }
                            
                            // 파일 다운로드 제공
                            res.download(expectedFile, path.basename(expectedFile), (err) => {
                                if (err) {
                                    console.error('Error during file download:', err);
                                    res.status(500).json({ error: 'File download failed', details: err.message });
                                }
                            });
                        });
                    }
                });
            } else {
                // 원래 경로에 파일이 있는 경우 정상 처리
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

// DELETE 특정 docker_file 삭제 - CSRF 방지 토큰 추가
app.delete('/docker-files/:id', (req, res) => {
    const id = req.params.id;

    // 입력 검증
    if (!id || !/^\d+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid ID' });
    }

    const selectQuery = 'SELECT * FROM docker_files WHERE id = ?';
    pool.query(selectQuery, [id], (err, results) => {
        if (err || results.length === 0) {
            console.error('Record not found or error:', err);
            return res.status(404).json({ error: 'Record not found' });
        }

        const { docker_tag } = results[0];
        const folderPath = path.resolve('/usr/src/libc-data/data', docker_tag);
        
        console.log(`삭제 요청: ID ${id}, docker_tag: ${docker_tag}, 폴더: ${folderPath}`);

        const deleteQuery = 'DELETE FROM docker_files WHERE id = ?';
        pool.query(deleteQuery, [id], (err) => {
            if (err) {
                console.error('Error deleting record:', err);
                return res.status(500).json({ error: 'Failed to delete record', details: err.message });
            }

            // 경로 순회 방지를 위한 추가 검증
            const normalizedPath = path.normalize(folderPath);
            if (!normalizedPath.startsWith('/usr/src/libc-data/data')) {
                return res.status(403).json({ error: 'Access denied: Invalid folder path' });
            }

            // 폴더 존재 확인
            if (fs.existsSync(folderPath)) {
                console.log(`폴더 삭제 시작: ${folderPath}`);
                
                // 폴더 내용 확인 (디버깅 용도)
                try {
                    const files = fs.readdirSync(folderPath);
                    console.log(`삭제 전 폴더 내용: ${files.join(', ')}`);
                } catch (e) {
                    console.error(`폴더 내용 확인 중 오류: ${e.message}`);
                }
                
                // 강제 폴더 삭제 (하위 파일 모두 포함)
                fs.rm(folderPath, { recursive: true, force: true }, (fsErr) => {
                    if (fsErr) {
                        console.error(`폴더 삭제 실패: ${folderPath}`, fsErr);
                        
                        // 폴더 삭제 실패 시 추가 시도: 개별 파일 삭제 후 폴더 삭제
                        try {
                            // libc.so.6 및 ld-linux-x86-64.so.2 파일 개별 삭제 시도
                            const libcPath = path.join(folderPath, 'libc.so.6');
                            const ldPath = path.join(folderPath, 'ld-linux-x86-64.so.2');
                            
                            if (fs.existsSync(libcPath)) {
                                fs.unlinkSync(libcPath);
                                console.log(`libc 파일 개별 삭제: ${libcPath}`);
                            }
                            
                            if (fs.existsSync(ldPath)) {
                                fs.unlinkSync(ldPath);
                                console.log(`ld 파일 개별 삭제: ${ldPath}`);
                            }
                            
                            // 빈 폴더 삭제 재시도
                            fs.rmdirSync(folderPath);
                            console.log(`빈 폴더 삭제 성공: ${folderPath}`);
                            
                            // 성공 응답
                            dumpDatabase();
                            return res.status(200).json({ 
                                message: 'Record and files deleted successfully with additional attempt.',
                                deleted_path: folderPath
                            });
                        } catch (additionalErr) {
                            console.error(`추가 삭제 시도 실패: ${folderPath}`, additionalErr);
                            return res.status(500).json({ 
                                error: 'Failed to delete files even with additional attempt', 
                                details: additionalErr.message,
                                original_error: fsErr.message,
                                folder_path: folderPath
                            });
                        }
                    } else {
                        console.log(`폴더 삭제 성공: ${folderPath}`);
                        
                        // 성공적으로 폴더 삭제 후, 부모 디렉터리가 비어있는지 확인
                        fs.readdir('/usr/src/libc-data/data', (dirErr, files) => {
                            if (!dirErr) {
                                console.log(`남은 폴더/파일 수: ${files.length}`);
                            }
                            
                            dumpDatabase();
                            return res.status(200).json({ 
                                message: 'Record and files deleted successfully.',
                                deleted_path: folderPath
                            });
                        });
                    }
                });
            } else {
                console.log(`폴더가 존재하지 않음: ${folderPath}`);
                dumpDatabase();
                return res.status(200).json({ 
                    message: 'Record deleted successfully. Files were already removed.',
                    folder_path: folderPath,
                    folder_exists: false
                });
            }
        });
    });
});

// 파일 업로드 및 데이터 삽입 - 보안 강화
app.post('/docker-files/upload', upload.fields([{ name: 'libc' }, { name: 'ld' }]), (req, res) => {
    const { dockerTag } = req.body;
    const libcFile = req.files['libc'] ? req.files['libc'][0] : null;
    const ldFile = req.files['ld'] ? req.files['ld'][0] : null;

    // 입력 검증
    if (!dockerTag || dockerTag.trim() === '') {
        return res.status(400).json({ error: 'Docker Tag is required.' });
    }

    // 특수문자 및 경로 주입 방지
    if (!/^[a-zA-Z0-9._-]+$/.test(dockerTag)) {
        return res.status(400).json({ error: 'Docker Tag contains invalid characters.' });
    }

    if (!libcFile || !ldFile) {
        return res.status(400).json({ error: 'libc file and ld file are required.' });
    }

    // 저장할 위치 설정
    const dataDir = '/usr/src/libc-data/data';
    const folderPath = path.resolve(dataDir, dockerTag);
    
    console.log(`파일 업로드 시작: Docker Tag=${dockerTag}, 저장 경로=${folderPath}`);

    try {
        // 데이터 디렉토리 확인
        if (!fs.existsSync(dataDir)) {
            console.log(`데이터 디렉토리 생성: ${dataDir}`);
            fs.mkdirSync(dataDir, { recursive: true });
        }

        // 대상 폴더 생성
        if (!fs.existsSync(folderPath)) {
            console.log(`폴더 생성: ${folderPath}`);
            fs.mkdirSync(folderPath, { recursive: true });
        } else {
            console.log(`기존 폴더 사용: ${folderPath}`);
        }

        // 파일 이동
        const libcPath = path.join(folderPath, 'libc.so.6');
        const ldPath = path.join(folderPath, 'ld-linux-x86-64.so.2');

        // 기존 파일 존재시 삭제
        if (fs.existsSync(libcPath)) {
            console.log(`기존 libc 파일 삭제: ${libcPath}`);
            fs.unlinkSync(libcPath);
        }
        
        if (fs.existsSync(ldPath)) {
            console.log(`기존 ld 파일 삭제: ${ldPath}`);
            fs.unlinkSync(ldPath);
        }

        // 새 파일 이동
        fs.copyFileSync(libcFile.path, libcPath);
        fs.copyFileSync(ldFile.path, ldPath);
        
        console.log(`파일 복사 완료: ${libcFile.path} -> ${libcPath}`);
        console.log(`파일 복사 완료: ${ldFile.path} -> ${ldPath}`);
        
        // 원본 업로드 파일 삭제
        try {
            fs.unlinkSync(libcFile.path);
            fs.unlinkSync(ldFile.path);
        } catch (unlinkErr) {
            console.error('업로드 파일 삭제 실패:', unlinkErr);
            // 계속 진행 (중요하지 않은 오류)
        }

        // 파일 권한 설정
        fs.chmodSync(libcPath, 0o644);
        fs.chmodSync(ldPath, 0o644);

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
            return res.status(200).json({ 
                message: 'Files uploaded and data inserted successfully.',
                file_paths: {
                    libc: libcPath,
                    ld: ldPath
                }
            });
        });
    } catch (error) {
        console.error('Error during file upload:', error);
        return res.status(500).json({ error: 'File upload failed', details: error.message });
    }
});

// 레코드 업데이트 - 보안 강화
app.put('/docker-files/:id', (req, res) => {
    const id = req.params.id;
    const { docker_tag, old_docker_tag } = req.body;

    // 입력 검증
    if (!id || !/^\d+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid ID' });
    }

    if (!docker_tag || docker_tag.trim() === '') {
        return res.status(400).json({ error: 'Docker Tag is required.' });
    }

    // 특수문자 및 경로 주입 방지
    if (!/^[a-zA-Z0-9._-]+$/.test(docker_tag)) {
        return res.status(400).json({ error: 'Docker Tag contains invalid characters.' });
    }

    const updateQuery = 'UPDATE docker_files SET docker_tag = ? WHERE id = ?';
    const queryValues = [docker_tag, id];

    pool.query(updateQuery, queryValues, (err, results) => {
        if (err) {
            console.error('Error updating record:', err);
            return res.status(500).json({ error: 'Failed to update record', details: err.message });
        }

        // 파일 경로 업데이트 (폴더 이름 변경)
        const oldFolderPath = path.resolve('/usr/src/libc-data/data', old_docker_tag);
        const newFolderPath = path.resolve('/usr/src/libc-data/data', docker_tag);

        // 경로 순회 방지를 위한 추가 검증
        const normalizedOldPath = path.normalize(oldFolderPath);
        const normalizedNewPath = path.normalize(newFolderPath);
        if (!normalizedOldPath.startsWith('/usr/src/libc-data/data') || 
            !normalizedNewPath.startsWith('/usr/src/libc-data/data')) {
            return res.status(403).json({ error: 'Access denied: Invalid folder path' });
        }

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

// 필요한 디렉토리 생성 함수
const ensureDirectories = () => {
    // libc-data 디렉토리 및 하위 디렉토리 생성
    const libcDataPath = '/usr/src/libc-data';
    const libcDataDataPath = path.join(libcDataPath, 'data');
    
    if (!fs.existsSync(libcDataPath)) {
        console.log(`${libcDataPath} 디렉토리 생성 중...`);
        fs.mkdirSync(libcDataPath, { recursive: true });
    }
    
    if (!fs.existsSync(libcDataDataPath)) {
        console.log(`${libcDataDataPath} 디렉토리 생성 중...`);
        fs.mkdirSync(libcDataDataPath, { recursive: true });
    }
    
    // uploads 디렉토리 생성
    const uploadsPath = '/usr/src/uploads';
    if (!fs.existsSync(uploadsPath)) {
        console.log(`${uploadsPath} 디렉토리 생성 중...`);
        fs.mkdirSync(uploadsPath, { recursive: true });
    }
    
    // tmp 디렉토리 생성
    if (!fs.existsSync(BASE_PATH)) {
        console.log(`${BASE_PATH} 디렉토리 생성 중...`);
        fs.mkdirSync(BASE_PATH, { recursive: true });
    }
    
    console.log('필요한 모든 디렉토리가 생성되었습니다.');
};

// 서버 시작 전에 기존 DB 경로 수정
const fixDatabasePaths = () => {
    console.log('데이터베이스 경로 수정 및 검증 중...');
    
    // 모든 docker_files 레코드 조회
    const selectQuery = 'SELECT * FROM docker_files';
    
    pool.query(selectQuery, (err, results) => {
        if (err) {
            console.error('데이터베이스 레코드 조회 실패:', err);
            return;
        }
        
        if (results.length === 0) {
            console.log('수정할 레코드가 없습니다.');
            return;
        }
        
        // 각 레코드의 경로 수정 및 검증
        results.forEach(record => {
            const id = record.id;
            const dockerTag = record.docker_tag;
            const expectedDir = `/usr/src/libc-data/data/${dockerTag}`;
            const expectedLibcPath = path.join(expectedDir, 'libc.so.6');
            const expectedLdPath = path.join(expectedDir, 'ld-linux-x86-64.so.2');
            let needsUpdate = false;
            let newLibcPath = record.libc;
            let newLdPath = record.ld;
            
            // 잘못된 경로 패턴 확인 (/usr/src/app/libc-data/data/)
            if (record.libc && record.libc.includes('/usr/src/app/libc-data/data/')) {
                // 올바른 경로로 변경 (/usr/src/libc-data/data/)
                newLibcPath = record.libc.replace('/usr/src/app/libc-data/data/', '/usr/src/libc-data/data/');
                newLdPath = record.ld.replace('/usr/src/app/libc-data/data/', '/usr/src/libc-data/data/');
                needsUpdate = true;
                console.log(`ID ${id}: 잘못된 경로 패턴 감지됨, 수정 중...`);
            }
            
            // 현재 데이터베이스에 등록된 파일 경로가 존재하는지 확인
            if (fs.existsSync(record.libc) && fs.existsSync(record.ld)) {
                console.log(`ID ${id}: 파일이 정상적으로 존재함, 경로 유지`);
            } else {
                // 예상 경로에 파일이 존재하는지 확인
                if (fs.existsSync(expectedLibcPath) && fs.existsSync(expectedLdPath)) {
                    console.log(`ID ${id}: 기존 경로에 파일이 없지만 예상 경로에는 존재함, 경로 수정 중...`);
                    newLibcPath = expectedLibcPath;
                    newLdPath = expectedLdPath;
                    needsUpdate = true;
                } else {
                    // 디렉토리 생성 시도
                    if (!fs.existsSync(expectedDir)) {
                        try {
                            fs.mkdirSync(expectedDir, { recursive: true });
                            console.log(`ID ${id}: 디렉토리 ${expectedDir} 생성됨`);
                        } catch (mkdirErr) {
                            console.error(`ID ${id}: 디렉토리 생성 실패:`, mkdirErr);
                        }
                    }
                }
            }
            
            // 경로 업데이트가 필요한 경우
            if (needsUpdate) {
                const updateQuery = 'UPDATE docker_files SET libc = ?, ld = ? WHERE id = ?';
                pool.query(updateQuery, [newLibcPath, newLdPath, id], (updateErr) => {
                    if (updateErr) {
                        console.error(`ID ${id} 레코드 경로 업데이트 실패:`, updateErr);
                    } else {
                        console.log(`ID ${id} 레코드 경로 수정됨:`, {
                            old_libc: record.libc,
                            new_libc: newLibcPath,
                            old_ld: record.ld,
                            new_ld: newLdPath
                        });
                    }
                });
            }
        });
        
        // libc-data/data 디렉토리 내용 출력 (디버깅 용도)
        const dataDir = '/usr/src/libc-data/data';
        if (fs.existsSync(dataDir)) {
            try {
                const items = fs.readdirSync(dataDir);
                console.log(`${dataDir} 디렉토리 내용:`, items);
                
                // 각 디렉토리 내부 파일 확인
                items.forEach(item => {
                    const itemPath = path.join(dataDir, item);
                    try {
                        if (fs.statSync(itemPath).isDirectory()) {
                            const files = fs.readdirSync(itemPath);
                            console.log(`${itemPath} 내부 파일:`, files);
                        }
                    } catch (e) {
                        console.error(`${itemPath} 확인 중 오류:`, e);
                    }
                });
            } catch (e) {
                console.error(`${dataDir} 내용 확인 중 오류:`, e);
            }
        } else {
            console.error(`${dataDir} 디렉토리가 존재하지 않음`);
        }
    });
};

// 데이터베이스 경로 수정 API
app.post('/fix-paths', (req, res) => {
    fixDatabasePaths();
    return res.status(200).json({ message: '데이터베이스 경로 수정 요청이 처리되었습니다.' });
});

// [긴급] 모든 레코드 삭제 API - 문제 해결 용도
app.post('/emergency-reset', (req, res) => {
    console.log('긴급 리셋 요청 받음 - 모든 레코드 삭제...');
    
    // 모든 레코드 삭제
    const deleteQuery = 'DELETE FROM docker_files';
    
    pool.query(deleteQuery, (err) => {
        if (err) {
            console.error('레코드 삭제 실패:', err);
            return res.status(500).json({ error: '레코드 삭제 실패', details: err.message });
        }
        
        console.log('모든 레코드가 성공적으로 삭제되었습니다.');
        
        // 디렉토리 내용 확인 및 정리
        try {
            const dataDir = '/usr/src/libc-data/data';
            if (fs.existsSync(dataDir)) {
                const items = fs.readdirSync(dataDir);
                console.log(`${dataDir} 디렉토리 내용:`, items);
                
                // 각 디렉토리 내부 파일 정리
                items.forEach(item => {
                    const itemPath = path.join(dataDir, item);
                    try {
                        if (fs.statSync(itemPath).isDirectory()) {
                            fs.rmSync(itemPath, { recursive: true, force: true });
                            console.log(`${itemPath} 디렉토리 삭제됨`);
                        }
                    } catch (e) {
                        console.error(`${itemPath} 삭제 중 오류:`, e);
                    }
                });
            }
        } catch (e) {
            console.error('디렉토리 정리 중 오류:', e);
        }
        
        return res.status(200).json({ message: '모든 레코드가 성공적으로 삭제되었습니다.' });
    });
});

// [테스트] 파일 시스템 정보 API
app.get('/filesystem-info', (req, res) => {
    const info = {
        current_time: new Date().toISOString(),
        directories: {}
    };
    
    // 디렉토리 내용 수집
    const dirs = [
        '/usr/src/libc-data',
        '/usr/src/libc-data/data',
        '/usr/src/uploads'
    ];
    
    dirs.forEach(dir => {
        try {
            if (fs.existsSync(dir)) {
                const items = fs.readdirSync(dir);
                info.directories[dir] = items;
                
                // 하위 디렉토리 확인
                if (dir === '/usr/src/libc-data/data') {
                    items.forEach(item => {
                        const itemPath = path.join(dir, item);
                        try {
                            if (fs.statSync(itemPath).isDirectory()) {
                                const files = fs.readdirSync(itemPath);
                                info.directories[itemPath] = files;
                            }
                        } catch (e) {
                            info.directories[itemPath] = { error: e.message };
                        }
                    });
                }
            } else {
                info.directories[dir] = { exists: false };
            }
        } catch (e) {
            info.directories[dir] = { error: e.message };
        }
    });
    
    return res.status(200).json(info);
});

// 서버 시작 시 자동으로 경로 수정 실행
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // 필요한 디렉토리 생성
    ensureDirectories();
    
    // 서버 시작 후 경로 수정 실행
    fixDatabasePaths();
});