CREATE TYPE "public"."connection_status" AS ENUM('ok', 'invalid', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."connection_type" AS ENUM('posthog', 'postgres');--> statement-breakpoint
CREATE TABLE "app_connections" (
	"app_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"first_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_connections_app_id_connection_id_pk" PRIMARY KEY("app_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "app_threads" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"pending_prompt" text,
	"pending_connection_ids" uuid[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboards_artifact_id_unique" UNIQUE("artifact_id")
);
--> statement-breakpoint
CREATE TABLE "data_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "connection_type" NOT NULL,
	"config" jsonb NOT NULL,
	"secret" jsonb,
	"credential_hint" text NOT NULL,
	"demo_dataset" text,
	"status" "connection_status" NOT NULL,
	"last_checked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_connections_secret_or_demo" CHECK (("data_connections"."demo_dataset" IS NULL) = ("data_connections"."secret" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_connections" ADD CONSTRAINT "app_connections_connection_id_data_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."data_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_threads" ADD CONSTRAINT "app_threads_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_connections_connection_id_idx" ON "app_connections" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "app_threads_app_id_idx" ON "app_threads" USING btree ("app_id","updated_at");--> statement-breakpoint
CREATE INDEX "apps_user_id_idx" ON "apps" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "dashboards_app_id_idx" ON "dashboards" USING btree ("app_id","position");--> statement-breakpoint
CREATE INDEX "data_connections_user_id_idx" ON "data_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_connections_user_demo_idx" ON "data_connections" USING btree ("user_id","demo_dataset");