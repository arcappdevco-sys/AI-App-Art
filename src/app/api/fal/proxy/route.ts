// Keeps FAL_KEY server-side. The browser only ever talks to /api/fal/proxy.
import { route } from "@fal-ai/server-proxy/nextjs";

export const { GET, POST, PUT } = route;
