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
  duration: z.int32(),
  artistId: z.int32().optional(),
  compressed_data: z.base64().transform((b) => Buffer.from(b, "base64")),
});

export const EditTrackRequest = z.object({
  id: z.int32(),
  title: z.string().min(1).optional(),
  artistIds: z.array(z.int32()).optional(),
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
  // New avatar image bytes, base64-encoded. Omit to leave the avatar unchanged.
  image: z
    .base64()
    .transform((b) => Buffer.from(b, "base64"))
    .optional(),
});

export const DeleteByIdRequest = z.object({ id: z.int32() });

// ===========================================================================
// Response bodies — what the server RETURNS. Binary payloads are never inlined
// here; instead a field holds the URL of a dedicated route that streams the
// raw bytes (e.g. `imageUrl` -> getArtistImage, track audio -> getTrackAudio).
// ===========================================================================

export const TrackResponse = z.object({
  id: z.int32(),
  title: z.string(),
  duration: z.int32(),
  artists: z.array(z.string()),
});

export const ArtistResponse = z.object({
  id: z.int32(),
  name: z.string(),
  // URL of the `getArtistImage` route when the artist has an image, else
  // absent. The raw image bytes are fetched separately from that route.
  imageUrl: z.string().optional(),
});

export const PlaylistResponse = z.object({
  name: z.string(),
  desc: z.string(),
  playlistId: z.int32(),
  imageUrl: z.string(),
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
      body: DeleteByIdRequest,
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
      summary: "List all tracks available for streaming",
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
      summary: "Edit an artist's name and/or avatar image",
    },
    getTrackAudio: {
      method: "GET",
      path: "/track/:id/audio",
      pathParams: z.object({ id: z.coerce.number() }),
      headers: {
        range: z.string().optional(),
      },
      responses: {
        // Raw audio bytes (the stored track, decompressed). The declared
        // contentType is the fallback; servers should send the real audio
        // MIME (audio/mpeg, audio/flac, …) when they know it.
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
      summary: "Stream a track's raw (decompressed) audio bytes",
      description:
        "Servers MUST send `Accept-Ranges: bytes` and answer `Range` " +
        "requests with `206 Partial Content` — that is what lets clients " +
        "start playback before the download finishes and seek instantly. " +
        "Do not gzip the response: byte ranges address the raw audio bytes. " +
        "Clients that need progressive bytes (the app's bun-side stream " +
        "proxy) fetch this route directly via `trackAudioPath` — the " +
        "ts-rest fetch client buffers response bodies, which would defeat " +
        "streaming.",
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
      summary: "Edit a track's title and/or replace its artist links",
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
export const trackAudioPath = (trackId: number) =>
  insertParamsIntoPath({
    path: ApiContract.getTrackAudio.path,
    params: { id: String(trackId) },
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
