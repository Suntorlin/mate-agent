import type { z } from "zod";
import type { timelineSchema } from "./schema.js";

export type Timeline = z.output<typeof timelineSchema>;
export type Shot = Timeline["shots"][number];
export type PlacedShot = Shot & { start: number; end: number };
export type TextItem = Timeline["texts"][number];
export type CaptionLine = Timeline["captions"][number];
export type AudioTrack = Timeline["audio"][number];
export type Position = TextItem["position"];
