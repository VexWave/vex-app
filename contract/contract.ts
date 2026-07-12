import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const TrackSchema = z.object({
  title: z.string(),
  duration: z.int32(),
  artistId: z.int32().optional(),
  compressed_data: z.base64().transform((b) => Buffer.from(b, "base64")),
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
