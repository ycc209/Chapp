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

The whole story runs end to end on Meta's models: find a kit's manual, read it, recognize the kit, plan the plate, run
it hands-free, read the plate, see the results, share by QR. Still to do before submission: hosting, a usage cap,
testing on iPhones and the demo video.

## What it does

- **Find the protocol.** Say the kit ("Pierce BCA"). Chapp finds the vendor's manual on the web and reads it into a
  protocol, steps first.
- **Know your kit.** One photo of the bottles: SAM 3.1 cuts out each bottle and Muse Spark reads the labels. A bottle it
  could not read is a guess the user confirms, never assumed.
- **Plan the plate.** The number of samples and replicates sets the standards, the working reagent and the plate layout.
  The app computes them; a model never does.
- **Run it hands-free.** One step at a time with the bottle, the volume and the timer on screen. Gloves mode keeps
  listening and shows the instruction large enough to read from arm's length. A timer that ends reaches the lock screen.
- **Change the run by voice.** "A B C D ok" ticks several vials at once, and "1 to 5 loaded" several tubes. "Redo B"
  also redoes the vials made from B. "B3 has a bubble, use H12" moves a well, or Chapp picks the next free one. "Add a
  well for a positive control" and "add a heat shock condition" add wells. Plan, Run, Results and Share all follow the
  changes, and a bad well is never read.
- **Read the plate.** A plate reader's export (Gen5, SoftMax Pro, Tecan, BMG) is parsed without a model. A photo of the
  reader's screen goes to Muse Spark, and the user confirms what it read.
- **Results.** The app subtracts the blank, fits the standard curve and reads each sample off it (`shared/fit.ts`).
- **Share.** The protocol, the plan, the plate changes and, if you choose, the results travel in a QR code. A labmate
  scans it and has the same run.
- **Ask any time.** Chapp answers with the manual's page and draws cards ([A2UI](https://github.com/google/A2UI)) where
  a card is clearer: reagents, the plate, standards, steps, timers, "is 10 mL enough?". Chapp listens but stays silent:
  every answer is on screen.

## Keeping the model to what the user said

- Every model reply is checked against a strict schema (Zod) before the app uses it.
- Each change the model asks for is checked against the user's own words (`server/ai/authorize.ts`). It is made when
  the user asked for it, shown as a button when the user only asked a question, and dropped otherwise.
- Timer lengths come from the step, the run or the user, never from the model. A sentence that claims a change the app
  did not make is removed.
- Wells, volumes and concentrations come from the app. The model only says what to do.
- Common bench phrases ("A to D done", "redo B", "B3 is bad, use H12") are matched on the phone without calling a model.

## Meta models

One photo of the kit, start to finish: **SAM 3.1** outlines every bottle → **Muse Spark** reads each label → the
bottle, cut out along SAM's mask, stands in the step pictures.

| Model | What Chapp uses it for |
|---|---|
| Muse Spark 1.3 | Finding the vendor manual (web search), reading the PDF into a structured protocol, recognizing the kit box and reading bottle labels, reading a photo of the plate reader, the conversation (answers with citations, changes to the run, cards) |
| SAM 3.1 | Finding every bottle in one photo of the kit. Its masks are the outlines on the kit photos, and the cut-out of each bottle (`server/ai/samMask.ts`) |
| Muse Voice Transcribe | Live speech to text at the bench: the phone streams through the server to the realtime endpoint, words show as they are said and the model decides when you have finished. Chinese and English in one sentence, the lab's words as keywords, Chinese written as Taiwan writes it (`?voice=server` sends a recording per turn instead; `?voice=browser` uses the phone's own recognizer, English only) |
| Muse Image | Planned for a consistent set of equipment icons; not in the app yet (`npm run smoke` checks it) |

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
npm run dev:phone       # the same over HTTPS: phones open the microphone and camera only on HTTPS
npm test                # every check, with no network and no cost
npm run build           # type check and production build
npm run smoke           # one real call to each Meta model
```

Without a key, or with `AI_PROVIDER=mock` in `.env`, the server answers from fixed BCA data: no network and no cost.

## Data and rights

Vendor manuals are copyrighted. Chapp fetches them from the vendor's own site at runtime and keeps them, their extracted
text and anything derived from them in `data/`, which is never committed. Every fact in a protocol cites the page it came
from, and the tests check that every quoted sentence appears word for word on that page.

## Layout

- `shared/protocol.ts`: the protocol format (`chapp.protocol/1`) and its consistency checks
- `shared/calc.ts`, `shared/units.ts`, `shared/fit.ts`: the numbers (working reagent, standards sized to the plate, unit
  conversion, the standard curve); never left to a model
- `shared/a2ui.ts`: the cards Chapp may draw and how each is checked
- `shared/share.ts`: what a QR code carries
- `server/`: the API and the built app; `server/ai/` talks to the Meta models (`meta.ts`), checks each change against
  the user's words (`authorize.ts`) and answers without a network in mock mode (`mock.ts`)
- `src/screens/`: one folder per screen (home, chat, protocol, kit, plan, run, results, share, library, intro)
- `src/state/`: the run (plan, progress, timers, plate changes) and the changes Chapp makes to it
- `src/voice/`: listening (live through `server/live.ts`, a recording per turn, or the browser's recognizer), hold to
  talk, lab-word fixes
- `src/style-guide/`: the interface style guide (`/style`)
- `public/chapp/`: the Chapp character (`chapp.glb`: the 24 subunits of Hsp16.5, PDB 1SHS, each its own piece of
  round lumps of gel, with the cage's 14 windows open, rounded into a ball and wearing a face, one animation per
  expression; three quick taps on the big 3D Chapp take it apart for a moment) and its
  stills; `node scripts/chapp-model/body.ts` rebuilds the body from the PDB file, and with Vite running
  `node scripts/chapp-model/stills.ts` renders the stills (and `--icons`, the app icons) from the app's own 3D scene
- `scripts/smoke-meta.ts`: checks each Meta model Chapp depends on; the other scripts try one feature against the real
  models (finding, importing, kit photos, voice, conversation), and `scripts/bench/` compares models at reading manuals
- `tests/`: the protocol format, the numbers, model replies (recorded, replayed without a network), voice, the cards and
  the screens
