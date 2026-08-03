import { initContract, insertParamsIntoPath } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

// ===========================================================================
// Request bodies — what clients SEND. Binary payloads (audio, images) arrive
// base64-encoded and are transformed to Buffers for storage.
//
// Every field a client controls is bounded. An unbounded one is an open
// invitation to spend the server's resources: a megabyte-long title costs a
// megabyte of storage per row, a megabyte-long password costs argon2 the CPU
// to hash it, and a million-entry track list costs a million junction rows.
// The server enforces matching per-route body limits (see `limitRouteBodies`),
// so these bounds are the finer-grained half of the same fence.
// ===========================================================================

const MAX_NAME_LENGTH = 200;
const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_ARTISTS_PER_TRACK = 64;
const MAX_TRACKS_PER_PLAYLIST = 5000;
// Longest track the API accepts, as a sanity bound rather than a real limit:
// 24 hours in milliseconds.
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
// Base64 costs 4 characters per 3 bytes, so these cap the decoded payloads at
// roughly 7.5 MiB of image and 75 MiB of audio. Exported because the server
// sizes each route's body ceiling from them (see `limitRouteBodies`); the two
// have to move together or a payload this schema accepts would be rejected
// before the schema ever saw it.
export const MAX_IMAGE_BASE64 = 10 * 1024 * 1024;
export const MAX_AUDIO_BASE64 = 100 * 1024 * 1024;

// Base64-encoded image bytes, decoded to a Buffer for storage.
const ImageBase64 = z
  .base64()
  .max(MAX_IMAGE_BASE64)
  .transform((b) => Buffer.from(b, "base64"));

export const LoginRequest = z.object({
  username: z.string().min(1).max(MAX_USERNAME_LENGTH),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export const CreateTrackRequest = z.object({
  title: z.string().min(1).max(MAX_NAME_LENGTH),
  // Track length in milliseconds.
  duration: z.int32().min(0).max(MAX_DURATION_MS),
  artistIds: z.array(z.int32()).max(MAX_ARTISTS_PER_TRACK).optional(),
  // Raw audio bytes, sent base64-encoded and stored as-is (bytea).
  data: z
    .base64()
    .max(MAX_AUDIO_BASE64)
    .transform((b) => Buffer.from(b, "base64")),
  // Raw cover-image bytes, sent base64-encoded and stored as-is (bytea).
  cover: ImageBase64.optional(),
});

export const EditTrackRequest = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  artistIds: z.array(z.int32()).max(MAX_ARTISTS_PER_TRACK).optional(),
  // New cover-image bytes, base64-encoded; `null` removes the cover;
  // omit to leave it unchanged.
  cover: ImageBase64.nullable().optional(),
});

export const CreateArtistRequest = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  // Raw image bytes, sent base64-encoded and stored as-is (bytea).
  image: ImageBase64.optional(),
});

export const EditArtistRequest = z.object({
  id: z.int32(),
  name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  // New avatar image bytes, base64-encoded; `null` removes the avatar;
  // omit to leave it unchanged.
  image: ImageBase64.nullable().optional(),
});

// Ordered playback list of a playlist. Order is playback order; a track may
// appear at most once — duplicate ids are a 400, same as unknown ids.
const PlaylistTrackIds = z
  .array(z.uuid())
  .max(MAX_TRACKS_PER_PLAYLIST)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "trackIds must not contain duplicates",
  });

export const CreatePlaylistRequest = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  // Initial ordered playback list (see PlaylistTrackIds).
  trackIds: PlaylistTrackIds.optional(),
  // Raw cover-image bytes, sent base64-encoded and stored as-is (bytea).
  image: ImageBase64.optional(),
});

export const EditPlaylistRequest = z.object({
  id: z.int32(),
  name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  // Full replacement of the ordered track list (an empty array clears it);
  // omit to leave it unchanged. Same semantics as the create route (see
  // PlaylistTrackIds): duplicate and unknown ids are a 400.
  trackIds: PlaylistTrackIds.optional(),
  // New cover-image bytes, base64-encoded; `null` removes the cover;
  // omit to leave it unchanged.
  image: ImageBase64.nullable().optional(),
});

// Artists and playlists are still addressed by their serial id; tracks have
// their own request shape because a track id is a uuid.
export const DeleteByIdRequest = z.object({ id: z.int32() });

export const DeleteTrackRequest = z.object({ id: z.uuid() });

// ===========================================================================
// Response bodies — what the server RETURNS. Binary payloads are never inlined
// here; instead a field holds the URL of a dedicated route that streams the
// raw bytes (e.g. `imageUrl` -> getArtistImage, track audio -> getTrackAudio).
// ===========================================================================

