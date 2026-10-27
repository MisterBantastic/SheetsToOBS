# Contributing

Thanks for helping! A few notes:

- **Run the tests:** `npm install` then `npm test`. Tests use a temporary data folder and never touch your real `config.json`.
- **Never commit secrets:** `config.json`, logs and build output are in `.gitignore`. Check `git status` before committing.
- **Escape sheet text:** anything that comes from a sheet or OBS must be escaped before it goes into HTML (`escapeHtml` in `src/public/app.js`). Use `data-action` attributes instead of inline `onclick`, because the page runs under a strict Content-Security-Policy.
- **Experimental code:** the Control Sheet / Web Dashboard (`src/engine/control-sheet.js`, `src/public/dashboard.*`) is behind the Experimental Features switch (Personalization tab). Keep it that way until it's ready.
- **AI-assisted changes:** welcome, but say so in the pull request and make sure you've run and checked the change yourself (see [AI_DISCLOSURE.md](AI_DISCLOSURE.md)).
