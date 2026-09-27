# Voice logger, weekend 1

The only goal this weekend is to measure how fast speech becomes text.
No parsing, no database, no logging. If the latency is bad here, every
decision after this is built on sand.

## Run it

Backend:

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # paste your Deepgram key into DEEPGRAM_API_KEY
uvicorn main:app --reload --port 8000
```

Frontend, in a second terminal:

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5173, allow the mic, press start.

To test on your phone on the same wifi, use the network URL Vite prints.
Note that browsers only grant mic access over https or localhost, so for
phone testing run `npx vite --host` behind a tunnel, or just test on the
laptop this weekend and defer phone testing to when you deploy.

## What you are measuring

Each finalised line shows the gap between the last audio chunk sent and
the arrival of the final transcript. The median across the session is the
number that matters. Budget is 700ms end to end for a full log action, and
this step should be consuming roughly 300 to 400ms of it.

Say twenty short utterances of the kind you will actually use:

- log thirty minutes strength training
- log two rotis and a katori of dal
- log forty five minutes cycling
- I had three idlis for breakfast

## How to read the result

**Median under 400ms.** On budget. Move to weekend 2.

**400 to 700ms.** Usually the endpointing setting. Drop `endpointing` from
250 to 150 in `src/lib/listener.js` and retest. Below 150 it starts cutting
people off mid sentence.

**Over 700ms.** Almost always network, not Deepgram. Check whether you are
on a VPN. Deepgram has no India region, so a bad route to their nearest
edge is the usual cause. If it stays slow on a clean connection, that is
real signal and we swap to a different provider before building anything on
top of it.

Also watch for accuracy, not just speed. Note which words it gets wrong on
Indian food names. That list feeds the alias table in weekend 3.

## What is deliberately missing

No auth, no database writes, no parser, no PWA manifest, no wake word. All
of that is weekend 2 and later. Resist adding any of it now.
