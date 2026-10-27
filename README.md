# flea-helper

Turn a folder (or zip) of photos of used things into ready-to-paste Slack posts for the
flea-market channel.

Point it at your photos and it:

1. sorts the photos by item (several shots of the same monitor end up together),
2. identifies each item from the photos: brand, exact model, size, read off labels and boxes,
3. searches the web for specs and used prices in Estonia (okidoki.ee, osta.ee, soov.ee, …,
   falling back to nearby EU marketplaces when there are few local listings),
4. suggests a flea-market asking price in EUR plus the lowest price worth accepting,
5. writes one folder per item with its photos, the Slack post and your research notes.

Posts are written in English. It uses the OpenAI API (`gpt-5.5` by default).

## Setup

You need [Nix](https://nixos.org/download) with flakes enabled and an OpenAI API key.

```sh
git clone <this repo> && cd flea-helper
cp .env.example .env      # then put your key in .env: OPENAI_API_KEY=sk-...
```

`.env` is gitignored. Variables set in your shell take priority over `.env`. The `.env` file is
read from the directory you run the command in.

### API key permissions

Create the key in a separate OpenAI project (e.g. `flea-helper`) so its usage and spending are
separate and it can be revoked on its own. Give it **Restricted** permissions:

| Permission | Access | Why |
|---|---|---|
| Responses API (`/v1/responses`) | Write | grouping, identifying and pricing |
| Files (`/v1/files`) | Write | photos are uploaded for the run and deleted afterwards |
| everything else | None | |

Set a monthly budget on the project as a safety net.

## Usage

```sh
nix run . -- ~/Pictures/flea              # a folder of photos
nix run . -- ~/Downloads/flea.zip         # a zip, e.g. an album export from Immich or Google Photos
```

A zip is first extracted to a folder named after it, next to it (`~/Downloads/flea/`). Subfolders
inside the zip are flattened (a photo is renamed if two share a name), and macOS `__MACOSX` and
hidden files are ignored.

Output:

```
~/Pictures/flea/items/
  dual-monitor-arm/
    P_20261027_224909.jpg …    copies of the item's photos, to attach in Slack
    post.slack.txt             the Slack post, open it and paste
    notes.txt                  your price research, not for buyers
    listing.json               the raw result
  dell-monitor/
  hoka-kaha-3-gtx-boots/
  …
```

`post.slack.txt` (Slack formatting, *bold* and _italic_ render when pasted):

```
*NB North Bayou H180 dual gas-spring monitor arm* | *35 EUR*
Dual desk monitor mount with two adjustable gas-spring arms on a central pole and desk clamp. …
• Condition: Used, with visible light scratches and wear on the black finish. …
• Model: NB North Bayou H180
_DM me if interested_
```

`notes.txt`:

```
Asking 35 EUR, accept down to 25 EUR
Used market: 25 EUR to 45 EUR
Confidence: high
Check: Check before selling that both gas springs hold a monitor and that the tension adjustment works. …
  - Kaup24.ee — North Bayou H180 monitor holder, new | 56.59–71.00 € | https://kaup24.ee/…
  - Okidoki Tallinn — North Bayou F160 dual gas monitor bracket | 45 € | https://www.okidoki.ee/…
```

Read the **Check** line before posting: it says what the photos couldn't show (does it power
on, are cables included) and what would move the price.

### Running it again

Photos already sorted into `items/` are skipped, so you can drop more photos into the folder (or
run the same zip again) and only the new ones are processed. If an item fails, its photos stay
unsorted and the next run retries them; the other items are still written.

### Tips for better results

- Photograph labels, model plates, size tags and boxes: an exact model gives a much better price.
- Show the defects and the parts buyers care about (soles of shoes, the screen switched on,
  included cables), otherwise the condition line says it can't tell.
- Shoot each item separately; clearly different backgrounds help the grouping.

## Limitations

- Photos must be jpg, png, webp or gif. HEIC (the iPhone default) is skipped with a warning;
  export as JPEG or convert it first.
- Prices are always researched for Estonia in EUR (`MARKET` / `CURRENCY` in `src/flea.ts`).
- Comparable listings come from a live web search, but the model chooses what to search, and
  links can be stale. Treat the price as a starting point, not a valuation.
- A zip is read into memory as a whole; fine for hundreds of photos, slow for multi-GB archives.
- Each item takes a while, since it runs several web searches; 3 items are researched in parallel.
- Every run costs OpenAI API usage, and so does every re-run of a failed item.

## Configuration

| Variable | Default | |
|---|---|---|
| `OPENAI_API_KEY` | | required |
| `OPENAI_MODEL` | `gpt-5.5` | must support image input and web search |

## Development

```sh
nix develop          # Node 26 + pnpm
pnpm install
pnpm flea ./samples  # run from source
pnpm typecheck
nix build            # the packaged CLI in ./result/bin/flea
```

The whole app is `src/flea.ts`, which Node runs directly (type stripping, no build step). After
changing dependencies, update `hash` in `nix/package.nix`: set it to `lib.fakeHash`, run
`nix build`, and copy the hash it prints.
