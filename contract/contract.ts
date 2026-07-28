import { initContract, insertParamsIntoPath } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

// ===========================================================================
// Request bodies — what clients SEND. Binary payloads (audio, images) arrive
// base64-encoded and are transformed to Buffers for storage.
// ===========================================================================

export const LoginRequest = z.object({
  username: z.string(),
  password: z.string(),
});

export const CreateTrackRequest = z.object({
  title: z.string(),
  // Track length in milliseconds.
  duration: z.int32(),
  artistIds: z.array(z.int32()).optional(),
  // Raw audio bytes, sent base64-encoded and stored as-is (bytea).
  data: z.base64().transform((b) => Buffer.from(b, "base64")),
  // Raw cover-image bytes, sent base64-encoded and stored as-is (bytea).
  cover: z
    .base64()
    .transform((b) => Buffer.from(b, "base64"))
    .optional(),
});

export const EditTrackRequest = z.object({
  id: z.uuid(),
  title: z.string().min(1).optional(),
  artistIds: z.array(z.int32()).optional(),
  // New cover-image bytes, base64-encoded; `null` removes the cover;
  // omit to leave it unchanged.
  cover: z
    .base64()
    .transform((b) => Buffer.from(b, "base64"))
    .nullable()
    .optional(),
});

export const CreateArtistRequest = z.object({
  name: z.string(),
  // Raw image bytes, sent base64-encoded and stored as-is (bytea).
  image: z
    .base64()
    .transform((b) => Buffer.from(b, "base64"))
    .optional(),
});

export const EditArtistRequest = z.object({
  id: z.int32(),
  name: z.string().min(1).optional(),
  // New avatar image bytes, base64-encoded; `null` removes the avatar;
  // omit to leave it unchanged.
  image: z
    .base64()
    .transform((b) => Buffer.from(b, "base64"))
    .nullable()
    .optional(),
});

// Ordered playback list of a playlist. Order is playback order; a track may
// appear at most once — duplicate ids are a 400, same as unknown ids.
const PlaylistTrackIds = z
  .array(z.uuid())
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "trackIds must not contain duplicates",
  });

export const CreatePlaylistRequest = z.object({
  name: z.string().min(1),
  // Initial ordered playback list (see PlaylistTrackIds).
  trackIds: PlaylistTrackIds.optional(),
  // Raw cover-image bytes, sent base64-encoded and stored as-is (bytea).
  image: z
    .base64()
    .transform((b) => Buffer.from(b, "base64"))
    .optional(),
});

export const EditPlaylistRequest = z.object({
  id: z.int32(),
  name: z.string().min(1).optional(),
  // Full replacement of the ordered track list (an empty array clears it);
  // omit to leave it unchanged. Same semantics as the create route (see
  // PlaylistTrackIds): duplicate and unknown ids are a 400.
  trackIds: PlaylistTrackIds.optional(),
  // New cover-image bytes, base64-encoded; `null` removes the cover;
  // omit to leave it unchanged.
  image: z
    .base64()
    .transform((b) => Buffer.from(b, "base64"))
    .nullable()
    .optional(),
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
      },
      summary: "Log in with username and password, returns a session token",
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
      },
      summary: "Post an artist",
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
      },
      summary: "Post a track",
    },
    deleteTrack: {
      method: "POST",
      path: "/deleteTrack",
      body: DeleteTrackRequest,
      responses: {
        200: z.string(),
        401: z.string(),
        404: z.string(),
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
      },
      summary: "Get an artist's raw image bytes (public, no auth required)",
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
      },
      summary: "Get a track's raw cover image bytes (public, no auth required)",
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
      },
      summary:
        "Edit an artist's name and/or avatar image (send null to remove)",
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
      },
      summary:
        "Edit a track's title, cover image, and/or replace its artist links",
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
      },
      summary: "Create a playlist, optionally with an initial track list",
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
      },
      summary:
        "Edit a playlist's name, cover, and/or replace its ordered track " +
        "list (send null to remove the cover)",
    },
    deletePlaylist: {
      method: "POST",
      path: "/deletePlaylist",
      body: DeleteByIdRequest,
      responses: {
        200: z.string(),
        401: z.string(),
        404: z.string(),
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
      },
      summary:
        "Get a playlist's raw cover-image bytes (public, no auth required)",
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
