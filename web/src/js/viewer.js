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

    let isEditMode = false;
    let editId = null;

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

        if (!dockerTag) {
            alert('Docker Tag를 입력해주세요.');
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
            const response = await fetch(`${apiBase}/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ docker_tag: dockerTag })
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
                return;
            }

            tableBody.innerHTML = '';
            data.forEach(item => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${item.id}</td>
                    <td>${item.docker_tag}</td>
                    <td>${new Date(item.created_at).toLocaleString()}</td>
                    <td><a href="${apiBase}/${item.id}/download/libc">Download Libc</a></td>
                    <td><a href="${apiBase}/${item.id}/download/ld">Download LD</a></td>
                    <td><button class="editBtn" data-id="${item.id}" data-docker-tag="${item.docker_tag}">Edit</button></td>
                    <td><button class="deleteBtn" data-id="${item.id}">Delete</button></td>
                `;
                tableBody.appendChild(row);
            });

            document.querySelectorAll('.deleteBtn').forEach(button => {
                button.addEventListener('click', () => {
                    const id = button.getAttribute('data-id');
                    deleteDockerFile(id);
                });
            });

            document.querySelectorAll('.editBtn').forEach(button => {
                button.addEventListener('click', () => {
                    const id = button.getAttribute('data-id');
                    const dockerTag = button.getAttribute('data-docker-tag');
                    isEditMode = true;
                    editId = id;
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
                method: 'DELETE'
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

    loadDockerFiles();
});