export const TrackResponse = z.object({
  id: z.uuid(),
  title: z.string(),
  // Track length in milliseconds.
  duration: z.int32(),
  artists: z.array(z.string()),
  // URL of the `getTrackImage` route when the track has a cover, else absent.
  // The raw image bytes are fetched separately from that route.
  coverUrl: z.string().optional(),
});

export const ArtistResponse = z.object({
  id: z.int32(),
  name: z.string(),
  // URL of the `getArtistImage` route when the artist has an image, else
  // absent. The raw image bytes are fetched separately from that route.
  imageUrl: z.string().optional(),
});

export const PlaylistResponse = z.object({
  id: z.int32(),
  name: z.string(),
  // Ordered playback list; each track id appears at most once. Ids of tracks
  // that were deleted from the library are silently dropped from every
  // playlist server-side and never appear here.
  trackIds: z.array(z.uuid()),
  // URL of the `getPlaylistImage` route when the playlist has a cover, else
  // absent. The raw image bytes are fetched separately from that route.
  imageUrl: z.string().optional(),
});

// Statuses produced by the request pipeline rather than by an endpoint, and so
// possible on routes whose handler never returns them itself. `429` is the
// rate limiter turning a caller away — it carries a `Retry-After` header —
// and `413` is a request body over the route's ceiling.
const RateLimited = { 429: z.string() };
const BodyTooLarge = { 413: z.string() };

// ===========================================================================
// Route policy — how the server treats a route, carried on the route itself so
// that adding a route can't leave its policy behind in another file. The hooks
// in `src/app/hooks.ts` read this (via ts-rest's per-route `metadata`) instead
// of keeping their own lists of route names.
//
// Every field is optional and every default is the restrictive one: a route
// that says nothing requires a session token, accepts only a small body, and
// is never stored by a cache.
// ===========================================================================

export type RoutePolicy = {
  /** Answers callers with no session token. Default: a token is required. */
  public?: true;

  /**
   * Size class of the request body, sized from the base64 caps above. The
   * default leaves room for ids and names only.
   */
  body?: "image" | "audio";

  /**
   * How the response may be cached. The default forbids storing it at all.
   * `"private"` keeps a per-user body out of shared caches while still
   * letting the browser reuse it; `"shared"` is for bodies any caller may
   * read, and leaves caching to the client and any CDN in front.
   */
  cache?: "private" | "shared";

  /**
   * A stricter per-address request budget than the blanket one, as
   * `[limit, windowMs]`, for routes where a caller can guess at a secret.
   */
  throttle?: readonly [limit: number, windowMs: number];
};

// The three image routes are public so that a client can point an `<img>` at
// them directly. The text below states the consequence for API consumers; two
// more are accepted rather than overlooked:
//
//   - A 404 distinguishes "no such id" from "id exists but has no image",
//     which tells an anonymous caller how many artists and playlists exist.
//   - Track covers are addressed by uuid, so unlike artist and playlist images
//     they are not enumerable by walking a range.
//
// Nothing else is public: the listings that hand out these URLs, and the audio
// itself, are all scoped to the requesting user.
const PUBLIC_IMAGE_DISCLAIMER =
  "Public and un-scoped: this route serves the stored bytes to any caller, " +
  "with no token and no ownership check, so anything uploaded as an image " +
  "is world-readable. Artist and playlist ids are sequential, so their " +
  "images are enumerable by anyone.";

