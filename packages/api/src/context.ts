import type { Session } from "@shuyi-harness/auth";
import type { Database } from "@shuyi-harness/db";

export type Context = {
	session: Session | null;
	db: Database;
};
