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

    const buildButton = document.getElementById('buildButton');
    const ubuntuInput = document.getElementById('ubuntuVersion');
    const digestInput = document.getElementById('digestValue');

    if (buildButton && ubuntuInput && digestInput) {
        buildButton.addEventListener('click', async () => {
            const ubuntuVersion = ubuntuInput.value.trim();
            const digest = digestInput.value.trim();

            if (!ubuntuVersion.match(/^\d+\.\d+$/)) {
                alert('Ubuntu Version은 올바른 형식(예: 22.04)이어야 합니다.');
                return;
            }

            if (digest && (!digest.match(/^[a-f0-9]{64}$/))) {
                alert('Digest는 64자리의 16진수여야 합니다.');
                return;
            }

            const payload = { ubuntuVersion, digest };

            try {
                const response = await fetch('/backend/build-docker', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (response.ok) {
                    const result = await response.json();
                    alert('Docker 빌드 성공: ' + JSON.stringify(result));
                } else {
                    const errorMessage = await response.text();
                    alert(`요청 실패: ${errorMessage}`);
                }
            } catch (error) {
                alert('요청 실패: ' + error.message);
            }
        });
    }
});