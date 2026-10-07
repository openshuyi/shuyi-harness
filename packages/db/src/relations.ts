import { defineRelations } from "drizzle-orm";

import {
	account as accountTable,
	authRelations,
	session as sessionTable,
	user as userTable,
	verification as verificationTable,
} from "./schema";

export const relations = {
	...defineRelations({
		account: accountTable,
		session: sessionTable,
		user: userTable,
		verification: verificationTable,
	}),
	...authRelations,
};
