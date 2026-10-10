# OpenStudio Personal

Your own agent. Your own software. On your own machine. Made by [OpenStudio](https://openstudio.tech).

<p align="center"><img src="docs/marcel-chat.jpg" alt="A conversation with Marcel" width="860"></p>

Marcel gets things done for you. He searches the web, reads the pictures you send him, uses the small apps you have built, and remembers how you like things done. It requires only an OpenRouter key to get started. There are no accounts.

## Pieces

OpenStudio agents use pieces to get things done. A piece is a small app that does one job: a budget that knows which day the rent goes out, a news scraper that reads your favourite sites, a reminder that checks for the next school holiday. Think of it as a skill and the code behind it in one package. Pieces can call each other, and they get more useful as they are linked together.

There are two ways to make one.

**With Finn, at [openstudio.tech](https://openstudio.tech).** Describe the piece and Finn builds it. Download it from there and it runs here. Finn also keeps a gallery, so a piece someone else made is a download away, and yours can be shared the same way.

**With your own AI coding tool, over MCP.** Open Settings, AI client, and copy the command for yours:

```sh
# Claude Code
claude mcp add --transport http openstudio-personal <address> --header "Authorization: Bearer <token>"

# Codex
export OPENSTUDIO_PERSONAL_TOKEN=<token>
codex mcp add openstudio-personal --url <address> --bearer-token-env-var OPENSTUDIO_PERSONAL_TOKEN
```

Any other client takes the same address and header. Then say what you want. The piece is written, tested and running, with its own page, its own state, and a schedule if it needs one. Marcel can use it from the next message.

## Why OpenStudio Personal exists

OpenStudio, the hosted version, has what teams need: security rules, approvals, traceability, observability, and the rest of it. Those features are how we keep the lights on, and they are why it will cost money eventually. For now it is free for beta users.

Both exist because of one belief. You are the one building the agent, so the skills and the code you build with it should go wherever you go. Writing code is cheap now. The ideas are what matter, and they are yours. They should belong to you.

## Launch it

### On Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/hdJufp?referralCode=tl7Qqa)

Two services, each with a volume, and the secrets made for you. Sign in with `OPENSTUDIO_SECRET` from the control service's variables.

### On your own machine

```sh
docker run -d --name openstudio --restart unless-stopped \
  -p 127.0.0.1:4010:4010 -p 127.0.0.1:28181:28181 \
  -e OPENSTUDIO_UNSAFE_NO_SECRET=1 -v openstudio:/data \
  ghcr.io/openstudiotech/os-personal
```

Open http://127.0.0.1:4010 and say hello.

## What you need

One key, from [OpenRouter](https://openrouter.ai/settings/keys). Marcel thinks with it and searches with it.

Add a [Steel](https://app.steel.dev/settings/api-keys) key and he can use a browser.

## Know before you run it

- It is not a hardened sandbox. Run pieces you chose.
- It has no accounts, roles or approvals. On your own machine, whoever can use the computer has everything. This is for home use, at your own risk.
- There is no approval step in OpenStudio Personal. Once you grant a piece a service, it can do anything that service allows, such as send mail, delete an event or share a file, without asking you.

## Google

Gmail, Google Calendar and Google Drive sign you in through a Google app of your own. Make it once:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the Gmail, Google Calendar and Google Drive APIs.
2. Set up the consent screen, and add yourself as a test user.
3. Create an OAuth client of type "Web application". Give it the redirect address shown on the Services page.
4. On the Services page, press Connect beside Gmail, Google Calendar or Google Drive. The first time, it asks for the client ID and client secret.

Google will say the app is unverified. It is yours, so that is expected.

## Development

Needs Node 22.18 or later and a celld binary at `.dev/celld-v0.6.2-openstudio.1`.

```sh
cd kernel && npm ci
cd ../control && npm ci
npm run kernel     # the kernel, on http://127.0.0.1:28181
npm start          # the control plane, on http://127.0.0.1:4010
```

To test it, with the kernel running:

```sh
cd kernel && CELLS_KERNEL_TEST_URL=http://127.0.0.1:28181 npm test
cd kernel && CELLS_KERNEL_TEST_URL=http://127.0.0.1:28181 node --test --test-force-exit test/scheduler.test.mjs
cd control && npm test
```

Every setting, who can reach it, and running it on Railway by hand are in [docs/running.md](docs/running.md). How pieces are written is in [docs/writing-a-piece.md](docs/writing-a-piece.md).

## Bugs, patches and security

- **A bug:** [open an issue](../../issues/new/choose).
- **A fix:** we do not take pull requests on GitHub. Email a patch to [hi@openstudio.tech](mailto:hi@openstudio.tech) and we will read it. See [CONTRIBUTING.md](CONTRIBUTING.md).
- **A security problem:** email [security@openstudio.tech](mailto:security@openstudio.tech), not an issue. See [SECURITY.md](SECURITY.md).

## Licence

The [Sustainable Use License](LICENSE.md): free for your own use, including inside your own company. Third-party notices are in [THIRD-PARTY.md](THIRD-PARTY.md).
