-- One row per article: the text Wikipedia shows today.
-- MariaDB keeps every earlier version as a history row, because of WITH SYSTEM VERSIONING.
CREATE TABLE IF NOT EXISTS article (
  page_id   INT UNSIGNED NOT NULL,
  title     VARCHAR(255) NOT NULL,
  rev_id    INT UNSIGNED NOT NULL,
  user      VARCHAR(255),
  comment   TEXT,
  sha1      CHAR(31),
  text      MEDIUMTEXT COMPRESSED NOT NULL,
  row_start TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
  row_end   TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (page_id)
) CHARACTER SET utf8mb4 WITH SYSTEM VERSIONING;
