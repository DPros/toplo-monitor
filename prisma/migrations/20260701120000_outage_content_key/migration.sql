-- Re-key the Outage cache on content (neighborhood|areaText) instead of toplo's
-- unstable AccidentId. Existing rows can't be backfilled cleanly past duplicate-
-- content rows from AccidentId churn, and this is still test data, so reset the
-- cache + notifications. The next poll rebuilds the cache and re-notifies any
-- currently-matching outage once.
TRUNCATE TABLE "SentNotification", "Outage" RESTART IDENTITY CASCADE;

-- DropIndex
DROP INDEX "Outage_accidentId_key";

-- AlterTable
ALTER TABLE "Outage" ADD COLUMN     "key" TEXT NOT NULL,
ALTER COLUMN "accidentId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Outage_key_key" ON "Outage"("key");
