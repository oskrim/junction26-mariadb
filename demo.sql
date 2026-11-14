-- A tour of system-versioned tables. Run:
--   docker compose exec -T mariadb mariadb -uwiki -pwiki wiki -t -v < demo.sql
SET time_zone = '+00:00';

-- 1. The mechanism on a toy table. No history code: only WITH SYSTEM VERSIONING.
CREATE OR REPLACE TABLE price (item VARCHAR(20) PRIMARY KEY, eur INT) WITH SYSTEM VERSIONING;
INSERT INTO price VALUES ('milk', 1);
DO SLEEP(0.01); SET @after_insert = NOW(6); DO SLEEP(0.01);
UPDATE price SET eur = 2 WHERE item = 'milk';
DO SLEEP(0.01);
DELETE FROM price WHERE item = 'milk';

-- The table is empty now.
SELECT COUNT(*) AS rows_now FROM price;
-- Every version is still there. A row is "current" while row_end is the maximum timestamp.
SELECT item, eur, ROW_START, ROW_END FROM price FOR SYSTEM_TIME ALL ORDER BY ROW_START;
-- The table as it was at one moment.
SELECT item, eur FROM price FOR SYSTEM_TIME AS OF @after_insert;

-- 2. One Wikipedia article at four moments.
SELECT '2006' AS as_of, rev_id, user, CHAR_LENGTH(text) AS chars
  FROM article FOR SYSTEM_TIME AS OF TIMESTAMP '2006-01-01 00:00:00' WHERE title = 'Alan Turing'
UNION ALL
SELECT '2012', rev_id, user, CHAR_LENGTH(text)
  FROM article FOR SYSTEM_TIME AS OF TIMESTAMP '2012-01-01 00:00:00' WHERE title = 'Alan Turing'
UNION ALL
SELECT '2020', rev_id, user, CHAR_LENGTH(text)
  FROM article FOR SYSTEM_TIME AS OF TIMESTAMP '2020-01-01 00:00:00' WHERE title = 'Alan Turing'
UNION ALL
SELECT 'now', rev_id, user, CHAR_LENGTH(text) FROM article WHERE title = 'Alan Turing';

-- 3. AS OF applies to the whole table: which articles existed, and how much text.
SELECT '2004' AS as_of, COUNT(*) AS articles, SUM(CHAR_LENGTH(text)) AS chars
  FROM article FOR SYSTEM_TIME AS OF TIMESTAMP '2004-01-01 00:00:00'
UNION ALL
SELECT '2010', COUNT(*), SUM(CHAR_LENGTH(text))
  FROM article FOR SYSTEM_TIME AS OF TIMESTAMP '2010-01-01 00:00:00'
UNION ALL
SELECT 'now', COUNT(*), SUM(CHAR_LENGTH(text)) FROM article;

-- 4. Join two moments of the same table: growth since 2010.
SELECT cur.title, CHAR_LENGTH(old.text) AS chars_2010, CHAR_LENGTH(cur.text) AS chars_now
FROM article AS cur
JOIN article FOR SYSTEM_TIME AS OF TIMESTAMP '2010-01-01 00:00:00' AS old USING (page_id)
ORDER BY CHAR_LENGTH(cur.text) - CHAR_LENGTH(old.text) DESC LIMIT 5;

-- 5. A time range: the versions that were live at some point in one week.
SELECT rev_id, row_start, user, LEFT(comment, 40) AS comment
FROM article FOR SYSTEM_TIME BETWEEN TIMESTAMP '2012-06-23 00:00:00' AND TIMESTAMP '2012-06-30 00:00:00'
WHERE title = 'Alan Turing' ORDER BY row_start;

-- 6. Reverts: a version whose text differs from the one before it, but equals an older one.
SELECT title, COUNT(*) AS versions, SUM(is_revert) AS reverts
FROM (SELECT title,
             sha1 <> LAG(sha1) OVER (PARTITION BY page_id ORDER BY row_start)
               AND MIN(row_start) OVER (PARTITION BY page_id, sha1) < row_start AS is_revert
      FROM article FOR SYSTEM_TIME ALL) AS v
GROUP BY title ORDER BY reverts DESC LIMIT 5;
