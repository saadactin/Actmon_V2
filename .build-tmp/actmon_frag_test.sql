SET ECHO ON
SET FEEDBACK ON
SET TIMING ON
WHENEVER SQLERROR CONTINUE

DROP TABLE actmon_frag_test PURGE;

CREATE TABLE actmon_frag_test (
    id         NUMBER PRIMARY KEY,
    filler     VARCHAR2(1000),
    created_at DATE DEFAULT SYSDATE
);

INSERT INTO actmon_frag_test (id, filler)
SELECT ROWNUM, RPAD('X', 1000, 'X')
FROM (SELECT LEVEL AS n FROM DUAL CONNECT BY LEVEL <= 2000) a,
     (SELECT LEVEL AS n FROM DUAL CONNECT BY LEVEL <= 700) b;
COMMIT;

EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'ACTMON_FRAG_TEST');

SELECT table_name, num_rows, blocks,
       ROUND(blocks * 8192 / 1024 / 1024, 1) AS allocated_mb
FROM   user_tables
WHERE  table_name = 'ACTMON_FRAG_TEST';

DELETE FROM actmon_frag_test WHERE MOD(id, 4) != 0;
COMMIT;

EXEC DBMS_STATS.GATHER_TABLE_STATS(USER, 'ACTMON_FRAG_TEST');

SELECT table_name, num_rows, blocks,
       ROUND(blocks * 8192 / 1024 / 1024, 1) AS allocated_mb
FROM   user_tables
WHERE  table_name = 'ACTMON_FRAG_TEST';

EXIT;
