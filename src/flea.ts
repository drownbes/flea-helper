// flea: drop a folder (or zip) of item photos in, get one folder per item with a Slack post out.
//
//   flea ~/Pictures/flea
//   flea ~/Downloads/flea.zip      extracts the photos to ~/Downloads/flea/ first
//
// Groups the photos by item, researches each item, and writes
//   <folder>/items/<slug>/{photos..., post.slack.txt, notes.txt}
// Photos already sorted into items/ are skipped, so re-running only handles new photos.

import OpenAI, { toFile } from 'openai';
import { unzipSync } from 'fflate';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';

const DEFAULT_MODEL = 'gpt-5.5';
const MARKET = 'Estonia';
const CURRENCY = 'EUR';
const ITEMS_DIR = 'items';
const PARALLEL_ITEMS = 3;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const UNSUPPORTED_IMAGE_EXTENSIONS = new Set(['.heic', '.heif', '.dng', '.raw', '.tif', '.tiff']);

type Photo = { name: string; path: string; fileId: string };

type Group = { slug: string; photos: string[] };

type Listing = {
  title: string;
  brand_model: string | null;
  description: string;
  condition: string;
  price: { asking: number; quick_sale: number; market_low: number; market_high: number; currency: string };
  comparables: { title: string; price: string; url: string }[];
  confidence: 'low' | 'medium' | 'high';
  caveats: string | null;
};

const GROUPING_INSTRUCTIONS = `You sort a seller's photos into the items they are selling at a flea market.
Each photo is preceded by its filename. Put photos of the same physical item (different angles, close-ups of labels, defects, accessories that are sold with it) into one group. Different items, even of the same kind, get separate groups. Every photo goes into exactly one group.
Name each group with a short English kebab-case slug describing the item, e.g. "sony-wh1000xm4-headphones" or "red-wine-bottle-toscana". Slugs must be unique.`;

const RESEARCH_INSTRUCTIONS = `You help a private seller price used items for a local flea market in ${MARKET} and write the post for it. Prices are in ${CURRENCY}. Write the title, description and condition in English.

1. Identify the item from the photos as precisely as you can: brand, model, variant, size, edition. Read labels, model plates and serial stickers.
2. Search the web for what the item is (specs, original retail price) and what it sells for used in ${MARKET}. Prefer local classifieds (okidoki.ee, osta.ee, soov.ee, Facebook Marketplace in Estonia) and sold listings over new retail prices; search in Estonian and Russian as well as English. If there are few local listings, use nearby EU used prices (e.g. Finland, Latvia, eBay.de sold) as a reference.
3. Price it for a flea market: buyers there expect to pay less than on online marketplaces and to haggle, so the asking price leaves some room and the quick-sale price is what the seller can accept to get rid of it today. Use round, cash-friendly numbers.
4. Judge condition only from what the photos show; never invent defects or claim it works if you can't tell.
5. If you could not identify the exact model, say so in caveats and set confidence accordingly.`;

function groupingSchema(filenames: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['slug', 'photos'],
          properties: {
            slug: { type: 'string', description: 'Short English kebab-case name of the item' },
            photos: { type: 'array', items: { type: 'string', enum: filenames } },
          },
        },
      },
    },
  };
}

const listingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'brand_model', 'description', 'condition', 'price', 'comparables', 'confidence', 'caveats'],
  properties: {
    title: { type: 'string', description: 'Short listing headline, e.g. "Sony WH-1000XM4 headphones, black"' },
    brand_model: { type: ['string', 'null'], description: 'Exact brand and model if identified' },
    description: {
      type: 'string',
      description: '2-4 sentences for buyers: what it is, key specs/features, what is included',
    },
    condition: { type: 'string', description: 'Condition as visible in the photos' },
    price: {
      type: 'object',
      additionalProperties: false,
      required: ['asking', 'quick_sale', 'market_low', 'market_high', 'currency'],
      properties: {
        asking: { type: 'number', description: 'Recommended asking price at a flea market' },
        quick_sale: { type: 'number', description: 'Lowest sensible price to accept for a fast sale' },
        market_low: { type: 'number', description: 'Low end of comparable used prices found' },
        market_high: { type: 'number', description: 'High end of comparable used prices found' },
        currency: { type: 'string', enum: [CURRENCY] },
      },
    },
    comparables: {
      type: 'array',
      description: 'Up to 5 comparable listings or sold items you found',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'price', 'url'],
        properties: {
          title: { type: 'string' },
          price: { type: 'string', description: 'Price as shown, with currency' },
          url: { type: 'string' },
        },
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    caveats: { type: ['string', 'null'], description: 'Anything the seller should double-check' },
  },
};

// OPENAI_API_KEY etc. from ./.env when present; real environment variables win
function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

