import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const isBadUpload = error?.code === "LIMIT_FILE_SIZE" || error?.code === "LIMIT_UNEXPECTED_FILE" ||
    message === "Image is empty" || message.includes("Image is larger") || message.includes("valid JPG");
  const status = isBadUpload ? 400 : message.includes("not configured") || message.includes("OpenRouter") ? 503 : 500;
  res.status(status).json({ error: message });
};
