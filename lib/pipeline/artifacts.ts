/**
 * Run artifacts: where a captured browser frame is actually kept.
 *
 * The browser layer takes a full-page PNG for every page it opens
 * (`PageCapture.screenshot`), the VIS lane looks at it, and until this module
 * existed that was the end of it — the image lived in one Node process's memory
 * for the length of the run and was never written anywhere. The run view had
 * nothing to render, so every environment card reported "No frame captured
 * yet", truthfully and permanently.
 *
 * So the frame is persisted here, as an `artifacts` row:
 *
 *   - `kind`        'screenshot'
 *   - `mime_type`   'image/png'
 *   - `data`        the PNG bytes
 *   - `run_id`      the run that captured it
 *   - `finding_id`  **null** — a page frame is evidence of the page, not of one
 *                   finding. That null is also the discriminator: the ledger
 *                   attaches finding evidence to the same table with a
 *                   `finding_id` set, and only rows without one are page frames.
 *   - `storage_path` the page URL the frame depicts.
 *
 * That last one deserves a note, because the column's original meaning was "an
 * object-store path for anything too large to inline". `artifacts` has no
 * `page_id` column, and adding one is a migration against a live database on
 * the morning of a demo. `storage_path` is the one free locator column on the
 * row, and a page URL is a locator: it is exactly what `pages.url` and the
 * page-keyed half of `pipeline_jobs.job_key` hold, which is what lets the run
 * view join a frame to the card that captured it. The bytes are still in
 * `data`; nothing about the payload changes.
 *
 * Bytes never travel by any route but `/api/artifacts/{id}`. They are not put
 * on the SSE stream and not put in React props — a full-page PNG is measured in
 * megabytes and both of those paths would carry it on every update.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { artifacts, runs, targets, type ArtifactKind } from '@/lib/db/schema';

import { emitEvent } from './events';

/**
 * Largest frame written to the ledger, in decoded bytes.
 *
 * A full-page PNG of a long marketing page runs to a couple of megabytes; ten
 * of those is a fine row set. A pathological one is not worth a `bytea` row
 * that every read of the run has to step over, and the honest placeholder is a
 * better outcome than a stalled query. Above this the frame is dropped and the
 * reason is written to the run log rather than swallowed.
 */
export const MAX_STORED_FRAME_BYTES = 10_000_000;

