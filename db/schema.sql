-- Схема базы под выгрузку компаний.
-- Идея: сырые строки и чистые данные живут раздельно. Любая строка из любого файла
-- сначала попадает в import_rows «как пришла», и только та, что прошла валидацию,
-- доезжает до companies. Так загрузка ничего не теряет и не портит, а всё сомнительное
-- остаётся видимым в БД, а не только в логе.

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- индекс под поиск по названию через ILIKE '%…%'

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Журнал прогонов загрузчика
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_runs (
  id           bigserial PRIMARY KEY,
  source       text        NOT NULL,          -- 'api_pages' | 'review_csv'
  -- clock_timestamp(), а не now(): now() внутри транзакции возвращает время её начала,
  -- и длительность прогона всегда получалась бы нулевой.
  started_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at  timestamptz,
  stats        jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Сырые строки: что именно пришло, из какого файла, из какой строки
--    и что с этим решил загрузчик
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_rows (
  id           bigserial PRIMARY KEY,
  run_id       bigint      NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  source_file  text        NOT NULL,
  source_row   integer     NOT NULL,          -- номер строки в CSV / индекс в items[]
  external_id  text,                          -- id как пришёл, может быть пустым
  raw          jsonb       NOT NULL,          -- строка целиком, до нормализации
  status       text        NOT NULL,
  issues       text[]      NOT NULL DEFAULT '{}',
  CONSTRAINT import_rows_status_chk CHECK (
    status IN ('applied', 'unchanged', 'duplicate', 'quarantined', 'rejected')
  )
);

-- Повторный запуск не должен плодить копии одной и той же строки одного файла.
-- Следствие, о котором стоит знать: import_rows — снимок ПОСЛЕДНЕГО прогона по каждой
-- строке, а не полная история. Историю прогонов со счётчиками держит import_runs.
CREATE UNIQUE INDEX IF NOT EXISTS import_rows_uniq
  ON import_rows (source_file, source_row);

CREATE INDEX IF NOT EXISTS import_rows_status_idx ON import_rows (status);
CREATE INDEX IF NOT EXISTS import_rows_issues_idx ON import_rows USING gin (issues);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Компании — только валидные записи
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  external_id     text PRIMARY KEY,           -- id поставщика: единственный надёжный ключ
  name            text NOT NULL,
  name_key        text NOT NULL,              -- имя без «кавычек» и ООО/АО/ИП — только для поиска дублей
  category        text,
  city            text,                       -- как в источнике, после trim
  city_key        text,                       -- канонический город: Moscow/москва/«Москва » → Москва
  address         text,
  rating          numeric(2,1) CHECK (rating >= 0 AND rating <= 5),
  -- NULL = «неизвестно». Ноль означал бы «отзывов нет» — это утверждение,
  -- которого в данных нет (см. ANOMALIES.md, п. 6).
  reviews_count   integer CHECK (reviews_count >= 0),
  site            text,
  phone           text,                       -- как в источнике
  phone_e164      text,                       -- +7XXXXXXXXXX, для сверки дублей
  source          text NOT NULL,
  source_file     text NOT NULL,
  source_row      integer NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS companies_city_key_idx  ON companies (city_key);
CREATE INDEX IF NOT EXISTS companies_category_idx  ON companies (category);
CREATE INDEX IF NOT EXISTS companies_rating_idx    ON companies (rating);
CREATE INDEX IF NOT EXISTS companies_reviews_idx   ON companies (reviews_count);
-- Поиск по названию идёт как ILIKE '%…%' — обычный btree тут бесполезен, нужен триграммный.
CREATE INDEX IF NOT EXISTS companies_name_trgm_idx ON companies USING gin (name gin_trgm_ops);
-- Сверка бизнес-дублей: одна компания под двумя id.
CREATE INDEX IF NOT EXISTS companies_phone_e164_idx ON companies (phone_e164);
CREATE INDEX IF NOT EXISTS companies_city_addr_idx   ON companies (city_key, address);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Подозрения на дубли: одна и та же компания под разными external_id.
--    Автоматически НЕ склеиваем — только фиксируем на ручную проверку.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS duplicate_candidates (
  id            bigserial PRIMARY KEY,
  external_id   text NOT NULL,                -- новая запись
  duplicate_of  text NOT NULL,                -- уже загруженная запись
  match_reason  text NOT NULL,                -- 'phone' | 'city_address' | 'phone+city_address'
  confidence    text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  found_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT duplicate_candidates_uniq UNIQUE (external_id, duplicate_of, match_reason)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Кандидаты в email и результат их проверки.
--    В выгрузке поля email нет (см. ANOMALIES.md), поэтому адреса здесь ВЫВЕДЕНЫ
--    из домена сайта, а не получены из источника. Это догадки, и колонка source
--    существует ровно для того, чтобы догадка никогда не смешалась с фактом:
--    рассылка по неподтверждённым адресам сжигает домен отправителя.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_candidates (
  id            bigserial PRIMARY KEY,
  external_id   text NOT NULL,                -- какой компании принадлежит
  email         text NOT NULL,                -- адрес после исправления опечаток
  local_part    text NOT NULL,
  domain        text NOT NULL,
  source        text NOT NULL CHECK (source IN ('derived_from_site', 'from_source')),
  status        text NOT NULL CHECK (status IN ('valid', 'quarantined', 'rejected', 'unknown')),
  -- На каком из шести этапов адрес выбыл. NULL — дошёл до конца.
  stage_failed  text CHECK (stage_failed IN
                  ('domain_typo', 'syntax', 'role', 'disposable', 'mx', 'smtp')),
  issues        text[] NOT NULL DEFAULT '{}',
  checked_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_candidates_uniq UNIQUE (external_id, email)
);

CREATE INDEX IF NOT EXISTS email_candidates_status_idx ON email_candidates (status);
CREATE INDEX IF NOT EXISTS email_candidates_domain_idx ON email_candidates (domain);
CREATE INDEX IF NOT EXISTS email_candidates_stage_idx  ON email_candidates (stage_failed);
