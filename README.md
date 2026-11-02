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
it hands-free, read the plate, see the results, share by QR. Still to do before submission: hosting, testing on
iPhones and the demo video.

## What it does

- **Find the protocol.** Say the kit ("Pierce BCA"). Chapp finds the vendor's manual on the web and reads it into a
  protocol, steps first.
- **Know your kit.** One photo of the bottles: SAM 3.1 cuts out each bottle and Muse Spark reads the labels. A bottle it
  could not read is a guess the user confirms, never assumed.
- **Plan the plate.** The number of samples and replicates sets the standards, the working reagent and the plate layout.
  The app computes them; a model never does.
- **Run it hands-free.** One step at a time with the bottle, the volume and the timer on screen. Each step opens with
  its picture playing at the top, the user's own bottles on the bench and what to do written on it, every action with
  its numbers, big enough to read from arm's length: ① 9.8 mL and ② 196 µL on the arrows into a 10 mL tube, then
  "Mix until green"; 200 µL by the pipette over the plan's 42 wells, then "Shake 30 s" on the plate; "Cover", 37 °C
  over the incubator and 30 min on the timer; "Cool to RT" by a thermometer, then 562 nm over the reader. Each comes
  from the protocol's own fields (a step's timer and equipment, the mix's parts and notes). What to do, written
  out, goes under it when the user wants the words (a switch on the picture, remembered); the standards and the plate
  keep their grids to tick through, the picture small beside them. Gloves mode keeps listening and shows the same
  picture, the words in type big enough to read from arm's length. A timer that ends reaches the lock screen.
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
- Every sentence goes to the model, bench commands included ("next", "A to D done", "B3 is bad, use H12"): nothing is
  matched by pattern on the phone. The one exception runs on the server: the plainest bench commands (next step, back
  a step, the timer) are matched by sentence embedding against example phrasings and performed at once when the match
  is unmistakable (`server/ai/router.ts`); a question that only mentions a command goes to the model. The app checks
  what comes back either way.
- A front assistant hears every sentence first, at the lowest reasoning effort with a short prompt, and finishes chat,
  bench commands and opening a kit the library already has by itself (one call, under two seconds). Why and how,
  manuals the library lacks, and numbers go to a specialist that continues the same conversation with its own rules
  and tools (`server/ai/agents.ts`): the model routes, not a pattern. A bench operation ends with the app's own
  receipt and confirmation (`server/ai/confirm.ts`): a command is one model call, or none.
- The conversation is the thread through the app; the screens are what it opens. "Start the experiment", said or typed,
  is one action (`startRun`): back to the run where it is once it has begun; a start card under the answer (the plan,
  Start, Change the plan) while the plan was never set; else straight into the run. A "yes" to the card starts it.
  The steps are never written out as a way of starting. Every Start button starts the same way (`src/state/start.ts`).
  This follows OpenAI's Apps SDK (one decision in an inline card, a long task full screen with the conversation still
  on) and the step modes of voice assistants (pick it, then start).
- What you do by hand on the run (Next, a tick, a timer, the plan) is written into the conversation as a small line,
  and Chapp hears of it with the next thing said (`src/state/runEvents.ts`), as context that asks for no answer.
- One conversation per experiment (`src/state/threads.ts`): a conversation becomes an experiment's when a protocol is
  opened or started in it, and keeps the whole run. New conversation starts a plain one and leaves the run under way
  with its own. The sidebar lists them all, newest first, to go back to; an experiment comes back with its run.
- Every timer rings, whichever experiment it belongs to and whatever screen is open (`src/state/alarms.ts`): Time's up
  covers the screen and opens the next step in that experiment, the lock screen gets it through the server's push under
  the experiment's own key, the sidebar shows each experiment's time left, and Chapp is told of timers running in
  other experiments, so "how long is left?" is answered from anywhere.
- Library sits outside the conversation. Opening a protocol there shows its Overview as a preview, the run under way
  untouched, and a line in the conversation; Start or Plan there makes it the conversation's experiment, and the run
  before it is kept in its own conversation.

## Fast at the bench

What matters is on screen first; the rest follows while you read. How long until something is shown, against how long
until all of it is read and processed (what you would wait for if Chapp showed nothing until it was done). Measured
2026-10-31 with Muse Spark 1.3, mean ± SD over n runs, each run alone:

