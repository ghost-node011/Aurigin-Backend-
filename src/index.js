// Local dev entrypoint (`npm run dev` / `npm start`). Vercel doesn't use
// this file — see api/index.js, which re-exports the same `app` as a
// serverless function instead of calling .listen(). Connecting up front
// here (rather than relying on app.js's connect-on-first-request
// middleware) just makes local dev fail fast if Mongo is unreachable.
import "dotenv/config";
import { app } from "./app.js";
import { connectDB } from "./db.js";

const port = process.env.PORT || 4000;

connectDB()
  .then(() => {
    app.listen(port, () => console.log(`Aurigin HR API listening on http://localhost:${port}`));
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err.message);
    process.exit(1);
  });
