-- Три запроса из задания. Запустить все сразу: npm run queries
-- Или по одному в psql:
--   docker compose exec db psql -U polza -d polza -f /dev/stdin < db/queries.sql
--
-- Общие решения, одинаковые для всех трёх:
--  * группировка по city_key / category — это нормализованные значения,
--    иначе «Москва», «москва», «Москва » и «Moscow» дадут четыре разных города;
--  * в companies попадают только валидные записи, карантин и мусор лежат
--    отдельно в import_rows и в агрегаты не подмешиваются.

-- @name Топ-5 категорий по числу компаний
SELECT
  category,
  count(*) AS companies
FROM companies
WHERE category IS NOT NULL
GROUP BY category
ORDER BY companies DESC, category
LIMIT 5;

-- @name Средний рейтинг по городам среди компаний с 10+ отзывами
-- rating IS NOT NULL обязателен: неизвестный рейтинг — это NULL, а не 0,
-- и включать его в среднее нельзя. avg() сам игнорирует NULL, но фильтр
-- нужен, чтобы rated_companies считал именно те компании, что попали в среднее.
SELECT
  city_key AS city,
  count(*)                        AS rated_companies,
  round(avg(rating), 2)           AS avg_rating,
  min(rating)                     AS min_rating,
  max(rating)                     AS max_rating
FROM companies
WHERE reviews_count >= 10
  AND rating IS NOT NULL
  AND city_key IS NOT NULL
GROUP BY city_key
ORDER BY avg_rating DESC, city;

-- @name Доля компаний с сайтом по категориям
-- count(*) FILTER вместо суммы CASE — читается короче и считает то же самое.
-- Приведение к numeric обязательно: два integer в Postgres делятся нацело
-- и доля превратилась бы в 0.
SELECT
  category,
  count(*)                                          AS companies,
  count(*) FILTER (WHERE site IS NOT NULL)          AS with_site,
  round(
    100.0 * count(*) FILTER (WHERE site IS NOT NULL) / count(*),
    1
  )                                                 AS with_site_percent
FROM companies
WHERE category IS NOT NULL
GROUP BY category
ORDER BY with_site_percent DESC, companies DESC, category;
