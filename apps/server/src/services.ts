import { createAuth } from "@shuyi-harness/auth";
import { createDb } from "@shuyi-harness/db";

import { ENV, desktopOrigins } from "./env.server";

export const db = createDb(ENV);
export const auth = createAuth(ENV, db, desktopOrigins);