| Asked | n | Shown first | All of it read and processed | Shown sooner by |
|---|---|---|---|---|
| A kit new to Chapp (the Pierce BCA manual) | 3 | at a glance and the steps: 10.7 ± 0.2 s | the whole protocol: 26.2 ± 3.6 s, 49/49 checks right every run | 15.5 ± 3.4 s (2.4×) |
| A science question (為什麼 BCA 會變紫) | 3 | what Chapp knows, marked from memory: 3.2 ± 0.5 s | the cited answer: 24.0 ± 3.0 s, 2–3 sources | 20.9 ± 2.7 s (7.7×) |

Both columns come from the same runs. The kit was read by `scripts/import-protocol.ts` (wall clock, checked against
the hand-made protocol); the science question went through `/api/converse` from outside, timed to the first words
and to the complete reply.

- **A kit**: one quick call reads what the kit is, its at-a-glance summary and its steps; the rest is read alongside
  (how, below).
- **A science question**: a quick call says what the model already knows while the sources are read; the cited,
  reviewed answer then replaces it.
- **Plain commands** like 下一步 skip the model: matched on the server, confirmed by the app.

## Meta models

One photo of the kit, start to finish: **SAM 3.1** outlines every bottle → **Muse Spark** reads each label → the
bottle, cut out along SAM's mask, stands in the step pictures: turned upright when it was photographed lying down,
and made whole by **Muse Image** where a hand or the photo's edge hid part of it.

| Model | What Chapp uses it for |
|---|---|
| Muse Spark 1.3 | Finding the vendor manual (web search), reading the PDF into a structured protocol, recognizing the kit box and reading bottle labels, reading a photo of the plate reader, the conversation (answers with citations, changes to the run, cards; each call replays the conversation from the server's own record, since continuing Meta's stored response measured about 7 s slower per call) |
| SAM 3.1 | Finding every bottle in one photo of the kit. A tap on something it missed is a point prompt. Its masks are the outlines on the kit photos, and the cut-out of each bottle (`server/ai/samMask.ts`). In a video of the kit it follows every bottle from frame to frame, streamed: the app plays the video again just behind SAM with each bottle traced on every frame (in the kit bottle's colour once its label is read), and cuts each bottle's photo along SAM's mask on the frame it is taken from, with no second call. Under the video, the kit's bottles: each with the bottle the video showed, or "Not seen". Once the video is still, the bar takes it to any frame; a tap on a bottle in that list shows it on the video; a tap on a bottle on the video names it, or has SAM outline one it missed, a point prompt on that frame; a bottle not seen is chosen in the list, then tapped on the video. A video with a kit bottle not seen waits for the user instead of going on (`server/ai/vision.ts` trackBottles, `src/screens/kit/Watch.tsx`) |
| Muse Voice Transcribe | Live speech to text at the bench: the phone streams through the server to the realtime endpoint, words show as they are said and the model decides when you have finished. Chinese and English in one sentence, the lab's words as keywords, Chinese written as Taiwan writes it (`?voice=server` sends a recording per turn instead; `?voice=browser` uses the phone's own recognizer, English only) |
| Muse Image | The pictures of common lab equipment on the bench in every step picture, and the user's own bottles made whole where their photo hid part of them (both below) |

Cost: every call logs its tokens, how many the API's prompt cache had, and its price; `CHAPP_DAILY_USD` caps a day,
and a manual's tokens are counted before it is read (`server/ai/usage.ts`).

### Common lab equipment, drawn by Muse Image

Every item on the bench in the step pictures is a picture Muse Image drew, in one scientific-illustration style
(BioRender-like): the 1.5 mL tube, the 15 mL conical tube, the reagent bottle, the pipette, the reservoir, the 96-well
plate, the tube rack, the culture dish, the culture flask, the beaker, the wash bottle, the
CO₂ incubator, the plate reader, the centrifuge and the microscope.

