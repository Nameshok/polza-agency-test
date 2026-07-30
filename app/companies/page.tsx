/**
 * Задача 2: /companies — таблица компаний из Postgres с поиском по названию
 * и фильтром по городу.
 *
 * Решения, которые тут важны:
 *  - это Server Component: SQL выполняется на сервере, строка подключения в браузер
 *    не попадает, в клиентский бандл pg не тащится;
 *  - dynamic = 'force-dynamic' — иначе Next закеширует страницу и поиск будет
 *    отдавать вчерашний результат;
 *  - запрос параметризованный, а % и _ в поисковой строке экранируются, иначе
 *    пользователь, набравший «%», получит всю базу;
 *  - фильтр по городу работает по city_key, то есть «Москва», «москва», «Москва »
 *    и «Moscow» — это один город;
 *  - сортировка детерминированная (rating DESC NULLS LAST, external_id), иначе
 *    пагинация начнёт показывать одни и те же компании на разных страницах.
 */

import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface CompanyRow {
  external_id: string;
  name: string;
  category: string | null;
  city: string | null;
  city_key: string | null;
  address: string | null;
  rating: string | null;
  reviews_count: number | null;
  site: string | null;
  phone: string | null;
}

/** searchParams может отдать массив (?q=a&q=b) — берём первое значение. */
function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** В ILIKE % и _ — служебные символы. Экранируем их, а не выкидываем. */
function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

function pageUrl(params: { q: string; city: string; page: number }): string {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.city) search.set('city', params.city);
  if (params.page > 1) search.set('page', String(params.page));
  const qs = search.toString();
  return qs ? `/companies?${qs}` : '/companies';
}

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = firstValue(params.q).trim();
  const city = firstValue(params.city).trim();
  const pageParam = Number(firstValue(params.page) || '1');
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

  const namePattern = q ? `%${escapeLike(q)}%` : null;
  const cityFilter = city || null;

  const where = `
    WHERE ($1::text IS NULL OR name ILIKE $1 ESCAPE '\\')
      AND ($2::text IS NULL OR city_key = $2)
  `;

  const [cities, totals] = await Promise.all([
    query<{ city_key: string; companies: string }>(
      `SELECT city_key, count(*)::text AS companies
         FROM companies
        WHERE city_key IS NOT NULL
        GROUP BY city_key
        ORDER BY count(*) DESC, city_key`,
    ),
    query<{ total: string }>(
      `SELECT count(*)::text AS total FROM companies ${where}`,
      [namePattern, cityFilter],
    ),
  ]);

  const total = Number(totals[0]?.total ?? '0');
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // ?page=99999 не должен показывать пустоту — прижимаем к последней странице.
  const currentPage = Math.min(page, lastPage);

  const rows = await query<CompanyRow>(
    `SELECT external_id, name, category, city, city_key, address,
            rating, reviews_count, site, phone
       FROM companies
       ${where}
      ORDER BY rating DESC NULLS LAST, reviews_count DESC, external_id
      LIMIT $3 OFFSET $4`,
    [namePattern, cityFilter, PAGE_SIZE, (currentPage - 1) * PAGE_SIZE],
  );
  const hasFilters = q !== '' || city !== '';

  return (
    <main>
      <h1>Компании</h1>
      <p className="sub">
        Данные из Postgres, запрос выполняется на сервере. Найдено: {total.toLocaleString('ru-RU')}
        {hasFilters ? ' по текущему фильтру' : ' всего'}.
      </p>

      <form action="/companies" method="get">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Поиск по названию: Восток, ИП, Медиа…"
          aria-label="Поиск по названию"
        />
        <select name="city" defaultValue={city} aria-label="Город">
          <option value="">Все города</option>
          {cities.map((item) => (
            <option key={item.city_key} value={item.city_key}>
              {item.city_key} ({item.companies})
            </option>
          ))}
        </select>
        <button type="submit">Показать</button>
        {hasFilters && (
          <a className="reset" href="/companies">
            сбросить
          </a>
        )}
      </form>

      {rows.length === 0 ? (
        <p className="empty">
          Ничего не найдено. {hasFilters && <a href="/companies">Сбросить фильтры</a>}
        </p>
      ) : (
        <>
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th>Категория</th>
                <th>Город</th>
                <th>Адрес</th>
                <th style={{ textAlign: 'right' }}>Рейтинг</th>
                <th style={{ textAlign: 'right' }}>Отзывы</th>
                <th>Сайт</th>
                <th>Телефон</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.external_id}>
                  <td>
                    {row.name}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {row.external_id}
                    </div>
                  </td>
                  <td>{row.category ?? <span className="muted">—</span>}</td>
                  <td>{row.city_key ?? <span className="muted">—</span>}</td>
                  <td>{row.address ?? <span className="muted">—</span>}</td>
                  <td className="num">{row.rating ?? <span className="muted">—</span>}</td>
                  <td className="num">
                    {row.reviews_count ?? <span className="muted">—</span>}
                  </td>
                  <td>
                    {row.site ? (
                      <a href={row.site} target="_blank" rel="noreferrer noopener">
                        {row.site.replace(/^https?:\/\//, '')}
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {row.phone ?? <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <div className="pager">
            {currentPage > 1 ? (
              <a href={pageUrl({ q, city, page: currentPage - 1 })}>← назад</a>
            ) : (
              <span className="muted">← назад</span>
            )}
            <span className="muted">
              страница {currentPage} из {lastPage}
            </span>
            {currentPage < lastPage ? (
              <a href={pageUrl({ q, city, page: currentPage + 1 })}>вперёд →</a>
            ) : (
              <span className="muted">вперёд →</span>
            )}
          </div>
        </>
      )}
    </main>
  );
}