/** One page frame, as the run view needs it. Bytes are fetched by URL, not here. */
export interface PageFrame {
  artifactId: string;
  /** The page URL the frame depicts. Matches `pages.url`. */
  pageUrl: string;
  capturedAt: string;
  bytes: number;
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

export interface RecordPageScreenshotInput {
  runId: string;
  /** The URL the browser actually ended on, normalised. The frame's identity. */
  pageUrl: string;
  /** Base64 PNG, straight off `PageCapture.screenshot`. */
  base64: string | null | undefined;
}

/**
 * Persist one page's frame, replacing any frame already held for that page.
 *
 * Replacing rather than appending is deliberate. A run re-crawls: a resume
 * repeats pages it had already captured, and the final audit re-crawls the
 * whole origin under the same run id. The card shows *the latest* frame, so
 * keeping every historical copy would grow the row set for a page nothing ever
 * reads, and would make "which one is current" a question the reader has to
 * answer. One frame per page per run, always the most recent.
 *
 * Never throws. A frame that cannot be stored is a degraded run view; it is not
 * a reason to fail a crawl that otherwise succeeded, so the failure is reported
 * on the run log and the caller continues.
 *
 * @returns the artifact id, or `null` when there was no frame to store.
 */
export async function recordPageScreenshot(
  input: RecordPageScreenshotInput,
): Promise<string | null> {
  const base64 = (input.base64 ?? '').trim();
  if (!base64) return null;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (bytes.byteLength === 0) return null;

  if (bytes.byteLength > MAX_STORED_FRAME_BYTES) {
    await emitEvent({
      runId: input.runId,
      type: 'log',
      capability: 'sandbox',
      summary: `The frame for ${input.pageUrl} was too large to keep.`,
      detail:
        `It decoded to ${Math.round(bytes.byteLength / 1_000_000)} MB, over the ` +
        `${Math.round(MAX_STORED_FRAME_BYTES / 1_000_000)} MB ceiling for an inline artifact. ` +
        'The page was still audited; its card reports no frame rather than a partial one.',
      data: { url: input.pageUrl, bytes: bytes.byteLength },
    }).catch(() => undefined);
    return null;
  }

  try {
    return await db.transaction(async (tx) => {
      // The previous frame for this page goes, so a page holds exactly one.
      await tx
        .delete(artifacts)
        .where(
          and(
            eq(artifacts.runId, input.runId),
            eq(artifacts.kind, 'screenshot'),
            isNull(artifacts.findingId),
            eq(artifacts.storagePath, input.pageUrl),
          ),
        );

      const [row] = await tx
        .insert(artifacts)
        .values({
          runId: input.runId,
          findingId: null,
          kind: 'screenshot',
          mimeType: 'image/png',
          data: bytes,
          storagePath: input.pageUrl,
        })
        .returning({ id: artifacts.id });

      return row?.id ?? null;
    });
  } catch (error) {
    await emitEvent({
      runId: input.runId,
      type: 'log',
      capability: 'sandbox',
      summary: `The frame for ${input.pageUrl} could not be stored.`,
      detail: error instanceof Error ? error.message : String(error),
      data: { url: input.pageUrl },
    }).catch(() => undefined);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every page frame this run holds, oldest first, one per page.
 *
 * Deliberately does not select `data`: this is the index the run view joins
 * against, and pulling megabytes of PNG into a page render to then discard them
 * is the mistake the whole by-URL design exists to avoid.
 */
export async function screenshotsForRun(runId: string): Promise<PageFrame[]> {
  const rows = await db
    .select({
      id: artifacts.id,
      storagePath: artifacts.storagePath,
      createdAt: artifacts.createdAt,
      bytes: sql<number>`coalesce(octet_length(${artifacts.data}), 0)::int`,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.runId, runId),
        eq(artifacts.kind, 'screenshot'),
        isNull(artifacts.findingId),
      ),
    )
    .orderBy(asc(artifacts.createdAt));

  // One row per page even if a historical duplicate survives; latest wins.
  const byUrl = new Map<string, PageFrame>();
  for (const row of rows) {
    if (!row.storagePath) continue;
    byUrl.set(row.storagePath, {
      artifactId: row.id,
      pageUrl: row.storagePath,
      capturedAt: row.createdAt.toISOString(),
      bytes: Number(row.bytes ?? 0),
    });
  }
  return [...byUrl.values()];
}

/** An artifact's bytes, with everything needed to serve them. */
export interface ServedArtifact {
  id: string;
  runId: string;
  kind: ArtifactKind;
  mimeType: string;
  data: Buffer | null;
  storagePath: string | null;
  createdAt: Date;
}

/**
 * One artifact, scoped to the signed-in user.
 *
 * The same rule as every other read in the product: the query joins through
 * `targets.user_id` rather than trusting the id in the URL. An artifact id is a
 * UUID, not a capability. `null` covers "no such artifact" and "not yours"
 * alike, which is what lets the route answer 404 for both — a 403 would confirm
 * that another user's artifact exists.
 */
export async function artifactForUser(
  artifactId: string,
  userId: string,
): Promise<ServedArtifact | null> {
  const [row] = await db
    .select({
      id: artifacts.id,
      runId: artifacts.runId,
      kind: artifacts.kind,
      mimeType: artifacts.mimeType,
      data: artifacts.data,
      storagePath: artifacts.storagePath,
      createdAt: artifacts.createdAt,
    })
    .from(artifacts)
    .innerJoin(runs, eq(artifacts.runId, runs.id))
    .innerJoin(targets, eq(runs.targetId, targets.id))
    .where(and(eq(artifacts.id, artifactId), eq(targets.userId, userId)))
    .limit(1);

  return row ?? null;
}
