# OpenStudio Personal

Your own agent. Your own software. On your own machine. Made by [OpenStudio](https://openstudio.tech).

<p align="center"><img src="docs/marcel-chat.jpg" alt="A conversation with Marcel" width="860"></p>

Marcel (your private little raccoon tinkerer) gets things done for you. He searches the web, reads the pictures you send him, uses the tools you have given him, and remembers how you like things done. It requires only an OpenRouter key to get started.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/hdJufp?referralCode=tl7Qqa) [![ghcr.io](https://img.shields.io/badge/ghcr.io-openstudiotech%2Fos--personal-blue?logo=docker&style=for-the-badge)](https://github.com/openstudiotech/os-personal/pkgs/container/os-personal)

## Pieces

OpenStudio agents use *Pieces* to get things done. A Piece is a small app that does one job: a budget that knows which day the rent goes out, a news scraper that reads your favourite sites, or a reminder that checks for the next school holiday. Think of it as a skill and the code behind it in one package. Pieces can call each other, and they get more useful as they are linked together.

There are two ways to make one.

1. **With Finn, at [openstudio.tech](https://openstudio.tech).** Describe the Piece and Finn builds it. He's a beaver so knows how to build new stuff. Raccoons are more scavengers than builders... Download it from OpenStudio and it will run on OpenStudio Personal. FYI - Finn also has access to a gallery, so you can share the Pieces you build and get access to other people's Pieces.

2. **With your own AI coding tool and OpenStudio Personal over MCP.** Open Settings, AI client, and copy the command for yours:

```sh
# Claude Code
claude mcp add --transport http openstudio-personal <address> --header "Authorization: Bearer <token>"

# Codex
export OPENSTUDIO_PERSONAL_TOKEN=<token>
codex mcp add openstudio-personal --url <address> --bearer-token-env-var OPENSTUDIO_PERSONAL_TOKEN
```

Any other client takes the same address and header.

## Why OpenStudio Personal exists

OpenStudio, the hosted version, has what teams crave: security rules, approvals, traceability, observability, and the rest of it. Those features are what we need to keep the lights on, and they are why that platform will cost money (eventually).

The Personal version exists because we have a pretty strong belief: You are the one building the agent, so the skills and the code you build with it should go where you go. If you don't like our service anymore, quit. Take what you built with you. (do please tell us why so we can make our service better!)

Writing code is cheap now. The ideas are what matter, and those should be yours to keep. Builders deserve to take their work to the ecosystem that makes them happy, and that's the type of "studio" we are building at OpenStudio.

## Launch it

### On Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/hdJufp?referralCode=tl7Qqa)

Sign in with `OPENSTUDIO_SECRET` from the control service's variables.

### On your own machine

```sh
docker run -d --name openstudio --restart unless-stopped \
  -p 127.0.0.1:4010:4010 -p 127.0.0.1:28181:28181 \
  -e OPENSTUDIO_UNSAFE_NO_SECRET=1 -v openstudio:/data \
  ghcr.io/openstudiotech/os-personal
```

Open http://127.0.0.1:4010 and say hello.

## What you need to get started

One key, from [OpenRouter](https://openrouter.ai/settings/keys). Marcel thinks with it and searches with it. If you add a [Steel](https://app.steel.dev/settings/api-keys) key, he can use a browser.

## Know before you run it

- It is not a hardened sandbox. Run pieces you chose.
- It has no accounts, roles or approvals. On your own machine, whoever can use the computer has **everything**. This is for home use, and you use it at your own risk.
- There is no approval step in OpenStudio Personal. Once you grant a Piece a service, it can do anything that service allows, such as send mail, delete an event or share a file, without asking you.

## Using OpenStudio Personal with Google Accounts

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

### We aren't accepting open pull requests here on GitHub, but please do email us with any services you build

We would love to know what you are building and are excited to add them to OpenStudio Personal. You can hook up any MCP server already, but if you want to build one in TypeScript and share it with the world... we would really love that.

## Bugs, patches and security

- **A bug:** [open an issue](../../issues/new/choose).
- **A fix:** we do not take pull requests on GitHub. Email a patch to [hi@openstudio.tech](mailto:hi@openstudio.tech) and we will read it. See [CONTRIBUTING.md](CONTRIBUTING.md).
- **A security problem:** email [security@openstudio.tech](mailto:security@openstudio.tech), not an issue. See [SECURITY.md](SECURITY.md).

## Licence

The [Sustainable Use License](LICENSE.md): free for your own use, including inside your own company. Third-party notices are in [THIRD-PARTY.md](THIRD-PARTY.md).
