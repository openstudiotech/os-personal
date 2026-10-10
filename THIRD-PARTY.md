# Third-party work in this release

## In this repository

Code from these is in the files named, so their notices are here in full.

| Work | Where | Licence | Copyright |
|---|---|---|---|
| **Heroicons** | The icons in the menu, `control/src/icons.ts` | MIT | Copyright (c) Tailwind Labs, Inc. |
| **Tailwind CSS** 4.3.3 | The built stylesheet, `control/assets/app.css` | MIT | Copyright (c) Tailwind Labs, Inc. |
| **capnweb** 0.11.1 | `kernel/assets/capnweb.js` | MIT | Copyright (c) 2025 Cloudflare, Inc. |
| **Chart.js** 4.5.1 | `kernel/assets/vendor/chart.js` | MIT | Copyright (c) 2014-2024 Chart.js Contributors |
| **@kurkle/color** 0.3.4 | Inside `kernel/assets/vendor/chart.js` | MIT | Copyright (c) 2018-2024 Jukka Kurkela |

### The MIT License

It applies to each work above, under that work's copyright line.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Installed when you set it up

Not in this repository. `npm ci` fetches them, each with its own licence file.

| Work | Used for | Licence | Copyright |
|---|---|---|---|
| **yaml** | Reads a piece's manifest | ISC | Copyright Eemeli Aro |
| **croner** | Times a piece's schedules | MIT | Copyright (c) 2015-2021 Hexagon |
| **esbuild**, **TypeScript**, **Tailwind CSS**, **@cloudflare/workers-types** | Building and checking | MIT, Apache 2.0, MIT, MIT or Apache 2.0 | |

## In the image the Dockerfile builds

| Work | Where in the image | Licence |
|---|---|---|
| **celld** (runs the kernel) | `/usr/local/bin/celld`, with its licences in `/usr/share/licenses/celld` and here in `licenses/celld` | Apache 2.0. Copyright Deno Land Inc. It includes code from Tokio, MIT, Copyright (c) Tokio Contributors |
| **Node.js** | `/usr/local`, with its licence at `/usr/local/LICENSE` | MIT, with the licences of what it bundles |

celld is used from a fork with one fix: https://github.com/openstudiotech/celld, tag `v0.6.2-openstudio.1`.
