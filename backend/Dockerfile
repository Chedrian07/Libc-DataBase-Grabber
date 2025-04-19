FROM node:18

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

# libc-data 디렉토리가 올바른 경로에 생성되도록 수정
RUN mkdir -p /usr/src/libc-data/data
RUN cp -r app/libc-data/* /usr/src/libc-data/
RUN chmod +x /usr/src/libc-data/export.sh

# .my.cnf 파일 복사 && 권한 설정
COPY .my.cnf /root/.my.cnf
RUN chmod 600 /root/.my.cnf

# Docker && Mysql Client 설치
RUN apt-get update && \
    apt-get install -y docker.io && \
    apt-get install -y default-mysql-client && \
    rm -rf /var/lib/apt/lists/*

EXPOSE 3000

CMD ["node", "app/server.js"]