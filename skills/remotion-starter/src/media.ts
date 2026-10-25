import { staticFile } from "remotion";
import { isUrl } from "./schema.js";

/** URLs pass through; everything else is a file staged in the render's public directory. */
export const mediaUrl = (src: string): string => (isUrl(src) ? src : staticFile(src));

export const toFrames = (seconds: number, fps: number): number => Math.round(seconds * fps);
