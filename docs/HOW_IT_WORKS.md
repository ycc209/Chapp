# How Chapp works

The details behind the [README](../README.md): a step at the bench, the conversation, each Meta model's part, the
pictures, and how a manual is read, with every benchmark number.

- [A step at the bench](#a-step-at-the-bench)
- [The conversation](#the-conversation)
- [Meta models, in detail](#meta-models-in-detail)
- [Common lab equipment, drawn by Muse Image](#common-lab-equipment-drawn-by-muse-image)
- [The user's bottles, upright and whole](#the-users-bottles-upright-and-whole)
- [How Chapp reads a manual](#how-chapp-reads-a-manual)
- [The benchmark, every setup](#the-benchmark-every-setup)
- [Science questions and bench commands](#science-questions-and-bench-commands)

## A step at the bench

One step at a time, with the bottle, the volume and the timer on screen. Each step opens with its picture playing at
the top: the user's own bottles on the bench and what to do written on it, every action with its numbers, big enough
to read from arm's length.

- ① 9.8 mL and ② 196 µL on the arrows into a 10 mL tube, then "Mix until green"
- 200 µL by the pipette over the plan's 42 wells, then "Shake 30 s" on the plate
- "Cover", 37 °C over the incubator and 30 min on the timer
- "Cool to RT" by a thermometer, then 562 nm over the reader

Each comes from the protocol's own fields (a step's timer and equipment, the mix's parts and notes). What to do,
written out, goes under the picture when the user wants the words (a switch on the picture, remembered). The standards
and the plate keep their grids to tick through, the picture small beside them.

The bench scenes (`shared/benchScenes.ts`) stand the vials on the bench, with no rack. A bottle a step takes from or
pours into stands open, its cap upside down beside it; the pipette's tip ends just over the well. Each picture is
framed round what it draws (`src/components/bench/frame.ts`).

Gloves on, Chapp keeps listening and shows the same picture, with the words in type big enough to read from arm's
length. What Chapp hears shows above the Listening waveform. A loading step says how much ("25 µL in each well"), the
Standards step shows its dilution table, and the incubation timer can be reset, with the buttons too. A timer that
ends reaches the lock screen.

## The conversation

- **A front assistant and specialists** (`server/ai/agents.ts`). A front assistant hears every sentence first, at the
  lowest reasoning effort with a short prompt, and finishes chat, bench commands and opening a kit the library already
  has by itself (one call, under two seconds). Why and how, manuals the library lacks, and numbers go to a specialist
  that continues the same conversation with its own rules and tools. The model routes, not a pattern. A bench
  operation ends with the app's own receipt and confirmation (`server/ai/confirm.ts`): a command is one model call,
  or none.
- **Every sentence goes to the model**, bench commands included ("next", "A to D done", "B3 is bad, use H12"): nothing
  is matched by pattern on the phone. The one exception runs on the server: the plainest bench commands (next step,
  back a step, the timer) are matched by sentence embedding against example phrasings and performed at once when the
  match is unmistakable (`server/ai/router.ts`). A question that only mentions a command goes to the model. The app
  checks what comes back either way.
- **One way to start** (`src/state/start.ts`). "Start the experiment", said or typed, is one action (`startRun`): back
  to the run where it is once it has begun; a start card under the answer (the plan, Start, Change the plan) while the
  plan was never set; else straight into the run. A "yes" to the card starts it. The steps are never written out as a
  way of starting. This follows OpenAI's Apps SDK (one decision in an inline card, a long task full screen with the
  conversation still on) and the step modes of voice assistants (pick it, then start).
- **What you do by hand is heard** (`src/state/runEvents.ts`). Next, a tick, a timer or the plan, done on the run, is
  written into the conversation as a small line, and Chapp hears of it with the next thing said, as context that asks
  for no answer.
- **One conversation per experiment** (`src/state/threads.ts`). A conversation becomes an experiment's when a protocol
  is opened or started in it, and keeps the whole run. New conversation starts a plain one and leaves the run under way
  with its own. The sidebar lists them all, newest first; an experiment comes back with its run.
- **Every timer rings** (`src/state/alarms.ts`), whichever experiment it belongs to and whatever screen is open. Time's
  up covers the screen and opens the next step in that experiment; the lock screen gets it through the server's push
  under the experiment's own key; the sidebar shows each experiment's time left; and Chapp is told of timers running in
  other experiments, so "how long is left?" is answered from anywhere.
- **Library sits outside the conversation.** Opening a protocol there shows its Overview as a preview, the run under
  way untouched, and a line in the conversation. Start or Plan there makes it the conversation's experiment, and the
  run before it is kept in its own conversation.
- **Silent on purpose.** Chapp listens but does not speak: every answer is on screen (`src/voice/speak.ts`,
  `VOICE_OUTPUT`).

## Meta models, in detail

**Muse Spark 1.3.** Finding the vendor manual (web search), reading the PDF into a structured protocol, recognizing
the kit and reading bottle labels, reading a photo of the plate reader, and the conversation: answers with citations,
changes to the run, cards. Each conversation call replays the conversation from the server's own record, since
continuing Meta's stored response measured about 7 s slower per call. Kits and labels are read at minimal effort (the
same answers in half the time); which end of a bottle is its cap stays at low.

**SAM 3.1.** Finding every bottle in one photo of the kit. A tap on something it missed is a point prompt. Its masks
are the outlines on the kit photos and the cut-out of each bottle (`server/ai/samMask.ts`).

In a video of the kit it follows every bottle from frame to frame (`server/ai/vision.ts` trackBottles,
`src/screens/kit/Watch.tsx`):

- The video goes to SAM at 720p and 10 fps: the user's 11 s iPhone video was followed in 9.3 s, not 31.6 s. While it
  records, the video goes to the server a second at a time, and its first frames say which kit it is meanwhile.
- The app plays the video again just behind SAM, each bottle traced on every frame (in the kit bottle's colour once its
  label is read), and cuts each bottle's photo along SAM's mask on the frame it is taken from, with no second call.
- Which kit: the frames vote, a box counting twice; two must agree to settle it early, and a tie asks.
- A label whose evidence disagrees is a mismatch with its candidates, never one of them made to fit. Each label carries
  its volume, how sure it is and how many views showed it.
- Under the video, the kit's bottles: each with the bottle the video showed, or "Not seen". Once the video is still,
  the bar takes it to any frame. A tap on a bottle in the list shows it on the video; a tap on a bottle on the video
  names it, or has SAM outline one it missed (a point prompt on that frame). A video with a kit bottle not seen waits
  for the user instead of going on.

**Muse Voice Transcribe.** Live speech to text at the bench: the phone streams through the server to the realtime
endpoint (`server/live.ts`), words show as they are said, and the model decides when you have finished. Chinese and
English in one sentence, the lab's words as keywords, Chinese written as Taiwan writes it. `?voice=server` sends a
recording per turn instead; `?voice=browser` uses the phone's own recognizer, English only.

**Muse Image.** The pictures of common lab equipment in every step picture, and the user's own bottles made whole
where their photo hid part of them (both below).

**Cost.** Every call logs its tokens, how many the API's prompt cache had, and its price (Meta's list prices,
dev.meta.ai, read 2026-10-30). `CHAPP_DAILY_USD` caps a day, and a manual's tokens are counted before it is read
(`server/ai/usage.ts`).

## Common lab equipment, drawn by Muse Image

Every item on the bench in the step pictures is a picture Muse Image drew, in one scientific-illustration style
(BioRender-like): the 1.5 mL tube, the 15 mL conical tube, the reagent bottle, the pipette, the reservoir, the 96-well
plate, the culture dish, the culture flask, the beaker, the wash bottle, the CO₂ incubator, the plate reader, the
centrifuge and the microscope.

- One culture flask was drawn first, after a reference picture, with the `images/edits` endpoint (the reference
  attached). That flask was then the style reference for every other item ("use the attached image only as a style
  reference"), so the set looks like one set. Two candidates each; the better one kept.
- Some were redrawn to match real equipment: a plain snap-cap tube of the same clear plastic as its body, a dish and a
  plate all clear, and an incubator after a photo of a real one (a solid white door, the control panel across the top).
- Each was cut out of its white background and kept in `public/bench/` (15 files, 1.1 MB). The flask's medium is split
  off as a mask, so it can hold any colour, or none. They were made once: the app makes no image calls for them.
- The app draws the step onto the pictures (`shared/benchArt.ts` says where each stands and where its inside is;
  `src/components/bench/Items.tsx`): the liquid, its level and colour, laid over the picture so its outlines and shine
  show through; a bottle's cap colour and printed label; what a display reads (37.0 °C, 562 nm); the pipette's volume;
  and the plate's 96 wells, drawn on the plate's face (Muse Image drew 70). The timer, thermometer, arrows and standard
  curve are drawn, not pictured.

## The user's bottles, upright and whole

A bottle photographed lying down, or held in a hand that hides its cap, still stands up whole in the step pictures:

1. **Cut out.** SAM 3.1's mask cuts the bottle out of its crop.
2. **Upright.** Its long axis (from the mask) is turned to stand up, its cap on top. Which end is the cap, Muse Spark
   says (`POST /api/kit/cap`): the shape cannot, since a vial's cap is often wider than its rounded foot (taking the
   narrower end for the neck stood the 3T3-L1 kit's vials on their caps). It is asked twice, about the bottle alone on
   white and the same turned over, and only an answer the two agree on counts; without one, the bottle is only
   straightened, never turned over. On the BCA and 3T3-L1 kits' bottles every answer was right this way.
3. **Drawn whole.** The upright crop goes to Muse Image (`POST /api/kit/whole`, the `images/edits` endpoint), asked for
   the same bottle alone and whole, everything hidden or cut off filled in, on a plain dark grey background.
4. **Laid over.** The picture goes under the photo (`src/components/bench/whole.ts`). Muse Image draws the bottle at its
   own size and place (the BCA kit's Reagent B came back about 15 % small), so the picture is first lined up by outline
   alone (so the words it writes on its own label, which called the Albumin Standard "PRP Bovine Serum", play no part)
   and toned like the photo. Then only a real missing piece is filled: the cap under a thumb, not the band a few pixels
   wide where the drawn cap is a little taller or the foot a little lower. A bottle with nothing missing, like Reagent
   A, is left exactly as photographed. Next to the missing piece, and only there, the photo gives way where it is not
   the bottle (the glove SAM took in with Reagent B's cap); everywhere else, the label too, the photo is untouched.
5. **Or not.** When nothing is missing, or the picture is not this bottle's shape (it leaves part of the photo's bottle
   outside it, is far bigger, or does not run along most of its outline), the upright photo stands alone. The step's
   sheet says when part of the bottle was drawn ("What your photo hid is drawn by Muse Image").

It starts as soon as a bottle is matched on the kit screen (and, for bottles photographed earlier, when the protocol
opens), so it is usually done before a step shows it: the upright bottle within a few seconds, the whole one about 23 s
later. Each bottle is drawn once ($0.01, and about $0.005 for the two questions about its cap) and kept on the phone and
on the server (`data/whole/`, by the crop it was drawn from).

On the BCA kit: Reagent A lay in its box, cap to the left, and now stands up exactly as photographed (nothing was
missing); Reagent B, held in a gloved hand that hid its cap, stands up with its cap drawn in and its label, product
number 1859078, its own.

## How Chapp reads a manual

Chapp's setting, Mixed, as it runs with Muse Spark 1.3 (`server/ai/import.ts`). Each step is one model call unless it
says otherwise; calls on the same line run at the same time.

1. **Search the web** (minimal). Finds the vendor's own manual for the kit and catalog number. It writes the manual's
   link first, then an intro from what it read online.
2. **As soon as the link is written**, while the search finishes: Chapp downloads the PDF (no model). The search's
   intro from the web is on screen first, marked as still being checked.
3. **Intro from the PDF** (minimal, on the PDF itself, figures included) and **Inventory** (minimal, on the manual's
   text: bottles, recipes, procedures, standard curves, instrument settings, each given an id). The PDF's intro
   replaces the web's; only it is saved.
4. **Steps** (low), **Standard curves** (minimal) and **Notes** (minimal), on the text, once the inventory is back.
5. **Assemble and check** (no model): the five parts become one protocol, every id and number is checked to add up,
   and it is saved.

What made it fast:

- **What matters first.** The intro is on screen while the rest is read.
- **Text where pictures don't matter.** Only the intro gets the PDF; the other calls get the manual's text (pdftotext),
  a third of the tokens and about twice as fast.
- **A shorter answer.** One short citation per row, timers only where a step has one, nothing the app doesn't show:
  about a third less to write.
- **Read while the search writes.** The download starts when the search writes the link, not when the search ends. A
  new kit (Coomassie Plus, n = 1): steps on screen 10.5 s after asking, where waiting for the PDF's intro took 19 s.
- **A quick search.** The search thinks at minimal: on the BCA manual it found the right PDF every time, and its
  summary was on screen in a median 6.1 s (n = 12), where low took 10.9 s (n = 9). The search only finds the manual,
  so the read is the same either way.

One Mixed run, call by call (1 November 2026, the run with the median time of three; seconds from the start of the
search):

| Call | Start | End |
|---|---|---|
| Search the web (minimal) | 0 | 4.9 |
| Download the PDF (no model) | 3.4 | 4.3 |
| Intro from the PDF (minimal) | 4.3 | 13.5 |
| Inventory, from the text (minimal) | 4.3 | 12.7 |
| Steps (low) | 12.7 | 26.5 |
| Standard curves (minimal) | 12.7 | 17.9 |
| Notes (minimal) | 12.7 | 17.2 |

The same model searching and then reading the whole PDF in one call shows nothing read from the PDF until that call
ends: 30.7 s at all minimal, 51.6 s at all low.

**Before the speed work** (28 October 2026, reading only, no search, Muse Spark 1.3): the whole PDF in every call at
medium, nothing shown until done, took 96.6 ± 33.0 s (n = 2), 48 of 49 checks right. More thinking only made it
slower: 96.3 s at high, 189 s at xhigh, 215 s at max, with no fewer mistakes. On 31 October, the way Chapp reads it put
the steps on screen at 10.7 ± 0.2 s and the whole protocol at 26.2 ± 3.6 s (n = 3), 49 of 49 every run.

## The benchmark, every setup

1 November 2026. Each model searched the web for the Thermo Pierce BCA Protein Assay Kit's user guide (23225) itself
and read it into a protocol, through the same pipeline; three runs per setup, each timed from the search to the whole
protocol. Accuracy is the share of 49 checks against the hand-made protocol that a run got right, averaged over the
three runs; a 2-hour incubation option without a temperature, "30 mins" written as "30 min", and steps split finer or
merged all count as right. A run that read nothing (no usable PDF, or the vendor's site refused the link) counts as 0%.
Costs are estimated from each vendor's list prices. Every run was measured again after three fixes to Chapp: its check
of the manual's link, and two ways it used to drop a tube of the dilution table. The data:
`video/data/bca-runs-2026-11-01.csv`.

Mixed is the steps at low and the rest at minimal. Sorted by median time; **bold** is what Chapp runs. A run that read
nothing has no time, so the median of a setup with one is of its other two runs.

| Model | Setup | Median (s) | Accuracy | Cost / manual |
|---|---|---|---|---|
| Muse Spark 1.3 | All minimal | 24.3 | 100% | $0.083 |
| Muse Spark 1.2 | All minimal | 26.2 | 53.1% | $0.096 |
| Muse Spark 1.2 | Mixed | 26.2 | 100% | $0.073 |
| **Muse Spark 1.3** | **Mixed** | **26.5** | **100%** | **$0.090** |
| Muse Wonder 1.0 | All minimal | 28.7 | 98.6% | $0.312 |
| Muse Spark 1.1 | Mixed | 32.2 | 64.6% | $0.071 |
| Muse Spark 1.3 | All low | 32.3 | 100% | $0.125 |
| Muse Spark 1.1 | All minimal | 32.8 | 76.2% | $0.091 |
| Claude Sonnet 5.5 | All medium | 33.5 | 99.3% | $0.303 |
| Muse Wonder 1.0 | Mixed | 33.7 | 98.0% | $0.341 |
| Claude Sonnet 5.5 | All low | 34.0 | 100% | $0.320 |
| Muse Spark 1.1 | All low | 35.2 | 85.7% | $0.112 |
| Muse Spark 1.2 | All low | 39.5 | 84.4% | $0.145 |
| Muse Wonder 1.0 | All low | 40.9 | 64.6% | $0.417 |
| GPT-6 Luna | All low | 43.1 | 98.0% | $0.028 |
| Claude Opus 5.5 | All low | 47.0 | 98.0% | $0.589 |
| GPT-6.1 Sol | All low | 58.3 | 66.7% | $0.200 |
| Claude Haiku 5.5 | All low | 61.6 | 99.3% | $0.040 |
| GPT-6.1 Terra | All low | 62.8 | 100% | $0.099 |
| GPT-6 Astra | All low | 64.9 | 100% | $1.073 |
| GPT-6 Luna | All medium | 72.4 | 98.0% | $0.035 |
| Claude Opus 5.5 | All medium | 77.0 | 98.6% | $0.688 |
| GPT-6.1 Terra | All medium | 82.8 | 100% | $0.116 |
| Claude Haiku 5.5 | All medium | 84.7 | 99.3% | $0.040 |
| GPT-6.1 Sol | All medium | 90.4 | 100% | $0.285 |
| GPT-6 Astra | All medium | 95.2 | 66.7% | $0.876 |

The README's chart keeps one row per model (its fastest setup that was 100% right in all three runs, or else its
fastest) and Muse Spark 1.3 Mixed, and leaves out Muse Spark 1.1, as the demo video does.

## Science questions and bench commands

- **A science question** (為什麼 BCA 會變紫, 31 October 2026, n = 3, through `/api/converse` from outside): a quick call
  says what the model already knows, marked from memory, at 3.2 ± 0.5 s, while the sources are read; the cited,
  reviewed answer then replaces it at 24.0 ± 3.0 s, with 2–3 sources.
- **Plain commands** like 下一步 skip the model: matched on the server by embedding, confirmed by the app.
