import {
  convertQueryParamsToUrlString,
  initContract,
  insertParamsIntoPath,
} from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

const MAX_NAME_LENGTH = 200;
const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_ARTISTS_PER_TRACK = 64;
const MAX_TRACKS_PER_PLAYLIST = 5000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
// `limitRouteBodies` sizes each route's body ceiling from these; the two have
// to move together.
export const MAX_IMAGE_BASE64 = 10 * 1024 * 1024;
export const MAX_AUDIO_BASE64 = 100 * 1024 * 1024;

// --- Requests ---

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
  duration: z.int32().min(0).max(MAX_DURATION_MS),
  artistIds: z.array(z.int32()).max(MAX_ARTISTS_PER_TRACK).optional(),
  data: z
    .base64()
    .max(MAX_AUDIO_BASE64)
    .transform((b) => Buffer.from(b, "base64")),
  cover: ImageBase64.optional(),
});

// On every edit route a null image removes it, an absent one leaves it.
export const EditTrackRequest = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  artistIds: z.array(z.int32()).max(MAX_ARTISTS_PER_TRACK).optional(),
  cover: ImageBase64.nullable().optional(),
});

export const CreateArtistRequest = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  image: ImageBase64.optional(),
});

export const EditArtistRequest = z.object({
  id: z.int32(),
  name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  image: ImageBase64.nullable().optional(),
});

// Array order is playback order.
const PlaylistTrackIds = z
  .array(z.uuid())
  .max(MAX_TRACKS_PER_PLAYLIST)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "trackIds must not contain duplicates",
  });

export const CreatePlaylistRequest = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  trackIds: PlaylistTrackIds.optional(),
  image: ImageBase64.optional(),
});

export const EditPlaylistRequest = z.object({
  id: z.int32(),
  name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  // Full replacement; an empty array clears the list.
  trackIds: PlaylistTrackIds.optional(),
  image: ImageBase64.nullable().optional(),
});

export const DeleteByIdRequest = z.object({ id: z.int32() });

export const DeleteTrackRequest = z.object({ id: z.uuid() });

// --- Responses ---

export const TrackResponse = z.object({
  id: z.uuid(),
  title: z.string(),
  duration: z.int32(),
  artistIds: z.array(z.int32()),
  coverUrl: z.string().optional(),
});

export const ArtistResponse = z.object({
  id: z.int32(),
  name: z.string(),
  imageUrl: z.string().optional(),
});

export const PlaylistResponse = z.object({
  id: z.int32(),
  name: z.string(),
  // A deleted track is dropped from every playlist server-side.
  trackIds: z.array(z.uuid()),
  imageUrl: z.string().optional(),
});

export const DataResponse = z.object({
  // Oldest first; a uuid carries no order of its own.
  tracks: z.array(TrackResponse),
  // Every artist the caller owns, sent once and referenced by id from
  // `tracks` — including artists no track references.
  artists: z.array(ArtistResponse),
  playlists: z.array(PlaylistResponse),
});

// Produced by the request pipeline, not by any endpoint.
const RateLimited = { 429: z.string() };
const BodyTooLarge = { 413: z.string() };

// Read by `src/app/hooks.ts`. Every default is the restrictive one: a route
// that says nothing requires a token, accepts only a small body, and is never
// stored by a cache.
export type RoutePolicy = {
  public?: true;
  body?: "image" | "audio";
  /**
   * `"versioned"`: public bytes whose URL pins a content hash, so an edit
   * publishes new bytes under a new URL. `"private-immutable"`: per-user bytes
   * fixed for a URL, which no shared cache may store.
   */
  cache?: "versioned" | "private-immutable";
  throttle?: readonly [limit: number, windowMs: number];
};

