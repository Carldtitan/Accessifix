/**
 * `/api/artifacts/{artifactId}` — the bytes of one stored artifact.
 *
 * The only way a screenshot leaves the database. Nothing else in the product
 * carries artifact bytes: they are not on the SSE stream, not in a React prop
 * and not in a JSON body, because a full-page PNG is megabytes and every one of
 * those paths would re-send it on every update. The run view holds an artifact
 * id and lets the browser fetch the image the way it fetches any other image —
 * once, cached, off the critical path of the page.
 *
 * Ownership follows the same rule as every other read: the query joins through
 * `targets.user_id`, so an artifact belonging to someone else's run is a **404,
 * never a 403**. A 403 would confirm that the artifact exists, which is exactly
 * the disclosure the scoping is there to prevent.
 *
 * Next 16: `params` is a Promise.
 */
import { NextResponse } from 'next/server';

import { artifactForUser } from '@/lib/pipeline/artifacts';
import { currentUser, isUuid, NOT_FOUND, UNAUTHORIZED } from '@/lib/pipeline/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Content types this route will hand back.
 *
 * `mime_type` is a text column, and a stored value is echoed into a response
 * header, so it is checked against a list rather than trusted. Anything else is
 * served as an opaque download: the bytes are still the user's, but the browser
 * is never told to render an unexpected type inline.
 */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'application/json',
  'text/plain',
  'video/webm',
  'video/mp4',
]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ artifactId: string }> },
): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { artifactId } = await params;

  // A malformed id is a 404 as well: Postgres would reject the cast, and the
  // caller has no more right to a 400 telling it the id was not even a UUID.
  if (!isUuid(artifactId)) return NextResponse.json(NOT_FOUND, { status: 404 });

  const artifact = await artifactForUser(artifactId, user.id);
  if (!artifact) return NextResponse.json(NOT_FOUND, { status: 404 });

  if (!artifact.data || artifact.data.byteLength === 0) {
    // The row exists but holds no inline bytes — it is a reference to something
    // kept outside the ledger. There is nothing to serve, and saying so is
    // better than an empty 200 the browser renders as a broken image.
    return NextResponse.json(
      {
        error: 'No bytes for this artifact.',
        reason:
          'The artifact is recorded as a reference rather than as inline bytes' +
          (artifact.storagePath ? `, at ${artifact.storagePath}.` : '.'),
      },
      { status: 404 },
    );
  }

  const inline = INLINE_TYPES.has(artifact.mimeType);
  const body = new Uint8Array(artifact.data);

  return new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': inline ? artifact.mimeType : 'application/octet-stream',
      'content-length': String(body.byteLength),
      'content-disposition': inline ? 'inline' : `attachment; filename="${artifact.id}"`,
      // An artifact is immutable once written: a re-captured frame is a new
      // row with a new id. So it can be cached hard, and privately — this is
      // one user's audit evidence and no shared cache may keep a copy.
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}
