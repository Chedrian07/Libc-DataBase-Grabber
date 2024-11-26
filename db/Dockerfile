FROM mysql:8.0

COPY init.sql /docker-entrypoint-initdb.d/init.sql
COPY .my.cnf /root/.my.cnf
RUN chmod 600 /root/.my.cnf