/** How a saved password reads in lists: never anything of the password itself. */
export const passwordHint = (password: string) => (password ? "password ••••" : "no password");