export const ApiContract = c.router(
  {
    login: {
      method: "POST",
      path: "/login",
      body: LoginRequest,
      responses: {
        200: z.object({ token: z.string() }),
        401: z.string(),
        500: z.string(),
        ...BodyTooLarge,
        ...RateLimited,
      },
      summary: "Log in with username and password, returns a session token",
      description:
        "Login is rate limited per source address and per account. A `429` " +
        "carries `Retry-After` (in seconds); clients MUST wait that long " +
        "rather than retrying immediately. A wrong password and an unknown " +
        "username are deliberately indistinguishable, in both body and " +
        "response time.",
      metadata: {
        public: true,
        // Tight, because this is the one route where a caller can guess at a
        // secret. The per-account budget lives in the endpoint: at the point
        // this one is applied the body hasn't been parsed, so there is no
        // username to key on yet.
        throttle: [10, 15 * 60 * 1000],
      } satisfies RoutePolicy,
    },
    postArtist: {
      method: "POST",
      path: "/postArtist",
      body: CreateArtistRequest,
      responses: {
        200: z.string(),
        400: z.string(),
        401: z.string(),
        500: z.string(),
        ...BodyTooLarge,
        ...RateLimited,
      },
      summary: "Post an artist",
      metadata: { body: "image" } satisfies RoutePolicy,
    },
    postTrack: {
      method: "POST",
      path: "/postTrack",
      body: CreateTrackRequest,
      responses: {
        200: z.string(),
        400: z.string(),
        401: z.string(),
        500: z.string(),
        ...BodyTooLarge,
        ...RateLimited,
      },
      summary: "Post a track",
      metadata: { body: "audio" } satisfies RoutePolicy,
    },
    deleteTrack: {
      method: "POST",
      path: "/deleteTrack",
      body: DeleteTrackRequest,
      responses: {
        200: z.string(),
        401: z.string(),
        404: z.string(),
        ...BodyTooLarge,
        ...RateLimited,
      },
      summary: "Delete a track owned by the requesting user",
    },
    deleteArtist: {
      method: "POST",
      path: "/deleteArtist",
      body: DeleteByIdRequest,
      responses: {
        200: z.string(),
        401: z.string(),
        404: z.string(),
        ...BodyTooLarge,
        ...RateLimited,
      },
      summary:
        "Delete an artist owned by the requesting user (tracks are kept)",
    },
    getTracks: {
      method: "GET",
      path: "/tracks",
      responses: {
        200: z.array(TrackResponse),
        401: z.string(),
        500: z.string(),
        ...RateLimited,
      },
      summary: "List all tracks available for streaming, oldest first",
      description:
        "Servers MUST return the listing in ascending order of when each " +
        "track was added. A track id is a uuid and carries no order of its " +
        "own, so this response is the only thing telling clients which " +
        "uploads are the recent ones.",
    },
    getArtists: {
      method: "GET",
      path: "/artists",
      responses: {
        200: z.array(ArtistResponse),
        401: z.string(),
        500: z.string(),
        ...RateLimited,
      },
      summary: "List all artists",
    },
    getArtistImage: {
      method: "GET",
      path: "/artist/:id/image",
      pathParams: z.object({ id: z.coerce.number() }),
      responses: {
        // Raw stored image bytes. The declared contentType is a fallback;
        // servers should send the real image MIME when they know it.
        200: c.otherResponse({
          contentType: "application/octet-stream",
          body: c.type<Uint8Array>(),
        }),
        404: z.string(),
        ...RateLimited,
      },
      summary: "Get an artist's raw image bytes (public, no auth required)",
      description: PUBLIC_IMAGE_DISCLAIMER,
      metadata: { public: true, cache: "shared" } satisfies RoutePolicy,
    },
    getTrackImage: {
      method: "GET",
      path: "/track/:id/image",
      pathParams: z.object({ id: z.uuid() }),
      responses: {
        // Raw stored image bytes. The declared contentType is a fallback;
        // servers should send the real image MIME when they know it.
        200: c.otherResponse({
          contentType: "application/octet-stream",
          body: c.type<Uint8Array>(),
        }),
        404: z.string(),
        ...RateLimited,
      },
      summary: "Get a track's raw cover image bytes (public, no auth required)",
      description: PUBLIC_IMAGE_DISCLAIMER,
      metadata: { public: true, cache: "shared" } satisfies RoutePolicy,
    },
    editArtist: {
      method: "POST",
      path: "/editArtist",
      body: EditArtistRequest,
      responses: {
        200: z.string(),
        400: z.string(),
        401: z.string(),
        404: z.string(),
        ...BodyTooLarge,
        ...RateLimited,
      },
      summary:
        "Edit an artist's name and/or avatar image (send null to remove)",
      metadata: { body: "image" } satisfies RoutePolicy,
    },
    getTrackAudio: {
      method: "GET",
      path: "/track/:id/audio",
      pathParams: z.object({ id: z.uuid() }),
      headers: {
        range: z.string().optional(),
      },
      responses: {
        // The stored audio bytes, verbatim. The declared contentType is the
        // fallback; servers should send the real audio MIME (audio/mpeg,
        // audio/flac, …) when they know it.
        200: c.otherResponse({
          contentType: "application/octet-stream",
          body: c.type<Uint8Array>(),
        }),
        206: c.otherResponse({
          contentType: "application/octet-stream",
          body: c.type<Uint8Array>(),
        }),
        401: z.string(),
        404: z.string(),
        416: z.string(),
        ...RateLimited,
      },
      summary: "Stream a track's raw audio bytes",
      description:
        "Servers MUST send `Accept-Ranges: bytes` and answer `Range` " +
        "requests with `206 Partial Content` — that is what lets clients " +
        "start playback before the download finishes and seek instantly. " +
        "Byte ranges address the stored bytes, so the body must go out " +
        "verbatim and un-encoded. Clients that need progressive bytes (the " +
        "app's bun-side stream proxy) fetch this route directly via " +
        "`trackAudioPath` — the ts-rest fetch client buffers response " +
        "bodies, which would defeat streaming.",
      // Per-user bytes, but whole tracks: refusing to cache them would cost
      // more than it protects, so they stay out of shared caches only.
      metadata: { cache: "private" } satisfies RoutePolicy,
    },
    editTrack: {
      method: "POST",
      path: "/editTrack",
      body: EditTrackRequest,
      responses: {
        200: z.string(),
        400: z.string(),
        401: z.string(),
        404: z.string(),
        ...BodyTooLarge,
        ...RateLimited,
      },
      summary:
        "Edit a track's title, cover image, and/or replace its artist links",
      metadata: { body: "image" } satisfies RoutePolicy,
    },
    postPlaylist: {
      method: "POST",
      path: "/postPlaylist",
      body: CreatePlaylistRequest,
      responses: {
        200: z.string(),
        400: z.string(),
        401: z.string(),
        500: z.string(),
        ...BodyTooLarge,
        ...RateLimited,
      },
      summary: "Create a playlist, optionally with an initial track list",
      metadata: { body: "image" } satisfies RoutePolicy,
    },
    editPlaylist: {
      method: "POST",
      path: "/editPlaylist",
      body: EditPlaylistRequest,
      responses: {
        200: z.string(),
        400: z.string(),
        401: z.string(),
        404: z.string(),
        ...BodyTooLarge,
        ...RateLimited,
      },
      summary:
        "Edit a playlist's name, cover, and/or replace its ordered track " +
        "list (send null to remove the cover)",
      metadata: { body: "image" } satisfies RoutePolicy,
    },
    deletePlaylist: {
      method: "POST",
      path: "/deletePlaylist",
      body: DeleteByIdRequest,
      responses: {
        200: z.string(),
        401: z.string(),
        404: z.string(),
        ...BodyTooLarge,
        ...RateLimited,
      },
      summary:
        "Delete a playlist owned by the requesting user (tracks are kept)",
    },
    getPlaylists: {
      method: "GET",
      path: "/playlists",
      responses: {
        200: z.array(PlaylistResponse),
        401: z.string(),
        500: z.string(),
        ...RateLimited,
      },
      summary: "List all playlists with their ordered track ids",
      description:
        "Each playlist carries its complete ordered `trackIds` — clients " +
        "join them against the track listing, so there is no per-playlist " +
        "detail route. Servers MUST silently remove a track from every " +
        "playlist when it is deleted from the library (playlists never " +
        "contain dangling ids).",
    },
    getPlaylistImage: {
      method: "GET",
      path: "/playlist/:id/image",
      pathParams: z.object({ id: z.coerce.number() }),
      responses: {
        // Raw stored image bytes. The declared contentType is a fallback;
        // servers should send the real image MIME when they know it.
        200: c.otherResponse({
          contentType: "application/octet-stream",
          body: c.type<Uint8Array>(),
        }),
        404: z.string(),
        ...RateLimited,
      },
      summary:
        "Get a playlist's raw cover-image bytes (public, no auth required)",
      description: PUBLIC_IMAGE_DISCLAIMER,
      metadata: { public: true, cache: "shared" } satisfies RoutePolicy,
    },
  },
  {
    baseHeaders: {
      authorization: z.string().optional(),
    },
  },
);

