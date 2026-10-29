# Chapp

A voice-first lab companion that knows every vial in your kit. Tell Chapp which kit you are running; it reads the vendor's
manual into a structured protocol, recognizes each bottle from one photo of your kit, and walks you through the run with
the right bottle, the right volume and the right timer on screen.

The name is *chaperone* + *app*. Molecular chaperones such as heat shock proteins help other proteins fold and stay
stable under stress without doing their work for them; Chapp does the same for the person at the bench. Its character is
a small, soft protein in blue, teal and lavender (`public/chapp/`).

**Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)** (Oct 26 – Nov 4, 2026, Indie Developer track).
Everything in this repository was written during the hackathon, starting October 27, 2026.

## Status

Phase 1 of 5: project setup, the protocol format, the first real protocol (Pierce BCA Protein Assay) and the interface
style.

## Meta models

| Model | What Chapp uses it for |
|---|---|
| Muse Spark 1.3 | Finding the vendor manual (web search), reading the PDF into a structured protocol, answering questions with citations, composing screens |
| SAM 3.1 | Segmenting every bottle in one photo of the kit |
| Muse Voice Transcribe | Hands-free commands at the bench |
| Muse Image | One consistent set of equipment icons |

## How Chapp asks Muse Spark to read a manual

Measured on the Pierce BCA manual (5 pages), Muse Spark 1.3 either way.

| | Read it straight | Read it the way Chapp teaches it |
|---|---|---|
| How it reads | The whole PDF in every call, medium thinking, nothing shown until done | What matters first, then the rest; mostly text, minimal thinking (low for the steps) |
| Steps on screen | 88–95 s | about 8 s |
| Whole protocol | 88–95 s | 20–29 s |

More thinking only made the straight read slower: 96 s at high, 189 s at xhigh, 215 s at max, with no fewer mistakes.

How Chapp asks it to read:
- **What matters first.** One quick call returns what the kit is, its at-a-glance summary and its steps; the rest is
  read alongside.
- **Text where pictures don't matter.** Only the quick call gets the PDF; the others get the manual's text, a third of
  the tokens.
- **A shorter answer.** One short citation per row, timers only where a step has one, nothing the app doesn't show:
  about a third less to write.

## Built with

- [React](https://github.com/facebook/react), [Vite](https://github.com/vitejs/vite), [TypeScript](https://github.com/microsoft/TypeScript), [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss)
- [React Router](https://github.com/remix-run/react-router), [Zustand](https://github.com/pmndrs/zustand) (state), [Zod](https://github.com/colinhacks/zod) (checking every model reply)
- [Radix UI](https://github.com/radix-ui/primitives), [Sonner](https://github.com/emilkowalski/sonner) (interface parts)
- [three.js](https://github.com/mrdoob/three.js), [React Three Fiber](https://github.com/pmndrs/react-three-fiber), [drei](https://github.com/pmndrs/drei) (3D Chapp)
- [node-qrcode](https://github.com/soldair/node-qrcode), [jsQR](https://github.com/cozmo/jsQR) (sharing by QR code)
- [A2UI](https://github.com/google/A2UI) v0.9 format for the cards Chapp draws (rendered by Chapp's own code)
- [Vitest](https://github.com/vitest-dev/vitest), [Puppeteer](https://github.com/puppeteer/puppeteer) (tests and screenshots)

## Run it

Requires Node.js 22.18 or newer (Chapp's server and scripts are TypeScript that Node runs directly).

```sh
npm install
cp .env.example .env    # then put your Meta Model API key in MODEL_API_KEY
npm start               # API on http://127.0.0.1:3003
npm run dev             # app on http://localhost:5175 (forwards /api to the server)
npm test                # protocol checks
npm run smoke           # one real call to each Meta model
```

## Data and rights

Vendor manuals are copyrighted. Chapp fetches them from the vendor's own site at runtime and keeps them, their extracted
text and anything derived from them in `data/`, which is never committed. Every fact in a protocol cites the page it came
from, and the tests check that every quoted sentence appears word for word on that page.

## Layout

- `shared/protocol.ts`: the protocol format (`chapp.protocol/1`) and its consistency checks
- `shared/calc.ts`: run-dependent numbers (working reagent, standards sized to the plate, plate layout); never left to a model
- `server/`: the API and the built app
- `src/`: the app; for now the interface style guide
- `public/chapp/`: the Chapp character (`chapp.glb`, with breathe and blink animations) and its renders; `npm run model` rebuilds the model from `scripts/chapp-model/`
- `scripts/smoke-meta.ts`: checks each Meta model Chapp depends on
- `tests/`: format, data and calculation checks
