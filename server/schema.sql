-- One table per dataset, and their search indexes. FULLTEXT indexes use the tables' default collation,
-- utf8mb4_uca1400_ai_ci, so "sisallissota" finds "sisällissota" and case does not matter.

-- S: the history-of-Finland articles as they are now, in Finnish, Swedish and English (Markdown).
CREATE TABLE IF NOT EXISTS s_article (
  lang          CHAR(2)      NOT NULL,
  page_id       INT UNSIGNED NOT NULL,
  rev_id        INT UNSIGNED NOT NULL,
  wikidata_id   VARCHAR(20),
  title         VARCHAR(255) NOT NULL,
  url           VARCHAR(500) NOT NULL,
  date_modified DATETIME,
  text          MEDIUMTEXT   NOT NULL,
  PRIMARY KEY (lang, page_id),
  KEY title (lang, title)
) CHARACTER SET utf8mb4;

-- S: which categories each Finnish article is in.
CREATE TABLE IF NOT EXISTS s_category (
  page_id  INT UNSIGNED NOT NULL,
  category VARCHAR(255) NOT NULL,
  PRIMARY KEY (page_id, category)
) CHARACTER SET utf8mb4;

-- M: every saved version of an article, and the current text of every other Finnish article (L). The current version is the current row; each earlier one
-- is a history row stored with Wikipedia's real edit times, so FOR SYSTEM_TIME AS OF '2015-06-01'
-- returns what Wikipedia showed on 1 June 2015. An L article has one version, in Markdown (format).
CREATE TABLE IF NOT EXISTS m_article (
  page_id   INT UNSIGNED NOT NULL,
  title     VARCHAR(255) NOT NULL,
  rev_id    INT UNSIGNED NOT NULL,
  user      VARCHAR(255),
  anonymous BOOL NOT NULL,
  comment   TEXT,
  minor     BOOL NOT NULL,
  sha1      CHAR(31),
  bytes     INT UNSIGNED NOT NULL,
  text      MEDIUMTEXT COMPRESSED NOT NULL,
  format    ENUM('wikitext', 'markdown') NOT NULL DEFAULT 'wikitext',
  row_start TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
  row_end   TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (page_id),
  -- MariaDB's own index on the versions is (page_id, row_end), so "as of 2005" walks every version that
  -- ended after 2005. This one finds the last version that started before.
  KEY start_key (page_id, row_start),
  KEY (rev_id),
  KEY (title)
) CHARACTER SET utf8mb4 WITH SYSTEM VERSIONING;

-- M: one row per [[link]] from an article to another history-of-Finland article, for as long as the
-- link was in the text. Read AS OF a date, it is the link graph on that date.
CREATE TABLE IF NOT EXISTS m_link (
  src       INT UNSIGNED NOT NULL,
  dst       VARCHAR(255) NOT NULL,
  row_start TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
  row_end   TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (src, dst),
  KEY (dst)
) CHARACTER SET utf8mb4 WITH SYSTEM VERSIONING;

-- M: one row per article, written by the loader with its versions: the current title, how many versions
-- it has and when the first was saved. Counting them in m_article on each request reads every version.
-- topic is the article's S category that the most M articles share.
CREATE TABLE IF NOT EXISTS m_article_stats (
  page_id  INT UNSIGNED NOT NULL,
  title    VARCHAR(255) NOT NULL,
  versions INT UNSIGNED NOT NULL,
  first    TIMESTAMP(6) NOT NULL,
  topic    VARCHAR(255),
  PRIMARY KEY (page_id),
  KEY (title),
  FULLTEXT KEY title_ft (title)
) CHARACTER SET utf8mb4;

-- M: the text search looks in, one row per article: its current Finnish S text, else its current M text.
CREATE TABLE IF NOT EXISTS m_search (
  page_id INT UNSIGNED NOT NULL,
  text    MEDIUMTEXT   NOT NULL,
  PRIMARY KEY (page_id),
  FULLTEXT KEY text_ft (text)
) CHARACTER SET utf8mb4;

-- One BAAI/bge-m3 vector per article and language, from its title and current text: S's ready-made vectors
-- (fi, sv, en), and embed.py's for the Finnish articles S has none for. The vector index needs NOT NULL, so a
-- row exists only once its vector does. M=16, not the default 6: with 1024 dimensions M=6 found only 79% of
-- the true top 10 (MariaDB's RAG starter).
CREATE TABLE IF NOT EXISTS article_vector (
  lang      CHAR(2)      NOT NULL,
  page_id   INT UNSIGNED NOT NULL,
  model     VARCHAR(50)  NOT NULL,
  truncated BOOL         NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  PRIMARY KEY (lang, page_id),
  VECTOR INDEX (embedding) M=16 DISTANCE=cosine
);

-- One voyage-4-lite vector per Finnish article (server/voyage.py), from the same text as article_vector's, at the
-- model's full 2048 dimensions. tokens is the article's share of its request's token count, by text length.
CREATE TABLE IF NOT EXISTS article_vector_voyage (
  page_id   INT UNSIGNED NOT NULL,
  model     VARCHAR(50)  NOT NULL,
  tokens    INT          NOT NULL,
  embedding VECTOR(2048) NOT NULL,
  PRIMARY KEY (page_id),
  VECTOR INDEX (embedding) M=16 DISTANCE=cosine
);