- One culture flask was drawn first, after a reference picture, with the `images/edits` endpoint (the reference
  attached). That flask was then the style reference for every other item ("use the attached image only as a style
  reference"), so the set looks like one set. Two candidates each; the better one kept.
- Some were redrawn to match real equipment: a plain snap-cap tube of the same clear plastic as its body, a dish and a
  plate all clear, an incubator after a photo of a real one (a solid white door, the control panel across the top),
  and a rack after a photo of a 5 × 16 tube rack, in Chapp's colours.
- Each was cut out of its white background and kept in `public/bench/` (16 files, 1.4 MB). The flask's medium is
  split off as a mask, so it can hold any colour, or none. They were made once: the app makes no image calls for them.
- The app draws the step onto the pictures (`shared/benchArt.ts` says where each stands and where its inside is;
  `src/components/bench/Items.tsx`): the liquid, its level and colour, laid over the picture so its outlines and
  shine show through; a bottle's cap colour and printed label; what a display reads (37.0 °C, 562 nm); the pipette's
  volume; and the plate's 96 wells, drawn on the plate's face (Muse Image drew 70). The timer, thermometer, arrows and
  standard curve are drawn, not pictured.

### The user's bottles, upright and whole

A bottle photographed lying down, or held in a hand that hides its cap, still stands up whole in the step pictures:

1. **Cut out.** SAM 3.1's mask cuts the bottle out of its crop, as before.
2. **Upright.** Its long axis (from the mask) is turned to stand up, its cap on top. Which end is the cap, Muse Spark
   says (`POST /api/kit/cap`): the shape cannot, since a vial's cap is often wider than its rounded foot (taking the
   narrower end for the neck stood the 3T3-L1 kit's vials on their caps). It is asked twice, about the bottle alone on
   white and the same turned over, and only an answer the two agree on counts; without one, the bottle is only
   straightened, never turned over. On the BCA and 3T3-L1 kits' bottles every answer was right this way.
3. **Drawn whole.** The upright crop goes to Muse Image (`POST /api/kit/whole`, the `images/edits` endpoint), asked
   for the same bottle alone and whole, everything hidden or cut off filled in, on a plain dark grey background.
4. **Laid over.** The picture goes under the photo (`src/components/bench/whole.ts`). Muse Image draws the bottle at
   its own size and place (the BCA kit's Reagent B came back about 15 % small), so the picture is first lined up by
   outline alone (so the words it writes on its own label, which called the Albumin Standard "PRP Bovine Serum", play
   no part) and toned like the photo. Then only a real missing piece is filled: the cap under a thumb, not the band a
   few pixels wide where the drawn cap is a little taller or the foot a little lower. A bottle with nothing missing,
   like Reagent A, is left exactly as photographed. Next to the missing piece, and only there, the photo gives way
   where it is not the bottle (the glove SAM took in with Reagent B's cap); everywhere else, the label too, the photo
   is untouched.
5. **Or not.** When nothing is missing, or the picture is not this bottle's shape (it leaves part of the photo's bottle
   outside it, is far bigger, or does not run along most of its outline), the upright photo stands alone. The
   step's sheet says when part of the bottle was drawn ("What your photo hid is drawn by Muse Image").

It starts as soon as a bottle is matched on the kit screen (and, for bottles photographed earlier, when the protocol
opens), so it is usually done before a step shows it: the upright bottle within a few seconds, the whole one about
23 s later. Each
bottle is drawn once ($0.01, and about $0.005 for the two questions about its cap) and kept on the phone and on the
server (`data/whole/`, by the crop it was drawn from).
On the BCA kit: Reagent A lay in its box, cap to the left, and now stands up exactly as photographed (nothing was
missing); Reagent B, held in a gloved hand that hid its cap, stands up with its cap drawn in and its label, product
number 1859078, its own.

## How Chapp asks Muse Spark to read a manual

Measured on the Pierce BCA manual (5 pages), Muse Spark 1.3 either way.

| | Read it straight | Read it the way Chapp teaches it |
|---|---|---|
| How it reads | The whole PDF in every call, medium thinking, nothing shown until done | What matters first, then the rest; mostly text, minimal thinking (low for the steps) |
| Steps on screen | 96.6 ± 33.0 s (n = 2) | 10.7 ± 0.2 s (n = 3) |
| Whole protocol | 96.6 ± 33.0 s (n = 2) | 26.2 ± 3.6 s (n = 3) |
| Correct, of 49 checks | 48 both | 49 all three |

More thinking only made the straight read slower: 96 s at high, 189 s at xhigh, 215 s at max, with no fewer mistakes.

How Chapp asks it to read:
- **What matters first.** One quick call returns what the kit is, its at-a-glance summary and its steps; the rest is
  read alongside.
- **Text where pictures don't matter.** Only the quick call gets the PDF; the others get the manual's text, a third of
  the tokens.
- **A shorter answer.** One short citation per row, timers only where a step has one, nothing the app doesn't show:
  about a third less to write.
- **Read while the search writes.** The web search writes the manual's URL first, and Chapp starts downloading and
  reading it then, while the search goes on to write what it read there (a summary, the steps, the bottles). That shows
  until the manual's own intro replaces it, and every number is still checked against the PDF. A new kit (Coomassie
  Plus, n = 1): steps on screen 10.5 s after asking, where waiting for the PDF's intro took 19 s.
- **A quick search.** The search thinks at minimal: on the BCA manual it found the right PDF every time, and its
  summary was on screen in a median 6.1 s (n = 12), where low took 10.9 s (n = 9). The search only finds the manual,
  so the read is the same either way.

## Built with

- [React](https://github.com/facebook/react), [Vite](https://github.com/vitejs/vite), [TypeScript](https://github.com/microsoft/TypeScript), [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss)
- [React Router](https://github.com/remix-run/react-router), [Zustand](https://github.com/pmndrs/zustand) (state), [Zod](https://github.com/colinhacks/zod) (checking every model reply)
- [Radix UI](https://github.com/radix-ui/primitives), [Sonner](https://github.com/emilkowalski/sonner) (interface parts)
- [three.js](https://github.com/mrdoob/three.js), [React Three Fiber](https://github.com/pmndrs/react-three-fiber), [drei](https://github.com/pmndrs/drei) (3D Chapp)
- [node-qrcode](https://github.com/soldair/node-qrcode), [jsQR](https://github.com/cozmo/jsQR) (sharing by QR code)
- [A2UI](https://github.com/google/A2UI) v0.9 format for the cards Chapp draws (rendered by Chapp's own code)
- [Transformers.js](https://github.com/huggingface/transformers.js) running [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) on the server (the embedding fast path for bench commands)
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
- `server/`: the API and the built app; `server/ai/` talks to the Meta models (`meta.ts`), runs the conversation as a
  front assistant and its specialists (`agents.ts`, `conversation.ts`), performs the plainest bench commands by
  embedding (`router.ts`) and confirms bench operations (`confirm.ts`), checks each change against the user's words
  (`authorize.ts`) and answers without a network in mock mode (`mock.ts`)
- `src/screens/`: one folder per screen (home, chat, protocol, kit, plan, run, results, share, library, intro)
- `src/state/`: the run (plan, progress, timers, plate changes) and the changes Chapp makes to it
- `src/voice/`: listening (live through `server/live.ts`, a recording per turn, or the browser's recognizer), hold to
  talk, lab-word fixes, and when words that have settled are sent ahead or taken as the turn (`engine.ts`)
- `src/components/bench/`: the step pictures: the bench scenes (`BenchView.tsx`, composed by `shared/benchScenes.ts`),
  the equipment pictures with the step drawn onto them (`Items.tsx`, `shared/benchArt.ts`, pictures in
  `public/bench/`), and the user's bottles cut out, upright and whole (`cutout.ts`, `whole.ts`)
- `src/style-guide/`: the interface style guide (`/style`)
- `public/chapp/`: the Chapp character (`chapp.glb`: the 24 subunits of Hsp16.5, PDB 1SHS, each its own piece of
  round lumps of gel, with the cage's 14 windows open, rounded into a ball and wearing a face, one animation per
  expression; three quick taps on the big 3D Chapp take it apart for a moment) and its
  stills; `node scripts/chapp-model/body.ts` rebuilds the body from the PDB file, and with Vite running
  `node scripts/chapp-model/stills.ts` renders the stills from the app's own 3D scene and
  `node scripts/chapp-model/icons.ts` the app icons (the cage without its face, down a four-fold axis, on black)
- `scripts/smoke-meta.ts`: checks each Meta model Chapp depends on; the other scripts try one feature against the real
  models (finding, importing, kit photos, voice, conversation), and `scripts/bench/` compares models at reading manuals
  and scores the embedding router's examples (`router-check.ts`, no Meta call)
- `tests/`: the protocol format, the numbers, model replies (recorded, replayed without a network), voice, the cards and
  the screens