// Extracts the zip's images, flattened, into a folder named after it next to the zip. Entry paths
// are reduced to their file name, so nothing can be written outside that folder. Files already
// there are kept, so re-running on the same zip reuses the earlier extraction.
async function extractZip(zipPath: string): Promise<string> {
  const folder = join(dirname(zipPath), basename(zipPath, extname(zipPath)));
  await mkdir(folder, { recursive: true });

  const isPhoto = (path: string) =>
    !path.endsWith('/') &&
    !path.split('/').some((part) => part.startsWith('.') || part === '__MACOSX') &&
    IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
  const entries = unzipSync(await readFile(zipPath), { filter: (file) => isPhoto(file.name.replaceAll('\\', '/')) });

  const used = new Set<string>();
  let extracted = 0;
  for (const [path, data] of Object.entries(entries)) {
    const parts = path.replaceAll('\\', '/').split('/');
    let name = parts[parts.length - 1];
    // Same file name in two zip folders: prefix the folder name to keep both
    if (used.has(name)) name = `${parts.slice(0, -1).join('-')}-${name}`;
    used.add(name);
    try {
      await writeFile(join(folder, name), data, { flag: 'wx' });
      extracted++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  log(`Extracted ${extracted} new photo(s) of ${used.size} from ${basename(zipPath)} to ${folder}`);
  return folder;
}

async function listNewPhotos(folder: string): Promise<string[]> {
  const sorted = new Set<string>();
  const itemDirs = await readdir(join(folder, ITEMS_DIR), { withFileTypes: true }).catch(() => []);
  for (const dir of itemDirs.filter((entry) => entry.isDirectory())) {
    for (const name of await readdir(join(folder, ITEMS_DIR, dir.name))) sorted.add(name);
  }

  const photos: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (UNSUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      log(`skipping ${entry.name}: convert it to jpg first`);
    } else if (IMAGE_EXTENSIONS.has(extension) && !sorted.has(entry.name)) {
      photos.push(entry.name);
    }
  }
  return photos.sort();
}

async function uploadPhoto(client: OpenAI, folder: string, name: string): Promise<Photo> {
  const path = join(folder, name);
  const file = await client.files.create({ file: await toFile(await readFile(path), name), purpose: 'vision' });
  return { name, path, fileId: file.id };
}

function imageInputs(photos: Photo[], detail: 'low' | 'high'): OpenAI.Responses.ResponseInputContent[] {
  return photos.flatMap((photo): OpenAI.Responses.ResponseInputContent[] => [
    { type: 'input_text', text: `Photo: ${photo.name}` },
    { type: 'input_image', detail, file_id: photo.fileId },
  ]);
}

async function structuredResponse<T>(
  client: OpenAI,
  params: Omit<OpenAI.Responses.ResponseCreateParamsNonStreaming, 'text'>,
  name: string,
  schema: Record<string, unknown>,
): Promise<T> {
  const response = await client.responses.create({
    ...params,
    text: { format: { type: 'json_schema', name, strict: true, schema } },
  });
  if (response.status === 'incomplete') {
    throw new Error(`response incomplete: ${response.incomplete_details?.reason ?? 'unknown reason'}`);
  }
  if (!response.output_text) {
    const refusal = response.output
      .flatMap((item) => (item.type === 'message' ? item.content : []))
      .find((part) => part.type === 'refusal');
    throw new Error(refusal ? `model declined: ${refusal.refusal}` : 'model returned no result');
  }
  return JSON.parse(response.output_text) as T;
}

async function groupPhotos(client: OpenAI, model: string, photos: Photo[]): Promise<Group[]> {
  if (photos.length === 1) return [{ slug: 'item', photos: [photos[0].name] }];
  const { items } = await structuredResponse<{ items: Group[] }>(
    client,
    { model, instructions: GROUPING_INSTRUCTIONS, input: [{ role: 'user', content: imageInputs(photos, 'low') }] },
    'photo_groups',
    groupingSchema(photos.map((photo) => photo.name)),
  );

  // Hold the model to "every photo in exactly one group": first claim wins, leftovers get their own group
  const claimed = new Set<string>();
  const groups = items
    .map((group) => ({ slug: group.slug, photos: group.photos.filter((name) => !claimed.has(name) && claimed.add(name)) }))
    .filter((group) => group.photos.length > 0);
  for (const photo of photos.filter((p) => !claimed.has(p.name))) {
    groups.push({ slug: basename(photo.name, extname(photo.name)), photos: [photo.name] });
  }
  return groups;
}

function research(client: OpenAI, model: string, photos: Photo[]): Promise<Listing> {
  return structuredResponse<Listing>(
    client,
    {
      model,
      instructions: RESEARCH_INSTRUCTIONS,
      input: [{ role: 'user', content: imageInputs(photos, 'high') }],
      tools: [{ type: 'web_search' }],
    },
    'listing',
    listingSchema,
  );
}

function formatMoney(amount: number, currency: string): string {
  return `${amount.toLocaleString('en', { maximumFractionDigits: 2 })} ${currency}`;
}

// Slack mrkdwn: *bold*, _italic_, bullets as plain "•" lines
function slackPost(listing: Listing): string {
  const { price } = listing;
  return [
    `*${listing.title}* | *${formatMoney(price.asking, price.currency)}*`,
    listing.description,
    `• Condition: ${listing.condition}`,
    ...(listing.brand_model ? [`• Model: ${listing.brand_model}`] : []),
    '_DM me if interested_',
  ].join('\n');
}

function researchNotes(listing: Listing): string {
  const { price } = listing;
  return [
    `Asking ${formatMoney(price.asking, price.currency)}, accept down to ${formatMoney(price.quick_sale, price.currency)}`,
    `Used market: ${formatMoney(price.market_low, price.currency)} to ${formatMoney(price.market_high, price.currency)}`,
    `Confidence: ${listing.confidence}`,
    ...(listing.caveats ? [`Check: ${listing.caveats}`] : []),
    ...listing.comparables.map((c) => `  - ${c.title} | ${c.price} | ${c.url}`),
  ].join('\n');
}

function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

// items/<slug>, or items/<slug>-2 etc. when an earlier run already used the name
async function createItemDir(folder: string, slug: string): Promise<string> {
  await mkdir(join(folder, ITEMS_DIR), { recursive: true });
  for (let n = 1; ; n++) {
    const dir = join(folder, ITEMS_DIR, n === 1 ? slug : `${slug}-${n}`);
    try {
      await mkdir(dir, { recursive: false });
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

async function processItem(client: OpenAI, model: string, folder: string, group: Group, photos: Photo[]): Promise<void> {
  const listing = await research(client, model, photos);
  const dir = await createItemDir(folder, slugify(group.slug));
  // Photos are copied last: a failed item leaves its photos unsorted, so the next run retries it
  await writeFile(join(dir, 'post.slack.txt'), `${slackPost(listing)}\n`);
  await writeFile(join(dir, 'notes.txt'), `${researchNotes(listing)}\n`);
  await writeFile(join(dir, 'listing.json'), `${JSON.stringify(listing, null, 2)}\n`);
  for (const photo of photos) await copyFile(photo.path, join(dir, photo.name));
  log(`\n${dir}\n  ${listing.title} | ${formatMoney(listing.price.asking, listing.price.currency)} (${listing.confidence} confidence)`);
}

async function mapLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]).then(
        (value) => ({ status: 'fulfilled', value }) as const,
        (reason: unknown) => ({ status: 'rejected', reason }) as const,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const USAGE = `usage: flea <folder | photos.zip>

  A zip is first extracted to a folder named after it, next to it.
  Sorts the photos in <folder> by item and writes <folder>/${ITEMS_DIR}/<item>/ with the item's
  photos, post.slack.txt (paste into Slack), notes.txt (price research) and listing.json.
  Photos already in ${ITEMS_DIR}/ are skipped. Prices for ${MARKET} (${CURRENCY}); posts are in English.

  Model: $OPENAI_MODEL (default ${DEFAULT_MODEL}); key: $OPENAI_API_KEY (or .env)`;

async function main(): Promise<void> {
  loadDotEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h', default: false } },
  });
  if (values.help || positionals.length !== 1) {
    log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const input = positionals[0];
  const folder = extname(input).toLowerCase() === '.zip' ? await extractZip(input) : input;
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const client = new OpenAI();

  const names = await listNewPhotos(folder);
  if (names.length === 0) {
    log(`No new photos in ${folder}.`);
    return;
  }

  log(`Uploading ${names.length} photo(s)...`);
  const uploads = await Promise.allSettled(names.map((name) => uploadPhoto(client, folder, name)));
  const photos = uploads.flatMap((upload) => (upload.status === 'fulfilled' ? [upload.value] : []));
  try {
    const failedUpload = uploads.find((upload) => upload.status === 'rejected');
    if (failedUpload) throw failedUpload.reason;
    log(`Grouping photos by item with ${model}...`);
    const groups = await groupPhotos(client, model, photos);
    log(`Found ${groups.length} item(s). Researching prices for ${MARKET}...`);

    const byName = new Map(photos.map((photo) => [photo.name, photo]));
    const results = await mapLimited(groups, PARALLEL_ITEMS, (group) =>
      processItem(client, model, folder, group, group.photos.map((name) => byName.get(name) as Photo)),
    );

    const failed = results.flatMap((result, index) => (result.status === 'rejected' ? [{ group: groups[index], reason: result.reason }] : []));
    for (const { group, reason } of failed) {
      log(`\nfailed: ${group.slug} (${group.photos.join(', ')}): ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    log(`\nDone: ${groups.length - failed.length} of ${groups.length} item(s) in ${join(folder, ITEMS_DIR)}`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    // Uploaded copies are only needed for this run
    await Promise.allSettled(photos.map((photo) => client.files.delete(photo.fileId)));
  }
}

main().catch((error: unknown) => {
  log(`flea: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
