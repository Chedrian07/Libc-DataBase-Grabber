FROM nginx:alpine

# Nginx 기본 설정 덮어쓰기
COPY nginx.conf /etc/nginx/nginx.conf

# 소스 파일 복사
COPY src /usr/share/nginx/html

# 포트 노출
EXPOSE 80

# Nginx 실행
CMD ["nginx", "-g", "daemon off;"]
