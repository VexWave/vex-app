import { initContract, insertParamsIntoPath } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const TrackSchema = z.object({
  title: z.string(),
  duration: z.int32(),
  artistId: z.int32().optional(),
  compressed_data: z.base64().transform((b) => Buffer.from(b, "base64")),
});

export const ServerTrackSchema = z.object({
  id: z.int32(),
  title: z.string(),
  duration: z.int32(),
  artists: z.array(z.string()),
});

export const PlaylistSchema = z.object({
  name: z.string(),
  desc: z.string(),
  playlistId: z.int32(),
  imageUrl: z.string(),
});

export const ArtistSchema = z.object({
  id: z.string(),
  name: z.string(),
  imageUrl: z.string().optional(),
});

export const CreateArtistSchema = z.object({
  name: z.string(),
  imageUrl: z.string().optional(),
});

export const DeleteByIdSchema = z.object({ id: z.int32() });

export const EditTrackSchema = z.object({
  id: z.int32(),
  title: z.string().min(1).optional(),
  artistIds: z.array(z.int32()).optional(),
});

export const LoginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export const ApiContract = c.router(
  {
    login: {
      method: "POST",
      path: "/login",
      body: LoginSchema,
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
      body: CreateArtistSchema,
      responses: {
        200: z.string(),
        401: z.string(),
        500: z.string(),
      },
      summary: "Post an artist",
    },
    postTrack: {
      method: "POST",
      path: "/postTrack",
      body: TrackSchema,
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
      body: DeleteByIdSchema,
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
      body: DeleteByIdSchema,
      responses: {
        200: z.string(),
        401: z.string(),
        404: z.string(),
      },
      summary: "Delete an artist owned by the requesting user (tracks are kept)",
    },
    getTracks: {
      method: "GET",
      path: "/tracks",
      responses: {
        200: z.array(ServerTrackSchema),
        401: z.string(),
        500: z.string(),
      },
      summary: "List all tracks available for streaming",
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
      body: EditTrackSchema,
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
