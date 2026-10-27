# AI Disclosure

**SheetsToOBS was made with AI.** Please read this before you rely on it.

## What that means

- Most of this repository was written by AI coding assistants, including Anthropic's Claude. That covers the desktop server and GUI, the sync engine, the Windows launcher and installer scripts, the tests and the documentation.
- A human maintainer chose what to build, ran it against real OBS setups and Google Sheets, reviewed changes, and decided what to publish.
- The code has **not** had an independent professional security audit or code review.
- Automated tests exist (`npm test`), but they can't cover every OBS setup, plugin, sheet layout or network.

## What you should do

1. **Test on copies first:** a copy of your Google Sheet and a separate OBS scene collection.
2. **Protect your credentials:** set an OBS WebSocket password, restrict your Google API key to the Sheets API, and never share `config.json`.
3. **Have a fallback for live shows:** know how to set your key graphics by hand in OBS if the sync stops or misbehaves.
4. **Review before you trust:** read the code, especially anything that touches the network or your credentials. Everything is here.
5. **Report problems:** see [SECURITY.md](SECURITY.md) for security issues, or open an issue for bugs.

## No warranty

As the [MIT License](LICENSE) says, the software is provided **"as is"**, without warranty of any kind. The authors and contributors are not responsible for broadcast failures, wrong graphics on air, lost data or exposed credentials.

## Contributions

AI-assisted contributions are welcome. Please say in your pull request that AI helped, and make sure you have run and checked the change yourself.
