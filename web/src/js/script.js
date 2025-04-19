// script.js
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

    const buildButton = document.getElementById('buildButton');
    const ubuntuInput = document.getElementById('ubuntuVersion');
    const digestInput = document.getElementById('digestValue');
    const resultElement = document.createElement('div');
    resultElement.id = 'buildResult';
    resultElement.className = 'result-message';
    
    // 결과 메시지 컨테이너 추가
    if (buildButton && ubuntuInput) {
        buildButton.parentNode.appendChild(resultElement);
    }

    if (buildButton && ubuntuInput && digestInput) {
        buildButton.addEventListener('click', async () => {
            const ubuntuVersion = ubuntuInput.value.trim();
            const digest = digestInput.value.trim();

            // 입력 유효성 검사 강화
            if (!ubuntuVersion.match(/^\d+\.\d+$/)) {
                resultElement.textContent = 'Ubuntu Version은 올바른 형식(예: 22.04)이어야 합니다.';
                resultElement.className = 'result-message error';
                return;
            }

            if (digest && (!digest.match(/^[a-f0-9]{64}$/))) {
                resultElement.textContent = 'Digest는 64자리의 16진수여야 합니다.';
                resultElement.className = 'result-message error';
                return;
            }

            // 로딩 메시지 표시
            resultElement.textContent = '빌드 요청 중...';
            resultElement.className = 'result-message loading';
            
            // 요청 제한 시간 설정
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30초 후 요청 중단

            const payload = { ubuntuVersion, digest };

            try {
                const response = await fetch('/backend/build-docker', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });

                clearTimeout(timeoutId); // 타임아웃 취소
                
                if (response.ok) {
                    const result = await response.json();
                    
                    // XSS 방지를 위한 이스케이핑
                    const escapeHtml = (unsafe) => {
                        return unsafe
                            .replace(/&/g, "&amp;")
                            .replace(/</g, "&lt;")
                            .replace(/>/g, "&gt;")
                            .replace(/"/g, "&quot;")
                            .replace(/'/g, "&#039;");
                    };
                    
                    resultElement.textContent = '빌드 성공: ' + escapeHtml(result.message);
                    resultElement.className = 'result-message success';
                    
                    // 빌드 성공 후 입력 필드 초기화
                    ubuntuInput.value = '';
                    digestInput.value = '';
                } else {
                    // 오류 메시지 처리
                    try {
                        const errorData = await response.json();
                        resultElement.textContent = `요청 실패: ${errorData.error || '알 수 없는 오류'}`;
                    } catch (parseError) {
                        resultElement.textContent = `요청 실패: ${response.status} ${response.statusText}`;
                    }
                    resultElement.className = 'result-message error';
                }
            } catch (error) {
                clearTimeout(timeoutId); // 타임아웃 취소
                
                if (error.name === 'AbortError') {
                    resultElement.textContent = '요청 시간 초과: 요청이 너무 오래 걸립니다.';
                } else {
                    resultElement.textContent = '요청 실패: ' + error.message;
                }
                resultElement.className = 'result-message error';
            }
        });
    }
});