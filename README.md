# Liquid Player

Простой музыкальный плеер в стиле iOS liquid glass (Electron).

## Возможности
- Приветствие по имени пользователя ПК и времени суток
- Плавная фоновая анимация-визуализатор (Web Audio API), реагирует на музыку
- Источник «Локальная папка»: выбор папки, рекурсивный поиск аудио (mp3, flac, wav, ogg, m4a, aac, opus…), теги и обложки
- Источник «Другие приложения»: постоянный поиск треков, которые играют в других программах (Spotify, браузер, Яндекс Музыка и т.д.), управление ими (пауза / следующий / предыдущий)
  - Windows: системные медиа-сессии (GlobalSystemMediaTransportControls); звук для визуализатора берётся через loopback-захват системного аудио
  - Linux: MPRIS через `playerctl`
  - macOS: Spotify / Music через AppleScript
- Анимация выбора трека: список «утекает» в волны визуализатора, обложка плавно появляется вместе с кнопками, на фоне — размытая обложка

## Запуск
```bash
npm install
npm start
```

Требуется Node.js 18+. На Windows должна работать служба «Windows Audio» (на обычных ПК она включена по умолчанию),
иначе система не отдаёт медиа-сессии других приложений.

## Скачать
Готовые сборки — на странице [Releases](https://github.com/Gitroomcust/liquid-player/releases), отдельно для каждой системы:
- **Windows** — `liquid-player-<версия>-windows-x64-setup.exe` (установщик) или `...-portable.exe` (без установки)
- **macOS** — `liquid-player-<версия>-mac-arm64.zip` (Apple Silicon) / `...-mac-x64.zip` (Intel). Сборка не подписана: при первом запуске — ПКМ по приложению → «Открыть»
- **Linux** — `.AppImage`, `.deb` или `.tar.gz`

## Сборка
```bash
npm run dist:linux   # AppImage, deb, tar.gz
npm run dist:mac     # zip (x64 + arm64)
npm run dist:win     # setup.exe + portable.exe (на Linux нужен wine, напр. образ electronuserland/builder:wine)
```
Артефакты появляются в `dist/`.

## Структура
- `src/main.js` — главный процесс: окно, выбор папки, чтение тегов (`music-metadata`), протокол `media://` для локальных файлов, loopback-аудио
- `src/system-media.js` — опрос медиа-сессий других приложений (каждые 1.5 с)
- `scripts/media-sessions.ps1` — PowerShell-скрипт для Windows (чтение сессий и управление)
- `src/renderer/` — интерфейс: `index.html`, `style.css` (liquid glass), `viz.js` (визуализатор), `app.js` (логика)
