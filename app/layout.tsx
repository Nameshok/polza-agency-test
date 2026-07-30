import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Компании — тестовое Polza Agency',
  description: 'Справочник компаний из Postgres: поиск по названию и фильтр по городу',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
