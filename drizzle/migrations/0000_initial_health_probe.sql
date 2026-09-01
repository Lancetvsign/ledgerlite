CREATE TABLE "_health" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