const ImageVersionQuery = z.object({
  v: z.string().max(64).optional().catch(undefined),
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
        ...BodyTooLarge,
        ...RateLimited,
      },
      summary: "Log in with username and password, returns a session token",
      // The per-account budget lives in the endpoint: here the body isn't
      // parsed yet, so there is no username to key on.
      metadata: {
        public: true,
        throttle: [10, 15 * 60 * 1000],
      } satisfies RoutePolicy,
    },
    getData: {
      method: "GET",
      path: "/data",
      responses: {
        200: DataResponse,
        401: z.string(),
        500: z.string(),
        ...RateLimited,
      },
      summary: "Get the caller's whole library: tracks, artists and playlists",
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
      summary: "Edit a track's title, cover, and/or artist links",
      metadata: { body: "image" } satisfies RoutePolicy,
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
      summary: "Edit an artist's name and/or image",
      metadata: { body: "image" } satisfies RoutePolicy,
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
      summary: "Edit a playlist's name, cover, and/or ordered track list",
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
    // Servers must answer `Range` with a verbatim, un-encoded `206`. Streaming
    // consumers fetch this via `trackAudioPath` rather than the ts-rest client,
    // which buffers response bodies.
    getTrackAudio: {
      method: "GET",
      path: "/track/:id/audio",
      pathParams: z.object({ id: z.uuid() }),
      headers: {
        range: z.string().optional(),
      },
      responses: {
        200: c.otherResponse({
          contentType: "application/octet-stream",
          body: c.type<Uint8Array>(),
        }),
        206: c.otherResponse({
          contentType: "application/octet-stream",
          body: c.type<Uint8Array>(),
        }),
        304: c.noBody(),
        401: z.string(),
        404: z.string(),
        416: z.string(),
        ...RateLimited,
      },
      summary: "Stream a track's raw audio bytes",
      metadata: { cache: "private-immutable" } satisfies RoutePolicy,
    },
    // The image routes are public, so stored images are world-readable — and
    // artist and playlist ids are sequential, so theirs are enumerable.
    getTrackImage: {
      method: "GET",
      path: "/track/:id/image",
      pathParams: z.object({ id: z.uuid() }),
      query: ImageVersionQuery,
      responses: {
        200: c.otherResponse({
          contentType: "application/octet-stream",
          body: c.type<Uint8Array>(),
        }),
        304: c.noBody(),
        404: z.string(),
        ...RateLimited,
      },
      summary: "Get a track's raw cover-image bytes",
      metadata: { public: true, cache: "versioned" } satisfies RoutePolicy,
    },
    getArtistImage: {
      method: "GET",
      path: "/artist/:id/image",
      pathParams: z.object({ id: z.coerce.number() }),
      query: ImageVersionQuery,
      responses: {
        200: c.otherResponse({
          contentType: "application/octet-stream",
          body: c.type<Uint8Array>(),
        }),
        304: c.noBody(),
        404: z.string(),
        ...RateLimited,
      },
      summary: "Get an artist's raw image bytes",
      metadata: { public: true, cache: "versioned" } satisfies RoutePolicy,
    },
    getPlaylistImage: {
      method: "GET",
      path: "/playlist/:id/image",
      pathParams: z.object({ id: z.coerce.number() }),
      query: ImageVersionQuery,
      responses: {
        200: c.otherResponse({
          contentType: "application/octet-stream",
          body: c.type<Uint8Array>(),
        }),
        304: c.noBody(),
        404: z.string(),
        ...RateLimited,
      },
      summary: "Get a playlist's raw cover-image bytes",
      metadata: { public: true, cache: "versioned" } satisfies RoutePolicy,
    },
  },
  {
    baseHeaders: {
      authorization: z.string().optional(),
    },
  },
);

export const trackAudioPath = (trackId: string) =>
  insertParamsIntoPath({
    path: ApiContract.getTrackAudio.path,
    params: { id: trackId },
  });

// `v` pins the content hash so the bytes can be cached for good: an edit
// changes the hash, and the client learns the new URL from its next `getData`.
const imagePath = (path: string, id: string | number, version?: string) =>
  insertParamsIntoPath({ path, params: { id: String(id) } }) +
  convertQueryParamsToUrlString({ v: version });

export const artistImagePath = (artistId: number, version?: string) =>
  imagePath(ApiContract.getArtistImage.path, artistId, version);

export const trackImagePath = (trackId: string, version?: string) =>
  imagePath(ApiContract.getTrackImage.path, trackId, version);

export const playlistImagePath = (playlistId: number, version?: string) =>
  imagePath(ApiContract.getPlaylistImage.path, playlistId, version);
