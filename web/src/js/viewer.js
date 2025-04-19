// viewer.js
document.addEventListener('DOMContentLoaded', () => {
    const themeToggle = document.getElementById('themeToggle');
    const currentTheme = localStorage.getItem('theme');
    const htmlElement = document.documentElement;

    if (currentTheme) {
        htmlElement.setAttribute('data-theme', currentTheme);
        themeToggle.checked = currentTheme === 'dark';
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        htmlElement.setAttribute('data-theme', 'dark');
        themeToggle.checked = true;
    } else {
        htmlElement.setAttribute('data-theme', 'light');
        themeToggle.checked = false;
    }

    themeToggle.addEventListener('change', () => {
        const newTheme = themeToggle.checked ? 'dark' : 'light';
        htmlElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    });

    const apiBase = '/backend/docker-files';
    const tableBody = document.querySelector('#docker-files-table tbody');
    const errorMessageDiv = document.getElementById('error-message');
    const uploadBtn = document.getElementById('uploadBtn');
    const popup = document.getElementById('popup');
    const popupClose = document.querySelector('.popup-close');
    const submitBtn = document.getElementById('submitBtn');
    const popupTitle = document.getElementById('popupTitle');
    const dockerTagInput = document.getElementById('dockerTag');
    const libcFileInput = document.getElementById('libcFile');
    const ldFileInput = document.getElementById('ldFile');

    // CSRF 토큰 관리
    let csrfToken = '';
    
    // 랜덤 CSRF 토큰 생성 함수
    function generateCSRFToken() {
        const array = new Uint8Array(16);
        window.crypto.getRandomValues(array);
        csrfToken = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('csrfToken', csrfToken);
        return csrfToken;
    }
    
    // 저장된 토큰 가져오기 또는 새로 생성
    csrfToken = localStorage.getItem('csrfToken') || generateCSRFToken();

    let isEditMode = false;
    let editId = null;
    let oldDockerTag = '';

    uploadBtn.addEventListener('click', () => {
        isEditMode = false;
        editId = null;
        dockerTagInput.value = '';
        libcFileInput.value = '';
        ldFileInput.value = '';
        popupTitle.textContent = 'Upload Files';
        popup.classList.remove('hidden');
    });

    popupClose.addEventListener('click', () => {
        popup.classList.add('hidden');
    });

    submitBtn.addEventListener('click', async () => {
        const dockerTag = dockerTagInput.value.trim();

        // 입력 유효성 검사 강화
        if (!dockerTag) {
            alert('Docker Tag를 입력해주세요.');
            return;
        }
        
        // 특수문자 검증
        if (!/^[a-zA-Z0-9._-]+$/.test(dockerTag)) {
            alert('Docker Tag에 허용되지 않는 특수문자가 포함되어 있습니다.');
            return;
        }

        if (isEditMode && editId) {
            // 레코드 업데이트
            await updateDockerFile(editId, dockerTag);
        } else {
            // 파일 업로드
            const libcFile = libcFileInput.files[0];
            const ldFile = ldFileInput.files[0];

            if (!libcFile || !ldFile) {
                alert('libc와 ld 파일을 모두 선택해주세요.');
                return;
            }
            
            // 파일 크기 및 형식 검증
            if (libcFile.size > 100 * 1024 * 1024 || ldFile.size > 100 * 1024 * 1024) {
                alert('파일 크기가 너무 큽니다. 100MB 이하의 파일만 업로드 가능합니다.');
                return;
            }

            await uploadDockerFiles(dockerTag, libcFile, ldFile);
        }
        popup.classList.add('hidden');
        loadDockerFiles();
    });

    async function uploadDockerFiles(dockerTag, libcFile, ldFile) {
        const formData = new FormData();
        formData.append('dockerTag', dockerTag);
        formData.append('libc', libcFile);
        formData.append('ld', ldFile);
        
        try {
            const response = await fetch(`${apiBase}/upload`, {
                method: 'POST',
                headers: {
                    'X-CSRF-Token': csrfToken
                },
                body: formData
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to upload files');
            }

            alert('파일이 성공적으로 업로드되었습니다.');
        } catch (error) {
            console.error('Error uploading files:', error);
            alert('Error: ' + error.message);
        }
    }

    async function updateDockerFile(id, dockerTag) {
        try {
            // OWASP 권장: 유효하지 않은 ID 거부
            if (!/^\d+$/.test(id)) {
                throw new Error('유효하지 않은 ID 형식입니다.');
            }
            
            const response = await fetch(`${apiBase}/${id}`, {
                method: 'PUT',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken 
                },
                body: JSON.stringify({ 
                    docker_tag: dockerTag,
                    old_docker_tag: oldDockerTag
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to update entry');
            }

            alert('항목이 성공적으로 업데이트되었습니다.');
        } catch (error) {
            console.error('Error updating entry:', error);
            alert('Error: ' + error.message);
        }
    }

    async function loadDockerFiles() {
        try {
            const response = await fetch(apiBase);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();

            if (data.length === 0) {
                errorMessageDiv.textContent = 'No records found.';
                tableBody.innerHTML = '';
                return;
            }

            errorMessageDiv.textContent = '';
            tableBody.innerHTML = '';
            
            data.forEach(item => {
                // XSS 방지를 위한 이스케이핑
                const escapeHtml = (unsafe) => {
                    return unsafe
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;")
                        .replace(/"/g, "&quot;")
                        .replace(/'/g, "&#039;");
                };
                
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${escapeHtml(String(item.id))}</td>
                    <td>${escapeHtml(item.docker_tag)}</td>
                    <td>${escapeHtml(new Date(item.created_at).toLocaleString())}</td>
                    <td><a href="${apiBase}/${encodeURIComponent(item.id)}/download/libc" class="download-link" data-id="${escapeHtml(String(item.id))}" data-type="libc">Download Libc</a></td>
                    <td><a href="${apiBase}/${encodeURIComponent(item.id)}/download/ld" class="download-link" data-id="${escapeHtml(String(item.id))}" data-type="ld">Download LD</a></td>
                    <td><button class="editBtn" data-id="${escapeHtml(String(item.id))}" data-docker-tag="${escapeHtml(item.docker_tag)}">Edit</button></td>
                    <td><button class="deleteBtn" data-id="${escapeHtml(String(item.id))}">Delete</button></td>
                `;
                tableBody.appendChild(row);
            });

            // 다운로드 링크 클릭 이벤트 추가
            document.querySelectorAll('.download-link').forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const id = link.getAttribute('data-id');
                    const fileType = link.getAttribute('data-type');
                    
                    // ID 검증
                    if (!/^\d+$/.test(id)) {
                        alert('유효하지 않은 ID 형식입니다.');
                        return;
                    }
                    
                    window.location.href = `${apiBase}/${id}/download/${fileType}`;
                });
            });

            document.querySelectorAll('.deleteBtn').forEach(button => {
                button.addEventListener('click', () => {
                    const id = button.getAttribute('data-id');
                    
                    // ID 검증
                    if (!/^\d+$/.test(id)) {
                        alert('유효하지 않은 ID 형식입니다.');
                        return;
                    }
                    
                    deleteDockerFile(id);
                });
            });

            document.querySelectorAll('.editBtn').forEach(button => {
                button.addEventListener('click', () => {
                    const id = button.getAttribute('data-id');
                    const dockerTag = button.getAttribute('data-docker-tag');
                    
                    // ID 검증
                    if (!/^\d+$/.test(id)) {
                        alert('유효하지 않은 ID 형식입니다.');
                        return;
                    }
                    
                    isEditMode = true;
                    editId = id;
                    oldDockerTag = dockerTag; // 기존 태그 저장
                    dockerTagInput.value = dockerTag;
                    libcFileInput.value = '';
                    ldFileInput.value = '';
                    popupTitle.textContent = 'Edit Docker Tag';
                    popup.classList.remove('hidden');
                });
            });
        } catch (error) {
            console.error('Error loading docker files:', error);
            errorMessageDiv.textContent = 'Failed to load data: ' + error.message;
        }
    }

    async function deleteDockerFile(id) {
        if (!confirm('정말로 이 항목을 삭제하시겠습니까?')) return;

        try {
            const response = await fetch(`${apiBase}/${id}`, {
                method: 'DELETE',
                headers: {
                    'X-CSRF-Token': csrfToken
                }
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to delete entry');
            }

            alert('항목이 성공적으로 삭제되었습니다.');
            loadDockerFiles();
        } catch (error) {
            console.error('Error deleting entry:', error);
            alert('Error: ' + error.message);
        }
    }

    // 초기화 시 데이터 로드
    loadDockerFiles();
});