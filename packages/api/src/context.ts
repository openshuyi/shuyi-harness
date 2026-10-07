import type { Session } from "@shuyi-harness/auth";
import type { Database } from "@shuyi-harness/db";

export interface Context {
	db: Database;
	session: Session | null;
}