/**
 * Concrete request path for `getTrackAudio` (see its description: streaming
 * consumers fetch this directly instead of going through the ts-rest client).
 */
export const trackAudioPath = (trackId: string) =>
  insertParamsIntoPath({
    path: ApiContract.getTrackAudio.path,
    params: { id: trackId },
  });

/**
 * Concrete request path for `getArtistImage`. Returned as `imageUrl` on artist
 * listings so clients know where to fetch the raw image bytes.
 */
export const artistImagePath = (artistId: number) =>
  insertParamsIntoPath({
    path: ApiContract.getArtistImage.path,
    params: { id: String(artistId) },
  });

/**
 * Concrete request path for `getTrackImage`. Returned as `coverUrl` on track
 * listings so clients know where to fetch the raw cover-image bytes.
 */
export const trackImagePath = (trackId: string) =>
  insertParamsIntoPath({
    path: ApiContract.getTrackImage.path,
    params: { id: trackId },
  });

/**
 * Concrete request path for `getPlaylistImage`. Returned as `imageUrl` on
 * playlist listings so clients know where to fetch the raw cover-image bytes.
 */
export const playlistImagePath = (playlistId: number) =>
  insertParamsIntoPath({
    path: ApiContract.getPlaylistImage.path,
    params: { id: String(playlistId) },
  });
