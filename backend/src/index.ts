import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import path from "path";
import { adminRouter } from "./routes/admin.js";
import { aiRouter } from "./routes/ai.js";
import { authRouter } from "./routes/auth.js";
import { healthIndexRouter } from "./routes/healthIndex.js";
import { postsRouter } from "./routes/posts.js";
import { subscribersRouter } from "./routes/subscribers.js";
import { botRouter } from "./routes/bot.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { initDb } from "./services/db.js";
import { apiLimiter } from "./services/rateLimit.js";
import { startGenerationScheduler } from "./services/generationScheduler.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
    credentials: true
  })
);
app.use(express.json({ limit: "12mb" }));
app.use(cookieParser());
app.use(apiLimiter);

const uploadsDir = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(uploadsDir));
app.use("/api/uploads", express.static(uploadsDir));

app.use("/api/auth", authRouter);
app.use("/api/posts", postsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/ai", aiRouter);
app.use("/api/subscribers", subscribersRouter);
app.use("/api/health", healthIndexRouter);
app.use("/api/bot/v1", botRouter);
app.use(errorHandler);

await initDb();
startGenerationScheduler();

app.listen(port, () => {
  console.log(`API listening on ${port}`);
});
