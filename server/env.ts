// Match Neon's env pull: existing .env, otherwise .env.local. Process env wins.
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });
