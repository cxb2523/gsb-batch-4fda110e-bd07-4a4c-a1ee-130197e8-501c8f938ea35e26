import { and, desc, eq, lt, or } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { appThreads, apps } from "@/lib/db/schema";
import { logError } from "@/lib/log";

import { fail, fromValidation, internalError, notFound, ok, type AppResult } from "./errors";
import { appIdSchema, registerThreadSchema, renameThreadSchema, threadIdSchema } from "./schemas";

/** The shape Agent Interface's thread list expects. */
export type AppThread = { id: string; title: string; createdAt: string };

const PAGE_SIZE = 30;

/**
 * Which app each chat thread belongs to. Threads live in OpenUI Cloud, which
 * has no notion of apps; this mapping is what scopes a thread list to one
 * app. Every call checks the app belongs to the user, and a thread belongs to
 * exactly one app.
 */
export function createThreadService({ db, now = () => new Date() }: { db: Database; now?: () => Date }) {
  async function ownsApp(userId: string, appId: string) {
    if (!appIdSchema.safeParse(appId).success) return false;
    const [row] = await db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.id, appId), eq(apps.userId, userId)))
      .limit(1);
    return Boolean(row);
  }

  const scope = (userId: string, appId: string, threadId: string) =>
    and(
      eq(appThreads.threadId, threadId),
      eq(appThreads.appId, appId),
      eq(appThreads.userId, userId),
    );

  async function guard<T>(operation: string, fn: () => Promise<AppResult<T>>): Promise<AppResult<T>> {
    try {
      return await fn();
    } catch (error) {
      logError(`threads.${operation}`, error);
      return internalError();
    }
  }

  return {
    /** The app's threads, most recently active first, a page at a time. */
    list(
      userId: string,
      appId: string,
      cursor?: string | null,
    ): Promise<AppResult<{ threads: AppThread[]; nextCursor?: string }>> {
      return guard("list", async () => {
        if (!(await ownsApp(userId, appId))) return notFound();
        const after = cursor ? decodeCursor(cursor) : null;
        if (cursor && !after) return fail({ code: "validation", message: "Invalid cursor." });

        const rows = await db
          .select()
          .from(appThreads)
          .where(
            and(
              eq(appThreads.appId, appId),
              eq(appThreads.userId, userId),
              after
                ? or(
                    lt(appThreads.updatedAt, after.updatedAt),
                    and(
                      eq(appThreads.updatedAt, after.updatedAt),
                      lt(appThreads.threadId, after.threadId),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(appThreads.updatedAt), desc(appThreads.threadId))
          .limit(PAGE_SIZE + 1);

        const page = rows.slice(0, PAGE_SIZE);
        const last = page.at(-1);
        return ok({
          threads: page.map((row) => ({
            id: row.threadId,
            title: row.title,
            createdAt: row.createdAt.toISOString(),
          })),
          ...(rows.length > PAGE_SIZE && last
            ? { nextCursor: encodeCursor(last.updatedAt, last.threadId) }
            : {}),
        });
      });
    },

    /**
     * Records a thread just created in Cloud as belonging to the app.
     * Registering the same thread for the same app again is a no-op; a thread
     * already mapped elsewhere is refused.
     */
    register(userId: string, appId: string, input: unknown): Promise<AppResult<AppThread>> {
      return guard("register", async () => {
        const parsed = registerThreadSchema.safeParse(input);
        if (!parsed.success) return fromValidation(parsed.error);
        if (!(await ownsApp(userId, appId))) return notFound();
        const { threadId, title } = parsed.data;

        const [inserted] = await db
          .insert(appThreads)
          .values({ threadId, appId, userId, title })
          .onConflictDoNothing()
          .returning();
        const row =
          inserted ??
          (await db.select().from(appThreads).where(eq(appThreads.threadId, threadId)).limit(1))[0];

        if (!row || row.appId !== appId || row.userId !== userId) {
          return fail({
            code: "thread_conflict",
            message: "This conversation belongs to another app.",
          });
        }
        return ok({ id: row.threadId, title: row.title, createdAt: row.createdAt.toISOString() });
      });
    },

    rename(userId: string, appId: string, threadId: string, input: unknown): Promise<AppResult> {
      return guard("rename", async () => {
        const parsed = renameThreadSchema.safeParse(input);
        if (!parsed.success) return fromValidation(parsed.error);
        if (!threadIdSchema.safeParse(threadId).success) return notFound();
        const updated = await db
          .update(appThreads)
          .set({ title: parsed.data.title, updatedAt: now() })
          .where(scope(userId, appId, threadId))
          .returning({ id: appThreads.threadId });
        return updated.length ? ok(undefined) : notFound();
      });
    },

    /** Removes the mapping. The Cloud conversation is deleted by the caller. */
    remove(userId: string, appId: string, threadId: string): Promise<AppResult> {
      return guard("remove", async () => {
        if (!threadIdSchema.safeParse(threadId).success) return notFound();
        const deleted = await db
          .delete(appThreads)
          .where(scope(userId, appId, threadId))
          .returning({ id: appThreads.threadId });
        return deleted.length ? ok(undefined) : notFound();
      });
    },

    /** Whether the thread belongs to this app and user. The chat route checks this before every turn. */
    async belongsTo(userId: string, appId: string, threadId: string): Promise<boolean> {
      if (!appIdSchema.safeParse(appId).success || !threadIdSchema.safeParse(threadId).success) {
        return false;
      }
      const [row] = await db
        .select({ id: appThreads.threadId })
        .from(appThreads)
        .where(scope(userId, appId, threadId))
        .limit(1);
      return Boolean(row);
    },

    /** Moves the thread to the top of the app's list. The chat route calls it on each turn. */
    async touch(userId: string, appId: string, threadId: string): Promise<void> {
      if (!threadIdSchema.safeParse(threadId).success) return;
      await db.update(appThreads).set({ updatedAt: now() }).where(scope(userId, appId, threadId));
    },
  };
}

export type ThreadService = ReturnType<typeof createThreadService>;

function encodeCursor(updatedAt: Date, threadId: string): string {
  return Buffer.from(JSON.stringify([updatedAt.toISOString(), threadId])).toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: Date; threadId: string } | null {
  try {
    const [iso, threadId] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const updatedAt = new Date(iso);
    if (Number.isNaN(updatedAt.getTime()) || !threadIdSchema.safeParse(threadId).success) return null;
    return { updatedAt, threadId };
  } catch {
    return null;
  }
}
